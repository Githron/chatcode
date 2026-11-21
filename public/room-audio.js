import {unseal} from "./transfer.js";

export function roomAudio(button, resume, socket, emit, notice, onState, onTick) {
  let session, snapshot, frame, audio, track, request, blobUrl, timer;
  let listening=false, blocked=false, starting=false, reposition=true, retryAt=0;
  const volume=document.getElementById("music-volume"), mute=document.getElementById("music-mute");
  let muted=false;
  let offset=null, lastSync=-Infinity, syncing=false;

  function label() {
    button.hidden=!session;
    button.setAttribute("aria-pressed",String(listening));
    resume.hidden=!blocked || !snapshot?.playing;
    button.textContent=listening ? "Listening" : "Listen Together";
    button.title=listening ? "Stop listening on this device" : "Listen on this device";
    volume.disabled=mute.disabled=!listening || !session;
    mute.textContent=muted ? "Unmute" : "Mute";
    mute.setAttribute("aria-pressed",String(muted));
  }
  function clearTrack() {
    request?.abort();
    request=null;
    track=null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl=null;
    starting=false;
    blocked=false;
    retryAt=0;
    reposition=true;
  }
  function stop() {
    clearTrack();
    if (frame) {frame.onload=null;frame.remove();}
    frame=audio=null;
    label();
  }
  function fail(message) {
    listening=false;
    stop();
    notice(message);
  }
  function position() {
    if (!snapshot) return 0;
    const now=offset===null ? Date.now() : performance.now()+offset;
    const elapsed=snapshot.playing ? Math.max(0,now-Date.parse(snapshot.anchor_time)) : 0;
    return Math.min(snapshot.duration_ms || 0,snapshot.position_ms+elapsed);
  }
  function align() {
    if (!audio || !snapshot || !blobUrl || audio.readyState<1 || offset===null) return;
    const duration=Math.min(audio.duration,snapshot.duration_ms/1000);
    const target=Math.min(duration,position()/1000);
    if (reposition || Math.abs(audio.currentTime-target)>0.12) audio.currentTime=target;
    reposition=false;
    if (!snapshot.playing || target>=duration || audio.ended && duration-audio.currentTime<0.12) {
      audio.pause();
      return;
    }
    if (!audio.paused || blocked || starting) return;
    starting=true;
    const source=request;
    audio.play().catch(err=>{
      if (request!==source || err.name==="AbortError") return;
      if (err.name==="NotAllowedError") {
        blocked=true;
        label();
        notice("Tap Start room audio to allow playback on this device.");
      } else fail("Audio could not play. Tap Listen Together to retry.");
    }).finally(()=>{if (request===source) starting=false;});
  }

  async function update() {
    if (!session || !listening || !audio || !snapshot) return;
    if (track!==snapshot.track_id) {
      clearTrack();
      track=snapshot.track_id;
      label();
    }
    if (request) {align();return;}
    if (!track || !snapshot.playing || muted || performance.now()<retryAt) return;
    const controller=new AbortController();
    request=controller;
    const {key,token}=session;
    try {
      const res=await fetch("/api/music/tracks/"+encodeURIComponent(track),{
        headers:{Authorization:"Bearer "+token},cache:"no-store",signal:controller.signal
      });
      if (request!==controller) return;
      if (res.status===429 || res.status===503) {
        request=null;
        retryAt=performance.now()+1500+Math.random()*1000;
        return;
      }
      if (!res.ok) throw new Error();
      const bytes=await unseal(key,new Uint8Array(await res.arrayBuffer()));
      if (request!==controller) return;
      blobUrl=URL.createObjectURL(new Blob([bytes],{type:"audio/mpeg"}));
      audio.src=blobUrl;
    } catch {
      if (request===controller) fail("Room audio could not be loaded. Tap Listen Together to retry.");
    }
  }
  function accept(state) {
    if (!session || (snapshot && BigInt(state.revision)<BigInt(snapshot.revision))) return;
    if (snapshot?.current_entry!==state.current_entry || snapshot?.anchor_time!==state.anchor_time ||
        snapshot?.position_ms!==state.position_ms) reposition=true;
    snapshot=state;
    onState(state);
    if (blocked) label();
    update();
  }
  socket.on("music_playback_snapshot",accept);

  async function synchronize() {
    if (syncing || !session) return;
    const current=session, {room}=session;
    syncing=true;
    lastSync=performance.now();
    try {
      // The lowest round trip is least affected by asymmetric queuing.
      let shortest=Infinity, bestOffset;
      for (let i=0;i<3;i++) {
        const sent=performance.now();
        const {serverTimeMs}=await emit("music_clock",{room});
        if (current!==session) return;
        const received=performance.now(), rtt=received-sent;
        if (rtt<shortest) {
          bestOffset=serverTimeMs-(sent+received)/2;
          shortest=rtt;
        }
      }
      offset=bestOffset;
      const result=await emit("music_playback_get",{room});
      if (current===session) accept(result.snapshot);
    } catch {
      if (current===session) lastSync=performance.now()-8000;
    } finally { if (current===session) syncing=false; }
  }
  function start() {
    frame=document.createElement("iframe");
    frame.title="Room audio";
    frame.hidden=true;
    frame.setAttribute("sandbox","allow-same-origin");
    frame.onload=()=>{
      audio=frame.contentDocument?.querySelector("audio");
      if (!audio) return fail("The room audio player could not open.");
      audio.volume=Number(volume.value)/100;
      audio.muted=muted;
      audio.onloadedmetadata=audio.oncanplay=align;
      audio.onerror=()=>{if (blobUrl) fail("This MP3 could not be decoded on this device.");};
      update();
    };
    frame.src="/audio-player.html";
    button.after(frame);
    label();
  }
  volume.oninput=()=>{
    if (!audio) return;
    const requested=Number(volume.value)/100;
    audio.volume=requested;
    if (Math.abs(audio.volume-requested)>.01) {
      volume.value=String(Math.round(audio.volume*100));
      notice("Use your device volume buttons to adjust this browser’s audio.");
    }
  };
  mute.onclick=()=>{
    muted=!muted;
    if (audio) audio.muted=muted;
    label();
    update();
  };
  resume.onclick=()=>{blocked=false;label();align();};
  button.onclick=()=>{
    if (!session) return;
    listening=!listening;
    if (listening) start(); else stop();
  };
  document.addEventListener("visibilitychange",()=>{
    if (session && !document.hidden) synchronize();
  });
  window.addEventListener("pagehide",()=>{listening=false;stop();});
  return {
    accept,
    position,
    get status() {
      if (!listening || !snapshot?.playing || muted) return "";
      if (blocked) return "Audio needs a tap";
      if (retryAt>performance.now()) return "Audio busy · retrying";
      return !blobUrl || !audio || audio.readyState<2 ? "Loading audio…" : "";
    },
    join(current) {
      session=current;
      clearInterval(timer);
      if (current) {
        synchronize();
        timer=setInterval(()=>{
          const sampleInterval=snapshot && !snapshot.playing ? 60000 : 10000;
          if (performance.now()-lastSync>sampleInterval) synchronize();
          update();
          if (snapshot?.playing && !document.hidden) onTick();
        },250);
      } else listening=false;
      if (listening && current) start(); else label();
    },
    disconnect() {
      clearInterval(timer);
      syncing=false;
      offset=null;
      lastSync=-Infinity;
      session=snapshot=null;
      stop();
    }
  };
}
