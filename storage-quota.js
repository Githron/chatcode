import { createHash, randomUUID } from "node:crypto";
import { MediaConfigurationError } from "./media-storage.js";
import { storageStep } from "./storage-diagnostics.js";

const musicLimit = 1024 ** 3;
const attachmentLimit = 40 * 1024 ** 2;

function integerSetting(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new MediaConfigurationError(name + " must be a nonnegative integer.");
  return Number(value);
}

export const quotaMigration = `
  ALTER TABLE chatcode_object_cleanup ADD COLUMN IF NOT EXISTS kind text;
  ALTER TABLE chatcode_object_cleanup ADD COLUMN IF NOT EXISTS deleting boolean NOT NULL DEFAULT false;
  ALTER TABLE chatcode_object_cleanup ADD COLUMN IF NOT EXISTS uploading_until timestamptz;
  UPDATE chatcode_object_cleanup SET kind='music' WHERE music_upload_id IS NOT NULL AND kind IS NULL;
  INSERT INTO chatcode_storage_lock VALUES (2),(3) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS chatcode_upload_attempts (
    id uuid PRIMARY KEY, session_hash text NOT NULL, ip_hash text NOT NULL,
    started timestamptz NOT NULL DEFAULT clock_timestamp(), active_until timestamptz
  );
  CREATE TABLE IF NOT EXISTS chatcode_r2_discrepancies (object_key text PRIMARY KEY, bytes bigint NOT NULL);
  CREATE TABLE IF NOT EXISTS chatcode_r2_missing (
    object_key text PRIMARY KEY, bytes bigint NOT NULL, checked_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chatcode_r2_scan (
    id integer PRIMARY KEY, checked_at timestamptz NOT NULL, missing bigint NOT NULL
  );
  CREATE OR REPLACE VIEW chatcode_recorded_storage AS
    SELECT room,object_key,byte_count,'attachment'::text AS kind FROM chatcode_messages WHERE byte_count>0
    UNION ALL SELECT room,object_key,byte_count,'music' FROM chatcode_music_tracks
    UNION ALL SELECT room,object_key,byte_count,kind FROM chatcode_object_cleanup;
  CREATE OR REPLACE VIEW chatcode_storage_charges AS
    SELECT room,object_key,greatest(byte_count,d.bytes,0) AS bytes,kind
    FROM chatcode_recorded_storage FULL JOIN chatcode_r2_discrepancies d USING(object_key);
`;

export function storageQuota(db, media, lockBudget) {
  const limit = integerSetting("CHATCODE_STORAGE_BUDGET_BYTES", media.hasR2 ? 7 * 1024 ** 3 : 128 * 1024 ** 2);
  const sessionRate = integerSetting("CHATCODE_UPLOADS_PER_SESSION_MINUTE", 12);
  const ipRate = integerSetting("CHATCODE_UPLOADS_PER_IP_MINUTE", 60);
  const ipConcurrent = integerSetting("CHATCODE_CONCURRENT_UPLOADS_PER_IP", 4);
  const globalFilter = media.hasR2 ? "object_key LIKE 'chatcode/r2/%'" : "true";
  let scan, lastScan = 0, nextScan = 0;

  async function reconcile() {
    // Stage every page before replacing the last complete inventory. Uploads can continue during LIST.
    await storageStep("postgres.reconcile",()=>db.transaction(async tx => {
      await tx.query("SELECT id FROM chatcode_storage_lock WHERE id=3 FOR UPDATE");
      await tx.query("CREATE TEMP TABLE scanned_objects (object_key text PRIMARY KEY, bytes bigint NOT NULL) ON COMMIT DROP");
      const deadline=Date.now()+5*60_000;
      for await (const page of media.inventory()) {
        if (Date.now()>deadline) throw new Error("Storage inventory timed out.");
        await tx.query("INSERT INTO scanned_objects SELECT * FROM unnest($1::text[],$2::bigint[])",
          [page.map(o=>o.Key),page.map(o=>o.Size)]);
      }
      await lockBudget(tx);
      await tx.query("DELETE FROM chatcode_r2_discrepancies");
      await tx.query(`INSERT INTO chatcode_r2_discrepancies
        SELECT s.object_key,s.bytes FROM scanned_objects s LEFT JOIN chatcode_recorded_storage r USING(object_key)
        WHERE r.object_key IS NULL OR s.bytes IS DISTINCT FROM r.byte_count`);
      await tx.query("DELETE FROM chatcode_r2_missing");
      await tx.query(`INSERT INTO chatcode_r2_missing(object_key,bytes,checked_at)
        SELECT p.object_key,max(p.byte_count)::bigint,clock_timestamp() FROM (
          SELECT object_key,byte_count FROM chatcode_music_tracks UNION ALL
          SELECT object_key,byte_count FROM chatcode_messages WHERE object_key LIKE 'chatcode/r2/%'
        ) p LEFT JOIN scanned_objects s USING(object_key)
        WHERE s.object_key IS NULL GROUP BY p.object_key`);
      await tx.query(`INSERT INTO chatcode_r2_scan SELECT 1,clock_timestamp(),count(*) FROM chatcode_r2_missing
        ON CONFLICT (id) DO UPDATE SET checked_at=excluded.checked_at,missing=excluded.missing`);
    }));
  }

  function refresh() {
    if (!media.hasR2 || Date.now()<nextScan) return scan;
    scan ??= reconcile().then(()=>{
      lastScan=Date.now();
      nextScan=lastScan+3600000;
    },()=>{
      lastScan=0;
      nextScan=Date.now()+60000;
      console.error("R2 inventory unavailable. New uploads paused until the next inventory.");
    }).finally(()=>{scan=undefined;});
    return scan;
  }

  function warning(used, cap) {
    if (cap<=0) return used>0 ? 95 : null;
    if (used >= cap * 0.95) return 95;
    if (used >= cap * 0.8) return 80;
    return null;
  }
  function inventoryReady() {
    return !media.hasR2 || lastScan>0 && Date.now()-lastScan<=3660000;
  }
  async function roomUsage(tx, room, kind) {
    const {rows} = await storageStep("postgres.check_room_budget",()=>tx.query(`SELECT sum(bytes) AS used FROM chatcode_storage_charges
      WHERE room=$1 AND (kind=$2 OR kind IS NULL)`,[room,kind]));
    return {used:Number(rows[0].used),limit:kind==="music" ? musicLimit : attachmentLimit};
  }
  return {
    refresh,
    ready:()=>inventoryReady() ? undefined : scan,
    async checkSpace(tx, room, bytes, kind="attachment") {
      if (!inventoryReady())
        throw new Error("Storage inventory unavailable.");
      const {rows} = await storageStep("postgres.check_budget",()=>tx.query("SELECT sum(bytes) AS used FROM chatcode_storage_charges WHERE "+globalFilter));
      const local = await roomUsage(tx,room,kind);
      const message = Number(rows[0].used)+bytes>limit ? "Global storage is full. You can still send text."
        : local.used+bytes>local.limit ? "Room "+kind+" storage is full. You can still send text." : null;
      if (message) throw Object.assign(new Error(message),{publicMessage:message});
    },
    roomUsage: room=>roomUsage(db,room,"music"),
    async report() {
      return storageStep("postgres.storage_report",()=>db.transaction(async tx=>{
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const total=await tx.query("SELECT sum(bytes) AS used FROM chatcode_storage_charges WHERE "+globalFilter);
        const used=Number(total.rows[0].used);
        const rooms=await tx.query(`SELECT room,sum(bytes) AS used FROM chatcode_storage_charges
          WHERE room IS NOT NULL AND (kind='music' OR kind IS NULL) GROUP BY room ORDER BY room`);
        const inventory=await tx.query(`SELECT checked_at,missing::text,
          (SELECT count(*) FROM chatcode_r2_discrepancies) AS discrepancies FROM chatcode_r2_scan WHERE id=1`);
        const missing=await tx.query("SELECT object_key,bytes::text FROM chatcode_r2_missing ORDER BY object_key LIMIT 20");
        const unknown=await tx.query("SELECT count(*)::text AS entries FROM chatcode_object_cleanup WHERE byte_count IS NULL");
        const stripPrefix = (key) => key.replace(/^chatcode\/r2\//, "");
        return {global:{used,limit,remaining:Math.max(0,limit-used),warning:warning(used,limit)},
          inventory:inventory.rows[0] ? {...inventory.rows[0],missingKeys:missing.rows.map(r=>({object_key:stripPrefix(r.object_key),bytes:r.bytes}))} : null,
          inventoryReady:inventoryReady(),
          unknownSize:{cleanupEntries:Number(unknown.rows[0].entries),bytes:null},
          rooms:rooms.rows.map(r=>({room:r.room,used:Number(r.used),limit:musicLimit,warning:warning(Number(r.used),musicLimit)}))};
      }));
    },
    async beginUpload(token, ip, countAttempt=true) {
      const hash=value=>createHash("sha256").update(value).digest("hex");
      const session=hash(token), address=hash(ip), id=randomUUID();
      return storageStep("postgres.begin_upload",()=>db.transaction(async tx=>{
        await tx.query("SELECT id FROM chatcode_storage_lock WHERE id=2 FOR UPDATE");
        await tx.query(`DELETE FROM chatcode_upload_attempts WHERE started<=clock_timestamp()-interval '1 minute'
          AND (active_until IS NULL OR active_until<=clock_timestamp())`);
        const {rows:[r]}=await tx.query(`SELECT
          count(*) FILTER (WHERE recent) AS total, count(*) FILTER (WHERE recent AND session_hash=$1) AS session_rate,
          count(*) FILTER (WHERE recent AND ip_hash=$2) AS ip_rate, count(*) FILTER (WHERE active) AS concurrent,
          count(*) FILTER (WHERE active AND session_hash=$1) AS session_active,
          count(*) FILTER (WHERE active AND ip_hash=$2) AS ip_active FROM
          (SELECT *,started>clock_timestamp()-interval '1 minute' AS recent,
            active_until>clock_timestamp() AS active FROM chatcode_upload_attempts) attempts`,[session,address]);
        if (Number(r.concurrent)>=4 || Number(r.session_active)>0 || Number(r.ip_active)>=ipConcurrent ||
            countAttempt && (Number(r.total)>=120 || Number(r.session_rate)>=sessionRate || Number(r.ip_rate)>=ipRate))
          return null;
        await tx.query(`INSERT INTO chatcode_upload_attempts(id,session_hash,ip_hash,started,active_until)
          VALUES ($1,$2,$3,CASE WHEN $4 THEN clock_timestamp() ELSE '-infinity'::timestamptz END,
            clock_timestamp()+interval '5 minutes')`,[id,session,address,countAttempt]);
        return id;
      }));
    },
    endUpload: id=>storageStep("postgres.end_upload",()=>db.query("UPDATE chatcode_upload_attempts SET active_until=NULL WHERE id=$1",[id]))
  };
}
