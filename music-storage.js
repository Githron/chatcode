import { randomUUID } from "node:crypto";

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
  "ALTER TABLE chatcode_object_cleanup ADD COLUMN IF NOT EXISTS music_upload_id uuid",
  `CREATE UNIQUE INDEX IF NOT EXISTS chatcode_music_upload_id ON chatcode_object_cleanup(music_upload_id)
   WHERE music_upload_id IS NOT NULL`
];

const stateFields = "revision::text, current_entry, position_ms, playing, anchor_time";
const emptyState = {revision:"0", current_entry:null, position_ms:0, playing:false, anchor_time:null};

// All callers are server-side. Room codes come from the authorized peer in a future transport layer.
export function musicStorage({db, media, roomId, checkSpace, collectKeys, lockBudget}) {
  async function lockRoom(tx, room) {
    await tx.query("INSERT INTO chatcode_music_playback(room) VALUES ($1) ON CONFLICT DO NOTHING", [room]);
    const {rows} = await tx.query("SELECT revision::text FROM chatcode_music_playback WHERE room=$1 FOR UPDATE", [room]);
    return rows[0].revision;
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

  async function resetCurrent(tx, room, entryIds) {
    await tx.query(`UPDATE chatcode_music_playback SET current_entry=NULL, playing=false, position_ms=0, anchor_time=NULL
      WHERE room=$1 AND current_entry=ANY($2::uuid[])`, [room, entryIds]);
  }

  return {
    async snapshot(code) {
      const room = roomId(code);
      return db.transaction(async tx => {
        const state = await tx.query(`SELECT ${stateFields} FROM chatcode_music_playback WHERE room=$1 FOR SHARE`, [room]);
        if (!state.rows.length) return {...emptyState, tracks:[], queue:[]};
        const tracks = await tx.query(`SELECT track_id, filename, mime_type, size_bytes, duration_ms, created_at
          FROM chatcode_music_tracks WHERE room=$1 ORDER BY created_at, track_id`, [room]);
        const queue = await tx.query("SELECT entry_id, track_id FROM chatcode_music_queue WHERE room=$1 ORDER BY position", [room]);
        return {...state.rows[0], tracks:tracks.rows, queue:queue.rows};
      });
    },

    // This private handle is for the R2 writer. Only publish after validation and a confirmed PUT.
    async reserveTrack(code, size) {
      if (!Number.isInteger(size) || size < 1 || size > maxTrackSize) throw new Error("Invalid track size.");
      const objectKey = media.newKey();
      if (!objectKey?.startsWith("chatcode/r2/")) throw new Error("Music requires private R2 storage.");
      const room = roomId(code), trackId = randomUUID(), bytes = size + envelopeBytes;
      await db.transaction(async tx => {
        await lockBudget(tx);
        await checkSpace(tx, room, bytes);
        await tx.query(`INSERT INTO chatcode_object_cleanup(object_key, room, byte_count, music_upload_id, due)
          VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`, [objectKey, room, bytes, trackId]);
      });
      return {trackId, objectKey};
    },

    async publishTrack(code, trackId, {filename, sizeBytes, durationMs}) {
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
          WHERE room=$1 AND music_upload_id=$2 AND due>clock_timestamp() RETURNING object_key, byte_count`, [room, trackId]);
        if (!claim.rows.length) throw new Error("Music reservation unavailable.");
        const {object_key, byte_count} = claim.rows[0];
        if (byte_count !== sizeBytes + envelopeBytes) throw new Error("Track size differs from reservation.");
        await tx.query(`INSERT INTO chatcode_music_tracks(room,track_id,object_key,filename,size_bytes,duration_ms)
          VALUES ($1,$2,$3,$4,$5,$6)`, [room, trackId, object_key, filename, sizeBytes, durationMs]);
        return advanceRevision(tx, room);
      });
    },

    enqueue(code, revision, trackId) {
      const entryId = randomUUID();
      return edit(code, revision, (tx, room) => tx.query(`INSERT INTO chatcode_music_queue(room,entry_id,track_id,position)
        SELECT $1,$2,$3,coalesce(max(position),0)+1 FROM chatcode_music_queue WHERE room=$1`, [room, entryId, trackId]));
    },

    reorder(code, revision, entryIds) {
      return edit(code, revision, async (tx, room) => {
        const entries = await tx.query("SELECT entry_id FROM chatcode_music_queue WHERE room=$1", [room]);
        const remaining = new Set(entries.rows.map(row => row.entry_id));
        if (!Array.isArray(entryIds) || entryIds.length !== remaining.size || !entryIds.every(id => remaining.delete(id)))
          throw new Error("Invalid queue order.");
        await tx.query(`UPDATE chatcode_music_queue q SET position=o.position
          FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id,position)
          WHERE q.room=$1 AND q.entry_id=o.id`, [room, entryIds]);
      });
    },

    removeEntry(code, revision, entryId) {
      return edit(code, revision, async (tx, room) => {
        await resetCurrent(tx, room, [entryId]);
        const result = await tx.query("DELETE FROM chatcode_music_queue WHERE room=$1 AND entry_id=$2 RETURNING entry_id", [room, entryId]);
        if (!result.rows.length) throw new Error("Queue entry unavailable.");
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
