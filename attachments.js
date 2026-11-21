import express from "express";
import { randomUUID, pbkdf2, createDecipheriv, createHmac } from "node:crypto";
import { promisify } from "node:util";
import yauzl from "yauzl";
import { imageSize } from "image-size";
import { fileLimit, uploadLimit } from "./public/transfer.js";
import { validateVideo } from "./video-container.js";
import { mp3Duration } from "./mp3.js";

const derive = promisify(pbkdf2);
const MiB = 1024 * 1024;
const envelopeLimit = fileLimit + 28;
const files = new Map();
const inflight = new Map();
const allowed = {
  mp4: "video/mp4", webm: "video/webm",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", zip: "application/zip",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const office = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" };
const invalid = () => new Error("The file contents do not match a supported format.");

function checkArchive(data, mainPart) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(invalid());
      const names = new Set();
      let expanded = 0;
      const fail = () => { zip.close(); reject(invalid()); };
      zip.on("error", fail);
      zip.on("entry", entry => {
        expanded += entry.uncompressedSize;
        if (names.size >= 2048 || expanded > 80 * MiB || entry.generalPurposeBitFlag & 1 ||
            names.has(entry.fileName) || /vbaProject\.bin$/i.test(entry.fileName)) return fail();
        names.add(entry.fileName);
        zip.readEntry();
      });
      zip.once("end", () => {
        zip.close();
        if (names.size && (!mainPart || (names.has("[Content_Types].xml") && names.has("_rels/.rels") && names.has(mainPart)))) resolve();
        else reject(invalid());
      });
      zip.readEntry();
    });
  });
}

// Accept single-frame GIFs. Skip length-prefixed data blocks without expanding pixels.
function checkGif(data) {
  if(data.length < 14) throw invalid();
  let pos=13, frames=0;
  const tableSize=packed=>(packed & 128) ? 3*(2 << (packed & 7)) : 0;
  pos+=tableSize(data[10]);
  while(pos<data.length){
    const block=data[pos++];
    if(block===0x3b && frames===1 && pos===data.length)return;
    if(block===0x21)pos++;
    else if(block===0x2c){
      if(++frames>1 || pos+9>data.length)throw invalid();
      const width=data.readUInt16LE(pos+4), height=data.readUInt16LE(pos+6);
      if(!width || !height || data.readUInt16LE(pos)+width>data.readUInt16LE(6) ||
          data.readUInt16LE(pos+2)+height>data.readUInt16LE(8))throw invalid();
      pos+=9+tableSize(data[pos+8])+1;
    }else throw invalid();
    while(pos<data.length && data[pos])pos+=1+data[pos];
    pos++;
  }
  throw invalid();
}

async function validate(data, ext) {
  if (allowed[ext].startsWith("image/")) {
    let image;
    try { image = imageSize(data); } catch { throw invalid(); }
    if (image.type !== (ext === "jpeg" ? "jpg" : ext) || !image.width || !image.height ||
        image.width * image.height > 32_000_000) throw invalid();
    if (ext==="gif")checkGif(data);
    return {width:image.width,height:image.height};
  } else if (allowed[ext].startsWith("video/")) {
    validateVideo(data, ext);
  } else if (ext === "pdf") {
    if (!data.subarray(0, 5).equals(Buffer.from("%PDF-")) || !data.subarray(-1024).includes("%%EOF")) throw invalid();
  } else if (office[ext] || ext==="zip") {
    await checkArchive(data, office[ext]);
  } else {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw invalid(); }
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw invalid();
  }
}

function expire() {
  const now = Date.now();
  for (const [id, f] of files) if (f.expires <= now) files.delete(id);
}
setInterval(expire, 30_000).unref();

export function clearFiles(room) {
  for (const [id, f] of files) if (f.room === room) files.delete(id);
}

function hasSpace(room, size) {
  let total = 0, local = 0, count = 0;
  for (const file of files.values()) {
    total += file.bytes.length;
    if (file.room === room) { local += file.bytes.length; count++; }
  }
  return files.size < 2048 && count < 256 && total + size <= 128 * MiB && local + size <= 40 * MiB;
}

export function stagedFile(id, peer) {
  const file = files.get(id);
  if (!file || file.expires <= Date.now() || file.room !== peer.room || file.owner !== peer.token || file.published) return null;
  return file;
}

export function releaseFile(id) { files.delete(id); }

export function attachmentRoutes(app, sessions, storage) {
  let recentUploads = [];
  const musicPath="/api/music/tracks";
  const uploadPaths=storage.music ? ["/api/files",musicPath] : ["/api/files"];
  if (storage.music) app.use(musicPath,(req,res,next)=>{req.musicUpload=true; next();});
  app.use(uploadPaths, (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const peer = sessions.get((req.get("Authorization") || "").replace(/^Bearer /, ""));
    if (!peer || req.get("Authorization") !== "Bearer " + peer.token) return res.status(401).json({ error: "Join the room again to access files." });
    req.peer = peer;
    next();
  });

  app.post(uploadPaths, async (req, res, next) => {
    const size = Number(req.get("Content-Length"));
    const { token, room } = req.peer;
    let name;
    try { name = decodeURIComponent(req.get("X-File-Name") || "").normalize("NFC"); } catch { name = ""; }
    const ext = name.split(".").pop().toLowerCase();
    const supported=req.musicUpload ? ext==="mp3" : Object.hasOwn(allowed,ext);
    if (!name.includes(".") || !supported || name.length > 160 || /[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name) || name.startsWith("."))
      return res.status(415).json({error:"Choose a supported file with a safe filename."});
    if (!Number.isSafeInteger(size) || size <= 28 || size > uploadLimit(name)+28 || !req.is("application/octet-stream") || req.get("Content-Encoding"))
      return res.status(413).json({ error: "Choose a nonempty image up to 8 MB or another supported file up to 10 MiB." });
    if (inflight.has(token) || inflight.size >= 4 || !hasSpace(room, size)) return res.status(429).json({ error: "File storage is busy or full. Try again later." });
    const now = Date.now();
    recentUploads = recentUploads.filter(entry => now-entry.time < 60_000);
    if (recentUploads.length >= 120 || recentUploads.filter(entry => entry.token === token).length >= 12)
      return res.set("Retry-After","60").status(429).json({error:"Too many uploads. Try again in a minute."});
    recentUploads.push({time:now,token});
    req.fileName = name;
    req.fileGeneration = req.peer.state.generation;
    inflight.set(token,req);
    res.once("close", () => {if (!req.checkingFile && inflight.get(token)===req) inflight.delete(token);});
    // A published music retry can succeed at a full quota; reserve after deriving its identity.
    try { if (!req.musicUpload) await storage.checkUploadSpace(room,size); }
    catch (err) { return res.status(err.publicMessage ? 507 : 503).json({error:err.publicMessage || "Storage is unavailable. Please retry."}); }
    next();
  }, express.raw({ type: "application/octet-stream", limit: envelopeLimit, inflate: false }), async (req, res) => {
    const peer = req.peer;
    req.checkingFile=true;
    const stillJoined=()=>!res.destroyed && sessions.get(peer.token)===peer;
    const generation = req.fileGeneration;
    let plaintext;
    let key;
    try {
      const name = req.fileName;
      const ext = name.split(".").pop().toLowerCase();
      const bytes = req.body;
      key = await derive(peer.room, "chatcode-salt-v1", 100000, 32, "sha256");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
      if (req.musicUpload) {
        const durationMs=mp3Duration(plaintext);
        const sizeBytes=plaintext.length;
        // The room key scopes deduplication. Retrying with a fresh IV retains the first envelope.
        const hex=createHmac("sha256",key).update("chatcode-mp3-v1\0").update(name).update("\0").update(plaintext).digest("hex");
        const id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join("-");
        plaintext.fill(0); key.fill(0);
        if (!stillJoined()) return res.status(401).json({error:"Join the room again to upload music."});
        try {
          const created=await storage.music.saveUpload(peer.room,id,{filename:name,sizeBytes,durationMs},bytes,stillJoined);
          if (!stillJoined()) return res.status(401).json({error:"Join the room again to upload music."});
          return res.status(created?201:200).json({id,name,type:"audio/mpeg",size:sizeBytes,durationMs});
        } catch (err) {
          if (!stillJoined()) return res.status(401).json({error:"Join the room again to upload music."});
          return res.status(err.publicMessage?507:503).json({error:err.publicMessage || "Music storage is unavailable. Retry the upload."});
        }
      }
      const dimensions=await validate(plaintext, ext);
      if (req.destroyed && !req.complete || res.destroyed || sessions.get(peer.token) !== peer || peer.state.generation !== generation)
        return res.status(409).json({ error: "The room changed. Choose the file again." });
      if (!hasSpace(peer.room, bytes.length)) return res.status(429).json({ error: "Room file storage is full." });
      const id = randomUUID();
      const info = { id, name, type: allowed[ext], size: plaintext.length, ...dimensions };
      files.set(id, { info, bytes, owner: peer.token, room: peer.room, published: false, expires: Date.now() + 120_000 });
      res.status(201).json(info);
    } catch {
      res.status(415).json({ error: "File validation failed. Check that the file is complete and matches its extension." });
    } finally {
      plaintext?.fill(0); key?.fill(0);
      if (inflight.get(peer.token)===req) inflight.delete(peer.token);
    }
  });

  app.get("/api/files/:id", async (req, res) => {
    const unavailable=()=>res.status(404).json({error:"This file is no longer in room history."});
    if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.params.id))return unavailable();
    try {
      const bytes=await storage.readFile(req.peer.room,req.params.id);
      if(!bytes || sessions.get(req.peer.token)!==req.peer)return unavailable();
      res.set("Content-Disposition","attachment").type("application/octet-stream").send(bytes);
    } catch {res.status(503).json({error:"File storage is unavailable. Please retry."});}
  });
  if (storage.music) {
    const reads=new Set();
    app.get(musicPath+"/:id",async (req,res)=>{
      const {peer}=req;
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.params.id))
        return res.status(404).json({error:"Track unavailable."});
      if (reads.size>=4 || reads.has(peer.token)) return res.status(429).json({error:"Music downloads are busy. Retry shortly."});
      reads.add(peer.token);
      try {
        const bytes=await storage.music.readTrack(peer.room,req.params.id);
        if (!bytes || sessions.get(peer.token)!==peer) return res.status(404).json({error:"Track unavailable."});
        if (res.destroyed) return;
        res.set("Content-Disposition","attachment").type("application/octet-stream").send(bytes);
        if (!res.writableFinished && !res.destroyed) await new Promise(resolve=>res.once("close",resolve));
      } catch {res.status(503).json({error:"Music storage is unavailable. Retry the download."});}
      finally {reads.delete(peer.token);}
    });
  }
  app.use(uploadPaths, (err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.type === "entity.too.large" ? 413 : 400).json({ error: "Upload interrupted or too large." });
  });
}
