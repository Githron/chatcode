import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { webcrypto, randomUUID } from "node:crypto";
import test from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join as pathJoin} from "node:path";
import { io } from "socket.io-client";
import { roomKey, encodeText, decodeText, seal, unseal, fileLimit } from "./public/transfer.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const room = "test-"+randomUUID().slice(0,12);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AFcAAAAASUVORK5CYII=","base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==","base64");
const docx = Buffer.from("UEsDBBQAAAAIAJO4dF2sbhJangAAANwAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2PsQ7CMBBDf6XKitqrGBhQ24UdGPiBU3JtI5pLlBwF/p4EpA6Mlu1nubu9A6Xq5RZOvZpFwhEg6ZkcpsYH4uyMPjqULOMEAfUdJ4J92x5AexZiqaUw1NBdVorRGqquGOWMjnoFTx8NGK8fLiebTFPV6Vcry73CEBarUaxnWNn8bdZ+HK2mrV9oIXpNKVme3NJsjkPLu4KHoYPvqeEDUEsDBBQAAAAIAJO4dF1hey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pYGKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E12WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQUAAAACACTuHRdyUDSwnYAAACcAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRc7BDcIwDAXQVaoOgCsOHKKQIdggJKGtVNuRbZSyPU05cHlfX5al75vLnN5YyIYdN1LX7uNiVh2ApqVg1AvXQsftxYLRjiozNJZchVNRXWnGDa7TdAOMK43BN/fk/OlZO9Kx8GDGgdiKeui9K6f19PcD/z3hC1BLAQIUAxQAAAAIAJO4dF2sbhJangAAANwAAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAk7h0XWF7L0OJAAAA8gAAAAsAAAAAAAAAAAAAAIABzwAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAk7h0XclA0sJ2AAAAnAAAABEAAAAAAAAAAAAAAIABgQEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAACYCAAAAAA==","base64");

function next(socket,event) {
  return new Promise((resolve,reject)=>{
    const onData = data => { clearTimeout(timer); resolve(data); };
    const timer=setTimeout(()=>{ socket.off(event,onData); reject(new Error("Timed out waiting for "+event)); },3500);
    socket.once(event,onData);
  });
}
function request(socket,event,data) {
  return socket.timeout(3500).emitWithAck(event,data);
}

test("two-client room and private attachment transfers", {timeout:150000}, async t=>{
  const directory=await mkdtemp(pathJoin(tmpdir(),"chatcode-db-"));
  const start=()=>spawn(process.execPath,["server.js"],{cwd:new URL("./",import.meta.url),env:{...process.env,DATABASE_URL:process.env.CHATCODE_TEST_DATABASE_URL||"",PGHOST:"",RENDER:"",NODE_ENV:"test",S3_BUCKET:"",CHATCODE_DATA_DIR:directory,PORT:"0"},stdio:["ignore","pipe","inherit"]});
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
  for(const [name,data] of [["sample.png",png],["notes.pdf",Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n")],["notes.docx",docx],["notes.txt",Buffer.from("Meeting notes")],["still.gif",gif],["files.zip",docx]]){
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
  await t.test("validation, room clear and revoked access",async()=>{
    assert.equal((await upload("wrong.png",Buffer.from("This is text"))).status,415);
    assert.equal((await upload("wrong.gif",png)).status,415);
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
  await t.test("100-message snapshot, replay, prune, room isolation and process restart",async()=>{
    const code="history-"+randomUUID().slice(0,8);
    const historyKey=await roomKey(code);
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
    const fileId=await attach(), clientId=randomUUID();
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
    const ended=once(server,"exit");server.kill();await ended;
    server=start();url=await address();
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
    await request(fresh,"clear_chat",{room:code,confirm:true});
    assert.equal((await download(fileId,restored.token)).status,404);
    assert.deepEqual((await join(fresh,"Newcomer",code)).history,[]);
  });
});
