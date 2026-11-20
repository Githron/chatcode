import { fetchFile } from "./transfer.js";

const rasterTypes=new Set(["image/jpeg","image/png","image/webp","image/gif"]);
export const isPreviewImage=file=>rasterTypes.has(file.type);
const viewer=document.getElementById("viewer");
const fullImage=document.getElementById("full-image");
const zoom=document.getElementById("viewer-zoom");
const visible=new Map();
let active=0, viewerUrl="", openedFrom, viewController;
const observer=new IntersectionObserver(entries=>{
  for(const entry of entries){
    const item=visible.get(entry.target);
    if(item)item.near=entry.isIntersecting;
  }
  pump();
},{root:document.getElementById("history"),rootMargin:"180px"});

export function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url;link.download=name;
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}

function pump(){
  for(const item of visible.values()){
    if(active>=3)break;
    if(!item.near || item.state!=="waiting" || !item.button.isConnected)continue;
    active++;
    item.state="loading";
    thumbnail(item).catch(()=>{
      if(!item.controller.signal.aborted){
        item.state="failed";item.button.textContent="Image unavailable · Retry";
        item.button.setAttribute("aria-label","Retry image preview for "+item.file.name);
      }
    }).finally(()=>{active--;item.button.removeAttribute("aria-busy");pump();});
  }
}

async function thumbnail(item){
  const {file,button}=item;
  const blob=await item.fetch(item.controller.signal);
  const original=URL.createObjectURL(blob);
  try{
    const source=new Image();source.src=original;await source.decode();
    if(item.controller.signal.aborted)return;
    const scale=Math.min(1,480/Math.max(source.naturalWidth,source.naturalHeight));
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(source.naturalWidth*scale));
    canvas.height=Math.max(1,Math.round(source.naturalHeight*scale));
    canvas.getContext("2d").drawImage(source,0,0,canvas.width,canvas.height);
    const small=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
    if(item.controller.signal.aborted)return;
    if(!small)throw new Error("Thumbnail conversion failed.");
    item.url=URL.createObjectURL(small);
    const image=document.createElement("img");image.alt=file.name;image.src=item.url;
    button.replaceChildren(image);button.classList.remove("skeleton");
    item.state="ready";observer.unobserve(button);
  }finally{URL.revokeObjectURL(original);}
}

function setZoom(enlarged){
  viewer.classList.toggle("zoomed",enlarged);
  zoom.setAttribute("aria-pressed",String(enlarged));
  zoom.textContent=enlarged?"Fit image":"Zoom in";
}
zoom.onclick=()=>setZoom(!viewer.classList.contains("zoomed"));
document.getElementById("close-viewer").onclick=()=>viewer.close();
viewer.onclose=()=>{
  viewController?.abort();URL.revokeObjectURL(viewerUrl);viewerUrl="";
  fullImage.removeAttribute("src");setZoom(false);
  document.getElementById("viewer-download").removeAttribute("href");
  if(openedFrom?.isConnected)openedFrom.focus();
};

async function openViewer(item){
  viewController?.abort();viewController=new AbortController();
  const signal=viewController.signal, file=item.file;
  openedFrom=item.button;
  document.getElementById("viewer-name").textContent=file.name;
  const status=document.getElementById("viewer-status");
  status.textContent="Loading original image…";
  fullImage.alt=file.name;zoom.disabled=true;viewer.showModal();
  try{
    const original=await item.fetch(signal);
    if(signal.aborted || !viewer.open)return;
    viewerUrl=URL.createObjectURL(original);fullImage.src=viewerUrl;await fullImage.decode();
    if(signal.aborted || !viewer.open)return;
    const download=document.getElementById("viewer-download");
    download.href=viewerUrl;download.download=file.name;zoom.disabled=false;status.textContent="";
  }catch{if(!signal.aborted)status.textContent="The original image could not be loaded. Close and retry.";}
}

export function imagePreview(file,session){
  const button=document.createElement("button");
  button.type="button";button.className="thumbnail skeleton";button.textContent="Loading image…";
  button.setAttribute("aria-label","Open image "+file.name);button.setAttribute("aria-busy","true");
  const item={file,button,near:false,state:"waiting",controller:new AbortController(),
    fetch:signal=>{const {key,token}=session();return fetchFile(file,key,token,signal);}};
  visible.set(button,item);observer.observe(button);
  button.onclick=()=>{
    if(item.state==="failed"){
      item.state="waiting";button.textContent="Loading image…";button.setAttribute("aria-busy","true");
      button.setAttribute("aria-label","Open image "+file.name);pump();
    }else void openViewer(item);
  };
  return button;
}
export function releasePreviews(root){
  for(const button of root.querySelectorAll(".thumbnail")){
    const item=visible.get(button);
    if(!item)continue;
    observer.unobserve(button);item.controller.abort();
    if(item.url)URL.revokeObjectURL(item.url);
    visible.delete(button);
  }
}
