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
  await webdriver(path+"/url","POST",{url});
  await run(`document.querySelector("#username-input").value=arguments[0];
    document.querySelector("#room-code-input").value=arguments[1]`,name,room);
  await click("#join-btn");
  return {run,click};
}

async function until(check, message) {
  const deadline=Date.now()+10000;
  while (Date.now()<deadline) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(message);
}

export async function playbackBrowser(t, url, room, command, restart, samples) {
  const [a,b]=await Promise.all([browser(t,url,room,"BrowserA"),browser(t,url,room,"BrowserB")]);
  const audio=`document.querySelector('iframe[src="/audio-player.html"]')?.contentDocument?.querySelector("audio")`;
  await command("seek",{positionMs:0});
  await command("play");
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
  await a.run(`document.querySelector("#message-input").value="listening together";
    document.querySelector("#composer").requestSubmit()`);
  await until(()=>b.run('return document.querySelector("#messages").textContent.includes("listening together")'),"chat while listening");

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
  await command("pause");
  await until(async()=>(await Promise.all([a,b].map(page=>page.run("return "+audio+".paused")))).every(Boolean),"room paused");
  await command("seek",{positionMs:6000});
  await until(()=>b.run("return Math.abs("+audio+".currentTime-6)<0.15"),"paused seek");

  // Reproduce a browser denying a remote play, then exercise the real gesture fallback.
  await b.run(`const media=${audio}; media.play=()=>{delete media.play;
    return Promise.reject(new DOMException("User gesture required","NotAllowedError"));}`);
  await command("play");
  await until(()=>b.run('return !document.querySelector("#resume-audio").hidden'),"autoplay fallback");
  await b.click("#resume-audio");
  await until(()=>playing(b),"gesture resumes at room position");
  await b.click("#listen-btn");
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
    return media && media.readyState>=2 && media.paused && media.currentSrc!==arguments[0]`,oldUrl),
    "opted-in browser rejoined and fetched the frozen selection");
  assert.equal(await b.run("return Boolean("+audio+")"),false);
  await command("play");
  await until(()=>playing(a),"rejoined browser resumed");

}
