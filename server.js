import express from "express";
import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { attachmentRoutes, clearFiles, stagedFile, releaseFile } from "./attachments.js";

import { openStorage } from "./storage.js";
import { MediaConfigurationError } from "./media-storage.js";

let storage;
try {storage=await openStorage({enableMusicStorage:process.env.CHATCODE_MUSIC_UPLOADS==="1"});}
catch (err) {console.error(err instanceof MediaConfigurationError ? err.message : "History storage could not start. Check the database configuration and permissions.");process.exit(1);}
const app = express();
app.disable("x-powered-by");
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 24 * 1024 });
const rooms = new Map();
const sessions = new Map();
const channel = code => "chatcode:" + code;
attachmentRoutes(app, sessions, storage);
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer",
    "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
  next();
});
// The chat keeps its original CSP. Only this script-free document can play local Blobs.
app.get("/video-player.html", (_req,res,next)=>{
  res.set("Content-Security-Policy","default-src 'none'; media-src blob:; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin");
  next();
});
app.get("/ping", (_req, res) => res.sendStatus(200));
app.use(express.static(fileURLToPath(new URL("./public/", import.meta.url))));
const encoded = value => typeof value === "string" && value.length >= 40 && value.length <= 4096 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

// Order the join snapshot, committed broadcasts and clears for each live room.
const roomTasks=new Map();
function inOrder(room, action) {
  const current=(roomTasks.get(room)||Promise.resolve()).then(action);
  const tail=current.catch(()=>{});
  roomTasks.set(room,tail);
  tail.then(()=>{if(roomTasks.get(room)===tail)roomTasks.delete(room);});
  return current;
}

function members(peer) {
  const list = [...peer.state.members].map(([id, p]) => ({ id, username: p.username }));
  io.to(channel(peer.room)).emit("members_update", { members: list });
}

io.on("connection", socket => {
  let peer, pending=0;
  function handle(event, action) {
    socket.on(event, (data, ack) => {
      const answer = result => { if (typeof ack === "function") ack(result); };
      if (!data || typeof data !== "object") return answer({ok:false,error:"Invalid request."});
      if (event !== "join_room" && (!peer || data.room !== peer.room)) return answer({ok:false,error:"Join this room first."});
      if (event.startsWith("typing_"))return answer(action(data));
      if (event==="join_room" && (typeof data.room!=="string" || data.room.length>24))
        return answer({ok:false,error:"Invalid room code."});
      if(pending>=8)return answer({ok:false,error:"Please wait before trying again."});
      pending++;
      inOrder(data.room,async()=>{
        if(!socket.connected)return;
        answer(await action(data));
      }).catch(err=>answer({ok:false,error:err.publicMessage || "Room storage is unavailable. Please retry."})).finally(()=>pending--);
    });
  }
  handle("join_room", async ({ username, room, identity }) => {
    if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,20}$/.test(username)) return {ok:false,error:"Use 1–20 letters, numbers, dots, dashes, or underscores for your name."};
    if (typeof room !== "string" || !/^[a-zA-Z0-9_-]{3,24}$/.test(room)) return {ok:false,error:"Use a 3–24 character room code with letters, numbers, dashes, or underscores."};
    if (peer && (peer.room!==room || peer.username!==username))return {ok:false,error:"Leave the current room first."};
    const history=await storage.history(room);
    if(!socket.connected)return {ok:false,error:"Disconnected."};
    // Another join on this socket may have completed during the database read.
    if(peer && (peer.room!==room || peer.username!==username))return {ok:false,error:"Leave the current room first."};
    if (peer)return {ok:true,token:peer.token,authorId:peer.authorId,history};
    const authorId=createHash("sha256").update(room+"|"+(uuid(identity)?identity:randomUUID())).digest("hex");
    const state = rooms.get(room) || { members:new Map(), generation:0 };
    rooms.set(room,state);
    peer = { room, username, authorId, token:randomBytes(32).toString("hex"), state, recent:[] };
    sessions.set(peer.token,peer);
    state.members.set(socket.id,peer);
    socket.join(channel(room));
    members(peer);
    socket.to(channel(room)).emit("user_joined",{message:username+" joined the room"});
    return {ok:true,token:peer.token,authorId,history};
  });
  handle("send_message", async ({ message, reply, attachmentId, clientId }) => {
    if (clientId !== undefined && !uuid(clientId)) return {ok:false,error:"Invalid message ID."};
    const receipt=await storage.receipt(peer.room,clientId);
    if(receipt)return {ok:true,id:receipt};
    if ((!encoded(message) && !(attachmentId && !message)) || (reply && (!encoded(reply.message) || typeof reply.username !== "string"))) return {ok:false,error:"Invalid message or reply."};
    const now = Date.now();
    peer.recent = peer.recent.filter(t => now-t<1000);
    if (peer.recent.length >= 5) return {ok:false,error:"Please wait a moment before sending again."};
    const file = attachmentId ? stagedFile(attachmentId,peer) : null;
    if (attachmentId && !file) return {ok:false,error:"Attachment expired. Please retry the upload."};
    const id = randomUUID();
    const safeReply = reply ? {id:uuid(reply.id)?reply.id:null,username:reply.username.slice(0,20),message:reply.message,isImage:!!reply.isImage} : null;
    peer.recent.push(now);
    const event={id,username:peer.username,authorId:peer.authorId,sentAt:now,message:message||"",reply:safeReply,attachment:file?.info || null};
    await storage.save(peer.room,event,clientId,file);
    if(file)releaseFile(attachmentId);
    io.to(channel(peer.room)).emit("receive_message",{...event,senderId:socket.id});
    return {ok:true,id};
  });
  for (const [event, notice] of [["typing_start","user_typing"],["typing_stop","user_stopped_typing"]]) {
    handle(event, () => {
      socket.to(channel(peer.room)).emit(notice,{username:peer.username,id:socket.id});
      return {ok:true};
    });
  }
  handle("clear_chat", async ({confirm}) => {
    if(confirm!==true)return {ok:false,error:"Confirm permanent deletion for everyone first."};
    await storage.clear(peer.room);
    peer.state.generation++;
    clearFiles(peer.room);
    io.to(channel(peer.room)).emit("chat_cleared",{clearedBy:peer.username});
    return {ok:true};
  });
  socket.on("disconnect", () => {
    if (!peer) return;
    sessions.delete(peer.token);
    peer.state.members.delete(socket.id);
    if (peer.state.members.size) {
      members(peer);
      socket.to(channel(peer.room)).emit("user_left",{id:socket.id,message:peer.username+" left the room"});
    } else {
      clearFiles(peer.room);
      rooms.delete(peer.room);
    }
  });
});
server.listen(Number(process.env.PORT || 3000), () => console.log("ChatCode listening on port "+server.address().port));
