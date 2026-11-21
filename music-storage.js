import { randomUUID } from "node:crypto";
import {applyQueueEdit, parseQueueCommand, queueError, queueId, resetCurrent} from "./music-queue.js";

const maxTrackSize = 10 * 1024 * 1024;
const envelopeBytes = 28; // 12-byte IV and 16-byte GCM tag

export const musicMigration = [
  `CREATE TABLE IF NOT EXISTS chatcode_music_tracks (
    room text NOT NULL,
    track_id uuid NOT NULL,
    object_key text NOT NULL UNIQUE CHECK (object_key LIKE 'chatcode/r2/%'),
    filename text NOT NULL CHECK (length(filename) BETWEEN 5 AND 160 AND lower(right(filename,4)) = '.mp3'),
    mime_type text NOT NULL DEFAULT 'audio/mpeg' CHECK (mime_type = 'audio/mpeg'),
    size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND ${maxTrackSize}),
    byte_count integer GENERATED ALWAYS AS (size_bytes + ${envelopeBytes}) STORED,
    duration_ms integer NOT NULL CHECK (duration_ms > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room, track_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chatcode_music_queue (
    room text NOT NULL,
    entry_id uuid NOT NULL,
    track_id uuid NOT NULL,
    position bigint NOT NULL CHECK (position > 0),
    PRIMARY KEY (room, entry_id),
    UNIQUE (room, position) DEFERRABLE INITIALLY IMMEDIATE,
    FOREIGN KEY (room, track_id) REFERENCES chatcode_music_tracks(room, track_id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS chatcode_music_queue_track ON chatcode_music_queue(room, track_id)",
  `CREATE TABLE IF NOT EXISTS chatcode_music_playback (
    room text PRIMARY KEY,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    current_entry uuid,
    position_ms integer NOT NULL DEFAULT 0 CHECK (position_ms >= 0),
    playing boolean NOT NULL DEFAULT false,
    anchor_time timestamptz,
    CHECK (playing = (anchor_time IS NOT NULL)),
    CHECK (current_entry IS NOT NULL OR (position_ms = 0 AND NOT playing)),
    FOREIGN KEY (room, current_entry) REFERENCES chatcode_music_queue(room, entry_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chatcode_music_queue_commands (
    room text NOT NULL REFERENCES chatcode_music_playback(room),
    command_id uuid NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
    applied_revision bigint NOT NULL CHECK (applied_revision>0),
    PRIMARY KEY (room,command_id)
  )`,
  "ALTER TABLE chatcode_object_cleanup ADD COLUMN IF NOT EXISTS music_upload_id uuid",
  `CREATE UNIQUE INDEX IF NOT EXISTS chatcode_music_upload_id ON chatcode_object_cleanup(music_upload_id)
   WHERE music_upload_id IS NOT NULL`
];

const stateFields = "revision::text, current_entry, position_ms, playing, anchor_time";
const emptyState = {revision:"0", current_entry:null, position_ms:0, playing:false, anchor_time:null};

async function playbackState(db, room) {
  const {rows}=await db.query(`SELECT p.revision::text,p.current_entry,p.position_ms,p.playing,p.anchor_time,
    q.track_id,t.duration_ms FROM chatcode_music_playback p
    LEFT JOIN chatcode_music_queue q ON q.room=p.room AND q.entry_id=p.current_entry
    LEFT JOIN chatcode_music_tracks t ON t.room=q.room AND t.track_id=q.track_id WHERE p.room=$1`,[room]);
  return rows[0] || {...emptyState,track_id:null,duration_ms:null};
}

function positionAt(state, now) {
  const elapsed=state.playing ? Math.max(0,now-new Date(state.anchor_time).getTime()) : 0;
  return Math.min(state.duration_ms,state.position_ms+elapsed);
}

// The caller holds the playback row lock. Queue order and duration cannot change underneath us.
async function applyPlayback(tx, room, {action,argument}, state) {
  state ||= await playbackState(tx,room);
  const now=Date.now();
  let entry=state.current_entry, playing=state.playing, position=positionAt(state,now);
  if (action==="seek") {
    if (!entry || argument>state.duration_ms) throw queueError("Invalid playback position.");
    position=argument;
  } else if (action==="pause") {
    playing=false;
  } else if (action==="play" && entry) {
    if (position===state.duration_ms) position=0;
    playing=true;
  } else {
    const {rows}=await tx.query("SELECT entry_id FROM chatcode_music_queue WHERE room=$1 ORDER BY position",[room]);
    if (!rows.length) throw queueError("The room queue is empty.");
    const index=rows.findIndex(row=>row.entry_id===entry);
    const target=action==="previous" ? Math.max(0,index-1) : index+1;
    if (target===rows.length) {
      position=state.duration_ms;
      playing=false;
    } else {
      entry=rows[target].entry_id;
      position=0;
      if (action==="play") playing=true;
    }
  }
  await tx.query(`UPDATE chatcode_music_playback SET current_entry=$2, position_ms=$3,
    playing=$4, anchor_time=$5 WHERE room=$1`,[room,entry,position,playing,playing?new Date(now):null]);
}

// Room codes come from the authorized peer. Reservation handles never leave the server.
export function musicStorage({db, media, roomId, checkSpace, collectKeys, lockBudget}) {
  async function lockedRevision(tx, room) {
    const {rows} = await tx.query("SELECT revision::text FROM chatcode_music_playback WHERE room=$1 FOR UPDATE", [room]);
    return rows[0]?.revision;
  }

  async function lockRoom(tx, room) {
    await tx.query("INSERT INTO chatcode_music_playback(room) VALUES ($1) ON CONFLICT DO NOTHING", [room]);
    return lockedRevision(tx,room);
  }

  async function advanceRevision(tx, room) {
    const {rows} = await tx.query("UPDATE chatcode_music_playback SET revision=revision+1 WHERE room=$1 RETURNING revision::text", [room]);
    return rows[0].revision;
  }

  function edit(code, expectedRevision, action, touchesBudget = false) {
    const room = roomId(code);
    return db.transaction(async tx => {
      if (touchesBudget) await lockBudget(tx);
      const revision = await lockRoom(tx, room);
      if (revision !== expectedRevision) throw new Error("Music revision changed.");
      await action(tx, room);
      return advanceRevision(tx, room);
    });
  }

  async function commitCommand(code, input, stillJoined, playback) {
    const command=parseQueueCommand(input,playback), room=roomId(code);
    return db.transaction(async tx=>{
      // Track publication creates the playback row. A rejected command in an empty room needs no writes.
      const revision=await lockedRevision(tx,room);
      if (!stillJoined()) throw queueError("Join this room first.");
      if (revision===undefined) {
        if (command.expectedRevision!=="0") return {ok:false,code:"stale_revision"};
        throw queueError("Room music unavailable.");
      }
      const receipt=await tx.query(`SELECT fingerprint, applied_revision::text FROM chatcode_music_queue_commands
        WHERE room=$1 AND command_id=$2`,[room,command.commandId]);
      if (receipt.rows.length) {
        const {fingerprint,applied_revision}=receipt.rows[0];
        if (!command.fingerprint.equals(fingerprint)) return {ok:false,code:"command_id_reused"};
        return {ok:true,replayed:true,appliedRevision:applied_revision};
      }
      if (revision!==command.expectedRevision) return {ok:false,code:"stale_revision"};
      if (playback) await applyPlayback(tx,room,command);
      else await applyQueueEdit(tx,room,command);
      const appliedRevision=await advanceRevision(tx,room);
      await tx.query(`INSERT INTO chatcode_music_queue_commands(room,command_id,fingerprint,applied_revision)
        VALUES ($1,$2,$3,$4)`,[room,command.commandId,command.fingerprint,appliedRevision]);
      if (!stillJoined()) throw queueError("Join this room first.");
      return {ok:true,replayed:false,appliedRevision};
    });
  }

  return {
    async snapshot(code, afterTrackId=null) {
      const room = roomId(code);
      if (afterTrackId!==null) afterTrackId=queueId(afterTrackId);
      return db.transaction(async tx => {
        // One consistent view across these SELECTs, without blocking an editor.
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const state = await tx.query(`SELECT ${stateFields} FROM chatcode_music_playback WHERE room=$1`, [room]);
        if (!state.rows.length) return {...emptyState, tracks:[], queue:[], nextTrackCursor:null};
        const tracks = await tx.query(`SELECT track_id, filename, mime_type, size_bytes, duration_ms, created_at
          FROM chatcode_music_tracks WHERE room=$1 AND ($2::uuid IS NULL OR track_id>$2)
          ORDER BY track_id LIMIT 101`, [room,afterTrackId]);
        const queue = await tx.query(`SELECT q.entry_id, q.track_id, t.filename, t.duration_ms
          FROM chatcode_music_queue q JOIN chatcode_music_tracks t USING (room,track_id)
          WHERE q.room=$1 ORDER BY q.position`, [room]);
        const page=tracks.rows.slice(0,100);
        return {...state.rows[0], tracks:page, queue:queue.rows, nextTrackCursor:tracks.rows.length>100?page.at(-1).track_id:null};
      });
    },

    // This private handle is for the R2 writer. Only publish after validation and a confirmed PUT.
    async reserveTrack(code, size, trackId = randomUUID()) {
      if (!Number.isInteger(size) || size < 1 || size > maxTrackSize) throw new Error("Invalid track size.");
      const objectKey = media.newKey();
      if (!objectKey?.startsWith("chatcode/r2/")) throw new Error("Music requires private R2 storage.");
      const room = roomId(code), bytes = size + envelopeBytes;
      return db.transaction(async tx => {
        await lockBudget(tx);
        const existing=await tx.query("SELECT 1 FROM chatcode_music_tracks WHERE room=$1 AND track_id=$2", [room,trackId]);
        if (existing.rows.length) return {trackId, published:true};
        const prior=await tx.query(`UPDATE chatcode_object_cleanup SET due=clock_timestamp()+interval '1 hour'
          WHERE room=$1 AND music_upload_id=$2 AND byte_count=$3 AND due>clock_timestamp() RETURNING object_key`, [room,trackId,bytes]);
        if (prior.rows.length) return {trackId, objectKey:prior.rows[0].object_key};
        await tx.query(`UPDATE chatcode_object_cleanup SET music_upload_id=NULL
          WHERE room=$1 AND music_upload_id=$2 AND due<=clock_timestamp()`,[room,trackId]);
        await checkSpace(tx, room, bytes);
        await tx.query(`INSERT INTO chatcode_object_cleanup(object_key, room, byte_count, music_upload_id, due)
          VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`, [objectKey, room, bytes, trackId]);
        return {trackId, objectKey};
      });
    },

    async publishTrack(code, trackId, {filename, sizeBytes, durationMs}, expectedKey=null, stillJoined=()=>true) {
      if (typeof filename !== "string" || filename.startsWith(".") || filename.length > 160 ||
          !/\.mp3$/i.test(filename) || /[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(filename))
        throw new Error("Invalid MP3 filename.");
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 2147483647) throw new Error("Invalid track duration.");
      if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxTrackSize) throw new Error("Invalid track size.");
      const room = roomId(code);
      return db.transaction(async tx => {
        await lockBudget(tx);
        const revision = await lockRoom(tx, room);
        const published = await tx.query("SELECT filename, size_bytes, duration_ms FROM chatcode_music_tracks WHERE room=$1 AND track_id=$2", [room, trackId]);
        if (published.rows.length) {
          const track = published.rows[0];
          if (track.filename !== filename || track.size_bytes !== sizeBytes || track.duration_ms !== durationMs)
            throw new Error("Track already published with different metadata.");
          return revision;
        }
        const claim = await tx.query(`DELETE FROM chatcode_object_cleanup
          WHERE room=$1 AND music_upload_id=$2 AND due>clock_timestamp() AND ($3::text IS NULL OR object_key=$3)
          RETURNING object_key, byte_count`, [room, trackId, expectedKey]);
        if (!claim.rows.length) throw new Error("Music reservation unavailable.");
        const {object_key, byte_count} = claim.rows[0];
        if (byte_count !== sizeBytes + envelopeBytes) throw new Error("Track size differs from reservation.");
        await tx.query(`INSERT INTO chatcode_music_tracks(room,track_id,object_key,filename,size_bytes,duration_ms)
          VALUES ($1,$2,$3,$4,$5,$6)`, [room, trackId, object_key, filename, sizeBytes, durationMs]);
        const nextRevision=await advanceRevision(tx,room);
        if (!stillJoined()) throw new Error("Room session ended.");
        return nextRevision;
      });
    },

    async saveUpload(code, id, metadata, encrypted, stillJoined) {
      if (encrypted.length!==metadata.sizeBytes+envelopeBytes) throw new Error("Invalid track envelope size.");
      const reservation=await this.reserveTrack(code,metadata.sizeBytes,id);
      if (!stillJoined()) throw new Error("Room session ended.");
      if (reservation.published) return false;
      await media.putOnce(reservation.objectKey,encrypted);
      await this.publishTrack(code,id,metadata,reservation.objectKey,stillJoined);
      return true;
    },

    async readTrack(code,id) {
      const {rows}=await db.query("SELECT object_key, byte_count FROM chatcode_music_tracks WHERE room=$1 AND track_id=$2", [roomId(code),id]);
      if (!rows.length) return null;
      const bytes=await media.get(rows[0].object_key);
      if (bytes.length!==rows[0].byte_count) throw new Error("Incomplete track.");
      return bytes;
    },

    queueCommand(code, input, stillJoined=()=>true) {
      return commitCommand(code,input,stillJoined,false);
    },
    playbackCommand(code, input, stillJoined=()=>true) {
      return commitCommand(code,input,stillJoined,true);
    },

    playbackSnapshot(code) { return playbackState(db,roomId(code)); },

    advanceIfEnded(code, expectedRevision, occupied) {
      const room=roomId(code);
      return db.transaction(async tx=>{
        if (await lockedRevision(tx,room)!==expectedRevision || !occupied()) return false;
        const state=await playbackState(tx,room);
        if (!state.playing || positionAt(state,Date.now())<state.duration_ms) return false;
        await applyPlayback(tx,room,{action:"next"},state);
        await advanceRevision(tx,room);
        return true;
      });
    },

    // At startup every room is empty. On disconnect freeze only the departing room.
    pauseEmptyRooms(code, at=Date.now()) {
      const params=[new Date(at)];
      if (code!==undefined) params.push(roomId(code));
      const sql=`UPDATE chatcode_music_playback p SET revision=revision+1, playing=false, anchor_time=NULL,
        position_ms=least(t.duration_ms, p.position_ms+greatest(0, floor(extract(epoch FROM ($1::timestamptz-p.anchor_time))*1000)))
        FROM chatcode_music_queue q JOIN chatcode_music_tracks t USING (room,track_id)
        WHERE p.playing AND p.room=q.room AND p.current_entry=q.entry_id ${code===undefined?"":"AND p.room=$2"}`;
      if (code===undefined) return db.query(sql,params);
      return db.transaction(async tx=>{
        // Also wait for a play that passed its session check and is still committing.
        await lockedRevision(tx,params[1]);
        await tx.query(sql,params);
      });
    },

    setPlayback(code, revision, {entryId, positionMs, playing}) {
      return edit(code, revision, async (tx, room) => {
        if (typeof playing !== "boolean" || !Number.isInteger(positionMs) || positionMs < 0) throw new Error("Invalid playback state.");
        const result = await tx.query(`UPDATE chatcode_music_playback p SET current_entry=q.entry_id, position_ms=$3,
          playing=$4, anchor_time=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END
          FROM chatcode_music_queue q JOIN chatcode_music_tracks t USING (room,track_id)
          WHERE p.room=$1 AND q.room=p.room AND q.entry_id=$2 AND $3<=t.duration_ms RETURNING p.room`, [room,entryId,positionMs,playing]);
        if (!result.rows.length) throw new Error("Invalid playback entry or position.");
      });
    },

    removeTrack(code, revision, trackId) {
      return edit(code, revision, async (tx, room) => {
        const entries = await tx.query("SELECT entry_id FROM chatcode_music_queue WHERE room=$1 AND track_id=$2", [room, trackId]);
        await resetCurrent(tx, room, entries.rows.map(row => row.entry_id));
        const removed = await tx.query(`DELETE FROM chatcode_music_tracks WHERE room=$1 AND track_id=$2
          RETURNING room, object_key, byte_count`, [room, trackId]);
        if (!removed.rows.length) throw new Error("Music track unavailable.");
        await collectKeys(tx, removed.rows);
      }, true);
    }
  };
}
