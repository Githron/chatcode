import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import pg from "pg";
import { mediaStorage } from "./media-storage.js";
import { quotaMigration, storageQuota } from "./storage-quota.js";
import { storageStep } from "./storage-diagnostics.js";
import { musicMigration, musicStorage } from "./music-storage.js";

function query(db, operation, sql, params) {
  return storageStep("postgres." + operation, () => db.query(sql, params));
}

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
  CREATE INDEX IF NOT EXISTS chatcode_object_cleanup_due ON chatcode_object_cleanup(due);
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
          // Budget decisions must see the transaction that just released the mutex.
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
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
  const db = await database();
  const lockBudget = tx => query(tx,"lock_budget","SELECT id FROM chatcode_storage_lock WHERE id=1 FOR UPDATE");
  let quota;
  try {
    quota=storageQuota(db,media,lockBudget);
    await db.exec(sql);
    await db.transaction(async tx => {
      await lockBudget(tx);
      for (const statement of musicMigration) await tx.query(statement);
      for (const statement of quotaMigration.split(";").filter(s=>s.trim())) await tx.query(statement);
    });
  } catch (error) {
    await db.close();
    throw error;
  }
  const {checkSpace}=quota;
  async function collectKeys(tx, rows, kind="attachment") {
    const objects = rows.filter(row => row.object_key);
    if (objects.length) await query(tx,"queue_cleanup",`INSERT INTO chatcode_object_cleanup(object_key, byte_count, room, kind, deleting)
      SELECT *, $4, true FROM unnest($1::text[], $2::integer[], $3::text[]) ON CONFLICT DO NOTHING`,
      [objects.map(r=>r.object_key), objects.map(r=>r.byte_count), objects.map(r=>r.room),kind]);
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
      const {rows}=await query(db,"cleanup_claim",`UPDATE chatcode_object_cleanup SET deleting=true,music_upload_id=NULL,
        uploading_until=NULL,due=clock_timestamp()+interval '5 minutes'
        WHERE object_key IN (SELECT object_key FROM chatcode_object_cleanup
          WHERE due<=clock_timestamp()
            AND (uploading_until IS NULL OR uploading_until<=clock_timestamp())
          ORDER BY due LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING object_key`);
      for(const {object_key} of rows) {
        try {
          await media.remove(object_key);
          await storageStep("postgres.cleanup_commit",()=>db.transaction(async tx=>{
            // A scan that already listed this key must finish before its charge disappears.
            await tx.query("SELECT id FROM chatcode_storage_lock WHERE id=3 FOR UPDATE");
            await lockBudget(tx);
            await tx.query("DELETE FROM chatcode_r2_discrepancies WHERE object_key=$1",[object_key]);
            await tx.query("DELETE FROM chatcode_object_cleanup WHERE object_key=$1 AND deleting",[object_key]);
          }));
        } catch {
          await query(db,"cleanup_defer",`UPDATE chatcode_object_cleanup SET due=now()+interval '5 minutes'
            WHERE object_key=$1`,[object_key]);
        }
      }
    } catch {console.error("Attachment cleanup deferred.");}
  }
  function cleanup() {
    cleaning ??= cleanObjects().finally(()=>{cleaning=undefined;});
    return cleaning;
  }
  let inventory=quota.refresh();
  const interval=setInterval(()=>{inventory=quota.refresh(); void cleanup();},60000).unref();
  void cleanup();

  // Mark the reservation as in flight in a short transaction, then write without holding a
  // database connection. Cleanup ignores rows whose upload lease is still active.
  async function writeReserved(key, bytes, once=false) {
    const state=await storageStep("postgres.upload_lease",()=>db.transaction(async tx=>{
      const held=await tx.query(`SELECT byte_count,deleting,due>clock_timestamp() AS active
        FROM chatcode_object_cleanup WHERE object_key=$1 FOR UPDATE`,[key]);
      if (!held.rows.length) return once ? "published" : "expired";
      const row=held.rows[0];
      if (row.deleting || !row.active) return "expired";
      if (row.byte_count!==bytes.length) return "expired";
      await tx.query(`UPDATE chatcode_object_cleanup
        SET uploading_until=clock_timestamp()+interval '10 minutes',
            due=clock_timestamp()+interval '10 minutes'
        WHERE object_key=$1`,[key]);
      return "reserved";
    }));
    if (state==="published") return; // A concurrent retry already published this create-only object.
    if (state==="expired") throw expiredReservation();
    if (once) await media.putOnce(key,bytes);
    else await media.put(key,bytes);
  }
  async function retrySoon(key, force=false) {
    // An ambiguous PUT/commit can be retried briefly. Cleanup still requires a confirmed DELETE.
    // If force=true (called from error handler), clear uploading_until to expedite cleanup.
    // Otherwise, respect the upload lease to avoid deleting an object still being written.
    const clause = force
      ? "NOT deleting"
      : "NOT deleting AND (uploading_until IS NULL OR uploading_until<=clock_timestamp())";
    await query(db,"retry_soon",`UPDATE chatcode_object_cleanup
      SET due=least(due,clock_timestamp()+interval '2 minutes'),
          uploading_until=CASE WHEN $2 THEN NULL ELSE uploading_until END
      WHERE object_key=$1 AND ${clause}`,[key,force]).catch(()=>console.error("Upload cleanup deferred."));
  }
  return {
    music: enableMusicStorage ? musicStorage({db, media, roomId, checkSpace, collectKeys, lockBudget,
      writeReserved, retrySoon, ready:quota.ready}) : undefined,
    report:quota.report, beginUpload:quota.beginUpload, endUpload:quota.endUpload,
    async close() {
      clearInterval(interval);
      await Promise.all([cleaning,inventory]);
      await db.close();
    },
    roomUsage: code=>quota.roomUsage(roomId(code)),
    async checkUploadSpace(code,size) {await quota.ready(); await checkSpace(db,roomId(code),size);},
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
      if (file) await quota.ready();
      if(objectKey){
        // The reservation survives a crash between PUT and the message commit.
        await storageStep("postgres.reserve_transaction",()=>db.transaction(async tx=>{
          await lockBudget(tx);
          if(file.objectKey){
            // A lost commit acknowledgement must never queue a published object for deletion.
            const reserved=await query(tx,"find_reservation","SELECT 1 FROM chatcode_object_cleanup WHERE object_key=$1 AND NOT deleting AND due>clock_timestamp()",[objectKey]);
            if(!reserved.rows.length)throw expiredReservation();
            return;
          }
          await checkSpace(tx,room,file.bytes.length);
          await query(tx,"insert_reservation",`INSERT INTO chatcode_object_cleanup(object_key,due,byte_count,room,kind)
            VALUES($1,now()+interval '1 hour',$2,$3,'attachment')`,[objectKey,file.bytes.length,room]);
        }));
        file.objectKey=objectKey;
        try {await writeReserved(objectKey,file.bytes);}
        catch (error) {await retrySoon(objectKey,true); throw error;}
      }
      await storageStep("postgres.publish_transaction",()=>db.transaction(async tx=>{
        // Serialize retention and storage-budget decisions in the same transaction.
        await lockBudget(tx);
        if(objectKey){
          const claimed=await query(tx,"claim_reservation","DELETE FROM chatcode_object_cleanup WHERE object_key=$1 AND NOT deleting AND due>clock_timestamp() RETURNING object_key",[objectKey]);
          if(!claimed.rows.length)throw expiredReservation();
        }
        if(file && !objectKey)await checkSpace(tx,room,file.bytes.length);
        await query(tx,"insert_message",`INSERT INTO chatcode_messages
          (room,message_id,client_id,payload,attachment_id,byte_count,ciphertext,object_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[
          room,event.id,clientId||null,JSON.stringify(event),file?.info.id||null,
          file?.bytes.length||0,file&&!objectKey?file.bytes:null,objectKey]);
        await trim(tx,room);
      })).catch(async error=>{if (objectKey) await retrySoon(objectKey,true); throw error;});
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
