// E2E test: two clients, one room — join, chat, E2E encrypt/decrypt, images, typing, clear, leave.
import { io } from "socket.io-client";

const URL = "http://localhost:3000";
const ROOM = "ferrari-f1";

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

// Minimal client-side crypto mirror (same params as public/script.js)
async function deriveKey(ip) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey("raw", enc.encode(ip), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("ipchat-salt-v1"), iterations: 100000, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encrypt(key, text) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  const combo = new Uint8Array(12 + ct.byteLength);
  combo.set(iv, 0); combo.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...combo));
}
async function decrypt(key, b64) {
  const combo = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: combo.slice(0,12) }, key, combo.slice(12));
  return new TextDecoder().decode(pt);
}

const connect = (username) => new Promise((res, rej) => {
  const s = io(URL, { transports: ["polling", "websocket"] });
  s.on("connect", () => res(s));
  s.on("connect_error", rej);
});
const join = (s, name, room) => new Promise(res => s.emit("join_room", { username: name, room }, res));
const send = (s, msg, room, reply=null) => new Promise(res => s.emit("send_message", { message: msg, room, reply }, res));

console.log("🔌 Connecting clients...");
const alice = await connect("alice");
const bob = await connect("bob");

console.log("🚪 Join room...");
// Server broadcasts members_update to the WHOLE room (including the joiner) BEFORE
// acking, so alice's own join fires members_update([alice]). Wait for the broadcast
// that shows BOTH users — that's the one after bob joins.
const bothMembersP = new Promise(res =>
  alice.on("members_update", ({ members }) => {
    if (members.length === 2 && members.some(m=>m.username==="alice") && members.some(m=>m.username==="bob")) res({ members });
  })
);
const aJoin = await join(alice, "alice", ROOM);
const bJoin = await join(bob, "bob", ROOM);
ok(aJoin.ok && bJoin.ok, "both clients join room");

const members = (await Promise.race([bothMembersP, new Promise(res => setTimeout(() => res({ members: [] }), 5000))])).members;
ok(members.length === 2 && members.some(m=>m.username==="alice") && members.some(m=>m.username==="bob"), "members list shows both users");

// E2E: alice sends ciphertext only server could not read
const key = await deriveKey(ROOM);
const plaintext = "hello from alice 🔐";
const cipher = await encrypt(key, plaintext);
ok(cipher !== plaintext && !cipher.includes(plaintext), "ciphertext does not leak plaintext");

// bob receives + decrypts
const recvP = new Promise(res => bob.once("receive_message", res));
await send(alice, cipher, ROOM);
const got = await recvP;
const decrypted = await decrypt(key, got.message);
ok(decrypted === plaintext, "bob decrypts alice's message exactly");
ok(got.username === "alice", "server relays username in plaintext");

// reply threading
const replyP = new Promise(res => alice.once("receive_message", res));
await send(bob, await encrypt(key, "replying!"), ROOM, { username: "alice", message: "hello from alice 🔐", isImage: false });
const r = await replyP;
ok(r.reply && r.reply.username === "alice", "reply metadata relayed");

// image
const imgP = new Promise(res => alice.once("receive_image", res));
await bob.emit("send_image", { imageData: await encrypt(key, "data:image/png;base64,AAAA"), room: ROOM });
const img = await imgP;
ok(typeof img.imageData === "string" && img.imageData.length > 0, "image relayed as ciphertext");

// typing
const typeP = new Promise(res => alice.once("user_typing", res));
bob.emit("typing_start", { room: ROOM });
ok((await typeP).username === "bob", "typing indicator relayed");

// bad room rejected
const evil = await join(await connect("mallory"), "mallory", "not a valid room code!!!");
ok(evil.ok === false, "invalid room code rejected");

// clear chat
const clearP = new Promise(res => bob.once("chat_cleared", res));
await new Promise(res => alice.emit("clear_chat", { room: ROOM }, res));
ok((await clearP).clearedBy === "alice", "clear_chat broadcast with clearedBy");

// leave — bob must still be connected to receive the broadcast; alice leaving is
// what triggers it, so race the wait instead of hanging if the server is down.
const leftP = new Promise(res => bob.once("user_left", res));
alice.disconnect();
ok((await Promise.race([leftP, new Promise(res => setTimeout(() => res({ message: "" }), 5000))])).message.includes("alice"), "leave notice broadcast");

console.log(`\n📊 ${pass} passed, ${fail} failed`);
bob.disconnect();
process.exit(fail ? 1 : 0);
