import express from "express";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { attachmentRoutes, clearFiles, publishFile } from "./attachments.js";

const app = express();
app.disable("x-powered-by");
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 24 * 1024 });
const rooms = new Map();
const sessions = new Map();
const channel = code => "chatcode:" + code;
attachmentRoutes(app, sessions);
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer",
    "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
  next();
});
app.get("/ping", (_req, res) => res.sendStatus(200));
app.use(express.static(fileURLToPath(new URL("./public/", import.meta.url))));
const encoded = value => typeof value === "string" && value.length >= 40 && value.length <= 4096 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);

function members(peer) {
  const list = [...peer.state.members].map(([id, p]) => ({ id, username: p.username }));
  io.to(channel(peer.room)).emit("members_update", { members: list });
}

io.on("connection", socket => {
  let peer;
  function handle(event, action) {
    socket.on(event, (data, ack) => {
      const answer = result => { if (typeof ack === "function") ack(result); };
      if (!data || typeof data !== "object") return answer({ok:false,error:"Invalid request."});
      if (event !== "join_room" && (!peer || data.room !== peer.room)) return answer({ok:false,error:"Join this room first."});
      answer(action(data));
    });
  }
  handle("join_room", ({ username, room }) => {
    if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,20}$/.test(username)) return {ok:false,error:"Use 1–20 letters, numbers, dots, dashes, or underscores for your name."};
    if (typeof room !== "string" || !/^[a-zA-Z0-9_-]{3,24}$/.test(room)) return {ok:false,error:"Use a 3–24 character room code with letters, numbers, dashes, or underscores."};
    if (peer) return peer.room === room && peer.username === username ? {ok:true,token:peer.token} : {ok:false,error:"Leave the current room first."};
    const state = rooms.get(room) || { members:new Map(), receipts:new Map(), generation:0 };
    rooms.set(room,state);
    peer = { room, username, token:randomBytes(32).toString("hex"), state, recent:[] };
    sessions.set(peer.token,peer);
    state.members.set(socket.id,peer);
    socket.join(channel(room));
    members(peer);
    socket.to(channel(room)).emit("user_joined",{message:username+" joined the room"});
    return {ok:true,token:peer.token};
  });
  handle("send_message", ({ message, reply, attachmentId, clientId }) => {
    if (clientId !== undefined && !uuid(clientId)) return {ok:false,error:"Invalid message ID."};
    const receipts = peer.state.receipts;
    if (clientId && receipts.has(clientId)) return {ok:true,id:receipts.get(clientId)};
    if ((!encoded(message) && !(attachmentId && !message)) || (reply && (!encoded(reply.message) || typeof reply.username !== "string"))) return {ok:false,error:"Invalid message or reply."};
    const now = Date.now();
    peer.recent = peer.recent.filter(t => now-t<1000);
    if (peer.recent.length >= 5) return {ok:false,error:"Please wait a moment before sending again."};
    const attachment = attachmentId ? publishFile(attachmentId,peer) : null;
    if (attachmentId && !attachment) return {ok:false,error:"Attachment expired. Please retry the upload."};
    const id = randomUUID();
    const safeReply = reply ? {username:reply.username.slice(0,20),message:reply.message,isImage:!!reply.isImage} : null;
    peer.recent.push(now);
    if (clientId) { receipts.set(clientId,id); if (receipts.size>512) receipts.delete(receipts.keys().next().value); }
    io.to(channel(peer.room)).emit("receive_message",{id,username:peer.username,senderId:socket.id,sentAt:now,message:message||"",reply:safeReply,attachment});
    return {ok:true,id};
  });
  for (const [event, notice] of [["typing_start","user_typing"],["typing_stop","user_stopped_typing"]]) {
    handle(event, () => {
      socket.to(channel(peer.room)).emit(notice,{username:peer.username,id:socket.id});
      return {ok:true};
    });
  }
  handle("clear_chat", () => {
    peer.state.generation++;
    clearFiles(peer.room);
    peer.state.receipts.clear();
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
