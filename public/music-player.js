import {roomAudio} from "./room-audio.js";
import {fileLimit, sizeLabel, upload} from "./transfer.js";

const $=id=>document.getElementById(id);
const time=ms=>{
  const seconds=Math.floor(Math.max(0,ms || 0)/1000);
  return Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");
};

export function musicPlayer(socket, emit, notice, icon) {
  let session, flags={}, state, catalog, usage, tab="queue", open=false;
  let commandBusy=false, transfer, loading=false, dragging=false, viewKey="";
  let readVersion=0, refreshTimer;
  const panel=$("room-music"), seek=$("music-seek"), list=$("music-tracks");
  const audio=roomAudio($("listen-btn"),$("resume-audio"),socket,emit,notice,accept,progress);

  function feedback(message) {
    $("music-feedback").textContent=message;
    if (!open && message) notice(message);
  }
  function accept(snapshot) {
    state=snapshot;
    playerControls();
  }
  function progress() {
    const duration=state?.duration_ms || 0;
    const position=dragging ? Number(seek.value) : audio.position();
    if (!dragging) seek.value=String(Math.round(position));
    seek.setAttribute("aria-valuetext",time(position)+" of "+time(duration));
    const detail=!session ? "Reconnecting…" : !state ? "Loading player…" :
      state.current_entry ? (audio.status || (state.playing ? "Playing" : "Paused"))+" · "+time(position)+" / "+time(duration) :
      "No track selected";
    if ($("playing-detail").textContent!==detail) $("playing-detail").textContent=detail;
  }
  function playerControls() {
    $("mini-player").hidden=!flags.musicPlayback;
    if (!flags.musicPlayback) return;
    $("playing-name").textContent=state?.filename || "Room music";
    const play=$("music-play"), action=state?.playing ? "pause" : "play";
    play.setAttribute("aria-label",(state?.playing ? "Pause" : "Play")+" for room");
    play.querySelector("use").setAttribute("href","#i-"+action);
    play.disabled=!session || !state || commandBusy || (!state.current_entry && catalog?.revision===state.revision && !catalog.queue.length);
    for (const id of ["music-previous","music-next","music-seek"])
      $(id).disabled=!session || !state?.current_entry || commandBusy;
    seek.max=String(state?.duration_ms || 0);
    progress();
  }

  function view(show,focus=false) {
    open=show;
    panel.hidden=!show;
    $("history").hidden=show;
    document.querySelector(".composer-wrap").hidden=show;
    $("music-view-toggle").setAttribute("aria-expanded",String(show));
    $("music-view-toggle").querySelector("span").textContent=show ? "Chat" : "Music";
    $("music-view-toggle").querySelector("use").setAttribute("href",show ? "#i-chat" : "#i-music");
    if (show) {
      if (focus) $("music-heading").focus();
      refresh();
    } else if (focus) $("music-view-toggle").focus();
  }
  $("music-view-toggle").onclick=()=>view(!open,true);
  $("player-toggle").onclick=()=>{
    const controls=$("player-controls"), button=$("player-toggle");
    controls.hidden=!controls.hidden;
    button.setAttribute("aria-expanded",String(!controls.hidden));
    button.setAttribute("aria-label",controls.hidden ? "Expand player" : "Collapse player");
  };

  function rowButton(action,label,symbol) {
    const button=document.createElement("button");
    button.type="button";
    button.dataset.action=action;
    button.setAttribute("aria-label",label);
    button.title=label;
    if (symbol) button.append(icon(symbol)); else button.textContent=label;
    return button;
  }
  function draw() {
    const queue=tab==="queue", tracks=(queue ? catalog?.queue : catalog?.tracks) || [];
    $("show-queue").hidden=!flags.musicQueue;
    $("show-queue").setAttribute("aria-pressed",String(queue));
    $("show-queue").textContent="Queue"+(catalog ? " ("+catalog.queue.length+")" : "");
    $("show-library").setAttribute("aria-pressed",String(!queue));
    $("more-tracks").hidden=queue || !catalog?.nextTrackCursor;
    $("more-tracks").disabled=loading || !session;
    $("music-upload").hidden=$("music-limit").hidden=!flags.musicUploads;
    $("music-upload").disabled=!session || !!transfer;
    $("music-usage").textContent=usage ? sizeLabel(usage.used)+" of "+(usage.limit/1024**3)+" GiB room music storage used" : loading ? "Checking music storage…" : "Music storage unavailable";
    $("music-meter").hidden=!usage;
    if (usage) { $("music-meter").max=usage.limit; $("music-meter").value=usage.used; }
    $("music-collection").setAttribute("aria-busy",String(loading));
    $("music-empty").textContent=!session ? "Reconnecting to the room…" : !catalog ? (loading ? "Loading room music…" : "Room music unavailable.") :
      tracks.length ? "" : queue ? "The queue is empty. Add a track from the library." :
      flags.musicUploads ? "Your library is empty. Upload an MP3 to get started." : "The room library is empty.";
    const current=catalog?.current_entry;
    const key=JSON.stringify([tab,tracks,current]);
    if (viewKey!==key) {
      const focused=document.activeElement, row=focused?.closest("#music-tracks li");
      const openId=list.querySelector("details[open]")?.closest("li").dataset.id;
      viewKey=key;
      const fragment=document.createDocumentFragment();
      tracks.forEach((track,index)=>{
        const item=document.createElement("li"), id=queue ? track.entry_id : track.track_id;
        item.dataset.id=id;
        const number=document.createElement("span");
        number.className="track-number";
        if (queue) number.textContent=String(index+1).padStart(2,"0"); else number.append(icon("music"));
        const title=queue ? rowButton("select","Select "+track.filename) : document.createElement("span");
        title.className="track-name"; title.textContent=track.filename; title.title=track.filename;
        if (queue && id===current) item.setAttribute("aria-current","true");
        const length=document.createElement("small"); length.textContent=time(track.duration_ms);
        item.append(number,title,length);
        if (!queue && flags.musicQueue) item.append(rowButton("add","Add "+track.filename+" to queue","plus"));
        if (flags.musicQueue && (queue || flags.musicUploads)) {
          const details=document.createElement("details"), summary=document.createElement("summary");
          summary.setAttribute("aria-label","Actions for "+track.filename); summary.title="Track actions"; summary.append(icon("more"));
          const actions=document.createElement("div"); actions.className="track-actions";
          if (queue && index>0) actions.append(rowButton("up","Move up"));
          if (queue && index+1<tracks.length) actions.append(rowButton("down","Move down"));
          actions.append(rowButton(queue ? "remove" : "deleteTrack",queue ? "Remove from queue" : "Delete from library"));
          details.append(summary,actions); details.open=id===openId;
          item.append(details);
        }
        fragment.append(item);
      });
      list.replaceChildren(fragment);
      if (row) {
        const target=Array.from(list.children).find(el=>el.dataset.id===row.dataset.id);
        const control=focused.dataset.action && target?.querySelector('[data-action="'+focused.dataset.action+'"]');
        (control || target?.querySelector("summary") || $("show-"+tab)).focus({preventScroll:true});
      }
    }
    for (const button of list.querySelectorAll("button")) button.disabled=!session || commandBusy;
    playerControls();
  }
  for (const name of ["queue","library"]) $("show-"+name).onclick=()=>{
    tab=name; draw();
  };

  async function refresh(more=false) {
    if (!session || (!flags.musicQueue && !flags.musicUploads)) return;
    const version=++readVersion, previous=catalog;
    loading=true; draw();
    try {
      const result=await emit(flags.musicQueue ? "music_queue_get" : "music_library_get",{
        room:session.room,includeUsage:true,afterTrackId:more ? previous?.nextTrackCursor : null
      });
      if (version!==readVersion) return;
      if (catalog && BigInt(result.snapshot.revision)<BigInt(catalog.revision)) return;
      if (more && previous.revision!==result.snapshot.revision) return refresh();
      catalog=result.snapshot;
      if (more) catalog.tracks=[...previous.tracks,...catalog.tracks];
      usage=result.usage;
    } catch(err) {
      if (version===readVersion) feedback(err.message+" Reopen Music to refresh.");
    } finally {
      if (version===readVersion) {loading=false;draw();}
    }
  }
  function changed() {
    if (!open) return;
    clearTimeout(refreshTimer);
    refreshTimer=setTimeout(()=>refresh(),90);
  }
  socket.on("music_library_changed",changed);
  socket.on("music_queue_changed",changed);
  socket.on("chat_cleared",changed);
  socket.on("receive_message",message=>{if (message.attachment) changed();});
  $("more-tracks").onclick=()=>refresh(true);

  async function command(event,action,fields={}) {
    const current=session;
    if (!current || commandBusy) return;
    const playback=event==="music_playback_command";
    const expectedRevision=(playback ? state : catalog)?.revision;
    if (expectedRevision===undefined) return;
    const data={room:current.room,action,...fields,expectedRevision,commandId:crypto.randomUUID()};
    commandBusy=true; feedback(""); draw();
    try {
      let result;
      try {result=await emit(event,data);}
      catch(err) {
        if (!err.timedOut || session!==current) throw err;
        result=await emit(event,data); // The original receipt protects a lost acknowledgement.
      }
      if (session!==current) return;
      if (playback) audio.accept(result.snapshot);
      else {
        if (!catalog || BigInt(result.snapshot.revision)>=BigInt(catalog.revision)) catalog=result.snapshot;
        if (action==="add") feedback("Added to the queue.");
      }
    } catch(err) {
      if (session===current) {
        feedback(err.result?.code==="stale_revision" ? "The room changed. Review the updated tracks and try again." : err.message);
        if (err.result?.snapshot && playback) audio.accept(err.result.snapshot);
        await refresh();
      }
    } finally {
      if (session===current) {commandBusy=false;draw();}
    }
  }
  const transport=(action,fields)=>command("music_playback_command",action,fields);
  $("music-play").onclick=()=>transport(state?.playing ? "pause" : "play");
  $("music-next").onclick=()=>transport("next");
  $("music-previous").onclick=()=>transport("previous");
  seek.oninput=()=>{dragging=true;progress();};
  seek.onchange=()=>{dragging=false;transport("seek",{positionMs:Number(seek.value)});};
  seek.onkeydown=event=>{
    if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const forward=event.key==="ArrowRight" || event.key==="ArrowUp";
    const step=Math.min(5000,Math.max(1,Math.round(Number(seek.max)/10)));
    seek.value=String(Number(seek.value)+(forward ? step : -step));
    seek.onchange();
  };
  seek.onpointercancel=seek.onblur=()=>{dragging=false;};
  list.onclick=event=>{
    const button=event.target.closest("button[data-action]");
    if (!button || !catalog) return;
    const action=button.dataset.action,id=button.closest("li").dataset.id;
    const menu=button.closest("details");
    if (menu) {menu.open=false;menu.querySelector("summary").focus();}
    if (action==="deleteTrack" && !confirm("Delete this MP3 from the room library and every queue entry?")) return;
    if (action==="up" || action==="down") {
      const entryIds=catalog.queue.map(entry=>entry.entry_id);
      const from=entryIds.indexOf(id),to=from+(action==="up" ? -1 : 1);
      if (from<0 || to<0 || to>=entryIds.length) return;
      [entryIds[from],entryIds[to]]=[entryIds[to],entryIds[from]];
      command("music_queue_command","reorder",{entryIds});
    } else command("music_queue_command",action,tab==="queue" ? {entryId:id} : {trackId:id});
  };
  $("music-upload").onclick=()=>$("music-file").click();
  $("music-file").onchange=async event=>{
    const file=event.target.files[0],current=session;
    event.target.value="";
    if (!file || !current || transfer) return;
    if (!/\.mp3$/i.test(file.name) || !file.size || file.size>fileLimit) {
      feedback("Choose a nonempty MP3 up to 10 MiB.");return;
    }
    const controller=new AbortController();transfer=controller;
    feedback("");draw(); $("music-transfer").hidden=false;
    try {
      await upload(file,current.key,current.token,controller.signal,(label,percent)=>{
        if (session!==current) return;
        $("music-transfer").querySelector("progress").value=percent;
        $("music-transfer-label").textContent=label;
      },"/api/music/tracks");
      if (session!==current) return;
      tab="library";feedback(file.name+" is in the library.");
      await refresh();
    } catch(err) {if (session===current) feedback(err.message);}
    finally {
      if (transfer===controller) {transfer=null;$("music-transfer").hidden=true;draw();}
    }
  };

  return {
    join(current,capabilities) {
      session=current; flags=capabilities;
      if (!flags.musicQueue) tab="library";
      $("music-view-toggle").hidden=!flags.musicQueue && !flags.musicUploads;
      if ($("music-view-toggle").hidden && open) view(false);
      audio.join(flags.musicPlayback ? current : null);
      if (open || flags.musicQueue) refresh();
      draw();
    },
    disconnect() {
      session=null; state=catalog=usage=null; commandBusy=loading=dragging=false;
      ++readVersion; clearTimeout(refreshTimer);
      transfer?.abort();transfer=null;$("music-transfer").hidden=true;
      audio.disconnect(); draw();
    }
  };
}
