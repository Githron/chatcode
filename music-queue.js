import {createHash, randomUUID} from "node:crypto";

// A complete reorder must fit in the existing 24 KiB Socket.IO message limit.
const maxEntries=256;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function queueError(message) {
  return Object.assign(new Error(message),{publicMessage:message});
}
export function queueId(value) {
  if (typeof value!=="string" || !uuid.test(value)) throw queueError("Invalid music ID.");
  return value.toLowerCase();
}

export function parseQueueCommand(input, playback=false) {
  if (!input || typeof input!=="object") throw queueError("Invalid queue command.");
  const {action,expectedRevision}=input;
  const commandId=queueId(input.commandId);
  if (typeof expectedRevision!=="string" || !/^(0|[1-9][0-9]{0,18})$/.test(expectedRevision) ||
      BigInt(expectedRevision)>9223372036854775807n) throw queueError("Invalid expected revision.");
  let field, argument;
  if (playback) {
    if (!["play","pause","next","previous","seek"].includes(action)) throw queueError("Unknown playback action.");
    if (action==="seek") field="positionMs";
  } else switch (action) {
    case "deleteTrack":
    case "add": field="trackId"; break;
    case "select":
    case "remove": field="entryId"; break;
    case "reorder": field="entryIds"; break;
    default: throw queueError("Unknown queue action.");
  }
  if (Object.keys(input).some(key=>!["room","commandId","expectedRevision","action",field].includes(key)))
    throw queueError("Unexpected queue command field.");
  if (field==="entryIds") {
    if (!Array.isArray(input.entryIds) || input.entryIds.length>maxEntries) throw queueError("Invalid queue order.");
    argument=Array.from(input.entryIds,queueId);
    if (new Set(argument).size!==argument.length) throw queueError("Invalid queue order.");
  } else if (field==="positionMs") {
    argument=input.positionMs;
    if (!Number.isSafeInteger(argument) || argument<0) throw queueError("Invalid playback position.");
  } else if (field) argument=queueId(input[field]);
  const fingerprint=createHash("sha256").update(JSON.stringify([expectedRevision,action,argument])).digest();
  return {commandId,expectedRevision,action,argument,fingerprint};
}

export async function resetCurrent(tx, room, entryIds) {
  await tx.query(`UPDATE chatcode_music_playback SET current_entry=NULL, playing=false, position_ms=0, anchor_time=NULL
    WHERE room=$1 AND current_entry=ANY($2::uuid[])`, [room,entryIds]);
}

// Called with the room playback row locked. Removing an entry never deletes its track.
export async function applyQueueEdit(tx, room, {action,argument}) {
  if (action==="add") {
    const track=await tx.query("SELECT 1 FROM chatcode_music_tracks WHERE room=$1 AND track_id=$2",[room,argument]);
    if (!track.rows.length) throw queueError("Track unavailable.");
    const added=await tx.query(`INSERT INTO chatcode_music_queue(room,entry_id,track_id,position)
      SELECT $1,$2,$3,coalesce(max(position),0)+1 FROM chatcode_music_queue WHERE room=$1
      HAVING count(*)<$4 RETURNING entry_id`,[room,randomUUID(),argument,maxEntries]);
    if (!added.rows.length) throw queueError("The room queue is full.");
    return;
  }
  if (action==="reorder") {
    const {rows}=await tx.query("SELECT entry_id FROM chatcode_music_queue WHERE room=$1",[room]);
    const members=new Set(rows.map(row=>row.entry_id));
    if (argument.length!==members.size || !argument.every(id=>members.has(id))) throw queueError("Invalid queue order.");
    await tx.query(`UPDATE chatcode_music_queue q SET position=o.position
      FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id,position)
      WHERE q.room=$1 AND q.entry_id=o.id`,[room,argument]);
    return;
  }
  let result;
  if (action==="select") {
    result=await tx.query(`UPDATE chatcode_music_playback p SET current_entry=q.entry_id,
      playing=false, position_ms=0, anchor_time=NULL FROM chatcode_music_queue q
      WHERE p.room=$1 AND q.room=p.room AND q.entry_id=$2 RETURNING q.entry_id`,[room,argument]);
  } else if (action==="remove") {
    await resetCurrent(tx,room,[argument]);
    result=await tx.query("DELETE FROM chatcode_music_queue WHERE room=$1 AND entry_id=$2 RETURNING entry_id",[room,argument]);
  } else throw queueError("Unknown queue action.");
  if (!result.rows.length) throw queueError("Queue entry unavailable.");
}
