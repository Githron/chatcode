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
  await a.click('button[aria-label="Select After Hours.mp3"]');
  await until(()=>b.run('return document.querySelector("#playing-name").textContent==="After Hours.mp3"'),"selected track");
  await a.click("#music-play");
  for (const page of [a,b]) await page.click("#music-view-toggle");
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
  await until(async()=>(await Promise.all([playing(a),playing(b)])).every(Boolean),"both decrypted MP3s are playing");
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
  await b.run(`const media=${audio}; media.currentTime+=2`);
  await delay(1500);
  const gaps=[];
  for (let i=0;i<8;i++) {
    // Subtract observation time so independent WebDriver request latency does not count as drift.
    const [first,second]=await Promise.all([a,b].map(page=>page.run(`return ${audio}.currentTime*1000-Date.now()`)));
    gaps.push(Math.round(Math.abs(first-second)));
    await delay(200);
  }
  t.diagnostic("Two foreground media clocks, settled gaps in ms: "+gaps.join(", "));
  assert.ok(Math.max(...gaps)<=500);
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
  const mutedUrl=await b.run("return "+audio+".currentSrc");
  await b.click("#listen-btn");
  assert.ok(await b.run("return revoked.includes(arguments[0])",mutedUrl));
  assert.equal(await b.run("return Boolean("+audio+")"),false);
  assert.ok(await playing(a));
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
  const oldUrl=await a.run("return "+audio+".currentSrc");
  await restart();
  await until(()=>a.run(`const media=${audio};
    return revoked.includes(arguments[0]) && media && media.paused && !media.currentSrc &&
      document.querySelector("#playing-detail").textContent.startsWith("Paused")`,oldUrl),
    "opted-in browser rejoined without downloading a paused track");
  assert.equal(await b.run("return Boolean("+audio+")"),false);
  await a.click("#music-play");
  await until(()=>playing(a),"rejoined browser resumed");
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
