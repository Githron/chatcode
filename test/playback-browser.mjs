// Opt-in integration check using two fresh Chromium sessions on a local WebDriver.
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";

async function webdriver(path, method, body) {
  const response=await fetch(process.env.CHATCODE_TEST_WEBDRIVER+path,{
    method,signal:AbortSignal.timeout(60000),headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
  });
  const {value}=await response.json();
  if (!response.ok) throw new Error(value.message);
  return value;
}

async function browser(t, url, room, name) {
  const options={args:["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--window-size=1100,800"]};
  if (process.env.CHATCODE_TEST_CHROMIUM) options.binary=process.env.CHATCODE_TEST_CHROMIUM;
  const {sessionId}=await webdriver("/session","POST",{capabilities:{
    alwaysMatch:{browserName:"chrome","goog:chromeOptions":options}
  }});
  const path="/session/"+sessionId;
  t.after(()=>webdriver(path,"DELETE"));
  const run=(script,...args)=>webdriver(path+"/execute/sync","POST",{script,args});
  const click=async selector=>{
    const element=await webdriver(path+"/element","POST",{using:"css selector",value:selector});
    await webdriver(path+"/element/"+element["element-6066-11e4-a52e-4f735466cecf"]+"/click","POST",{});
  };
  if (name==="BrowserB") await webdriver(path+"/goog/cdp/execute","POST",{
    cmd:"Emulation.setDeviceMetricsOverride",params:{width:390,height:844,deviceScaleFactor:1,mobile:true}
  });
  await webdriver(path+"/url","POST",{url});
  await run(`document.querySelector("#username-input").value=arguments[0];
    document.querySelector("#room-code-input").value=arguments[1]`,name,room);
  await click("#join-btn");
  return {run,click,acceptDialog:()=>webdriver(path+"/alert/accept","POST",{})};
}

async function until(check, message) {
  const deadline=Date.now()+10000;
  while (Date.now()<deadline) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(message);
}

export async function playbackBrowser(t, url, room, bytes, restart, samples) {
  const [a,b]=await Promise.all([browser(t,url,room,"BrowserA"),browser(t,url,room,"BrowserB")]);
  const audio=`document.querySelector('iframe[src="/audio-player.html"]')?.contentDocument?.querySelector("audio")`;
  async function waitFor(page,selector) {
    await until(()=>page.run("return !!document.querySelector(arguments[0])",selector),selector);
  }
  async function range(page,id,value) {
    await page.run(`const input=document.getElementById(arguments[0]);input.value=arguments[1];
      input.dispatchEvent(new Event("input"));input.dispatchEvent(new Event("change"))`,id,value);
  }
  async function uploadMusic(name) {
    await a.run(`const input=document.querySelector("#music-file"), files=new DataTransfer();
      files.items.add(new File([Uint8Array.from(atob(arguments[1]),c=>c.charCodeAt(0))],arguments[0]));
      input.files=files.files; input.dispatchEvent(new Event("change"))`,name,bytes.toString("base64"));
    await until(()=>a.run('return document.querySelector("#music-feedback").textContent.includes(arguments[0])',name),"published "+name);
  }
  for (const page of [a,b]) {
    await page.run(`window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL=url=>{revoked.push(url);revoke(url);}`);
    await page.click("#music-view-toggle");
    await page.click("#show-library");
  }
  await until(()=>b.run('return document.querySelector("#music-empty").textContent.includes("library is empty")'),"empty library");
  await a.run(`const input=document.querySelector("#music-file"), files=new DataTransfer();
    files.items.add(new File([new Uint8Array(10485761)],"oversize.mp3"));
    input.files=files.files; input.dispatchEvent(new Event("change"))`);
  await until(()=>a.run('return document.querySelector("#music-feedback").textContent.includes("10 MiB")'),"upload limit");
  const names=["Night Drive.mp3","After Hours.mp3"];
  for (const name of names) {
    await uploadMusic(name);
    const add='button[aria-label="Add '+name+' to queue"]';
    await waitFor(b,add);
    await a.click(add);
    await until(()=>a.run('return document.querySelector("#music-feedback").textContent.includes("Added")'),"queued "+name);
  }
  assert.ok(await b.run('return document.querySelector("#music-meter").value>0'));
  for (const page of [a,b]) await page.click("#show-queue");
  await b.click("li:nth-child(2) summary");await b.click('button[data-action="up"]');
  await until(()=>a.run('return document.querySelector(".track-name").textContent==="After Hours.mp3"'),"remote reorder");
  await a.click('button[aria-label="Select Night Drive.mp3"]');
  await until(()=>b.run('return document.querySelector("#playing-name").textContent==="Night Drive.mp3"'),"first paused selection");
  await a.click('button[aria-label="Select After Hours.mp3"]');
  for (const page of [a,b]) {
    await until(()=>page.run('return document.querySelector("#playing-name").textContent==="After Hours.mp3" && document.querySelector("#playing-detail").textContent.startsWith("Paused · 0:00")'),"paused switch on both devices");
    assert.equal(await page.run("return Boolean("+audio+")"),false);
  }
  await a.click("#music-play");
  for (const page of [a,b]) await page.click("#music-view-toggle");
  // Hold A's authorized fetch while B plays and A receives a new room position.
  await a.run(`const fetchTrack=window.fetch; window.trackReads=0;
    window.fetch=async (...args)=>{
      if (String(args[0]).startsWith("/api/music/tracks/") && ++trackReads===1)
        await new Promise(resolve=>{window.releaseTrack=resolve;});
      return fetchTrack(...args);
    }`);
  for (const page of [a,b]) {
    await until(()=>page.run('return !document.querySelector("#listen-btn").hidden'),"room supports playback");
    assert.equal(await page.run('return performance.getEntriesByType("resource").some(e=>e.name.includes("/api/music/tracks/"))'),false);
    assert.equal(await page.run("return document.visibilityState"),"visible");
    await page.click("#listen-btn");
  }
  async function playing(page) {
    if (await page.run('return !document.querySelector("#resume-audio").hidden'))
      await page.click("#resume-audio");
    return page.run(`const audio=${audio}; return audio && !audio.paused && audio.currentTime>0 && audio.readyState>=2`);
  }
  await until(()=>playing(b),"B plays while A is loading");
  await range(a,"music-seek",4000);
  await until(()=>b.run("return "+audio+".currentTime>=4"),"remote seek during A's fetch");
  assert.equal(await a.run('return trackReads===1 && document.querySelector("#playing-detail").textContent.startsWith("Loading audio")'),true);
  await a.run("releaseTrack()");
  await until(async()=>(await Promise.all([playing(a),playing(b)])).every(Boolean),"both decrypted MP3s are playing");
  await until(()=>a.run("return "+audio+".currentTime>=4"),"A plays from the seek received during its fetch");
  assert.equal(await a.run("return trackReads"),1);
  // Hold A's response for one selected song until both listeners are playing the next.
  const reads=await a.run(`const original=window.fetch;
    window.fetch=async (...args)=>{
      if (!String(args[0]).startsWith("/api/music/tracks/")) return original(...args);
      window.fetch=original;
      const response=await original(...args);
      await new Promise(resolve=>{window.releaseSelection=resolve;});
      return response;
    };
    return trackReads`);
  await b.click("#music-view-toggle");
  await until(()=>b.run('return document.querySelector("#music-collection").getAttribute("aria-busy")==="false"'),"queue refreshed");
  await b.click('button[aria-label="Select Night Drive.mp3"]');
  await until(()=>a.run('return !!window.releaseSelection && document.querySelector("#playing-name").textContent==="Night Drive.mp3" && document.querySelector("#playing-detail").textContent.startsWith("Loading audio")'),"A awaits the selected MP3");
  await until(()=>b.run(`return document.querySelector("#playing-name").textContent==="Night Drive.mp3" && !${audio}.paused && ${audio}.currentTime>0`),"B plays the selected song without pressing Play");
  await b.click('button[aria-label="Select After Hours.mp3"]');
  for (const page of [a,b]) await until(()=>page.run(`return document.querySelector("#playing-name").textContent==="After Hours.mp3" &&
    !${audio}.paused && ${audio}.currentTime>0 && document.querySelector("#playing-detail").textContent.startsWith("Playing")`),"both play the latest selection");
  const selectedUrl=await a.run("releaseSelection();return "+audio+".currentSrc");
  await until(async()=>await clockGap()<=500,"selected song in sync");
  assert.equal(await a.run("return "+audio+".currentSrc"),selectedUrl);
  assert.equal(await a.run("return trackReads"),reads+2);
  await b.click("#music-view-toggle");
  const firstUrl=await a.run("return "+audio+".currentSrc");
  await a.click("#player-toggle");
  await a.click("#music-next");
  await until(()=>a.run(`return revoked.includes(arguments[0]) && ${audio}.currentSrc!==arguments[0] && !${audio}.paused`,firstUrl),
    "next released prior MP3");
  await a.click("#music-previous");
  await until(()=>b.run('return document.querySelector("#playing-name").textContent==="After Hours.mp3"'),"previous track");
  await range(a,"music-volume",35);
  assert.equal(await a.run("return "+audio+".volume"),0.35);
  assert.equal(await b.run("return "+audio+".volume"),1);
  await a.click("#music-mute");
  assert.ok(await a.run("return "+audio+".muted"));
  assert.equal(await b.run("return "+audio+".muted"),false);
  await a.click("#music-mute");
  await until(()=>playing(b),"playing after track switch");
  const retained=await b.run("return "+audio+".currentSrc");
  await b.click("#music-view-toggle");
  await b.run('document.querySelector("#room-music").scrollTop=300');
  assert.equal(await b.run("return "+audio+".currentSrc"),retained);
  await b.click("#music-view-toggle");
  await a.run(`document.querySelector("#message-input").value="listening together";
    document.querySelector("#composer").requestSubmit()`);
  await until(()=>b.run('return document.querySelector("#messages").textContent.includes("listening together")'),"chat while listening");

  await a.run(`document.querySelector("#message-input").value="A line of chat.\\n".repeat(30);
    document.querySelector("#composer").requestSubmit()`);
  await until(()=>b.run('const h=document.querySelector("#history");return h.scrollHeight>h.clientHeight+100'),"scrollable chat");
  assert.ok(await b.run(`const h=document.querySelector("#history"),p=document.querySelector("#mini-player");
    const y=p.getBoundingClientRect().top;h.scrollTop=h.scrollHeight;const bottom=h.scrollTop;h.scrollTop=0;
    const pinned=bottom>0 && p.getBoundingClientRect().top===y;h.scrollTop=h.scrollHeight;
    return pinned && ${audio}.currentSrc===arguments[0]`,retained));
  await t.test("a buffered seek with an advancing media clock has a seek status",async()=>{
    const start=await b.run(`const media=${audio};
      Object.defineProperty(media,"seeking",{configurable:true,value:true});
      return media.currentTime`);
    try {
      await until(()=>b.run(`return ${audio}.readyState>=3 && ${audio}.currentTime>arguments[0]+0.35`,start),"buffered media clock advanced through a UI tick");
      assert.match(await b.run('return document.querySelector("#playing-detail").textContent'),/^Seeking/);
    } finally { await b.run(`delete ${audio}.seeking`); }
    assert.match(await b.run(`const media=${audio};media.dispatchEvent(new Event("seeked"));
      media.dispatchEvent(new Event("stalled"));
      return document.querySelector("#playing-detail").textContent`),/^Playing/);
  });
  // Hold the native seek on A across snapshots and timer ticks. B uses its real decoder.
  await a.run(`const media=${audio}, proto=media.ownerDocument.defaultView.HTMLMediaElement.prototype;
    const time=Object.getOwnPropertyDescriptor(proto,"currentTime");
    const seeking=Object.getOwnPropertyDescriptor(proto,"seeking");
    window.seekProbe={writes:[],rates:[],ready:4,seeking:true,reads:trackReads,media,url:media.currentSrc};
    media.addEventListener("ratechange",()=>seekProbe.rates.push(media.playbackRate));
    Object.defineProperties(media,{
      currentTime:{configurable:true,get:()=>seekProbe.landed ? time.get.call(media) : 0,set:value=>{
        seekProbe.writes.push(value);
        if (seekProbe.deliver) {
          seekProbe.seeking=true;
          setTimeout(()=>{time.set.call(media,value);seekProbe.landed=true;seekProbe.seeking=false;},650);
        }
      }},
      seeking:{configurable:true,get:()=>seekProbe.seeking || seeking.get.call(media)},
      readyState:{configurable:true,get:()=>seekProbe.ready}
    });
    media.dispatchEvent(new Event("seeking"))`);
  await b.run(`const media=${audio};window.nativeSeekEvents=[];
    for (const event of ["seeking","waiting","stalled","seeked","canplay","playing"])
      media.addEventListener(event,()=>nativeSeekEvents.push(event+"="+media.readyState),{once:true});`);
  for (const target of [12000,2000]) {
    await range(a,"music-seek",target);
    await until(()=>b.run(`return Math.abs(${audio}.currentTime*1000-arguments[0])<1500`,target),"B applied active seek");
    await until(()=>a.run('return !document.querySelector("#music-seek").disabled'),"seek acknowledged");
  }
  assert.deepEqual(await a.run("return seekProbe.writes"),[],"no currentTime writes during an unfinished seek");
  for (const [ready,event] of [[1,"waiting"],[2,"stalled"]]) {
    await a.run(`seekProbe.seeking=false; seekProbe.ready=arguments[0];seekProbe.media.dispatchEvent(new Event(arguments[1]))`,ready,event);
    await delay(550); // Cross two 250 ms alignment ticks with insufficient data.
    assert.deepEqual(await a.run("return seekProbe.writes"),[],"no corrections while buffering");
    assert.ok(await a.run('return document.querySelector("#playing-detail").textContent.startsWith("Loading audio")'));
  }
  await a.run(`const {media}=seekProbe;
    delete media.readyState;
    seekProbe.deliver=true;
    media.dispatchEvent(new Event("canplay"))`);
  async function clockGap() {
    // Exclude the time between the two WebDriver observations.
    const clocks=await Promise.all([a,b].map(page=>page.run(`return ${audio}.currentTime*1000-Date.now()`)));
    return Math.round(Math.abs(clocks[0]-clocks[1]));
  }
  await until(async()=>await a.run('return seekProbe.writes.length>0 && !seekProbe.media.seeking && document.querySelector("#playing-detail").textContent.startsWith("Playing")')
    && await clockGap()<=500,"A recovered at B's room position").catch(async error=>{
      for (const page of [a,b]) t.diagnostic(JSON.stringify(await page.run(`const media=${audio};return {
        roomMs:document.querySelector("#music-seek").value,local:media.currentTime,rate:media.playbackRate,
        detail:document.querySelector("#playing-detail").textContent,paused:media.paused,
        seeking:media.seeking,ready:media.readyState,writes:window.seekProbe?.writes
      }`)));
      throw error;
    });
  await until(()=>a.run("return seekProbe.media.playbackRate===1"),"normal tempo resumes after catch-up");
  t.diagnostic("Native seek events on B and their readyState: "+await b.run("return nativeSeekEvents.join(', ')"));
  t.diagnostic("Local rate changes during delayed seek recovery: "+await a.run("return seekProbe.rates.join(', ')"));
  t.diagnostic("Two foreground media clocks after a delayed authoritative seek: "+await clockGap()+" ms apart");
  assert.equal(await a.run("return seekProbe.writes.length"),1,"a slow completed seek can settle without another hard seek");
  await a.run("delete seekProbe.media.currentTime;delete seekProbe.media.seeking");
  assert.ok(await a.run(`return seekProbe.media===${audio} && seekProbe.url===${audio}.currentSrc && trackReads===seekProbe.reads`));
  await b.run(`const media=${audio}; media.currentTime+=2`);
  await delay(1500);
  const gaps=[];
  for (let i=0;i<8;i++) {
    gaps.push(await clockGap());
    await delay(200);
  }
  t.diagnostic("Two foreground media clocks, settled gaps in ms: "+gaps.join(", "));
  assert.ok(Math.max(...gaps)<=500);
  await t.test("uninterrupted playback does not flicker between Playing and Loading",async()=>{
    const statusesA=[],statusesB=[];
    const started=Date.now();
    while (Date.now()-started<20000) {
      const [sa,sb]=await Promise.all([
        a.run('return document.querySelector("#playing-detail").textContent.split(" · ")[0]'),
        b.run('return document.querySelector("#playing-detail").textContent.split(" · ")[0]')
      ]);
      statusesA.push(sa);statusesB.push(sb);
      await delay(250);
    }
    const transitionsA=statusesA.reduce((n,s,i)=>i && s!==statusesA[i-1]?n+1:n,0);
    const transitionsB=statusesB.reduce((n,s,i)=>i && s!==statusesB[i-1]?n+1:n,0);
    const loadingA=statusesA.filter(s=>s==="Loading audio…").length;
    const loadingB=statusesB.filter(s=>s==="Loading audio…").length;
    t.diagnostic("A statuses: "+[...new Set(statusesA)].join(" | ")+" transitions="+transitionsA+" loading="+loadingA+" samples="+statusesA.length);
    t.diagnostic("B statuses: "+[...new Set(statusesB)].join(" | ")+" transitions="+transitionsB+" loading="+loadingB+" samples="+statusesB.length);
    assert.equal(loadingA,0,"unexpected Loading audio status on A during uninterrupted playback");
    assert.equal(loadingB,0,"unexpected Loading audio status on B during uninterrupted playback");
  });
  await a.click("#music-play");
  await until(async()=>(await Promise.all([a,b].map(page=>page.run("return "+audio+".paused")))).every(Boolean),"room paused");
  await range(a,"music-seek",6000);
  await until(()=>b.run("return Math.abs("+audio+".currentTime-6)<0.15"),"paused seek");

  // Reproduce a browser denying a remote play, then exercise the real gesture fallback.
  await b.run(`const media=${audio}; media.play=()=>{delete media.play;
    return Promise.reject(new DOMException("User gesture required","NotAllowedError"));}`);
  await a.click("#music-play");
  await until(()=>b.run('return !document.querySelector("#resume-audio").hidden'),"autoplay fallback");
  await b.click("#resume-audio");
  await until(()=>playing(b),"gesture resumes at room position");
  await range(b,"music-volume",65);
  const uninterrupted=await a.run(`return {src:${audio}.currentSrc,time:${audio}.currentTime}`);
  const mutedUrl=await b.run(`window.playingBeforeOff=${audio};
    document.querySelector("#join-form").requestSubmit();
    return playingBeforeOff.currentSrc`);
  await until(()=>b.run('return !document.querySelector("#join-btn").disabled'),"same-session join completed");
  assert.ok(await b.run(`return playingBeforeOff===${audio} && playingBeforeOff.currentSrc===arguments[0] &&
    document.querySelectorAll('iframe[src="/audio-player.html"]').length===1`,mutedUrl));
  await b.click("#listen-btn");
  assert.deepEqual(await b.run(`return {
    pressed:document.querySelector("#listen-btn").getAttribute("aria-pressed"),
    frames:document.querySelectorAll('iframe[src="/audio-player.html"]').length,
    paused:playingBeforeOff.paused,hasSource:playingBeforeOff.hasAttribute("src")
  }`),{pressed:"false",frames:0,paused:true,hasSource:false},"OFF must silence the original element after a repeated join");
  assert.ok(await b.run("return revoked.includes(arguments[0])",mutedUrl));
  assert.equal(await b.run("return Boolean("+audio+")"),false);
  assert.ok(await playing(a));
  await b.click("#listen-btn");
  await until(()=>playing(b),"B opted back in during room playback");
  assert.notEqual(await b.run("return "+audio+".currentSrc"),mutedUrl);
  assert.equal(await b.run("return "+audio+".volume"),0.65);
  await until(async()=>await clockGap()<=500,"re-enabled listener at room position");
  assert.ok(await a.run(`return ${audio}.currentSrc===arguments[0].src && !${audio}.paused &&
    ${audio}.currentTime>arguments[0].time && ${audio}.volume===0.35`,uninterrupted));
  await b.click("#listen-btn");

  await t.test("rapid toggles and a late encrypted response leave no local source",async()=>{
    await b.run(`const original=window.fetch;
      window.fetch=async (...args)=>{
        if (!String(args[0]).startsWith("/api/music/tracks/")) return original(...args);
        window.fetch=original;
        window.pendingSignal=args[1].signal;
        const result=await original(...args);
        await new Promise(resolve=>{window.finishRead=resolve;});
        return result;
      };
      const btn=document.querySelector("#listen-btn");
      btn.click();btn.click();btn.click();`);
    await until(()=>b.run("return !!window.finishRead"),"authorized music response held");
    assert.equal(await b.run(`return document.querySelectorAll('iframe[src="/audio-player.html"]').length`),1);
    await b.click("#listen-btn");
    assert.ok(await b.run("finishRead(); return pendingSignal.aborted"));
    assert.equal(await b.run("return Boolean("+audio+")"),false);
  });

  await t.test("turning listening off during track decryption discards the late result",async()=>{
    await b.click("#listen-btn");
    await until(()=>playing(b),"B ready before the track switch");
    await b.run(`const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);
      crypto.subtle.decrypt=async (...args)=>{
        delete crypto.subtle.decrypt;
        const bytes=await decrypt(...args);
        await new Promise(resolve=>{window.finishDecrypt=resolve;});
        return bytes;
      };
      window.switchMedia=${audio}; window.lateBlobs=0;
      const create=URL.createObjectURL.bind(URL);
      URL.createObjectURL=blob=>{lateBlobs++;return create(blob);};`);
    await a.click("#music-next");
    await until(()=>b.run("return !!window.finishDecrypt"),"decryption held during the switch");
    await b.click("#listen-btn");
    await b.run("finishDecrypt()");
    assert.ok(await b.run(`return !${audio} && switchMedia.paused && !switchMedia.hasAttribute("src") &&
      lateBlobs===0 && document.querySelector("#listen-btn").getAttribute("aria-pressed")==="false"`));
    await until(()=>playing(a),"A continues with the selected track");
  });
  for (const [name,bytes] of Object.entries(samples)) {
    await a.run(`const selected=new DataTransfer(), input=document.querySelector("#file-input");
      selected.items.add(new File([Uint8Array.from(atob(arguments[1]),c=>c.charCodeAt(0))],arguments[0]));
      input.files=selected.files; input.dispatchEvent(new Event("change"));
      document.querySelector("#composer").requestSubmit()`,name,bytes.toString("base64"));
    await until(()=>b.run('return [...document.querySelectorAll(".file-name")].some(e=>e.textContent===arguments[0])',name),
      "second browser received "+name);
    if (name.endsWith(".png")) {
      await until(()=>b.run('return Boolean(document.querySelector(".thumbnail img")?.naturalWidth)'),"decrypted thumbnail");
      await b.click(".thumbnail");
      await until(()=>b.run('return !document.querySelector("#viewer-zoom").disabled'),"decrypted original");
      await b.click("#viewer-zoom");
      assert.ok(await b.run('return document.querySelector("#viewer").classList.contains("zoomed")'));
      await b.click("#close-viewer");
    } else {
      await b.click(`.clip-play[aria-label="Play ${name}"]`);
      await until(()=>b.run('return Boolean(document.querySelector(".clip-player iframe")?.contentDocument.querySelector("video")?.videoWidth)'),
        "decoded "+name);
    }
  }
  await t.test("a listener can opt out while the server is disconnected",async()=>{
    await b.click("#listen-btn");
    await until(()=>playing(b),"B is listening before disconnection");
    await restart(async()=>{
      await until(()=>b.run('return document.querySelector("#network").textContent==="Reconnecting…"'),"B disconnected");
      assert.equal(await b.run("return Boolean("+audio+")"),false);
      await b.click("#listen-btn");
      assert.equal(await b.run('return document.querySelector("#listen-btn").getAttribute("aria-pressed")'),"false");
    });
    for (const page of [a,b]) await until(()=>page.run(`return document.querySelector("#network").textContent==="Connected" &&
      !document.querySelector("#music-play").disabled && document.querySelector("#playing-detail").textContent.startsWith("Paused")`),"room rejoined");
    await a.click("#music-play");
    await until(()=>playing(a),"A resumed after the reconnect");
    assert.equal(await b.run("return Boolean("+audio+")"),false);
  });
  const oldUrl=await a.run("return "+audio+".currentSrc");
  await restart();
  await until(()=>a.run(`const media=${audio};
    return revoked.includes(arguments[0]) && media && media.paused && !media.currentSrc &&
      document.querySelector("#playing-detail").textContent.startsWith("Paused")`,oldUrl),
    "opted-in browser rejoined without downloading a paused track");
  assert.equal(await b.run("return Boolean("+audio+")"),false);
  await a.click("#music-play");
  await until(()=>playing(a),"rejoined browser resumed");
  assert.ok(await b.run(`return !${audio} && document.querySelector("#listen-btn").getAttribute("aria-pressed")==="false"`));
  await b.click("#music-view-toggle");
  await until(()=>b.run('return !!document.querySelector("#music-tracks li:first-child details")'),"Browser B music catalog is ready");
  if (!await b.run('return document.querySelector("#music-tracks li:first-child details").open')) await b.click("#music-tracks li:first-child summary");
  await b.click('[data-action="remove"]');
  await until(()=>b.run('return document.querySelectorAll("#music-tracks li").length===1'),"remove from queue");
  await b.click("#show-library");
  if (!await b.run('return document.querySelector("#music-tracks li:first-child details").open')) await b.click("#music-tracks li:first-child summary");
  await b.click('[data-action="deleteTrack"]');await b.acceptDialog();
  await until(()=>b.run('return document.querySelectorAll("#music-tracks li").length===1'),"delete from library");
  assert.ok(await b.run("return document.documentElement.scrollWidth<=innerWidth"));

}
