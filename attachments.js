import express from "express";
import { randomUUID, pbkdf2, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";
import yauzl from "yauzl";
import { imageSize } from "image-size";

const derive = promisify(pbkdf2);
const MiB = 1024 * 1024;
export const FILE_LIMIT = 10 * MiB;
const envelopeLimit = FILE_LIMIT + 28;
const files = new Map();
const inflight = new Set();
const allowed = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const office = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" };
const invalid = () => new Error("The file contents do not match a supported format.");

function checkOffice(data, mainPart) {
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
        if (names.has("[Content_Types].xml") && names.has("_rels/.rels") && names.has(mainPart)) resolve();
        else reject(invalid());
      });
      zip.readEntry();
    });
  });
}

async function validate(data, ext) {
  if (allowed[ext].startsWith("image/")) {
    let image;
    try { image = imageSize(data); } catch { throw invalid(); }
    if (image.type !== (ext === "jpeg" ? "jpg" : ext) || !image.width || !image.height ||
        image.width * image.height > 32_000_000) throw invalid();
  } else if (ext === "pdf") {
    if (!data.subarray(0, 5).equals(Buffer.from("%PDF-")) || !data.subarray(-1024).includes("%%EOF")) throw invalid();
  } else if (office[ext]) {
    await checkOffice(data, office[ext]);
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

export function publishFile(id, peer) {
  const file = files.get(id);
  if (!file || file.expires <= Date.now() || file.room !== peer.room || file.owner !== peer.token || file.published) return null;
  file.published = true;
  file.expires = Date.now() + 3600_000;
  return file.info;
}

export function attachmentRoutes(app, sessions) {
  app.use("/api/files", (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const peer = sessions.get((req.get("Authorization") || "").replace(/^Bearer /, ""));
    if (!peer || req.get("Authorization") !== "Bearer " + peer.token) return res.status(401).json({ error: "Join the room again to access files." });
    req.peer = peer;
    next();
  });

  app.post("/api/files", (req, res, next) => {
    const size = Number(req.get("Content-Length"));
    const { token, room } = req.peer;
    if (!Number.isSafeInteger(size) || size <= 28 || size > envelopeLimit || !req.is("application/octet-stream") || req.get("Content-Encoding"))
      return res.status(413).json({ error: "Choose a nonempty file up to 10 MiB." });
    if (inflight.has(token) || inflight.size >= 4 || !hasSpace(room, size)) return res.status(429).json({ error: "File storage is busy or full. Try again later." });
    req.fileGeneration = req.peer.state.generation;
    inflight.add(token);
    res.once("close", () => inflight.delete(token));
    next();
  }, express.raw({ type: "application/octet-stream", limit: envelopeLimit, inflate: false }), async (req, res) => {
    const peer = req.peer;
    const generation = req.fileGeneration;
    let plaintext;
    let key;
    try {
      const name = decodeURIComponent(req.get("X-File-Name") || "").normalize("NFC");
      const ext = name.split(".").pop().toLowerCase();
      if (!name.includes(".") || !Object.hasOwn(allowed, ext) || name.length > 160 || /[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name) || name.startsWith(".")) throw invalid();
      const bytes = req.body;
      key = await derive(peer.room, "chatcode-salt-v1", 100000, 32, "sha256");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
      await validate(plaintext, ext);
      if (req.destroyed && !req.complete || res.destroyed || sessions.get(peer.token) !== peer || peer.state.generation !== generation)
        return res.status(409).json({ error: "The room changed. Choose the file again." });
      if (!hasSpace(peer.room, bytes.length)) return res.status(429).json({ error: "Room file storage is full." });
      const id = randomUUID();
      const info = { id, name, type: allowed[ext], size: plaintext.length };
      files.set(id, { info, bytes, owner: peer.token, room: peer.room, published: false, expires: Date.now() + 120_000 });
      res.status(201).json(info);
    } catch {
      res.status(415).json({ error: "File validation failed. Check the format, image dimensions, and file name." });
    } finally { plaintext?.fill(0); key?.fill(0); }
  });

  app.get("/api/files/:id", (req, res) => {
    const f = files.get(req.params.id);
    if (!f || f.room !== req.peer.room || !f.published || f.expires <= Date.now())
      return res.status(404).json({ error: "This file is unavailable or has expired." });
    res.set("Content-Disposition", "attachment").type("application/octet-stream").send(f.bytes);
  });
  app.use("/api/files", (err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.type === "entity.too.large" ? 413 : 400).json({ error: "Upload interrupted or too large." });
  });
}
