import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, mkdir, rm, writeFile, readdir, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {promisify} from "node:util";
import pg from "pg";
import {PGlite} from "@electric-sql/pglite";
import {openStorage} from "../storage.js";
import {mediaStorage} from "../media-storage.js";

test("music storage migration and lifecycle", async t => {
  const directory = await mkdtemp(join(tmpdir(), "chatcode-music-"));
  const objects = join(directory, "objects");
  await mkdir(objects);
  const pgUrl = process.env.CHATCODE_TEST_DATABASE_URL || "";
  const schema = "music_test_" + randomUUID().replaceAll("-", "");
  const account = "a".repeat(32);
  Object.assign(process.env, {
    DATABASE_URL:pgUrl, PGHOST:"", PGOPTIONS:"", RENDER:"", NODE_ENV:"test",
    CHATCODE_DATA_DIR:join(directory,"db"), CHATCODE_TEST_OBJECT_DIR:objects,
    CHATCODE_STORAGE_BUDGET_BYTES:String(128*1024*1024),
    R2_ACCOUNT_ID:account, R2_ENDPOINT:"https://"+account+".r2.cloudflarestorage.com",
    R2_BUCKET_NAME:"test-r2", R2_ACCESS_KEY_ID:"r2-test", R2_SECRET_ACCESS_KEY:"fixture",
    S3_BUCKET:"test-legacy", S3_ENDPOINT:"https://legacy.invalid", AWS_REGION:"us-east-1",
    AWS_ACCESS_KEY_ID:"legacy-test", AWS_SECRET_ACCESS_KEY:"fixture", AWS_SESSION_TOKEN:""
  });
  await import("./mock-object-store.mjs");
  const media = mediaStorage();
  const admin = pgUrl ? new pg.Client({connectionString:pgUrl}) : null;
  if (admin) {
    await admin.connect();
    await admin.query("CREATE SCHEMA "+schema);
    process.env.PGOPTIONS = "-c search_path="+schema;
  }
  let store;
  async function close() {
    if (store) await store.close();
    store = undefined;
  }
  t.after(async () => {
    await close();
    if (admin) {
      await admin.query("DROP SCHEMA "+schema+" CASCADE");
      await admin.end();
    }
    await rm(directory,{recursive:true,force:true});
  });
  async function inspect(fn) {
    await close();
    const db = pgUrl ? new pg.Client({connectionString:pgUrl}) : new PGlite(process.env.CHATCODE_DATA_DIR);
    if (pgUrl) await db.connect();
    try { return await fn(db); }
    finally { if (pgUrl) await db.end(); else await db.close(); }
  }
  async function start(enableMusicStorage=true) {
    await close();
    store = await openStorage({enableMusicStorage});
  }
  const room = "music-room", other = "other-room";
  const roomHash = createHash("sha256").update(room).digest("hex");
  const legacyKey = "chatcode/"+randomUUID(), r2Key = media.newKey();
  const fixtures = [
    {type:"text/plain", key:null, bytes:Buffer.from("legacy DB envelope")},
    {type:"image/png", key:legacyKey, bytes:Buffer.from("legacy S3 envelope")},
    {type:"video/mp4", key:r2Key, bytes:Buffer.from("R2 video envelope")}
  ].map(f => ({...f, payload:{id:randomUUID(),attachment:{id:randomUUID(),type:f.type}}}));
  const olderCleanupKey = media.newKey();
  const track = {filename:"sample.mp3",sizeBytes:64,durationMs:91000};
  let handle, snapshot;

  await t.test("upgrade the pre-music schema with existing attachments and cleanup rows", async () => {
    await inspect(async db => {
      await db.query(`CREATE TABLE chatcode_messages (seq bigserial PRIMARY KEY, room text NOT NULL,
        message_id uuid NOT NULL UNIQUE, client_id uuid, payload jsonb NOT NULL, attachment_id uuid UNIQUE,
        byte_count integer NOT NULL DEFAULT 0, ciphertext bytea, object_key text, UNIQUE(room,client_id))`);
      await db.query("CREATE TABLE chatcode_object_cleanup(object_key text PRIMARY KEY, due timestamptz NOT NULL DEFAULT now())");
      await db.query("INSERT INTO chatcode_object_cleanup VALUES ($1, now()+interval '1 day')",[olderCleanupKey]);
      for (const {payload, key, bytes} of fixtures) {
        if (key) await media.put(key,bytes);
        await db.query(`INSERT INTO chatcode_messages(room,message_id,payload,attachment_id,byte_count,ciphertext,object_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [roomHash,payload.id,JSON.stringify(payload),payload.attachment.id,bytes.length,key?null:bytes,key]);
      }
    });
    await start(false);
    assert.equal(store.music,undefined);
    assert.deepEqual(await store.history(room),fixtures.map(f=>f.payload));
    for (const f of fixtures) assert.deepEqual(await store.readFile(room,f.payload.attachment.id),f.bytes);
    await inspect(async db => {
      const {rows} = await db.query("SELECT room,byte_count,music_upload_id FROM chatcode_object_cleanup WHERE object_key=$1",[olderCleanupKey]);
      assert.deepEqual(rows,[{room:null,byte_count:null,music_upload_id:null}]);
    });
    await start();
  });

  await t.test("claims encrypted bytes once, scopes publication to its room and hides object keys", async () => {
    const music = store.music;
    assert.equal((await music.snapshot(room)).revision,"0");
    for (const size of [0, 0.5, 10*1024*1024+1]) await assert.rejects(music.reserveTrack(room,size),/size/);
    handle = await music.reserveTrack(room,64);
    assert.match(handle.objectKey,/^chatcode\/r2\//);
    await media.put(handle.objectKey, Buffer.alloc(64+28,7));
    await assert.rejects(music.publishTrack(other,handle.trackId,track),/unavailable/);
    await assert.rejects(music.publishTrack(room,handle.trackId,{...track,filename:"../song.mp3"}),/filename/);
    await assert.rejects(music.publishTrack(room,handle.trackId,{...track,durationMs:0}),/duration/);
    await assert.rejects(music.publishTrack(room,handle.trackId,{...track,sizeBytes:63}),/differs/);
    assert.deepEqual(await Promise.all([music.publishTrack(room,handle.trackId,track),music.publishTrack(room,handle.trackId,track)]),["1","1"]);
    const state = await music.snapshot(room);
    assert.equal(state.tracks.length,1);
    assert.equal(state.tracks[0].size_bytes,64);
    assert.equal(state.tracks[0].mime_type,"audio/mpeg");
    assert.ok(!JSON.stringify(state).includes(handle.objectKey));
    assert.deepEqual((await music.snapshot(other)).tracks,[]);
  });

  await t.test("serialize competing edits, reorder and restrict all queue and player references to the room", async () => {
    const music=store.music, id=handle.trackId;
    const race=await Promise.allSettled([music.enqueue(room,"1",id),music.enqueue(room,"1",id)]);
    assert.deepEqual(race.filter(r=>r.status==="fulfilled").map(r=>r.value),["2"]);
    assert.match(race.find(r=>r.status==="rejected").reason.message,/revision/);
    await assert.rejects(music.enqueue(other,"0",id),{code:"23503"});
    assert.equal(await music.enqueue(room,"2",id),"3");
    const [a,b]=(await music.snapshot(room)).queue.map(e=>e.entry_id);
    await assert.rejects(music.reorder(room,"3",[b,b]),/order/);
    assert.equal(await music.reorder(room,"3",[b,a]),"4");
    assert.deepEqual((await music.snapshot(room)).queue.map(e=>e.entry_id),[b,a]);
    await assert.rejects(music.setPlayback(other,"0",{entryId:a,positionMs:0,playing:true}),/entry/);
    await assert.rejects(music.setPlayback(room,"4",{entryId:a,positionMs:91001,playing:true}),/position/);
    assert.equal(await music.setPlayback(room,"4",{entryId:a,positionMs:1050,playing:true}),"5");
    assert.equal(await music.removeEntry(room,"5",b),"6");
    assert.equal(await music.enqueue(room,"6",id),"7");
    snapshot=await music.snapshot(room);
    assert.equal(snapshot.current_entry,a);
    assert.equal(snapshot.position_ms,1050);
    assert.equal(snapshot.playing,true);
    assert.ok(snapshot.anchor_time);
    await assert.rejects(music.removeTrack(other,"0",id),/unavailable/);
  });

  await t.test("100-message pruning, Clear chat and reopening preserve the library, ordered queue and anchor", async () => {
    for (let i=0;i<101;i++) await store.save(room,{id:randomUUID(),message:"fixture"},null,null);
    assert.equal((await store.history(room)).length,100);
    assert.deepEqual(await store.music.snapshot(room),snapshot);
    await store.clear(room);
    await close();
    const {stdout}=await promisify(execFile)(process.execPath,["--import","./test/mock-object-store.mjs","--input-type=module","-e",`
      import {openStorage} from "./storage.js";
      const storage=await openStorage({enableMusicStorage:true});
      try { console.log(JSON.stringify(await storage.music.snapshot("music-room"))); }
      finally { await storage.close(); }
    `], {cwd:new URL("../",import.meta.url)});
    assert.deepEqual(JSON.parse(stdout),JSON.parse(JSON.stringify(snapshot)));
    await start();
    assert.deepEqual(await store.history(room),[]);
    assert.deepEqual(await store.music.snapshot(room),snapshot);
    assert.deepEqual(await media.get(handle.objectKey),Buffer.alloc(92,7));
  });

  await t.test("a deleted active track stays charged through an R2 cleanup failure and restart", async () => {
    process.env.CHATCODE_STORAGE_BUDGET_BYTES="92";
    await start();
    await assert.rejects(store.checkUploadSpace(other,1),/full/);
    await writeFile(join(objects,"offline"),"");
    await store.music.removeTrack(room,snapshot.revision,handle.trackId);
    const state=await store.music.snapshot(room);
    assert.deepEqual(state.tracks,[]);
    assert.deepEqual(state.queue,[]);
    assert.equal(state.current_entry,null);
    assert.equal(state.playing,false);
    assert.equal(state.anchor_time,null);
    assert.equal(state.revision,"8");
    await start();
    await close(); // await the startup cleanup attempt
    await inspect(async db => {
      const {rows}=await db.query("SELECT byte_count,due>now() AS retry FROM chatcode_object_cleanup WHERE object_key=$1",[handle.objectKey]);
      assert.deepEqual(rows,[{byte_count:92,retry:true}]);
    });
    await start();
    await assert.rejects(store.checkUploadSpace(other,1),/full/);
    await rm(join(objects,"offline"));
    await inspect(db=>db.query("UPDATE chatcode_object_cleanup SET due=now() WHERE object_key=$1",[handle.objectKey]));
    await start(false);
    await close();
    await start();
    await store.checkUploadSpace(other,92);
    assert.ok(!(await readdir(objects)).includes("r2-"+handle.objectKey.split("/").at(-1)));
  });

  await t.test("chat and music race for the same budget and abandoned reservations release bytes after expiry", async () => {
    const chatFile={info:{id:randomUUID()},bytes:Buffer.alloc(92)};
    const race=await Promise.allSettled([
      store.music.reserveTrack(room,64),
      store.save(other,{id:randomUUID(),attachment:chatFile.info},null,chatFile)
    ]);
    assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
    assert.match(race.find(r=>r.status==="rejected").reason.message,/full/);
    if (race[1].status==="fulfilled") {
      await store.clear(other);
      await start();
    }
    const r=race[0].status==="fulfilled"?race[0].value:await store.music.reserveTrack(room,64);
    await media.put(r.objectKey,Buffer.alloc(92));
    await assert.rejects(store.checkUploadSpace(other,1),/full/);
    await inspect(db=>db.query("UPDATE chatcode_object_cleanup SET due=now() WHERE music_upload_id=$1",[r.trackId]));
    await start();
    await assert.rejects(store.music.publishTrack(room,r.trackId,track),/unavailable/);
    await close();
    assert.ok(!(await readdir(objects)).includes("r2-"+r.objectKey.split("/").at(-1)));
    await start();
    await store.checkUploadSpace(room,92);
  });

  await t.test("10 MiB boundary and encrypted room quota apply to reservations alongside other rooms", async () => {
    process.env.CHATCODE_STORAGE_BUDGET_BYTES=String(128*1024*1024);
    await start();
    for (let i=0;i<3;i++) await store.music.reserveTrack(room,10*1024*1024);
    await assert.rejects(store.music.reserveTrack(room,10*1024*1024),/full/);
    await store.music.reserveTrack(other,10*1024*1024);
    await inspect(async db=>{
      const report=await readFile(new URL("../storage-usage.sql",import.meta.url),"utf8");
      for (const statement of report.split(";").filter(s=>s.trim())) await db.query(statement);
    });
  });
});
