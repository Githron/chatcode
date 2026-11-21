import {fileLimit} from "./public/transfer.js";

const mpeg1Rates = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
const lowRates = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
const sampleRates = [44100,48000,32000];
function invalid() { throw new Error("Invalid or unsupported MP3."); }

function synchsafe(bytes, pos) {
  if (pos+4>bytes.length || bytes.readUInt32BE(pos) & 0x80808080) invalid();
  return (bytes[pos]<<21) + (bytes[pos+1]<<14) + (bytes[pos+2]<<7) + bytes[pos+3];
}

// Metadata is never decoded or exposed. Walk its declared frame boundaries before accepting the audio.
function id3End(bytes) {
  if (bytes.toString("latin1",0,3)!=="ID3") return 0;
  const version=bytes[3], flags=bytes[5];
  if (bytes.length<10 || ![2,3,4].includes(version) || bytes[4]===255 ||
      (flags & (version===4?0x0f:version===3?0x1f:0x3f))) invalid();
  const end=10+synchsafe(bytes,6);
  if (end>bytes.length || (version<4 && flags&0x80) || (version===2 && flags&0x40)) invalid();
  let pos=10;
  if (version>=3 && flags&0x40) {
    if (pos+4>end) invalid();
    const ext=version===4?synchsafe(bytes,pos):4+bytes.readUInt32BE(pos);
    if (ext<(version===4?6:10) || pos+ext>end) invalid();
    pos+=ext;
  }
  const idLength=version===2?3:4, header=version===2?6:10;
  while (pos<end && bytes[pos]!==0) {
    if (pos+header>end || !/^[A-Z0-9]+$/.test(bytes.toString("latin1",pos,pos+idLength))) invalid();
    const size=version===4?synchsafe(bytes,pos+4):bytes.readUIntBE(pos+idLength,idLength);
    if (!size || pos+header+size>end) invalid();
    pos+=header+size;
  }
  for (;pos<end;pos++) if (bytes[pos]!==0) invalid();
  if (version===4 && flags&0x10) {
    if (bytes.toString("latin1",end,end+3)!=="3DI" || !bytes.subarray(end+3,end+10).equals(bytes.subarray(3,10))) invalid();
    return end+10;
  }
  return end;
}

// Layer III side information describes which bytes this frame borrows from earlier frames.
function checkSideInfo(bytes, start, mpeg1, channels, payloadSize, reservoir) {
  let bit=start*8;
  function read(count) {
    let value=0;
    for (let n=0;n<count;n++,bit++) value=value*2+((bytes[bit>>>3]>>>(7-(bit&7)))&1);
    return value;
  }
  const borrowed=read(mpeg1?9:8);
  if (borrowed>reservoir) invalid();
  bit+=mpeg1?(channels===1?5:3)+channels*4:channels;
  let used=0;
  for (let i=0;i<channels*(mpeg1?2:1);i++) {
    used+=read(12);
    if (read(9)>288) invalid();
    bit+=8+(mpeg1?4:9);
    const switched=read(1);
    if (switched) {
      if (read(2)===0) invalid();
      bit++;
    }
    for (let t=0;t<(switched?2:3);t++) {
      const table=read(5);
      if (table===4 || table===14) invalid();
    }
    bit+=(switched?9:7)+(mpeg1?3:2);
  }
  const remaining=borrowed+payloadSize-Math.ceil(used/8);
  if (remaining<0) invalid();
  return remaining;
}

export function mp3Duration(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length>fileLimit) invalid();
  const start=id3End(bytes);
  let end=bytes.length;
  if (end>=128 && bytes.toString("latin1",end-128,end-125)==="TAG") end-=128;
  let frames=0, sampleRate=0, samplesPerFrame=0, reservoir=0;
  let infoFrame=false, declaredFrames=0, trimSamples=0;
  for (let pos=start;pos<end;) {
    if (pos+4>end || bytes[pos]!==255 || (bytes[pos+1]&0xe0)!==0xe0) invalid();
    const version=(bytes[pos+1]>>3)&3, layer=(bytes[pos+1]>>1)&3, mpeg1=version===3;
    const rate=(mpeg1?mpeg1Rates:lowRates)[bytes[pos+2]>>4];
    const hz=sampleRates[(bytes[pos+2]>>2)&3]/(mpeg1?1:version===2?2:4);
    if (version===1 || layer!==1 || !rate || !hz || (bytes[pos+3]&3)===2 || (frames && hz!==sampleRate)) invalid();
    sampleRate=hz;
    samplesPerFrame=mpeg1?1152:576;
    const frameSize=Math.floor((mpeg1?144000:72000)*rate/hz)+((bytes[pos+2]>>1)&1);
    const channels=(bytes[pos+3]>>6)===3?1:2;
    const side=pos+4+((bytes[pos+1]&1)?0:2);
    const data=side+(mpeg1?(channels===1?17:32):(channels===1?9:17));
    const next=pos+frameSize;
    if (next>end || data>=next) invalid();
    reservoir=checkSideInfo(bytes,side,mpeg1,channels,next-data,reservoir);
    if (!frames && ["Xing","Info"].includes(bytes.toString("latin1",data,data+4))) {
      infoFrame=true;
      if (data+8>next) invalid();
      const flags=bytes.readUInt32BE(data+4);
      if (flags>15) invalid();
      let p=data+8;
      if (flags&1) { if (p+4>next) invalid(); declaredFrames=bytes.readUInt32BE(p); p+=4; }
      if (flags&2) { if (p+4>next || bytes.readUInt32BE(p)!==end-start) invalid(); p+=4; }
      if (flags&4) p+=100;
      if (flags&8) p+=4;
      if (p>next) invalid();
      if (p+24<=next && /^(LAME|Lavc|Lavf)/.test(bytes.toString("latin1",p,p+4))) {
        const packed=bytes.readUIntBE(p+21,3);
        trimSamples=(packed>>>12)+(packed&4095);
      }
    }
    frames++;
    pos=next;
  }
  const audioFrames=frames-Number(infoFrame);
  if (audioFrames<1 || (declaredFrames && declaredFrames!==audioFrames)) invalid();
  const duration=Math.round((audioFrames*samplesPerFrame-trimSamples)*1000/sampleRate);
  if (duration<1) invalid();
  return duration;
}
