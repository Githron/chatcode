import { uploadLimit, formats, sizeLabel, roomKey, encodeText, decodeText, upload, fetchFile } from "./transfer.js";

import {musicPlayer} from "./music-player.js";
import {downloadBlob, imagePreview, isPreviewImage, releasePreviews as releaseImages} from "./image-preview.js";
import {videoPlayer, releaseVideo} from "./video-player.js";

function releasePreviews(root){releaseImages(root);releaseVideo(root);}
window.addEventListener("pagehide",()=>releaseVideo());

const $ = id => document.getElementById(id);
const socket = io();
const mobile = matchMedia("(max-width:720px)");
const history = $("history"), messages=$("messages"), input=$("message-input");
let room="", username="", key, token="", joining=false, sending=false;
let reply=null, file=null, filePreview="", stagedId="", clientId="", uploadController;
let epoch=0, connectionVersion=0, renderQueue=Promise.resolve(), typingTimer, noticeTimer;
let sharedDownloads=new AbortController(), typingSent=false;
const typists=new Map();
let ownAuthor="", syncing=false, pendingLive=[];
const seen=new Set();
function clientIdentity(){
  try{
    let identity=sessionStorage.getItem("chatcode-tab");
    if(!identity){identity=crypto.randomUUID();sessionStorage.setItem("chatcode-tab",identity);}
    return identity;
  }catch{return crypto.randomUUID();}
}
const make=(tag,cls,text)=>{
  const node=document.createElement(tag);
  if(cls) node.className=cls;
  if(text!==undefined) node.textContent=text;
  return node;
};
function icon(name){
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  const use=document.createElementNS(svg.namespaceURI,"use");
  svg.setAttribute("class","icon"); svg.setAttribute("aria-hidden","true");
  use.setAttribute("href","#i-"+name); svg.append(use); return svg;
}
function button(label,symbol,fn){
  const b=make("button"); b.type="button"; b.append(icon(symbol),document.createTextNode(label)); b.onclick=fn;return b;
}
function notice(text){
  $("notice").textContent=text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$("notice").textContent="",4200);
}
function emit(event,payload){
  if(!socket.connected) return Promise.reject(new Error("Connection lost. Reconnect and retry."));
  return new Promise((resolve,reject)=>socket.timeout(payload.attachmentId ? 70000 : 15000).emit(event,payload,(err,result)=>{
    if(err) reject(Object.assign(new Error("No confirmation yet. Reconnect and retry."),{timedOut:true}));
    else if(!result?.ok) reject(Object.assign(new Error(result?.error||"Please try again."),{result}));
    else resolve(result);
  }));
}
function controls(){
  $("join-btn").disabled=joining||!socket.connected;
  $("join-btn").querySelector("span").textContent=joining?"Joining…":"Join room";
  $("send-btn").disabled=sending||!token||(!file&&!input.value.trim());
  input.readOnly=sending; $("attach").disabled=sending; $("remove-file").disabled=sending; $("reply-cancel").disabled=sending;
}
const music=musicPlayer(socket,emit,notice,icon);
async function establish(name,code){
  const version=connectionVersion;
  const returning=Boolean(room);
  syncing=true;pendingLive=[];
  $("history-status").hidden=false;
  $("wake-status").textContent="Loading room history…";
  const newKey=key&&room===code?key:await roomKey(code);
  key=newKey;
  const result=await emit("join_room",{username:name,room:code,identity:clientIdentity()});
  if(version!==connectionVersion) throw new Error("Connection changed. Please try again.");
  if(typeof result.token !== "string" || !result.token || !Array.isArray(result.history)) {
    throw new Error("This server is running an older ChatCode version. Restart the server, then reload this page.");
  }
  username=name;room=code;token=result.token;
  const {musicPlayback,musicQueue,musicUploads}=result;
  music.join({room,key,token},{musicPlayback,musicQueue,musicUploads});
  $("header-room").textContent=$("room-display").textContent=room;
  $("network").textContent="Connected"; $("wake-status").textContent="";
  $("join-screen").hidden=true;$("chat-screen").hidden=false;
  ownAuthor=result.authorId;
  updateDrawer();
  const generation=epoch;
  const batch=document.createDocumentFragment();
  for(const data of result.history){
    if(version!==connectionVersion || generation!==epoch)break;
    batch.append(await messageNode(data));
  }
  if(version!==connectionVersion){releasePreviews(batch);return;}
  if(generation===epoch){
    const follow=!returning || atBottom();
    const edge=history.getBoundingClientRect().top;
    const anchor=returning&&!follow ? [...messages.querySelectorAll("[data-id]")].find(n=>n.getBoundingClientRect().bottom>edge) : null;
    const offset=anchor?.getBoundingClientRect().top, oldTop=history.scrollTop;
    const known=new Set(seen);
    seen.clear();for(const node of batch.children)seen.add(node.dataset.id);
    releasePreviews(messages);messages.replaceChildren(batch);$("empty").hidden=seen.size>0;
    if(follow)bottom();
    else {
      const restored=anchor && [...messages.children].find(n=>n.dataset.id===anchor.dataset.id);
      history.scrollTop=restored ? history.scrollTop+restored.getBoundingClientRect().top-offset : oldTop;
      if([...seen].some(id=>!known.has(id)))$("latest").hidden=false;
    }
  }else releasePreviews(batch);
  syncing=false;$("history-status").hidden=true;
  for(const data of pendingLive)queueMessage(data);
  pendingLive=[];
}
$("join-form").onsubmit=async e=>{
  e.preventDefault();if(joining)return;
  const name=$("username-input").value.trim(),code=$("room-code-input").value.trim();
  $("join-error").textContent="";
  for(const [id,value,re,error] of [
    ["username-input",name,/^[a-zA-Z0-9_.-]{1,20}$/,"Use 1–20 letters, numbers, dots, dashes, or underscores for your name."],
    ["room-code-input",code,/^[a-zA-Z0-9_-]{3,24}$/,"Use a 3–24 character room code with letters, numbers, dashes, or underscores."]]){
    $(id).removeAttribute("aria-invalid");
    if(!re.test(value)){ $(id).setAttribute("aria-invalid","true");$("join-error").textContent=error;$(id).focus();return; }
  }
  joining=true;controls();
  try{await establish(name,code);input.focus();}
  catch(err){$("join-error").textContent=err.message;syncing=false;$("history-status").hidden=true;$("wake-status").textContent="";}
  finally{joining=false;controls();}
};
socket.on("connect",async()=>{
  $("wake-status").textContent="";
  if(room){
    try{await establish(username,room);notice("Reconnected to "+room);}
    catch(err){$("network").textContent=err.message;syncing=false;$("history-status").hidden=true;}
  }
  controls();
});
socket.on("disconnect",()=>{
  music.disconnect();
  releaseVideo();
  connectionVersion++;epoch++;pendingLive=[];syncing=true;token="";stagedId="";uploadController?.abort();stopTyping();resetTypists();
  $("network").textContent="Reconnecting…";$("wake-status").textContent="Reconnecting…";controls();
});
socket.on("connect_error",()=>{$("wake-status").textContent="Connecting to the server…";controls();});
$("leave-btn").onclick=()=>location.reload();
$("clear-btn").onclick=async()=>{
  if(!confirm("Permanently delete the saved history and shared files for everyone in this room? This cannot be undone."))return;
  try{await emit("clear_chat",{room,confirm:true});}catch(err){notice(err.message);}
};
$("copy").onclick=async()=>{try{await navigator.clipboard.writeText(room);notice("Room code copied.");}catch{notice("Room code: "+room);}};
let drawerOpen=false;
function updateDrawer(open=false){
  drawerOpen=mobile.matches&&open;
  $("sidebar").classList.toggle("open",drawerOpen);
  $("sidebar").inert=mobile.matches&&!drawerOpen;
  $("backdrop").hidden=!drawerOpen;
  $("main-room").inert=drawerOpen;
  $("menu-toggle").setAttribute("aria-expanded",String(drawerOpen));
}
$("menu-toggle").onclick=()=>{updateDrawer(true);$("drawer-close").focus();};
function closeDrawer(){updateDrawer();$("menu-toggle").focus();}
$("drawer-close").onclick=$("backdrop").onclick=closeDrawer;
document.addEventListener("keydown",e=>{
  if(drawerOpen&&e.key==="Escape"){closeDrawer();return;}
  if(drawerOpen&&e.key==="Tab"){
    if(e.shiftKey&&document.activeElement===$("drawer-close")){e.preventDefault();$("leave-btn").focus();}
    else if(!e.shiftKey&&document.activeElement===$("leave-btn")){e.preventDefault();$("drawer-close").focus();}
  }
});
mobile.addEventListener("change",()=>updateDrawer());
socket.on("members_update",({members})=>{
  $("user-count").textContent=members.length;
  $("members-list").replaceChildren(...members.map(m=>{
    const self=m.id===socket.id, li=make("li","member"+(self?" self":""));
    const avatar=make("span","avatar",m.username.slice(0,2).toUpperCase());avatar.setAttribute("aria-hidden","true");
    li.append(avatar,make("span","member-name",m.username));if(self)li.append(make("small","","You"));return li;
  }));
});
function atBottom(){return history.scrollHeight-history.scrollTop-history.clientHeight<64;}
function bottom(){history.scrollTop=history.scrollHeight;$("latest").hidden=true;}
history.addEventListener("scroll",()=>{if(atBottom())$("latest").hidden=true;});
$("latest").onclick=bottom;
function append(node){
  const follow=atBottom();
  $("empty").hidden=true;messages.append(node);
  while(seen.size>100 || messages.children.length>200){
    const oldest=messages.firstElementChild;
    if(oldest.dataset.id)seen.delete(oldest.dataset.id);
    releasePreviews(oldest);oldest.remove();
  }
  if(follow)bottom();else $("latest").hidden=false;
}
function resetReply(){
  reply=null;$("reply-preview").hidden=true;
}
function chooseReply(author,text,id){
  if(sending)return;
  reply={id,username:author,message:text.slice(0,160)};
  $("reply-preview").querySelector("span").textContent="Reply to "+author+" · "+reply.message;
  $("reply-preview").hidden=false;clientId="";input.focus();
}
$("reply-cancel").onclick=()=>{resetReply();clientId="";input.focus();};
function resetFile(){
  if(filePreview)URL.revokeObjectURL(filePreview);
  filePreview="";file=null;stagedId="";$("file-input").value="";
  $("file-tray").hidden=true;$("file-thumb").replaceChildren();
}
$("attach").onclick=()=>$("file-input").click();
$("remove-file").onclick=()=>{resetFile();clientId="";controls();input.focus();};
$("file-input").onchange=e=>{
  const next=e.target.files[0];if(!next)return;
  if(!formats.test(next.name)||!next.size||next.size>uploadLimit(next.name)){
    $("send-error").textContent="Choose an image up to 8 MB, or an MP4, WebM, PDF, ZIP, Office or text file up to 10 MiB.";$("file-input").value="";return;
  }
  resetFile();file=next;clientId="";$("send-error").textContent="";
  if(/\.(png|jpe?g|webp|gif)$/i.test(file.name)){
    const img=make("img");filePreview=URL.createObjectURL(file);img.src=filePreview;img.alt="";$("file-thumb").append(img);
  }else $("file-thumb").append(icon("file"));
  $("file-detail").textContent=file.name+" · "+sizeLabel(file.size);$("file-tray").hidden=false;controls();input.focus();
};
function showProgress(label,percent){
  $("transfer").hidden=false;$("transfer").querySelector("progress").value=percent;$("transfer-label").textContent=label;
}
$("composer").onsubmit=async e=>{
  e.preventDefault();if(sending||!token||(!input.value.trim()&&!file))return;
  const generation=epoch, text=input.value.trim();
  clientId ||= crypto.randomUUID();
  sending=true;controls();stopTyping();$("send-error").textContent="";
  uploadController=new AbortController();
  try{
    if(file&&!stagedId)stagedId=(await upload(file,key,token,uploadController.signal,showProgress)).id;
    const payload={room,clientId,message:text?await encodeText(key,text):"",attachmentId:stagedId||undefined,
      reply:reply?{id:reply.id,username:reply.username,message:await encodeText(key,reply.message)}:null};
    if(generation!==epoch)throw new Error("The room was cleared. Review your draft and send again.");
    if(file)showProgress("Sending to room…",100);
    await emit("send_message",payload);
    input.value="";resetFile();resetReply();clientId="";
  }catch(err){
    if(/expired|room was cleared/i.test(err.message))stagedId="";
    $("send-error").textContent=err.message;
  }finally{sending=false;uploadController=null;$("transfer").hidden=true;controls();if(!drawerOpen&&!mobile.matches)input.focus();}
};
input.onkeydown=e=>{
  if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();$("composer").requestSubmit();}
  if(e.key==="Escape"&&!sending){resetReply();clientId="";}
};
function stopTyping(){
  clearTimeout(typingTimer);
  if(typingSent&&socket.connected&&token)socket.emit("typing_stop",{room});
  typingSent=false;
}
input.oninput=()=>{
  clientId="";controls();if(!token)return;
  if(!input.value){stopTyping();return;}
  if(!typingSent){socket.emit("typing_start",{room});typingSent=true;}
  clearTimeout(typingTimer);typingTimer=setTimeout(stopTyping,1400);
};
function showTypists(){
  const names=[...typists.values()].map(t=>t.name);
  $("typing").textContent=names.length===1?names[0]+" is typing…":names.length>1?"Several people are typing…":"";
}
function removeTypist(id){clearTimeout(typists.get(id)?.timer);typists.delete(id);showTypists();}
function resetTypists(){for(const id of [...typists.keys()])removeTypist(id);}
socket.on("user_typing",({id,username:name})=>{
  clearTimeout(typists.get(id)?.timer);
  typists.set(id,{name,timer:setTimeout(()=>removeTypist(id),4500)});showTypists();
});
socket.on("user_stopped_typing",({id})=>removeTypist(id));
socket.on("user_left",({id,message})=>{removeTypist(id);append(make("p","system",message));});
socket.on("user_joined",({message})=>append(make("p","system",message)));
socket.on("chat_cleared",({clearedBy})=>{
  epoch++;seen.clear();pendingLive=[];releasePreviews(messages);uploadController?.abort();sharedDownloads.abort();sharedDownloads=new AbortController();
  stagedId="";clientId="";resetReply();resetTypists();messages.replaceChildren();$("latest").hidden=true;
  if($("viewer").open)$("viewer").close();
  append(make("p","system",clearedBy+" cleared the conversation."));
});
function attachmentView(f){
  const wrap=make("div","attachment"), info=make("div","file-info"), summary=make("div");
  summary.append(make("strong","file-name",f.name),make("small","",sizeLabel(f.size)));
  info.append(icon("file"),summary);wrap.append(info);
  if(isPreviewImage(f)){
    wrap.prepend(imagePreview(f,()=>({key,token})));
  }else if(f.type==="video/mp4" || f.type==="video/webm"){
    wrap.classList.add("video-attachment");
    wrap.prepend(videoPlayer(f,()=>({key,token})));
  }
  wrap.append(button("Download","download",async e=>{
    const b=e.currentTarget, generation=epoch;b.disabled=true;
    try{
      const blob=await fetchFile(f,key,token,sharedDownloads.signal);
      if(generation===epoch)downloadBlob(blob,f.name);
    }catch(err){if(err.name!=="AbortError")notice(err.message);}
    finally{b.disabled=false;}
  }));
  return wrap;
}

async function messageNode(data){
    const own=data.authorId===ownAuthor, currentKey=key;
    const text=await decodeText(currentKey,data.message);
    const quoted=data.reply?await decodeText(currentKey,data.reply.message):"";
    const node=make("article","msg"+(own?" self":"")), meta=make("div","meta");
    node.dataset.id=data.id;
    const date=new Date(data.sentAt),time=make("time","",date.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));time.dateTime=date.toISOString();
    meta.append(make("strong","",own?"You":data.username),time);
    const bubble=make("div","bubble");
    if(data.reply)bubble.append(make("blockquote","",data.reply.username+" · "+quoted));
    if(data.attachment)bubble.append(attachmentView(data.attachment));
    if(text)bubble.append(make("p","",text));
    const action=button("Reply","reply",()=>chooseReply(data.username,text||data.attachment?.name||"Attachment",data.id));
    action.className="reply-action";action.setAttribute("aria-label","Reply to "+data.username);
    node.append(meta,bubble,action);return node;
}
function queueMessage(data){
  const generation=epoch;
  renderQueue=renderQueue.then(async()=>{
    if(generation!==epoch || seen.has(data.id))return;
    const node=await messageNode(data);
    if(generation!==epoch){releasePreviews(node);return;}
    seen.add(data.id);append(node);
  }).catch(()=>notice("This message could not be displayed."));
}
socket.on("receive_message",data=>{
  if(syncing)pendingLive.push(data);
  else queueMessage(data);
});
controls();
