// Inspect container framing and track metadata without decoding or expanding media.
const invalid = () => { throw new Error("Invalid video container."); };

export function validateVideo(data, extension) {
  let remaining = 100_000;
  const count = () => { if (--remaining < 0) invalid(); };
  if (extension === "mp4") checkMp4(data, count);
  else if (extension === "webm") checkWebm(data, count);
  else invalid();
}

function checkMp4(data, count) {
  function* boxes(bytes) {
    for (let pos = 0; pos < bytes.length;) {
      count();
      if (bytes.length - pos < 8) invalid();
      const type = bytes.toString("latin1", pos+4, pos+8);
      let size = bytes.readUInt32BE(pos), header = 8;
      if (size === 1) {
        if (bytes.length - pos < 16 || bytes.readUInt32BE(pos+8) !== 0) invalid();
        size = bytes.readUInt32BE(pos+12);
        header = 16;
      } else if (!size) size = bytes.length - pos;
      if (size < header || size > bytes.length - pos) invalid();
      yield [type, bytes.subarray(pos+header, pos+size)];
      pos += size;
    }
  }
  function* children(bytes, name) {
    for (const [type, payload] of boxes(bytes)) if (type === name) yield payload;
  }
  function videoDescription(mdia) {
    let videoHandler = false, visualEntry = false, sampleBytes = 0;
    for (const [type, body] of boxes(mdia)) {
      if (type === "hdlr") videoHandler = body.length >= 24 && body.toString("latin1",8,12) === "vide";
      if (type !== "minf") continue;
      for (const stbl of children(body,"stbl")) for (const [table, tableBytes] of boxes(stbl)) {
        if (table==="stsz" || table==="stz2") {
          if (tableBytes.length<12) invalid();
          const samples=tableBytes.readUInt32BE(8), uniform=table==="stsz" ? tableBytes.readUInt32BE(4) : 0;
          const bits=table==="stsz" ? 32 : tableBytes[7];
          if (![4,8,16,32].includes(bits) || samples>data.length ||
              tableBytes.length!==12+(uniform ? 0 : Math.ceil(samples*bits/8))) invalid();
          if (uniform) sampleBytes+=uniform*samples;
          else for (let i=0;i<samples;i++) {
            count();
            const offset=12+Math.floor(i*bits/8);
            sampleBytes+=bits===4 ? (i%2 ? tableBytes[offset]&15 : tableBytes[offset]>>4) : tableBytes.readUIntBE(offset,bits/8);
          }
          continue;
        }
        if (table!=="stsd") continue;
        if (tableBytes.length < 8) invalid();
        let entries = 0;
        for (const [, sample] of boxes(tableBytes.subarray(8))) {
          entries++;
          if (sample.length >= 78 && sample.readUInt16BE(24) && sample.readUInt16BE(26)) visualEntry = true;
        }
        if (entries !== tableBytes.readUInt32BE(4)) invalid();
      }
    }
    return videoHandler && visualEntry ? sampleBytes : null;
  }
  let brand = false, mediaBytes = 0;
  const tracks=new Map(), fragments=new Set();
  for (const [type, body] of boxes(data)) {
    if (type === "ftyp") {
      if (body.length < 8 || body.length > 4096 || body.length % 4) invalid();
      for (let i=0; i<body.length; i+=4) {
        if (i !== 4 && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash|cmf[cs])$/.test(body.toString("latin1",i,i+4))) brand = true;
      }
    }
    if (type === "mdat") mediaBytes+=body.length;
    if (type === "moov") for (const track of children(body,"trak")) {
      let id, bytes;
      for (const [name,payload] of boxes(track)) {
        if (name==="tkhd") {
          const offset=payload[0]===1 ? 20 : 12;
          if (payload.length<offset+4) invalid();
          id=payload.readUInt32BE(offset);
        }
        if (name==="mdia") bytes=videoDescription(payload);
      }
      if (id && bytes!=null) tracks.set(id,bytes);
    }
    if (type==="moof") for (const traf of children(body,"traf")) {
      let id, samples=0;
      for (const [name,payload] of boxes(traf)) {
        if (name!=="tfhd" && name!=="trun") continue;
        if (payload.length<8) invalid();
        if (name==="tfhd") id=payload.readUInt32BE(4);
        else {
          const flags=payload.readUIntBE(1,3), n=payload.readUInt32BE(4);
          const words=[0x100,0x200,0x400,0x800].filter(bit=>flags&bit).length;
          const header=8+(flags&1 ? 4 : 0)+(flags&4 ? 4 : 0);
          if (n>data.length || header+4*words*n!==payload.length) invalid();
          samples+=n;
        }
      }
      if (id && samples) fragments.add(id);
    }
  }
  if (!brand || !mediaBytes || ![...tracks].some(([id,bytes])=>bytes<=mediaBytes && (bytes>0 || fragments.has(id)))) invalid();
}

function checkWebm(data, count) {
  // EBML IDs retain the leading marker bit. Sizes and block track numbers omit it.
  function vint(pos, end, id = false) {
    let mask = 128, width = 1;
    while (mask && !(data[pos] & mask)) { mask >>= 1; width++; }
    if (!mask || width > (id ? 4 : 8) || pos+width > end) invalid();
    let value = id ? data[pos] : data[pos] & (mask-1);
    let unknown = !id && value === mask-1;
    for (let i=1; i<width; i++) {
      value = value*256 + data[pos+i];
      unknown = unknown && data[pos+i] === 255;
    }
    return {value:unknown ? -1 : value, width};
  }
  function* elements(start, end) {
    for (let pos=start; pos<end;) {
      count();
      const id = vint(pos,end,true);
      const size = vint(pos+id.width,end);
      const body = pos+id.width+size.width;
      let next = body+size.value;
      if (size.value === -1) {
        if (id.value !== 0x18538067 && id.value !== 0x1f43b675) invalid();
        next = end;
        if (id.value === 0x1f43b675) {
          // Live WebM recorders can omit cluster lengths. Stop at the next segment child.
          let cursor=body;
          while (cursor<end) {
            count();
            const child=vint(cursor,end,true);
            if ([0x1f43b675,0x1c53bb6b,0x1254c367,0x1549a966,0x1654ae6b,0x114d9b74,0x1043a770,0x1941a469].includes(child.value)) break;
            const length=vint(cursor+child.width,end);
            if (length.value<0) invalid();
            cursor+=child.width+length.width+length.value;
            if (cursor>end) invalid();
          }
          next=cursor;
        }
      }
      if (next>end) invalid();
      yield {id:id.value,start:body,end:next};
      pos=next;
    }
  }
  const inside = e => elements(e.start,e.end);
  const uint = e => e.end-e.start>0 && e.end-e.start<=6 ? data.readUIntBE(e.start,e.end-e.start) : 0;
  const videos=new Set(), blocks=new Set();
  function track(entry) {
    let number, type, codec, width, height;
    for (const e of inside(entry)) {
      if (e.id===0xd7) number=uint(e);
      if (e.id===0x83) type=uint(e);
      if (e.id===0x86 && e.end-e.start<=32) codec=data.toString("latin1",e.start,e.end);
      if (e.id===0xe0) for (const dim of inside(e)) {
        if (dim.id===0xb0) width=uint(dim);
        if (dim.id===0xba) height=uint(dim);
      }
    }
    if (type===1 && number && width && height && ["V_VP8","V_VP9","V_AV1"].includes(codec)) videos.add(number);
  }
  function block(e) {
    const number=vint(e.start,e.end);
    if (number.value<=0 || e.end-e.start<=number.width+3) invalid();
    blocks.add(number.value);
  }
  let header=false, segment=false;
  for (const outer of elements(0,data.length)) {
    if (!header) {
      if (outer.id!==0x1a45dfa3) invalid();
      for (const e of inside(outer)) if (e.id===0x4282 && e.end-e.start===4 && data.toString("latin1",e.start,e.end)==="webm") header=true;
      if (!header) invalid();
    } else if (outer.id===0x18538067) {
      if (segment) invalid();
      segment=true;
      for (const e of inside(outer)) {
        if (e.id===0x1654ae6b) for (const entry of inside(e)) { if (entry.id===0xae) track(entry); }
        if (e.id===0x1f43b675) for (const child of inside(e)) {
          if (child.id===0xa3) block(child);
          if (child.id===0xa0) for (const part of inside(child)) { if (part.id===0xa1) block(part); }
        }
      }
    }
  }
  if (!segment || ![...videos].some(n=>blocks.has(n))) invalid();
}
