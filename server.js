// ── ChatCode real-time chat server ──
// Room code is only an identifier users type to join a room;
// we never reveal anyone's real network IP.
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  connectionStateRecovery: { maxDisconnectionDuration: 60_000 },
  cors: { origin: "*" },
  // Must cover the largest legal image after dataURL + AES-GCM + base64 expansion:
  // 10MB raw → ~19MB ciphertext base64. engine.io defaults to 1e6 (1MB), which
  // would 413-kill the transport before send_image ever reaches our handler.
  maxHttpBufferSize: 20 * 1024 * 1024,
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// In-memory room state
// rooms: Map<roomCode, Set<socketId>>
// peers: Map<socketId, { username, room }>
const rooms = new Map();
const peers = new Map();

const MAX_MESSAGE_LEN = 500;
const MAX_USERNAME_LEN = 20;
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 5;
const rateLimiter = new Map(); // socketId -> [timestamps]

function roomMembers(room) {
  const set = rooms.get(room);
  if (!set) return [];
  return [...set]
    .map((id) => {
      const p = peers.get(id);
      return p ? { id, username: p.username } : null;
    })
    .filter(Boolean);
}

function broadcastMembers(room) {
  io.to(room).emit("members_update", { members: roomMembers(room) });
}

function rateLimited(socketId) {
  const now = Date.now();
  const hits = (rateLimiter.get(socketId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateLimiter.set(socketId, hits);
  if (hits.length > RATE_MAX) return true;
  if (hits.length === 1) setTimeout(() => rateLimiter.delete(socketId), RATE_WINDOW_MS * 2);
  return false;
}

// ── Room code validation ──
// A room code is only an identifier users type to join a room.
// It is never a network address we route to, so keep it strict:
// 3-24 chars, alphanumeric + dash/underscore only.
const ROOM_CODE = /^[A-Za-z0-9_-]{3,24}$/;
function isValidRoom(code) {
  return typeof code === "string" && ROOM_CODE.test(code);
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{1,20}$/;

io.on("connection", (socket) => {
  let joinedRoom = null;

  socket.on("join_room", ({ username, room }, ack) => {
    const name = String(username ?? "").trim();
    const code = String(room ?? "").trim();
    if (!USERNAME_RE.test(name)) {
      return ack?.({ ok: false, error: "Invalid username." });
    }
    if (!isValidRoom(code)) {
      return ack?.({ ok: false, error: "Invalid room code." });
    }

    socket.data.username = name;
    socket.data.room = code;
    joinedRoom = code;
    socket.join(code);
    if (!rooms.has(code)) rooms.set(code, new Set());
    rooms.get(code).add(socket.id);
    peers.set(socket.id, { username: name, room: code });

    broadcastMembers(code);
    socket.to(code).emit("user_joined", { message: `${name} joined the room` });
    ack?.({ ok: true });
  });

  socket.on("send_message", ({ message, room, reply }, ack) => {
    if (rateLimited(socket.id)) return ack?.({ ok: false, error: "Too fast. Slow down." });
    const p = peers.get(socket.id);
    if (!p || p.room !== room || !rooms.get(room)?.has(socket.id)) {
      return ack?.({ ok: false, error: "Not in room." });
    }
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_LEN) {
      return ack?.({ ok: false, error: "Invalid message." });
    }
    // Server never sees plaintext (E2E), but we still bound the ciphertext.
    const safe = {
      username: p.username,
      message: message.slice(0, 4096),
      senderId: socket.id,
      reply: reply && typeof reply === "object" ? {
        username: String(reply.username ?? "").slice(0, MAX_USERNAME_LEN),
        message: String(reply.message ?? "").slice(0, 4096),
        isImage: Boolean(reply.isImage),
      } : null,
    };
    io.to(room).emit("receive_message", safe);
    ack?.({ ok: true });
  });

  socket.on("send_image", ({ imageData, room, reply }, ack) => {
    if (rateLimited(socket.id)) return ack?.({ ok: false, error: "Too fast. Slow down." });
    const p = peers.get(socket.id);
    if (!p || p.room !== room) return ack?.({ ok: false, error: "Not in room." });
    if (typeof imageData !== "string" || imageData.length > 15 * 1024 * 1024) {
      // 15M base64 chars ≈ 10MB raw file after dataURL + AES-GCM + base64 expansion.
      // maxHttpBufferSize above must be >= this or engine.io 413s first.
      return ack?.({ ok: false, error: "Invalid image." });
    }
    io.to(room).emit("receive_image", {
      username: p.username,
      imageData,
      senderId: socket.id,
      reply: reply && typeof reply === "object" ? {
        username: String(reply.username ?? "").slice(0, MAX_USERNAME_LEN),
        message: String(reply.message ?? "").slice(0, 4096),
        isImage: Boolean(reply.isImage),
      } : null,
    });
    ack?.({ ok: true });
  });

  socket.on("typing_start", ({ room }) => {
    const p = peers.get(socket.id);
    if (p && p.room === room) socket.to(room).emit("user_typing", { username: p.username });
  });
  socket.on("typing_stop", ({ room }) => {
    const p = peers.get(socket.id);
    if (p && p.room === room) socket.to(room).emit("user_stopped_typing", { username: p.username });
  });

  // Only the room member who issued the clear (verified by socket membership)
  // can clear that room's chat. No cross-room action is possible.
  socket.on("clear_chat", ({ room }, ack) => {
    const p = peers.get(socket.id);
    if (!p || p.room !== room) return ack?.({ ok: false, error: "Not authorized." });
    io.to(room).emit("chat_cleared", { clearedBy: p.username });
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const p = peers.get(socket.id);
    if (p) {
      rooms.get(p.room)?.delete(socket.id);
      if (rooms.get(p.room)?.size === 0) rooms.delete(p.room);
      peers.delete(socket.id);
      broadcastMembers(p.room);
      io.to(p.room).emit("user_left", { message: `${p.username} left the room` });
    }
    rateLimiter.delete(socket.id);
  });
});

app.get("/ping", (_req, res) => res.sendStatus(200));

httpServer.listen(PORT, () => {
  console.log(`ChatCode server listening on http://localhost:${PORT}`);
});
