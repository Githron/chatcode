import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { webcrypto, randomUUID } from "node:crypto";
import test from "node:test";
import {mkdtemp, rm, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join as pathJoin} from "node:path";
import { io } from "socket.io-client";
import { roomKey, encodeText, decodeText, seal, unseal, fileLimit } from "./public/transfer.js";
import { mediaStorage } from "./media-storage.js";
import { storageStep } from "./storage-diagnostics.js";
import { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import {validateVideo} from "./video-container.js";
import {mp3Duration} from "./mp3.js";

const mp4=await readFile(new URL("./test/fixtures/clip.mp4",import.meta.url));
const webm=await readFile(new URL("./test/fixtures/clip.webm",import.meta.url));
const mp3=await readFile(new URL("./test/fixtures/tone.mp3",import.meta.url));
const mono=await readFile(new URL("./test/fixtures/mono.mp3",import.meta.url));

test("MP3 duration is measured from bounded Layer III frames, including VBR and metadata",()=>{
  assert.equal(mp3Duration(mp3),350);
  assert.ok(mp3Duration(mono)>=250 && mp3Duration(mono)<350);
  const xing=mp3.indexOf("Xing");
  assert.ok(xing>0);
  const badCount=Buffer.from(mp3);
  badCount.writeUInt32BE(1,xing+8);
  const badSide=Buffer.from(mp3);
  badSide.fill(255,xing-32,xing);
  const badTag=Buffer.from(mp3);
  badTag[6]=0xff;
  const truncatedFrame=mp3.subarray(0,mp3.length-1);
  for (const bytes of [badCount,badSide,badTag,truncatedFrame,mp3.subarray(0,xing-36),
    Buffer.concat([mp3,Buffer.from("junk")]),Buffer.alloc(fileLimit+1),webm,mp4])
    assert.throws(()=>mp3Duration(bytes),/MP3/);
});

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const room = "test-"+randomUUID().slice(0,12);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AFcAAAAASUVORK5CYII=","base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==","base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==","base64");
const webp = Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=","base64");
const docx = Buffer.from("UEsDBBQAAAAIAJO4dF2sbhJangAAANwAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2PsQ7CMBBDf6XKitqrGBhQ24UdGPiBU3JtI5pLlBwF/p4EpA6Mlu1nubu9A6Xq5RZOvZpFwhEg6ZkcpsYH4uyMPjqULOMEAfUdJ4J92x5AexZiqaUw1NBdVorRGqquGOWMjnoFTx8NGK8fLiebTFPV6Vcry73CEBarUaxnWNn8bdZ+HK2mrV9oIXpNKVme3NJsjkPLu4KHoYPvqeEDUEsDBBQAAAAIAJO4dF1hey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pYGKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E12WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQUAAAACACTuHRdyUDSwnYAAACcAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRc7BDcIwDAXQVaoOgCsOHKKQIdggJKGtVNuRbZSyPU05cHlfX5al75vLnN5YyIYdN1LX7uNiVh2ApqVg1AvXQsftxYLRjiozNJZchVNRXWnGDa7TdAOMK43BN/fk/OlZO9Kx8GDGgdiKeui9K6f19PcD/z3hC1BLAQIUAxQAAAAIAJO4dF2sbhJangAAANwAAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAk7h0XWF7L0OJAAAA8gAAAAsAAAAAAAAAAAAAAIABzwAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAk7h0XclA0sJ2AAAAnAAAABEAAAAAAAAAAAAAAIABgQEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAACYCAAAAAA==","base64");

function next(socket,event,accept=()=>true) {
  return new Promise((resolve,reject)=>{
    const onData = data => {
      if (!accept(data)) return;
      socket.off(event,onData); clearTimeout(timer); resolve(data);
    };
    const timer=setTimeout(()=>{ socket.off(event,onData); reject(new Error("Timed out waiting for "+event)); },3500);
    socket.on(event,onData);
  });
}
function request(socket,event,data) {
  return socket.timeout(3500).emitWithAck(event,data);
}

test("video validation requires bounded containers, a video track and media data",()=>{
  function replace(bytes,from,to){
    const result=Buffer.from(bytes), pos=result.indexOf(from);
    assert.ok(pos>=0);
    Buffer.from(to).copy(result,pos);
    return result;
  }
  validateVideo(mp4,"mp4");validateVideo(webm,"webm");
  const shortMedia=Buffer.from(mp4.subarray(0,mp4.indexOf("mdat")+5));
  shortMedia.writeUInt32BE(9,shortMedia.indexOf("mdat")-4);
  for(const bytes of [webm,mp4.subarray(0,24),mp4.subarray(0,-1),replace(mp4,"vide","soun"),
    shortMedia,replace(mp4,"mdat","free"),replace(mp4,"stsd","free"),Buffer.from("0000000166747970ffffffffffffffff","hex")])
    assert.throws(()=>validateVideo(bytes,"mp4"));
  for(const bytes of [mp4,webm.subarray(0,36),webm.subarray(0,-1),replace(webm,"webm","xxxx"),
    replace(webm,"V_VP8","A_OPU"),replace(webm,Buffer.from("1f43b675","hex"),Buffer.from("1c53bb6b","hex")),
    Buffer.from("1a45dfa3801853806700","hex")])
    assert.throws(()=>validateVideo(bytes,"webm"));
});

test("media configuration fails closed and allows an explicit database fallback",()=>{
  assert.throws(()=>mediaStorage({}),/Configure R2/);
  assert.throws(()=>mediaStorage({R2_ACCOUNT_ID:"partial",CHATCODE_MEDIA_BACKEND:"database"}),/all five/);
  assert.equal(mediaStorage({CHATCODE_MEDIA_BACKEND:"database"}).newKey(),null);
});

test("R2 uses the validated values for signing and addressing the bucket",async t=>{
  t.mock.method(S3Client.prototype,"send",async function(command){
    const credentials=await this.config.credentials();
    assert.equal(credentials.accessKeyId,"fixture-id");
    assert.equal(credentials.secretAccessKey,"fixture-secret");
    assert.equal(command.input.Bucket,"test-media");
    assert.match(command.input.Key,/^chatcode\/r2\//);
    assert.equal((await this.config.endpoint()).hostname,account+".r2.cloudflarestorage.com");
  });
  const account="a".repeat(32);
  const media=mediaStorage({R2_ACCOUNT_ID:account+" ",R2_ENDPOINT:" https://"+account+".r2.cloudflarestorage.com/\n",
    R2_BUCKET_NAME:" test-media ",R2_ACCESS_KEY_ID:"fixture-id\n",R2_SECRET_ACCESS_KEY:" fixture-secret\r\n"});
  await media.put(media.newKey(),Buffer.alloc(32));
});

test("storage failures report only the failing step and safe diagnostic fields",async t=>{
  const log=t.mock.method(console,"error",()=>{});
  const sqlError=Object.assign(new Error("private filename"),{code:"42501",detail:"private row contents"});
  const fail=()=>{throw sqlError;};
  await assert.rejects(storageStep("postgres.reserve_transaction",()=>storageStep("postgres.insert_reservation",fail)),err=>err===sqlError);
  const unknown=Object.assign(new Error("private response body"),{name:"private-room",code:"secret-token",$metadata:{httpStatusCode:502}});
  await assert.rejects(storageStep("r2.PutObject",()=>{throw unknown;}),err=>err===unknown);
  assert.deepEqual(log.mock.calls.map(call=>call.arguments),[
    [JSON.stringify({event:"storage_failure",operation:"postgres.insert_reservation",sqlstate:"42501"})],
    [JSON.stringify({event:"storage_failure",operation:"r2.PutObject",code:"unknown",httpStatus:502})],
  ]);
});

test("two-client room and private attachment transfers", {timeout:process.env.CHATCODE_TEST_WEBDRIVER ? 360000 : 210000}, async t=>{
  const directory=await mkdtemp(pathJoin(tmpdir(),"chatcode-db-"));
  const objects=pathJoin(directory,"objects");
  await mkdir(objects);
  const account="a".repeat(32);
  let backend="database",budget=128*1024*1024,pgOptions="",musicEnabled=false,queueEnabled=false,playbackEnabled=false;
  let stderr="";
  const start=(port=0)=>{
    const child=spawn(process.execPath,["--import","./test/mock-object-store.mjs","server.js"],{
    cwd:new URL("./",import.meta.url),env:{...process.env,DATABASE_URL:process.env.CHATCODE_TEST_DATABASE_URL||"",
      PGHOST:"",PGOPTIONS:pgOptions,RENDER:"",NODE_ENV:"test",CHATCODE_MEDIA_BACKEND:"database",CHATCODE_STORAGE_BUDGET_BYTES:String(budget),
      S3_BUCKET:backend==="database"?"":"test-legacy",S3_ENDPOINT:"https://legacy.invalid",AWS_REGION:"us-east-1",
      AWS_ACCESS_KEY_ID:"legacy-test",AWS_SECRET_ACCESS_KEY:"fixture",AWS_SESSION_TOKEN:"",
      R2_ACCOUNT_ID:backend==="r2"?account:"",R2_ENDPOINT:backend==="r2"?"https://"+account+".r2.cloudflarestorage.com":"",
      R2_BUCKET_NAME:backend==="r2"?"test-r2":"",R2_ACCESS_KEY_ID:backend==="r2"?"r2-test":"",R2_SECRET_ACCESS_KEY:backend==="r2"?"fixture":"",
      CHATCODE_MUSIC_UPLOADS:musicEnabled?"1":"",CHATCODE_MUSIC_QUEUE:queueEnabled?"1":"",CHATCODE_MUSIC_PLAYBACK:playbackEnabled?"1":"",
      CHATCODE_TEST_OBJECT_DIR:objects,CHATCODE_DATA_DIR:pathJoin(directory,"db"),PORT:String(port)},stdio:["ignore","pipe","pipe"]});
    child.stderr.on("data",chunk=>{stderr+=chunk;process.stderr.write(chunk);});
    return child;
  };
  let server=start();
  const clients=[];
  t.after(async()=>{
    clients.forEach(c=>c.disconnect());
    if(server.exitCode===null && !server.signalCode){const ended=once(server,"exit");server.kill();await ended;}
    await rm(directory,{recursive:true,force:true});
  });
  async function address(){
  const [line]=await Promise.race([once(server.stdout,"data"),once(server,"exit").then(()=>{throw Error("Test server stopped");})]);
  const port=/port (\d+)/.exec(String(line))?.[1];
  assert.ok(port,"server published its listening port");
  return "http://127.0.0.1:"+port;
  }
  let url=await address();
  await t.test("only the script-free media frames can load Blob media",async()=>{
    const chat=await fetch(url),frame=await fetch(url+"/video-player.html");
    assert.equal(frame.status,200);
    assert.match(chat.headers.get("content-security-policy"),/frame-ancestors 'none'/);
    assert.doesNotMatch(chat.headers.get("content-security-policy"),/media-src/);
    const policy=frame.headers.get("content-security-policy");
    for(const directive of ["default-src 'none'","media-src blob:","frame-ancestors 'self'","sandbox allow-same-origin"])
      assert.ok(policy.split("; ").includes(directive));
    const audioFrame=await fetch(url+"/audio-player.html");
    assert.equal(audioFrame.headers.get("content-security-policy"),policy);
    const audioMarkup=await audioFrame.text();
    assert.match(audioMarkup,/<audio /);
    assert.doesNotMatch(audioMarkup,/<script|<source|\s(?:autoplay|src)=/i);
    const markup=await frame.text();
    assert.match(markup,/<video controls playsinline preload="none"/);
    assert.doesNotMatch(markup,/<script|<source|\s(?:autoplay|src)=/i);
  });
  async function restart(port=0,whileStopped){
    const ended=once(server,"exit");server.kill();await ended;
    if (whileStopped) await whileStopped();
    server=start(port);url=await address();
  }
  const connect=async()=>{
    const client=io(url,{autoConnect:false,reconnection:false});
    clients.push(client);
    const ready=next(client,"connect");client.connect();await ready;return client;
  };
  const alice=await connect(),bob=await connect(),other=await connect();
  const join=(s,name,code)=>request(s,"join_room",{username:name,room:code});
  const a=await join(alice,"Alice",room);
  const membership=next(alice,"members_update");
  const b=await join(bob,"Bob",room);
  assert.deepEqual((await membership).members.map(m=>m.username),["Alice","Bob"]);
  assert.equal((await join(other,"Casey","bad code")).ok,false);
  const outsider=await join(other,"Casey","another-room");
  assert.ok(a.ok&&b.ok&&outsider.ok);
  const key=await roomKey(room);
  const auth=token=>({Authorization:"Bearer "+token});
  async function upload(name,data,token=a.token){
    return fetch(url+"/api/files",{method:"POST",headers:{...auth(token),"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(name)},body:await seal(key,data)});
  }
  const download=(id,token)=>fetch(url+"/api/files/"+id,{headers:auth(token)});
  async function publish(id){
    const recv=next(bob,"receive_message");
    const payload={room,clientId:randomUUID(),message:"",attachmentId:id};
    let sent=await request(alice,"send_message",payload);
    if(sent.error==="Please wait a moment before sending again."){
      await new Promise(resolve=>setTimeout(resolve,1050));
      sent=await request(alice,"send_message",payload);
    }
    assert.ok(sent.ok);return recv;
  }
  await t.test("encrypted 500-character text, retry, reply and typing",async()=>{
    const plain="界".repeat(500),message=await encodeText(key,plain),clientId=randomUUID();
    const incoming=next(bob,"receive_message");
    const payload={room,message,clientId};
    const sent=await request(alice,"send_message",payload);
    assert.ok(sent.ok);assert.equal(await decodeText(key,(await incoming).message),plain);
    assert.deepEqual(await request(alice,"send_message",payload),sent);
    const answer=next(alice,"receive_message");
    await request(bob,"send_message",{room,message:await encodeText(key,"Reply"),reply:{username:"Alice",message:await encodeText(key,"Excerpt")}});
    assert.equal(await decodeText(key,(await answer).reply.message),"Excerpt");
    const typing=next(alice,"user_typing");bob.emit("typing_start",{room});assert.equal((await typing).username,"Bob");
  });
  let last;
  await t.test("JPEG and WebP metadata and session upload throttling",async()=>{
    for(const [name,data,type] of [["small.jpg",jpeg,"image/jpeg"],["small.webp",webp,"image/webp"]]){
      const response=await upload(name,data,b.token);
      assert.equal(response.status,201);
      const {width,height,type:mime}=await response.json();
      assert.deepEqual([width,height,mime],[2,1,type]);
    }
    for(let i=2;i<12;i++)assert.equal((await upload("small.png",png,b.token)).status,201);
    const limited=await upload("small.png",png,b.token);
    assert.equal(limited.status,429);
    assert.equal(limited.headers.get("retry-after"),"60");
  });
  for(const [name,data] of [["sample.png",png],["notes.pdf",Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n")],["notes.docx",docx],["notes.txt",Buffer.from("Meeting notes")],["still.gif",gif],["files.zip",docx],["clip.mp4",mp4],["clip.webm",webm]]){
    await t.test("upload, publish and byte-for-byte download of "+name,async()=>{
      const uploaded=await upload(name,data);assert.equal(uploaded.status,201);
      const f=await uploaded.json();assert.equal(f.name,name);
      assert.equal((await download(f.id,b.token)).status,404);
      const incoming=await publish(f.id);assert.equal(incoming.attachment.size,data.length);
      const fetched=await download(f.id,b.token);assert.equal(fetched.status,200);
      const cipher=new Uint8Array(await fetched.arrayBuffer());
      assert.deepEqual(Buffer.from(await unseal(key,cipher)),data);
      assert.equal((await download(f.id,outsider.token)).status,404);
      assert.equal((await download(f.id,"")).status,401);
      last=f.id;
    });
  }
  await t.test("video upload rejects mislabeled bytes and enforces the plaintext 10 MiB boundary",async()=>{
    const tester=await connect(), member=await join(tester,"Tester",room);
    assert.equal((await upload("clip.webm",webm,"")).status,401);
    assert.equal((await upload("clip.mp4",webm,member.token)).status,415);
    assert.equal((await upload("clip.webm",webm.subarray(0,24),member.token)).status,415);
    const free=Buffer.alloc(fileLimit-mp4.length);
    free.writeUInt32BE(free.length);free.write("free",4);
    const limit=await upload("limit.mp4",Buffer.concat([mp4,free]),member.token);
    assert.equal(limit.status,201);
    const attachmentId=(await limit.json()).id;
    assert.equal((await request(other,"send_message",{room:"another-room",attachmentId})).ok,false);
    assert.equal((await upload("large.webm",Buffer.alloc(fileLimit+1),member.token)).status,413);
    tester.disconnect();
  });
  await t.test("validation, room clear and revoked access",async()=>{
    assert.equal((await upload("wrong.png",Buffer.from("This is text"))).status,415);
    assert.equal((await upload("wrong.gif",png)).status,415);
    assert.equal((await upload("../file.png",png)).status,415);
    assert.equal((await upload("oversize.png",Buffer.alloc(8_000_001))).status,413);
    assert.equal((await upload("wrong.zip",png)).status,415);
    assert.equal((await upload("active.svg",Buffer.from("<svg/>"))).status,415);
    assert.equal((await upload("ordinary.docx",Buffer.from("This is text"))).status,415);
    assert.equal((await upload("empty.txt",Buffer.alloc(0))).status,413);
    assert.equal((await upload("large.txt",Buffer.alloc(fileLimit+1,65))).status,413);
    assert.equal((await request(other,"clear_chat",{room})).ok,false);
    assert.equal((await request(alice,"clear_chat",{room})).ok,false);
    const cleared=next(bob,"chat_cleared");await request(alice,"clear_chat",{room,confirm:true});assert.equal((await cleared).clearedBy,"Alice");
    assert.equal((await download(last,b.token)).status,404);
    const left=next(bob,"user_left");alice.disconnect();assert.match((await left).message,/Alice/);
    assert.equal((await download(last,a.token)).status,401);
  });
  const code="history-"+randomUUID().slice(0,8);
  const historyKey=await roomKey(code);
  const postFile=async(token,name="record.png",bytes=png)=>fetch(url+"/api/files",{method:"POST",
    headers:{...auth(token),"Content-Type":"application/octet-stream","X-File-Name":name},body:await seal(historyKey,bytes)});
  let fileId,legacyId;
  await t.test("100-message snapshot, replay, prune, room isolation and process restart",async()=>{
    const identity=randomUUID();
    const author=await connect();
    const membership=await request(author,"join_room",{username:"Author",room:code,identity});
    assert.deepEqual(membership.history,[]);
    const receiver=await connect();
    await join(receiver,"Reader",code);
    async function attach(){
      const r=await fetch(url+"/api/files",{method:"POST",headers:{...auth(membership.token),"Content-Type":"application/octet-stream","X-File-Name":"record.png"},body:await seal(historyKey,png)});
      assert.equal(r.status,201);
      return (await r.json()).id;
    }
    const oldestFile=await attach();
    assert.ok((await request(author,"send_message",{room:code,attachmentId:oldestFile})).ok);
    const ids=[];
    for(let group=0;group<20;group++){
      const writer=await connect();
      await join(writer,"Writer",code);
      for(let n=0;n<5;n++){
        const pending=next(receiver,"receive_message");
        const result=await request(writer,"send_message",{room:code,message:await encodeText(historyKey,"Entry "+(group*5+n))});
        assert.ok(result.ok);assert.equal((await pending).id,result.id);ids.push(result.id);
      }
      writer.disconnect();
    }
    assert.equal((await download(oldestFile,membership.token)).status,404);
    fileId=await attach();
    const clientId=randomUUID();
    const late=await connect(),arrivals=[];
    late.on("receive_message",m=>arrivals.push(m.id));
    const joining=join(late,"Late",code);
    const payload={room:code,attachmentId:fileId,clientId,reply:{id:ids.at(-1),username:"Writer",message:await encodeText(historyKey,"Entry 99")}};
    const sent=await request(author,"send_message",payload);
    assert.ok(sent.ok);
    const snapshot=(await joining).history;
    // A join racing a send sees it in exactly one of snapshot or live stream.
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal([...snapshot.map(m=>m.id),...arrivals].filter(id=>id===sent.id).length,1);
    author.disconnect();receiver.disconnect();late.disconnect();
    const again=await connect();
    const back=await request(again,"join_room",{room:code,username:"Author",identity});
    assert.equal(back.authorId,membership.authorId);
    const expected=[...ids.slice(1),sent.id];
    assert.deepEqual(back.history.map(m=>m.id),expected);
    assert.equal(back.history.at(-1).reply.id,ids.at(-1));
    assert.equal(back.history.at(-1).attachment.type,"image/png");
    assert.ok(back.history.every(m=>m.username && Number.isFinite(m.sentAt)));
    assert.equal((await download(fileId,outsider.token)).status,404);
    again.disconnect();
    backend="legacy";
    await restart();
    const fresh=await connect();
    const restored=await join(fresh,"Newcomer",code);
    assert.deepEqual(restored.history.map(m=>m.id),expected);
    assert.equal(await decodeText(historyKey,restored.history[0].message),"Entry 1");
    assert.deepEqual((await request(fresh,"send_message",payload)),{ok:true,id:sent.id});
    const stored=await download(fileId,restored.token);
    assert.equal(stored.status,200);
    assert.deepEqual(Buffer.from(await unseal(historyKey,new Uint8Array(await stored.arrayBuffer()))),png);
    const isolated=await connect(), separate=await join(isolated,"Other","other-"+randomUUID().slice(0,8));
    assert.deepEqual(separate.history,[]);
    assert.equal((await download(fileId,separate.token)).status,404);
    assert.equal((await download(fileId,back.token)).status,401);
    const legacy=await (await postFile(restored.token)).json();
    assert.ok((await request(fresh,"send_message",{room:code,attachmentId:legacy.id})).ok);
    legacyId=legacy.id;
  });
  await t.test("R2 publication, legacy reads, ambiguous writes, retry, budget pause and restart",async()=>{
    backend="r2";
    await restart();
    const uploader=await connect(), reader=await connect(), otherRoom=await connect();
    const u=await join(uploader,"Uploader",code), r=await join(reader,"Reader",code);
    const x=await join(otherRoom,"Outsider","separate-room");
    for(const id of [fileId,legacyId]){
      assert.deepEqual(Buffer.from(await unseal(historyKey,new Uint8Array(await (await download(id,r.token)).arrayBuffer()))),png);
    }
    const clip=await (await postFile(u.token,"clip.webm",webm)).json();
    const message={room:code,attachmentId:clip.id,clientId:randomUUID()};
    const offline=pathJoin(objects,"offline");
    await writeFile(offline,"");
    assert.equal((await request(uploader,"send_message",message)).ok,false);
    assert.ok(stderr.includes(JSON.stringify({event:"storage_failure",operation:"r2.PutObject",code:"AccessDenied",httpStatus:403})));
    assert.equal((await download(clip.id,r.token)).status,404);
    assert.equal((await join(reader,"Reader",code)).history.some(m=>m.attachment?.id===clip.id),false);
    await rm(offline);
    const incoming=next(reader,"receive_message"), own=next(uploader,"receive_message");
    const success=await request(uploader,"send_message",message);
    assert.ok(success.ok);
    assert.deepEqual(await request(uploader,"send_message",message),success);
    assert.equal((await incoming).attachment.type,"video/webm");
    assert.equal((await own).authorId,u.authorId);
    const keys=(await readdir(objects)).filter(k=>k.startsWith("r2-"));
    assert.equal(keys.length,1);
    assert.notDeepEqual(await readFile(pathJoin(objects,keys[0])),webm);
    await writeFile(offline,"");
    assert.equal((await download(clip.id,r.token)).status,503);
    assert.equal((await download(clip.id,x.token)).status,404);
    assert.equal((await download(clip.id,"")).status,401);
    await rm(offline);
    const picture=await (await postFile(u.token)).json();
    const savedPicture=await request(uploader,"send_message",{room:code,attachmentId:picture.id,clientId:randomUUID()});
    assert.ok(savedPicture.ok);
    budget=0;
    await restart();
    const returning=await connect(), restoredR2=await join(returning,"Reader",code);
    assert.equal(restoredR2.history.at(-1).id,savedPicture.id);
    assert.equal(restoredR2.history.find(m=>m.id===success.id).attachment.type,"video/webm");
    const restoredPicture=await download(picture.id,restoredR2.token);
    assert.deepEqual(Buffer.from(await unseal(historyKey,new Uint8Array(await restoredPicture.arrayBuffer()))),png);
    const response=await download(clip.id,restoredR2.token);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(Buffer.from(await unseal(historyKey,new Uint8Array(await response.arrayBuffer()))),webm);
    assert.equal((await postFile(restoredR2.token)).status,507);
    assert.ok((await request(returning,"send_message",{room:code,message:await encodeText(historyKey,"Still here")})).ok);
    await request(returning,"clear_chat",{room:code,confirm:true});
    assert.equal((await download(clip.id,restoredR2.token)).status,404);
    assert.deepEqual((await join(returning,"Reader",code)).history,[]);
    for(let i=0;i<50 && (await readdir(objects)).length;i++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(await readdir(objects),[]);
  });
  await t.test("concurrent room publications reserve the global budget before writing objects",async()=>{
    budget = 1024;
    await restart();
    async function prepare(){
      const code="quota-"+randomUUID().slice(0,8), client=await connect();
      const member=await join(client,"Writer",code);
      const body=await seal(await roomKey(code),Buffer.alloc(700,65));
      const stage=()=>fetch(url+"/api/files",{method:"POST",body,headers:{
        ...auth(member.token),"Content-Type":"application/octet-stream","X-File-Name":"note.txt"}});
      const staged=await stage();
      assert.equal(staged.status,201);
      const file=await staged.json();
      return {stage,publish:()=>request(client,"send_message",{room:code,attachmentId:file.id,clientId:randomUUID()}),
        clear:()=>request(client,"clear_chat",{room:code,confirm:true})};
    }
    const writers=await Promise.all([prepare(),prepare()]);
    const results=await Promise.all(writers.map(writer=>writer.publish()));
    assert.equal(results.filter(result=>result.ok).length,1);
    assert.match(results.find(result=>!result.ok).error,/storage is full/);
    assert.equal((await readdir(objects)).length,1);
    const winner=writers[results.findIndex(result=>result.ok)];
    assert.ok((await winner.clear()).ok);
    for(let i=0;i<50 && (await readdir(objects)).length;i++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(await readdir(objects),[]);
    // The durable cleanup must release its budget before the test stops the server.
    let status;
    for(let i=0;i<8;i++){
      status=(await winner.stage()).status;
      if(status!==507)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(status,201);
  });
  await t.test("PostgreSQL failures before and after R2 PUT are distinguishable and retryable",
    {skip:!process.env.CHATCODE_TEST_DATABASE_URL},async()=>{
    pgOptions="-c lock_timeout=500ms";
    budget=128*1024*1024;
    await restart();
    const writer=await connect(), member=await join(writer,"Writer",code);
    const staged=await postFile(member.token,"clip.mp4",mp4);
    assert.equal(staged.status,201);
    const file=await staged.json();
    const payload={room:code,clientId:randomUUID(),attachmentId:file.id};
    const locker=new pg.Client({connectionString:process.env.CHATCODE_TEST_DATABASE_URL});
    await locker.connect();
    try {
      for(const [table,step,objectCount] of [
        ["chatcode_object_cleanup","insert_reservation",0],["chatcode_messages","insert_message",1],
      ]){
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE "+table+" IN SHARE MODE");
        stderr="";
        const result=await request(writer,"send_message",payload);
        await locker.query("ROLLBACK");
        assert.deepEqual(result,{ok:false,error:"Room storage is unavailable. Please retry."});
        assert.equal((await download(file.id,member.token)).status,404);
        assert.equal((await readdir(objects)).length,objectCount);
        assert.deepEqual(stderr.trim().split("\n").map(line=>JSON.parse(line)),[
          {event:"storage_failure",operation:"postgres."+step,sqlstate:"55P03"},
        ]);
      }
      assert.ok((await request(writer,"send_message",payload)).ok);
      assert.equal((await download(file.id,member.token)).status,200);
      assert.equal((await readdir(objects)).length,1);
      const saved=await locker.query("SELECT object_key FROM chatcode_messages WHERE attachment_id=$1",[file.id]);
      assert.ok((await request(writer,"clear_chat",{room:code,confirm:true})).ok);
      for(let i=0;i<50;i++){
        const pending=await locker.query("SELECT 1 FROM chatcode_object_cleanup WHERE object_key=$1",[saved.rows[0].object_key]);
        if(!pending.rowCount)return;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.fail("Test object cleanup did not finish");
    } finally {await locker.end();}
  });

  await t.test("opt-in music uploads validate MP3s and retain one authorized encrypted track across retries and restarts",async()=>{
    const path="/api/music/tracks", code="music-"+randomUUID().slice(0,8), key=await roomKey(code);
    const post=(token,body,name="tone.mp3")=>fetch(url+path,{method:"POST",headers:{
      ...auth(token),"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(name)},body});
    const get=(token,id)=>fetch(url+path+"/"+id,{headers:auth(token)});
    const encrypted=await seal(key,mp3);
    assert.equal((await post("",encrypted)).status,404);
    musicEnabled=true;
    backend="r2";
    pgOptions="-c lock_timeout=500ms";
    budget=encrypted.length;
    await restart();
    const writer=await connect(),reader=await connect(),outsider=await connect();
    const w=await join(writer,"Writer",code), r=await join(reader,"Listener",code), x=await join(outsider,"Other",code+"-x");
    assert.equal((await post("",encrypted)).status,401);
    assert.equal((await post(x.token,encrypted)).status,415);
    assert.equal((await post(w.token,encrypted,"../tone.mp3")).status,415);
    assert.equal((await post(w.token,encrypted,"tone.mp4")).status,415);
    assert.equal((await post(w.token,await seal(key,webm))).status,415);
    assert.equal((await post(w.token,await seal(key,mp3.subarray(0,-1)))).status,415);
    assert.equal((await post(w.token,Buffer.alloc(fileLimit+29))).status,413);
    const tampered=encrypted.slice(); tampered[tampered.length-1]^=1;
    assert.equal((await post(w.token,tampered)).status,415);
    assert.deepEqual(await readdir(objects),[]);
    const offline=pathJoin(objects,"offline");
    await writeFile(offline,"");
    assert.equal((await post(w.token,encrypted)).status,503);
    await rm(offline);
    const [original]=await readdir(objects);
    assert.ok(original?.startsWith("r2-"));
    assert.deepEqual(await readFile(pathJoin(objects,original)),Buffer.from(encrypted));
    // Restart between an ambiguous PUT and publication, with precisely one track's quota.
    await restart();
    const a=await connect(), b=await connect(), c=await connect();
    const u=await join(a,"Writer",code), v=await join(b,"Listener",code), outsider2=await join(c,"Other",code+"-x");
    if (process.env.CHATCODE_TEST_DATABASE_URL) {
      const locker=new pg.Client({connectionString:process.env.CHATCODE_TEST_DATABASE_URL});
      await locker.connect();
      try {
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE chatcode_music_tracks IN SHARE MODE");
        assert.equal((await post(u.token,encrypted)).status,503);
      } finally {await locker.query("ROLLBACK"); await locker.end();}
    }
    const responses=await Promise.all([post(u.token,await seal(key,mp3)),post(v.token,await seal(key,mp3))]);
    const tracks=[];
    for (const res of responses) {
      assert.ok([200,201].includes(res.status),String(res.status));
      tracks.push(await res.json());
    }
    const track=tracks[0];
    assert.deepEqual(tracks[1],track);
    assert.deepEqual(track,{id:track.id,name:"tone.mp3",size:mp3.length,type:"audio/mpeg",durationMs:350});
    assert.equal((await post(v.token,encrypted)).status,200);
    assert.equal((await post(v.token,await seal(key,mono),"mono.mp3")).status,507);
    assert.deepEqual(await readdir(objects),[original]);
    assert.equal((await get("",track.id)).status,401);
    assert.equal((await get(r.token,track.id)).status,401);
    assert.equal((await get(outsider2.token,track.id)).status,404);
    await writeFile(offline,"");
    assert.equal((await get(u.token,track.id)).status,503);
    await rm(offline);
    assert.ok((await request(a,"clear_chat",{room:code,confirm:true})).ok);
    await restart();
    const again=await join(await connect(),"Listener",code);
    const download=await get(again.token,track.id);
    assert.equal(download.status,200);
    assert.equal(download.headers.get("cache-control"),"no-store");
    assert.equal(download.headers.get("content-type"),"application/octet-stream");
    const bytes=new Uint8Array(await download.arrayBuffer());
    assert.deepEqual(bytes,encrypted);
    assert.deepEqual(Buffer.from(await unseal(key,bytes)),mp3);
    // Grow the real ID3 padding, leaving the complete audio program intact.
    const extra=fileLimit-mp3.length;
    const oldSize=mp3.subarray(6,10).reduce((n,b)=>n*128+b,0);
    const limit=Buffer.concat([mp3.subarray(0,10+oldSize),Buffer.alloc(extra),mp3.subarray(10+oldSize)]);
    const tagSize=oldSize+extra;
    for (let i=0;i<4;i++) limit[9-i]=(tagSize>>>(7*i))&127;
    budget=128*1024*1024;
    await restart();
    const last=await join(await connect(),"Writer",code);
    const accepted=await post(last.token,await seal(key,limit),"limit.mp3");
    assert.equal(accepted.status,201);
    assert.equal((await accepted.json()).size,fileLimit);
  });

  await t.test("shared queue commands converge across clients, lost acknowledgements and a server restart",async()=>{
    const code="queue-"+randomUUID().slice(0,8), other=code+"-x";
    const get=(client,room=code)=>request(client,"music_queue_get",{room});
    const send=(client,data)=>request(client,"music_queue_command",data);
    const command=(expectedRevision,action,fields)=>({room:code,commandId:randomUUID(),expectedRevision,action,...fields});
    const disabled=await connect();
    await join(disabled,"Before",code);
    await assert.rejects(disabled.timeout(200).emitWithAck("music_queue_get",{room:code}),/timed out/);
    await assert.rejects(disabled.timeout(200).emitWithAck("music_playback_get",{room:code}),/timed out/);
    queueEnabled=true; musicEnabled=true; backend="r2"; budget=128*1024*1024; pgOptions="";
    await restart();
    const a=await connect(), b=await connect(), x=await connect();
    const invalid=command("0","add",{trackId:randomUUID()});
    assert.equal((await get(a)).ok,false);
    assert.equal((await send(a,invalid)).ok,false);
    const member=await join(a,"Alice",code);
    await join(b,"Bob",code); await join(x,"Casey",other);
    const outsideEvents=[];
    x.on("music_queue_changed",event=>outsideEvents.push(event));
    const key=await roomKey(code), ids=[];
    for (const [name,data] of [["first.mp3",mp3],["second.mp3",mono]]) {
      const res=await fetch(url+"/api/music/tracks",{method:"POST",headers:{...auth(member.token),
        "Content-Type":"application/octet-stream","X-File-Name":name},body:await seal(key,data)});
      assert.equal(res.status,201);
      ids.push((await res.json()).id);
    }
    const initial=(await get(b)).snapshot;
    assert.equal(initial.revision,"2");
    assert.deepEqual(initial.queue,[]);
    assert.deepEqual(initial.tracks.map(t=>t.track_id).sort(),[...ids].sort());
    assert.ok(!JSON.stringify(initial).includes("chatcode/r2/"));
    const objectsBefore=(await readdir(objects)).sort();
    await writeFile(pathJoin(objects,"offline"),"");
    const first=command(initial.revision,"add",{trackId:ids[0]});
    assert.equal((await send(x,first)).ok,false);
    const foreign=await send(x,{...first,room:other,expectedRevision:"0"});
    assert.equal(foreign.ok,false);
    assert.deepEqual((await get(x,other)).snapshot.tracks,[]);
    for (const bad of [{...first,commandId:null},{...first,expectedRevision:2},{...first,action:"play"}]) {
      assert.equal((await send(a,bad)).ok,false);
    }
    const changed=next(b,"music_queue_changed");
    const race=await Promise.all([send(a,first),send(b,{...first,commandId:randomUUID()})]);
    const applied=race.find(r=>r.ok), stale=race.find(r=>!r.ok);
    assert.equal(applied.appliedRevision,"3");
    assert.equal(stale.code,"stale_revision");
    assert.deepEqual(stale.snapshot,applied.snapshot);
    assert.deepEqual(await changed,{revision:"3"});
    const entry=applied.snapshot.queue[0].entry_id;
    const lost=command("3","add",{trackId:ids[1]});
    const delivered=next(b,"music_queue_changed");
    a.emit("music_queue_command",lost); // Commit without supplying an acknowledgement callback.
    assert.deepEqual(await delivered,{revision:"4"});
    const duplicate=await send(b,lost);
    assert.equal(duplicate.replayed,true);
    const second=duplicate.snapshot.queue[1].entry_id;
    const reused=await send(b,{...lost,expectedRevision:"4",action:"remove",trackId:undefined,entryId:entry});
    assert.equal(reused.code,"command_id_reused");
    assert.equal(reused.snapshot.revision,"4");
    const incomplete=await send(a,command("4","reorder",{entryIds:[second]}));
    assert.equal(incomplete.ok,false);
    const reordered=await send(a,command("4","reorder",{entryIds:[second,entry]}));
    assert.deepEqual(reordered.snapshot.queue.map(q=>q.entry_id),[second,entry]);
    const selected=await send(b,command("5","select",{entryId:second}));
    assert.equal(selected.snapshot.current_entry,second);
    assert.equal(selected.snapshot.playing,false);
    assert.ok((await request(a,"clear_chat",{room:code,confirm:true})).ok);
    assert.deepEqual((await get(a)).snapshot,selected.snapshot);
    b.disconnect();
    const returning=await connect();
    await join(returning,"Bob",code);
    assert.deepEqual((await get(returning)).snapshot,selected.snapshot);
    assert.deepEqual(outsideEvents,[]);
    musicEnabled=false;
    await restart();
    const c=await connect(), fresh=await join(c,"Carol",code);
    assert.equal((await fetch(url+"/api/music/tracks/"+ids[0],{headers:auth(fresh.token)})).status,404);
    const replay=await send(c,lost);
    assert.equal(replay.appliedRevision,"4");
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.snapshot,selected.snapshot);
    const removed=await send(c,command("6","remove",{entryId:second}));
    assert.equal(removed.snapshot.revision,"7");
    assert.deepEqual(removed.snapshot.queue.map(q=>q.entry_id),[entry]);
    assert.equal(removed.snapshot.current_entry,null);
    assert.equal(removed.snapshot.position_ms,0);
    assert.equal(removed.snapshot.anchor_time,null);
    assert.equal(removed.snapshot.tracks.length,2);
    await rm(pathJoin(objects,"offline"));
    assert.deepEqual((await readdir(objects)).sort(),objectsBefore);
  });
  await t.test("authoritative playback, revision races, empty rooms and restart recovery",async pt=>{
    playbackEnabled=musicEnabled=queueEnabled=true;
    await restart();
    const room="play-"+randomUUID().slice(0,8), outside=room+"-x";
    let a=await connect(), b=await connect();
    const x=await connect(), foreign=[];
    x.on("music_playback_snapshot",s=>foreign.push(s));
    const get=async client=>(await request(client,"music_playback_get",{room})).snapshot;
    const payload=(revision,action,args)=>({room,commandId:randomUUID(),expectedRevision:revision,action,...args});
    const send=(client,data)=>request(client,"music_playback_command",data);
    const command=async (action,args)=>send(a,payload((await get(a)).revision,action,args));
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    assert.equal((await send(a,payload("0","play"))).ok,false);
    const member=await join(a,"Conductor",room);
    assert.ok(member.musicPlayback);
    await join(b,"Member",room);
    await join(x,"Outsider",outside);
    assert.equal((await send(x,payload("0","play"))).ok,false);
    const clock=await request(a,"music_clock",{room});
    assert.ok(Math.abs(Date.now()-clock.serverTimeMs)<1000);
    const key=await roomKey(room);
    // Repeat the fixture's MPEG frames without its ID3v2 header or ID3v1 footer.
    const bytes=Buffer.concat(Array(120).fill(mono.subarray(64,-128)));
    const res=await fetch(url+"/api/music/tracks",{method:"POST",headers:{...auth(member.token),
      "Content-Type":"application/octet-stream","X-File-Name":"long.mp3"},body:await seal(key,bytes)});
    assert.equal(res.status,201);
    const {id:trackId,durationMs}=await res.json();
    let queue;
    for (let i=0;i<3;i++) {
      queue=await request(a,"music_queue_command",payload(String(i+1),"add",{trackId}));
      assert.ok(queue.ok);
    }
    const [first,second,third]=queue.snapshot.queue.map(q=>q.entry_id);
    const play=payload("4","play");
    const event=next(b,"music_playback_snapshot",s=>s.revision==="5");
    const replies=await Promise.all([send(a,play),send(b,play)]);
    assert.deepEqual(replies.map(r=>r.replayed).sort(),[false,true]);
    assert.equal((await event).current_entry,first);
    assert.equal((await send(b,{...play,action:"pause"})).code,"command_id_reused");
    assert.equal((await send(b,payload("4","next"))).code,"stale_revision");
    for (const args of [{positionMs:-1},{positionMs:durationMs+1},{positionMs:3,playing:true}])
      assert.equal((await send(b,payload("5","seek",args))).ok,false);
    await wait(80);
    const paused=(await command("pause")).snapshot;
    assert.ok(!paused.playing && paused.position_ms>=70 && paused.anchor_time===null);
    assert.equal((await command("next")).snapshot.current_entry,second);
    assert.equal((await command("previous")).snapshot.current_entry,first);
    const seek=await command("seek",{positionMs:durationMs-350});
    assert.equal(seek.snapshot.playing,false);
    assert.equal(seek.snapshot.position_ms,durationMs-350);
    const changed=next(b,"music_playback_snapshot",s=>s.current_entry===second);
    await command("play");
    const advanced=await changed;
    assert.equal(advanced.current_entry,second);
    assert.ok(advanced.playing);
    await wait(250);
    assert.equal((await get(a)).revision,advanced.revision);
    await command("seek",{positionMs:durationMs-400});
    await command("previous");
    await wait(500);
    assert.equal((await get(a)).current_entry,first);
    b.disconnect();
    assert.equal((await get(a)).playing,true);
    a.disconnect();
    await wait(250);
    a=await connect(); await join(a,"Returning",room);
    const frozen=await get(a);
    assert.ok(!frozen.playing && frozen.position_ms>=400 && frozen.position_ms<5000);
    await wait(100);
    assert.deepEqual(await get(a),frozen);
    await command("play");
    musicEnabled=queueEnabled=false;
    await restart();
    a=await connect(); const back=await join(a,"Returning",room);
    const restored=await get(a);
    assert.equal(restored.current_entry,first);
    assert.ok(!restored.playing && restored.position_ms>=frozen.position_ms);
    assert.ok((await send(a,play)).replayed);
    const path=url+"/api/music/tracks";
    assert.equal((await fetch(path,{method:"POST",headers:auth(back.token)})).status,404);
    const audio=await fetch(path+"/"+trackId,{headers:auth(back.token)});
    assert.equal(audio.headers.get("cache-control"),"no-store");
    assert.deepEqual(Buffer.from(await unseal(key,new Uint8Array(await audio.arrayBuffer()))),bytes);
    assert.equal((await command("next")).snapshot.current_entry,second);
    assert.equal((await command("next")).snapshot.current_entry,third);
    await command("seek",{positionMs:durationMs-350});
    const finished=next(a,"music_playback_snapshot",s=>!s.playing && s.position_ms===durationMs);
    await command("play");
    const end=await finished;
    assert.equal(end.current_entry,third);
    assert.equal(end.position_ms,durationMs);
    assert.equal(end.playing,false);
    assert.deepEqual(foreign,[]);
    if (process.env.CHATCODE_TEST_WEBDRIVER) {
      musicEnabled=queueEnabled=true;
      await restart();
      const {playbackBrowser}=await import("./test/playback-browser.mjs");
      await pt.test("two foreground browsers follow the room after drift, autoplay denial and reconnect",
        bt=>playbackBrowser(bt,url,room+"-ui",bytes,whileStopped=>restart(Number(new URL(url).port),whileStopped),{"test.png":png,"clip.mp4":mp4,"clip.webm":webm}));
    }
  });

});
