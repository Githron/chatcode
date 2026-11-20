export const fileLimit = 10 * 1024 * 1024;
export const formats = /\.(png|jpe?g|webp|pdf|docx|xlsx|pptx|txt|md|csv)$/i;
export const sizeLabel = bytes => bytes < 1024 ? bytes+" B" : bytes < 1048576 ? Math.ceil(bytes/1024)+" KiB" : (bytes/1048576).toFixed(1)+" MiB";

export async function roomKey(code) {
  if (!globalThis.crypto?.subtle) throw new Error("Open ChatCode over HTTPS or localhost to join.");
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw",encoder.encode(code),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",salt:encoder.encode("chatcode-salt-v1"),iterations:100000,hash:"SHA-256"},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
export async function seal(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:"AES-GCM",iv},key,data);
  const result = new Uint8Array(12+cipher.byteLength);
  result.set(iv); result.set(new Uint8Array(cipher),12);
  return result;
}
export function unseal(key, bytes) {
  return crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.subarray(0,12)},key,bytes.subarray(12));
}
export async function encodeText(key, text) {
  return btoa(String.fromCharCode(...await seal(key,new TextEncoder().encode(text))));
}
export async function decodeText(key, encoded) {
  if (!encoded) return "";
  try { return new TextDecoder().decode(await unseal(key,Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)))); }
  catch { return "Unable to decrypt this message."; }
}
export async function upload(file,key,token,signal,progress) {
  progress("Encrypting attachment…",0);
  const data = await seal(key,await file.arrayBuffer());
  signal.throwIfAborted();
  return new Promise((resolve,reject) => {
    const req = new XMLHttpRequest();
    const abort = () => req.abort();
    signal.addEventListener("abort",abort,{once:true});
    req.open("POST","/api/files");
    req.timeout=90000;
    req.setRequestHeader("Authorization","Bearer "+token);
    req.setRequestHeader("Content-Type","application/octet-stream");
    req.setRequestHeader("X-File-Name",encodeURIComponent(file.name));
    req.responseType="json";
    req.upload.onprogress=e=>{
      const percent=e.lengthComputable ? Math.round(100*e.loaded/e.total) : 0;
      progress(percent===100 ? "Checking file…" : "Uploading "+percent+"%",percent);
    };
    req.onload=()=>req.status===201 ? resolve(req.response) : reject(new Error(req.response?.error || "Upload failed. Try again."));
    req.onerror=req.ontimeout=()=>reject(new Error("Upload interrupted. Your attachment is ready to retry."));
    req.onabort=()=>reject(new Error("Upload canceled."));
    req.onloadend=()=>signal.removeEventListener("abort",abort);
    req.send(data);
  });
}
export async function fetchFile(file,key,token,signal) {
  const res=await fetch("/api/files/"+encodeURIComponent(file.id),{headers:{Authorization:"Bearer "+token},cache:"no-store",signal});
  if (!res.ok) throw new Error(res.status===404 ? "This file has expired or was cleared." : "Download failed. Reconnect and try again.");
  return new Blob([await unseal(key,new Uint8Array(await res.arrayBuffer()))],{type:file.type});
}
