import {fetchFile} from "./transfer.js";

let active;

export function releaseVideo(root) {
  if (active && (!root || root.contains(active.card))) active.reset();
}

export function videoPlayer(file, session) {
  const card=document.createElement("div");
  card.className="clip-player";
  const button=document.createElement("button");
  button.type="button";
  button.className="clip-play";
  button.textContent="Play video";
  button.setAttribute("aria-label","Play "+file.name);
  const status=document.createElement("p");
  status.setAttribute("role","status");
  card.append(button,status);

  button.onclick=()=>{
    releaseVideo();
    const {key,token}=session();
    if (!token) {status.textContent="Reconnect to play this clip.";return;}
    const controller=new AbortController();
    const focusPlayer=document.activeElement===button;
    const frame=document.createElement("iframe");
    frame.title="Video player for "+file.name;
    frame.setAttribute("sandbox","allow-same-origin");
    frame.allowFullscreen=true;
    let url="",video;
    const reset=()=>{
      controller.abort();
      if (video) {
        video.onerror=null;video.onplaying=null;video.onloadedmetadata=null;
        video.pause();video.removeAttribute("src");video.load();
      }
      frame.onload=null;frame.onerror=null;frame.remove();
      if (url) URL.revokeObjectURL(url);
      active=null;button.hidden=false;button.disabled=false;
      status.textContent="";card.removeAttribute("aria-busy");
    };
    const failed=(message)=>{
      if (controller.signal.aborted) return;
      const hadFocus=document.activeElement===frame || (focusPlayer && document.activeElement===document.body);
      reset();status.textContent=message;
      if (hadFocus) button.focus({preventScroll:true});
    };
    active={card,reset};
    button.disabled=true;card.setAttribute("aria-busy","true");
    status.textContent="Loading video…";
    frame.hidden=true;
    frame.onerror=()=>failed("Player unavailable. Retry or download the clip.");
    frame.onload=async()=>{
      try {
        video=frame.contentDocument?.querySelector("video");
        if (!video || !video.canPlayType(file.type)) {
          failed("This browser cannot play this format. Download the clip to open it.");return;
        }
        const blob=await fetchFile(file,key,token,controller.signal);
        if (controller.signal.aborted) return;
        url=URL.createObjectURL(blob);
        video.onerror=()=>failed("This clip could not be decoded. Download it to open in another player.");
        video.onloadedmetadata=()=>{
          if (!video.videoWidth) failed("This browser cannot decode the video track. Download the original clip.");
        };
        video.onplaying=()=>{status.textContent="";};
        video.src=url;
        frame.hidden=false;button.hidden=true;
        card.removeAttribute("aria-busy");status.textContent="";
        if (focusPlayer && document.activeElement===document.body) video.focus({preventScroll:true});
        try {await video.play();}
        catch (err) {
          if (controller.signal.aborted) return;
          if (err.name==="NotAllowedError") status.textContent="Ready. Use the player’s play button.";
          else if (err.name!=="AbortError") failed("This clip could not be played. Download it to open in another player.");
        }
      } catch {failed("Video could not be loaded. Reconnect and retry, or download the clip.");}
    };
    frame.src="/video-player.html";
    card.prepend(frame);
  };
  return card;
}
