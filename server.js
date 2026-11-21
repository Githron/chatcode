import express from "express";
import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { attachmentRoutes, clearFiles, stagedFile, releaseFile } from "./attachments.js";

import { openStorage } from "./storage.js";
import { MediaConfigurationError } from "./media-storage.js";

const musicUploads=process.env.CHATCODE_MUSIC_UPLOADS==="1";
const musicQueue=process.env.CHATCODE_MUSIC_QUEUE==="1";
const musicPlayback=process.env.CHATCODE_MUSIC_PLAYBACK==="1";
let storage;
try {
  storage=await openStorage({enableMusicStorage:musicUploads || musicQueue || musicPlayback});
  if (musicPlayback) await storage.music.pauseEmptyRooms();
}
catch (err) {console.error(err instanceof MediaConfigurationError ? err.message : "History storage could not start. Check the database configuration and permissions.");process.exit(1);}
const app = express();
app.disable("x-powered-by");
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 24 * 1024 });
const rooms = new Map();
const sessions = new Map();
const channel = code => "chatcode:" + code;
attachmentRoutes(app, sessions, storage, musicUploads || musicPlayback ? storage.music : null, musicUploads, room=>{
  io.to(channel(room)).emit("music_library_changed");
  if (musicPlayback) refreshPlayback(room);
});
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer",
    "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
  next();
});
// Only the script-free media frames can play local Blobs.
app.get(["/video-player.html","/audio-player.html"], (_req,res,next)=>{
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

// Timers are hints. The deadline and revision are checked again under the room lock.
async function refreshPlayback(room) {
  const live=rooms.get(room);
  if (!live) return;
  try {
    const snapshot=await storage.music.playbackSnapshot(room);
    if (rooms.get(room)!==live || BigInt(snapshot.revision)<BigInt(live.playbackRevision ?? 0)) return;
    if (live.playbackRevision!==snapshot.revision) {
      io.to(channel(room)).emit("music_playback_snapshot",snapshot);
      live.playbackRevision=snapshot.revision;
    }
    clearTimeout(live.playbackTimer);
    if (!snapshot.playing) return;
    const end=new Date(snapshot.anchor_time).getTime()+snapshot.duration_ms-snapshot.position_ms;
    live.playbackTimer=setTimeout(async ()=>{
      try {
        const changed=await storage.music.advanceIfEnded(room,snapshot.revision,()=>rooms.get(room)===live);
        if (changed && musicQueue) io.to(channel(room)).emit("music_queue_changed",{revision:String(BigInt(snapshot.revision)+1n)});
      } catch {
        if (rooms.get(room)===live) live.playbackTimer=setTimeout(()=>refreshPlayback(room),1000);
        return;
      }
      if (rooms.get(room)===live) refreshPlayback(room);
    },Math.min(2147483647,Math.max(1,end-Date.now())));
  } catch {
    if (rooms.get(room)===live) {
      clearTimeout(live.playbackTimer);
      live.playbackTimer=setTimeout(()=>refreshPlayback(room),1000);
    }
  }
}

const emptySince=new Map();
async function freezeEmptyRoom(room) {
  const at=emptySince.get(room);
  if (at===undefined) return;
  await storage.music.pauseEmptyRooms(room,at);
  emptySince.delete(room);
}
function scheduleFreeze(room) {
  inOrder(room,()=>freezeEmptyRoom(room)).catch(()=>{
    setTimeout(()=>{if (emptySince.has(room)) scheduleFreeze(room);},1000);
  });
}

function members(peer) {
  const list = [...peer.state.members].map(([id, p]) => ({ id, username: p.username }));
  io.to(channel(peer.room)).emit("members_update", { members: list });
}

io.on("connection", socket => {
  let peer, pending=0;
  let recentQueueRequests=[];
  function handle(event, action, queueRequest=false) {
    socket.on(event, (data, ack) => {
      const answer = result => { if (typeof ack === "function") ack(result); };
      if (!data || typeof data !== "object") return answer({ok:false,error:"Invalid request."});
      if (event !== "join_room" && (!peer || data.room !== peer.room)) return answer({ok:false,error:"Join this room first."});
      if (event.startsWith("typing_"))return answer(action(data));
      if (event==="join_room" && (typeof data.room!=="string" || data.room.length>24))
        return answer({ok:false,error:"Invalid room code."});
      if(pending>=8)return answer({ok:false,error:"Please wait before trying again."});
      if (queueRequest) {
        const now=Date.now();
        recentQueueRequests=recentQueueRequests.filter(time=>now-time<1000);
        if (recentQueueRequests.length>=20) return answer({ok:false,error:"Please wait before trying again."});
        recentQueueRequests.push(now);
      }
      pending++;
      const run=async()=>{
        if(!socket.connected)return;
        const result=await action(data);
        if (socket.connected) answer(result);
      };
      // Queue order is committed by PostgreSQL independently of chat attachment PUTs.
      const task=queueRequest ? run() : inOrder(data.room,run);
      task.catch(err=>answer({ok:false,error:err.publicMessage || "Room storage is unavailable. Please retry."})).finally(()=>pending--);
    });
  }
  handle("join_room", async ({ username, room, identity }) => {
    if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,20}$/.test(username)) return {ok:false,error:"Use 1–20 letters, numbers, dots, dashes, or underscores for your name."};
    if (typeof room !== "string" || !/^[a-zA-Z0-9_-]{3,24}$/.test(room)) return {ok:false,error:"Use a 3–24 character room code with letters, numbers, dashes, or underscores."};
    if (peer && (peer.room!==room || peer.username!==username))return {ok:false,error:"Leave the current room first."};
    const history=await storage.history(room);
    if (musicPlayback) await freezeEmptyRoom(room);
    if(!socket.connected)return {ok:false,error:"Disconnected."};
    // Another join on this socket may have completed during the database read.
    if(peer && (peer.room!==room || peer.username!==username))return {ok:false,error:"Leave the current room first."};
    if (peer)return {ok:true,token:peer.token,authorId:peer.authorId,history,musicPlayback,musicQueue,musicUploads};
    const authorId=createHash("sha256").update(room+"|"+(uuid(identity)?identity:randomUUID())).digest("hex");
    const state = rooms.get(room) || { members:new Map(), generation:0 };
    rooms.set(room,state);
    peer = { room, username, authorId, token:randomBytes(32).toString("hex"), state, recent:[] };
    sessions.set(peer.token,peer);
    state.members.set(socket.id,peer);
    socket.join(channel(room));
    members(peer);
    socket.to(channel(room)).emit("user_joined",{message:username+" joined the room"});
    return {ok:true,token:peer.token,authorId,history,musicPlayback,musicQueue,musicUploads};
  });
  if (musicQueue || musicUploads) {
    handle(musicQueue ? "music_queue_get" : "music_library_get",async ({afterTrackId,includeUsage})=>{
      const snapshot=await storage.music.snapshot(peer.room,afterTrackId);
      const usage=includeUsage ? await storage.roomUsage(peer.room) : undefined;
      if (!musicQueue) {
        const {tracks,revision,nextTrackCursor}=snapshot;
        return {ok:true,snapshot:{tracks,revision,nextTrackCursor,queue:[]},usage};
      }
      return {ok:true,snapshot,usage};
    },true);
  }
  if (musicQueue) {
    handle("music_queue_command",async data=>{
      const room=peer.room;
      if (data.action==="deleteTrack" && !musicUploads) return {ok:false,error:"Library changes are disabled."};
      const result=await storage.music.queueCommand(room,data,()=>socket.connected && sessions.get(peer.token)===peer);
      if (result.ok && !result.replayed) {
        io.to(channel(room)).emit("music_queue_changed",{revision:result.appliedRevision});
        if (musicPlayback) await refreshPlayback(room);
      }
      return {...result,snapshot:await storage.music.snapshot(room)};
    },true);
  }
  if (musicPlayback) {
    handle("music_clock",()=>({ok:true,serverTimeMs:Date.now()}),true);
    handle("music_playback_get",async ()=>({ok:true,snapshot:await storage.music.playbackSnapshot(peer.room)}),true);
    handle("music_playback_command",async data=>{
      const room=peer.room;
      const result=await storage.music.playbackCommand(room,data,()=>socket.connected && sessions.get(peer.token)===peer);
      if (result.ok && !result.replayed) {
        if (musicQueue) io.to(channel(room)).emit("music_queue_changed",{revision:result.appliedRevision});
        await refreshPlayback(room);
      }
      return {...result,snapshot:await storage.music.playbackSnapshot(room)};
    },true);
  }
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
      if (musicPlayback) {
        clearTimeout(peer.state.playbackTimer);
        emptySince.set(peer.room,Date.now());
        scheduleFreeze(peer.room);
      }
    }
  });
});
server.listen(Number(process.env.PORT || 3000), () => console.log("ChatCode listening on port "+server.address().port));
