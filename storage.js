import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import pg from "pg";
import { mediaStorage, MediaConfigurationError } from "./media-storage.js";
import { storageStep } from "./storage-diagnostics.js";
import { musicMigration, musicStorage } from "./music-storage.js";

function query(db, operation, sql, params) {
  return storageStep("postgres." + operation, () => db.query(sql, params));
}

const MiB = 1024 * 1024;
function expiredReservation() {
  const error = new Error("Attachment expired. Please retry the upload.");
  error.publicMessage = error.message;
  return error;
}
const roomId = room => createHash("sha256").update(room).digest("hex");
const sql = `
  CREATE TABLE IF NOT EXISTS chatcode_messages (
    seq bigserial PRIMARY KEY,
    room text NOT NULL,
    message_id uuid NOT NULL UNIQUE,
    client_id uuid,
    payload jsonb NOT NULL,
    attachment_id uuid UNIQUE,
    byte_count integer NOT NULL DEFAULT 0,
    ciphertext bytea,
    object_key text,
    UNIQUE(room, client_id)
  );
  CREATE INDEX IF NOT EXISTS chatcode_room_order ON chatcode_messages(room, seq);
  CREATE TABLE IF NOT EXISTS chatcode_object_cleanup (
    object_key text PRIMARY KEY,
    due timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE chatcode_object_cleanup ADD COLUMN IF NOT EXISTS byte_count integer;
  ALTER TABLE chatcode_object_cleanup ADD COLUMN IF NOT EXISTS room text;
  CREATE TABLE IF NOT EXISTS chatcode_storage_lock (id integer PRIMARY KEY);
  INSERT INTO chatcode_storage_lock VALUES (1) ON CONFLICT DO NOTHING;
`;

async function database() {
  if (process.env.DATABASE_URL || process.env.PGHOST) {
    const pool = new pg.Pool({connectionString:process.env.DATABASE_URL, max:5, connectionTimeoutMillis:8000});
    pool.on("error", () => console.error("PostgreSQL connection interrupted."));
    return {
      query:(...args)=>pool.query(...args),
      exec:text=>pool.query(text),
      close:()=>pool.end(),
      transaction:async fn=>{
        const client=await pool.connect();
        let discard;
        try {
          await client.query("BEGIN");
          const result=await fn(client);
          await client.query("COMMIT");
          return result;
        } catch(error) {
          try { await client.query("ROLLBACK"); }
          catch (rollbackError) { discard=rollbackError; }
          throw error;
        } finally {client.release(discard);}
      }
    };
  }
  if (process.env.RENDER || process.env.NODE_ENV === "production")
    throw new Error("Configure DATABASE_URL for durable production history.");
  const {PGlite} = await import("@electric-sql/pglite");
  const path = resolve(process.env.CHATCODE_DATA_DIR || ".chatcode-data");
  await mkdir(path,{recursive:true,mode:0o700});
  const actual=await realpath(path);
  const webRoot=await realpath(new URL("./public/",import.meta.url));
  if(actual===webRoot || actual.startsWith(webRoot+sep))throw new Error("Choose a private database directory.");
  return new PGlite(actual);
}

export async function openStorage({enableMusicStorage = false} = {}) {
  const media = mediaStorage();
  const configured = process.env.CHATCODE_STORAGE_BUDGET_BYTES ?? String(128 * MiB);
  const budget = Number(configured);
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(budget))
    throw new MediaConfigurationError("CHATCODE_STORAGE_BUDGET_BYTES must be a nonnegative integer.");
  const db = await database();
  await db.exec(sql);
  const lockBudget = tx => query(tx,"lock_budget","SELECT id FROM chatcode_storage_lock WHERE id=1 FOR UPDATE");
  await db.transaction(async tx => {
    await lockBudget(tx);
    for (const statement of musicMigration) await tx.query(statement);
  });
  async function checkSpace(tx, room, size) {
    const {rows} = await query(tx,"check_budget",`SELECT sum(byte_count) AS total,
      sum(byte_count) FILTER (WHERE room=$1) AS local FROM (
        SELECT byte_count, room FROM chatcode_messages WHERE byte_count>0
        UNION ALL SELECT byte_count, room FROM chatcode_music_tracks
        UNION ALL SELECT byte_count, room FROM chatcode_object_cleanup
      ) usage`, [room]);
    if (Number(rows[0].total) + size > budget || Number(rows[0].local) + size > 40 * MiB) {
      const error = new Error("Attachment storage is full. You can still send text.");
      error.publicMessage = error.message;
      throw error;
    }
  }
  async function collectKeys(tx, rows) {
    const objects = rows.filter(row => row.object_key);
    if (objects.length) await query(tx,"queue_cleanup",`INSERT INTO chatcode_object_cleanup(object_key, byte_count, room)
      SELECT * FROM unnest($1::text[], $2::integer[], $3::text[]) ON CONFLICT DO NOTHING`,
      [objects.map(r=>r.object_key), objects.map(r=>r.byte_count), objects.map(r=>r.room)]);
  }
  async function trim(tx,room) {
    const deleted=await query(tx,"prune_history",`DELETE FROM chatcode_messages WHERE room=$1 AND seq IN
      (SELECT seq FROM chatcode_messages WHERE room=$1 ORDER BY seq DESC OFFSET 100) RETURNING object_key,byte_count,room`,[room]);
    await collectKeys(tx,deleted.rows);
  }
  let cleaning;
  async function cleanObjects() {
    try {
      // Compete with publication for the reservation row before deleting its object.
      await db.query(`UPDATE chatcode_object_cleanup SET music_upload_id=NULL
        WHERE music_upload_id IS NOT NULL AND due<=clock_timestamp()`);
      const {rows}=await db.query(`SELECT object_key FROM chatcode_object_cleanup
        WHERE music_upload_id IS NULL AND due <= now() ORDER BY due LIMIT 50`);
      for(const {object_key} of rows) {
        try {
          await media.remove(object_key);
          await db.query("DELETE FROM chatcode_object_cleanup WHERE object_key=$1",[object_key]);
        } catch {
          await db.query("UPDATE chatcode_object_cleanup SET due=now()+interval '5 minutes' WHERE object_key=$1",[object_key]);
        }
      }
    } catch {console.error("Attachment cleanup deferred.");}
  }
  function cleanup() {
    cleaning ??= cleanObjects().finally(()=>{cleaning=undefined;});
    return cleaning;
  }
  const interval=setInterval(cleanup,60000).unref();
  void cleanup();

  return {
    music: enableMusicStorage ? musicStorage({db, media, roomId, checkSpace, collectKeys, lockBudget}) : undefined,
    async close() {
      clearInterval(interval);
      await cleaning;
      await db.close();
    },
    checkUploadSpace: (code, size) => checkSpace(db, roomId(code), size),
    async history(code) {
      const {rows}=await db.query("SELECT payload FROM chatcode_messages WHERE room=$1 ORDER BY seq",[roomId(code)]);
      return rows.map(r=>r.payload);
    },
    async receipt(code,clientId) {
      if(!clientId)return null;
      const {rows}=await query(db,"read_receipt","SELECT message_id FROM chatcode_messages WHERE room=$1 AND client_id=$2",[roomId(code),clientId]);
      return rows[0]?.message_id;
    },
    async save(code,event,clientId,file) {
      const room=roomId(code);
      const objectKey=file ? file.objectKey || media.newKey() : null;
      if(objectKey){
        // The reservation survives a crash between PUT and the message commit.
        await storageStep("postgres.reserve_transaction",()=>db.transaction(async tx=>{
          await lockBudget(tx);
          if(file.objectKey){
            // A lost commit acknowledgement must never queue a published object for deletion.
            const reserved=await query(tx,"find_reservation","SELECT 1 FROM chatcode_object_cleanup WHERE object_key=$1 AND due>now()",[objectKey]);
            if(!reserved.rows.length)throw expiredReservation();
            return;
          }
          await checkSpace(tx,room,file.bytes.length);
          await query(tx,"insert_reservation",`INSERT INTO chatcode_object_cleanup(object_key,due,byte_count,room)
            VALUES($1,now()+interval '1 hour',$2,$3)`,[objectKey,file.bytes.length,room]);
        }));
        file.objectKey=objectKey;
        await media.put(objectKey,file.bytes);
      }
      await storageStep("postgres.publish_transaction",()=>db.transaction(async tx=>{
        // Serialize retention and storage-budget decisions in the same transaction.
        await lockBudget(tx);
        if(objectKey){
          const claimed=await query(tx,"claim_reservation","DELETE FROM chatcode_object_cleanup WHERE object_key=$1 AND due>now() RETURNING object_key",[objectKey]);
          if(!claimed.rows.length)throw expiredReservation();
        }
        if(file && !objectKey)await checkSpace(tx,room,file.bytes.length);
        await query(tx,"insert_message",`INSERT INTO chatcode_messages
          (room,message_id,client_id,payload,attachment_id,byte_count,ciphertext,object_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[
          room,event.id,clientId||null,JSON.stringify(event),file?.info.id||null,
          file?.bytes.length||0,file&&!objectKey?file.bytes:null,objectKey]);
        await trim(tx,room);
      }));
    },
    async readFile(code,id) {
      const {rows}=await db.query("SELECT ciphertext,object_key FROM chatcode_messages WHERE room=$1 AND attachment_id=$2",[roomId(code),id]);
      if(!rows.length)return null;
      if(!rows[0].object_key)return Buffer.from(rows[0].ciphertext);
      return media.get(rows[0].object_key);
    },
    async clear(code) {
      await db.transaction(async tx=>{
        await tx.query("SELECT id FROM chatcode_storage_lock WHERE id=1 FOR UPDATE");
        const deleted=await tx.query("DELETE FROM chatcode_messages WHERE room=$1 RETURNING object_key,byte_count,room",[roomId(code)]);
        await collectKeys(tx,deleted.rows);
      });
      void cleanup();
    }
  };
}
