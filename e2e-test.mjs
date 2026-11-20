import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { webcrypto, randomUUID } from "node:crypto";
import test from "node:test";
import { io } from "socket.io-client";
import { roomKey, encodeText, decodeText, seal, unseal, fileLimit } from "./public/transfer.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const room = "integration-room";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AFcAAAAASUVORK5CYII=","base64");
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

test("two-client room and private attachment transfers", {timeout:40000}, async t=>{
  const server=spawn(process.execPath,["server.js"],{cwd:new URL("./",import.meta.url),env:{...process.env,PORT:"0"},stdio:["ignore","pipe","inherit"]});
  const clients=[];
  t.after(async()=>{
    clients.forEach(c=>c.disconnect());
    if(server.exitCode===null){const ended=once(server,"exit");server.kill();await ended;}
  });
  const [line]=await once(server.stdout,"data");
  const port=/port (\d+)/.exec(String(line))?.[1];
  assert.ok(port,"server published its listening port");
  const url="http://127.0.0.1:"+port;
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
    const sent=await request(alice,"send_message",{room,clientId:randomUUID(),message:"",attachmentId:id});
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
  for(const [name,data] of [["sample.png",png],["notes.pdf",Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n")],["notes.docx",docx],["notes.txt",Buffer.from("Meeting notes")]]){
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
    assert.equal((await upload("ordinary.docx",Buffer.from("This is text"))).status,415);
    assert.equal((await upload("empty.txt",Buffer.alloc(0))).status,413);
    assert.equal((await upload("large.txt",Buffer.alloc(fileLimit+1,65))).status,413);
    assert.equal((await request(other,"clear_chat",{room})).ok,false);
    const cleared=next(bob,"chat_cleared");await request(alice,"clear_chat",{room});assert.equal((await cleared).clearedBy,"Alice");
    assert.equal((await download(last,b.token)).status,404);
    const left=next(bob,"user_left");alice.disconnect();assert.match((await left).message,/Alice/);
    assert.equal((await download(last,a.token)).status,401);
  });
});
