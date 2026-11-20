import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import pg from "pg";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const MiB = 1024 * 1024;
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
      transaction:async fn=>{
        const client=await pool.connect();
        try {
          await client.query("BEGIN");
          const result=await fn(client);
          await client.query("COMMIT");
          return result;
        } catch(error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {client.release();}
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

export async function openStorage() {
  const db = await database();
  await db.exec(sql);
  const bucket=process.env.S3_BUCKET;
  const s3=bucket ? new S3Client({
    region:process.env.AWS_REGION || "us-east-1",
    endpoint:process.env.S3_ENDPOINT || undefined,
    forcePathStyle:!!process.env.S3_ENDPOINT,
    maxAttempts:2,
  }) : null;
  const locator=key=>({Bucket:bucket, Key:key});
  function collectKeys(tx, rows) {
    const keys=rows.map(row=>row.object_key).filter(Boolean);
    if (keys.length) return tx.query("INSERT INTO chatcode_object_cleanup(object_key) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",[keys]);
  }
  async function trim(tx,room) {
    const deleted=await tx.query(`DELETE FROM chatcode_messages WHERE room=$1 AND seq IN
      (SELECT seq FROM chatcode_messages WHERE room=$1 ORDER BY seq DESC OFFSET 100) RETURNING object_key`,[room]);
    await collectKeys(tx,deleted.rows);
  }
  let cleaning=false;
  async function cleanup() {
    if (!s3 || cleaning) return;
    cleaning=true;
    try {
      const {rows}=await db.query("SELECT object_key FROM chatcode_object_cleanup WHERE due <= now() ORDER BY due LIMIT 50");
      for(const {object_key} of rows) {
        try {
          await s3.send(new DeleteObjectCommand(locator(object_key)),{abortSignal:AbortSignal.timeout(15000)});
          await db.query("DELETE FROM chatcode_object_cleanup WHERE object_key=$1",[object_key]);
        } catch {
          await db.query("UPDATE chatcode_object_cleanup SET due=now()+interval '5 minutes' WHERE object_key=$1",[object_key]);
        }
      }
    } catch {console.error("Attachment cleanup deferred.");}
    finally {cleaning=false;}
  }
  setInterval(cleanup,60000).unref();
  void cleanup();

  return {
    async history(code) {
      const {rows}=await db.query("SELECT payload FROM chatcode_messages WHERE room=$1 ORDER BY seq",[roomId(code)]);
      return rows.map(r=>r.payload);
    },
    async receipt(code,clientId) {
      if(!clientId)return null;
      const {rows}=await db.query("SELECT message_id FROM chatcode_messages WHERE room=$1 AND client_id=$2",[roomId(code),clientId]);
      return rows[0]?.message_id;
    },
    async save(code,event,clientId,file) {
      const room=roomId(code);
      let objectKey=null;
      if(s3 && file){
        objectKey="chatcode/"+randomUUID();
        // The reservation survives a crash between PUT and the message commit.
        await db.query("INSERT INTO chatcode_object_cleanup(object_key,due) VALUES($1,now()+interval '1 hour')",[objectKey]);
        await s3.send(new PutObjectCommand({...locator(objectKey),Body:file.bytes,ContentType:"application/octet-stream"}),{abortSignal:AbortSignal.timeout(45000)});
      }
      await db.transaction(async tx=>{
        // Serialize retention and storage-budget decisions in the same transaction.
        await tx.query("SELECT id FROM chatcode_storage_lock WHERE id=1 FOR UPDATE");
        await tx.query(`INSERT INTO chatcode_messages
          (room,message_id,client_id,payload,attachment_id,byte_count,ciphertext,object_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[
          room,event.id,clientId||null,JSON.stringify(event),file?.info.id||null,
          file?.bytes.length||0,file&&!objectKey?file.bytes:null,objectKey]);
        await trim(tx,room);
        if(file){
          const {rows}=await tx.query(`SELECT sum(byte_count) AS total,
            sum(byte_count) FILTER(WHERE room=$1) AS local FROM chatcode_messages WHERE byte_count>0`,[room]);
          if(Number(rows[0].local)>40*MiB || Number(rows[0].total)>128*MiB){
            const error=new Error("File storage is full. Send text or clear files before retrying.");
            error.publicMessage=error.message;
            throw error;
          }
        }
        if(objectKey)await tx.query("DELETE FROM chatcode_object_cleanup WHERE object_key=$1",[objectKey]);
      });
    },
    async readFile(code,id) {
      const {rows}=await db.query("SELECT ciphertext,object_key FROM chatcode_messages WHERE room=$1 AND attachment_id=$2",[roomId(code),id]);
      if(!rows.length)return null;
      if(!rows[0].object_key)return Buffer.from(rows[0].ciphertext);
      if(!s3)throw new Error("Private object storage unavailable.");
      const object=await s3.send(new GetObjectCommand(locator(rows[0].object_key)),{abortSignal:AbortSignal.timeout(30000)});
      return Buffer.from(await object.Body.transformToByteArray());
    },
    async clear(code) {
      await db.transaction(async tx=>{
        await tx.query("SELECT id FROM chatcode_storage_lock WHERE id=1 FOR UPDATE");
        const deleted=await tx.query("DELETE FROM chatcode_messages WHERE room=$1 RETURNING object_key",[roomId(code)]);
        await collectKeys(tx,deleted.rows);
      });
      void cleanup();
    }
  };
}
