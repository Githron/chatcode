import {unseal} from "./transfer.js";

export function roomAudio(button, resume, socket, emit, notice) {
  let session, snapshot, frame, audio, track, request, blobUrl, timer;
  let listening=false, blocked=false, starting=false, reposition=true, retryAt=0;
  let offset=null, lastSync=-Infinity, syncing=false;

  function label() {
    button.hidden=!session;
    button.setAttribute("aria-pressed",String(listening));
    resume.hidden=!blocked || !snapshot?.playing;
    button.textContent=listening ? "Mute room audio" : "Listen to room music";
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
    clearInterval(timer);
    clearTrack();
    if (frame) {frame.onload=null;frame.remove();}
    frame=audio=null;
    syncing=false;
    offset=null;
    lastSync=-Infinity;
    label();
  }
  function fail(message) {
    listening=false;
    stop();
    notice(message);
  }
  function align() {
    if (!audio || !snapshot || !blobUrl || audio.readyState<1 || offset===null) return;
    const elapsed=snapshot.playing ? Math.max(0,performance.now()+offset-Date.parse(snapshot.anchor_time)) : 0;
    const duration=Math.min(audio.duration,snapshot.duration_ms/1000);
    const target=Math.min(duration,(snapshot.position_ms+elapsed)/1000);
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
      } else fail("Audio could not play. Tap Listen to room music to retry.");
    }).finally(()=>{if (request===source) starting=false;});
  }

  async function update() {
    if (!session || !listening || !audio || !snapshot) return;
    if (track===snapshot.track_id && (track===null || request)) {align();return;}
    if (track===snapshot.track_id && performance.now()<retryAt) return;
    clearTrack();
    label();
    track=snapshot.track_id;
    if (!track) return;
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
      if (request===controller) fail("Room audio could not be loaded. Tap Listen to room music to retry.");
    }
  }
  function accept(state) {
    if (!session || (snapshot && BigInt(state.revision)<BigInt(snapshot.revision))) return;
    if (snapshot?.current_entry!==state.current_entry || snapshot?.anchor_time!==state.anchor_time ||
        snapshot?.position_ms!==state.position_ms) reposition=true;
    snapshot=state;
    if (blocked) label();
    update();
  }
  socket.on("music_playback_snapshot",accept);

  async function synchronize() {
    if (syncing || !frame) return;
    const current=frame, {room}=session;
    syncing=true;
    lastSync=performance.now();
    try {
      // The lowest round trip is least affected by asymmetric queuing.
      let shortest=Infinity, bestOffset;
      for (let i=0;i<3;i++) {
        const sent=performance.now();
        const {serverTimeMs}=await emit("music_clock",{room});
        if (current!==frame) return;
        const received=performance.now(), rtt=received-sent;
        if (rtt<shortest) {
          bestOffset=serverTimeMs-(sent+received)/2;
          shortest=rtt;
        }
      }
      offset=bestOffset;
      const result=await emit("music_playback_get",{room});
      if (current===frame) accept(result.snapshot);
    } catch {
      if (current===frame) lastSync=performance.now()-8000;
    } finally { if (current===frame) syncing=false; }
  }
  function start() {
    frame=document.createElement("iframe");
    frame.title="Room audio";
    frame.hidden=true;
    frame.setAttribute("sandbox","allow-same-origin");
    frame.onload=()=>{
      audio=frame.contentDocument?.querySelector("audio");
      if (!audio) return fail("The room audio player could not open.");
      audio.onloadedmetadata=audio.oncanplay=align;
      audio.onerror=()=>{if (blobUrl) fail("This MP3 could not be decoded on this device.");};
      update();
    };
    frame.src="/audio-player.html";
    button.after(frame);
    synchronize();
    timer=setInterval(()=>{
      if (performance.now()-lastSync>10000) synchronize();
      update();
    },250);
    label();
  }
  resume.onclick=()=>{blocked=false;label();align();};
  button.onclick=()=>{
    if (!session) return;
    listening=!listening;
    if (listening) start(); else stop();
  };
  document.addEventListener("visibilitychange",()=>{
    if (listening && !document.hidden) synchronize();
  });
  window.addEventListener("pagehide",()=>{listening=false;stop();});
  return {
    join(current) {
      session=current;
      if (!current) listening=false;
      if (listening && current) start(); else label();
    },
    disconnect() {
      session=snapshot=null;
      stop();
    }
  };
}
