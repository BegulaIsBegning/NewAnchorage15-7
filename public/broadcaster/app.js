/* global io */
"use strict";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const socket = io({ path: "/socket.io" });

const canvas    = document.getElementById("outCanvas");
const ctx       = canvas.getContext("2d");
const hiddenVid = document.getElementById("camVideo");
const $ = id => document.getElementById(id);

// ─── STATE ────────────────────────────────────────────────────────────────────
let live = false, channelId = "";
let source = "file";
let playlist = [], currentIdx = -1, activeVid = null;

const audioSrcMap = new WeakMap();
let audioCtx = null, destNode = null, micGainNode = null, vidGainNode = null;
let sbGainNode = null;
let micStreamSource = null, analyser = null, analyserData = null;

let outStream = null, rafId = null;
let tickerX = 0, urgentImg = null, urgentUntil = 0;
const peers = new Map(), iceQueue = new Map(), viewers = new Set();

// ─── STATION CONTENT PREVIEW ──────────────────────────────────────────────────
// Periodically grabs a small, cheap snapshot of the output canvas and sends it
// to the server so viewers' channel-select grid shows real content instead of
// a static placeholder. Runs only while live.
let thumbTimer = null;
const thumbCanvas = document.createElement("canvas");
thumbCanvas.width = 320; thumbCanvas.height = 180;
const thumbCtx = thumbCanvas.getContext("2d");
function captureAndSendThumbnail() {
  if (!live || !channelId) return;
  try {
    thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const dataUrl = thumbCanvas.toDataURL("image/jpeg", 0.5);
    socket.emit("broadcaster-thumbnail", { channelId, dataUrl });
  } catch (e) {
    // Canvas can become tainted if a cross-origin overlay image without CORS
    // headers was drawn onto it — just skip this cycle rather than crash.
  }
}
function startThumbLoop() {
  stopThumbLoop();
  captureAndSendThumbnail();
  thumbTimer = setInterval(captureAndSendThumbnail, 4000);
}
function stopThumbLoop() {
  if (thumbTimer) { clearInterval(thumbTimer); thumbTimer = null; }
}

// ─── FPS DISPLAY ─────────────────────────────────────────────────────────────
let frameCount = 0, lastFpsTime = performance.now();
setInterval(() => {
  const now = performance.now();
  const fps = Math.round(frameCount / ((now - lastFpsTime) / 1000));
  $("fpsDisplay").textContent = fps + " fps";
  frameCount = 0; lastFpsTime = now;
}, 1000);

// ─── CLOCK ────────────────────────────────────────────────────────────────────
setInterval(() => {
  $("clockDisplay").textContent = new Date().toLocaleTimeString("pt-BR", { hour12: false });
}, 1000);
$("clockDisplay").textContent = new Date().toLocaleTimeString("pt-BR", { hour12: false });

// ─── VU METER ─────────────────────────────────────────────────────────────────
(function() {
  const b = $("vuBars"), l = $("ledbar");
  for (let i=0;i<28;i++){const d=document.createElement("div");d.className="vu-bar";b.appendChild(d);}
  for (let i=0;i<20;i++){const d=document.createElement("div");d.className="ls";l.appendChild(d);}
})();

function updateVU() {
  const bars = $("vuBars").querySelectorAll(".vu-bar");
  const segs = $("ledbar").querySelectorAll(".ls");
  if (!analyser) {
    bars.forEach(b=>b.style.height="2px"); segs.forEach(s=>s.className="ls"); $("vuDb").textContent="-∞"; return;
  }
  analyser.getByteFrequencyData(analyserData);
  let peak = 0;
  bars.forEach((bar,i)=>{
    const v=analyserData[Math.floor(i*analyserData.length/bars.length)]/255;
    peak=Math.max(peak,v);
    bar.style.height=Math.round(v*26)+"px";
    bar.className="vu-bar"+(i>22?" r":i>18?" a":"");
  });
  const db=peak>0?Math.round(20*Math.log10(peak)):-Infinity;
  $("vuDb").textContent=isFinite(db)?db+"dB":"-∞";
  segs.forEach((s,i)=>{
    s.className="ls"+(peak>i/segs.length?(i>17?" ar":i>13?" aa":" ag"):"");
  });
}

// ─── LIVE UI ──────────────────────────────────────────────────────────────────
function setLiveUI(on) {
  $("liveBadge").className="live-badge "+(on?"on":"off");
  $("liveBadgeText").textContent=on?"On air":"Off air";
  $("btnGoLive").disabled=on; $("btnStop").disabled=!on; $("channelId").disabled=on;
  $("channelDisplay").textContent="Channel: "+(on?channelId.toUpperCase():"—");
}
function updateViewers(){$("viewersCount").textContent=viewers.size;}

// ─── SOURCE TABS ──────────────────────────────────────────────────────────────
window.selectSource = function(s) {
  source=s;
  $("srcFile").classList.toggle("active",s==="file");
  $("srcCam").classList.toggle("active",s==="cam");
  $("fileSourcePanel").style.display=s==="file"?"":"none";
  $("camSourcePanel").style.display=s==="cam"?"":"none";
  if(s==="cam") loadCamDevices();
  updateSourceBadge();
};
async function loadCamDevices() {
  try {
    const devs=await navigator.mediaDevices.enumerateDevices();
    $("camSelect").innerHTML=devs.filter(d=>d.kind==="videoinput")
      .map((d,i)=>`<option value="${d.deviceId}">${d.label||"Camera "+(i+1)}</option>`).join("");
  } catch(e){console.warn(e);}
}
$("btnRefreshCam").onclick=loadCamDevices;

// ─── PLAYLIST ─────────────────────────────────────────────────────────────────
function fmtTime(s){
  if(!isFinite(s))return"--:--";
  return Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
}

function renderPlaylist() {
  const el=$("playlist");
  if(!playlist.length){el.innerHTML='<div class="pl-empty">No sources.</div>';return;}
  el.innerHTML=playlist.map((item,i)=>`
    <div class="pl-item${i===currentIdx?" playing":""}" data-i="${i}">
      <span class="pl-ic">${i===currentIdx?"▶":"○"}</span>
      <span class="pl-name">${item.name}</span>
      <span class="pl-dur">${fmtTime(item.duration)}</span>
      <span class="pl-del" data-del="${i}">✕</span>
    </div>`).join("");
  el.querySelectorAll(".pl-item").forEach(row=>row.addEventListener("click",e=>{
    if(e.target.dataset.del!==undefined)return;
    switchToIdx(Number(row.dataset.i));
  }));
  el.querySelectorAll(".pl-del").forEach(btn=>btn.addEventListener("click",e=>{
    e.stopPropagation(); removeItem(Number(btn.dataset.del));
  }));
}

function removeItem(idx) {
  const item=playlist[idx]; if(!item)return;
  if(audioSrcMap.has(item.vid)){try{audioSrcMap.get(item.vid).disconnect();}catch(_){}audioSrcMap.delete(item.vid);}
  URL.revokeObjectURL(item.objectURL);
  playlist.splice(idx,1);
  if(currentIdx===idx){currentIdx=-1;activeVid=null;}
  else if(currentIdx>idx)currentIdx--;
  renderPlaylist(); updateSourceBadge();
}

$("btnAddVideos").onclick=()=>$("videoFiles").click();
$("videoFiles").addEventListener("change",e=>{
  Array.from(e.target.files||[]).forEach(f=>{
    const url=URL.createObjectURL(f);
    const vid=document.createElement("video");
    vid.src=url; vid.preload="metadata"; vid.crossOrigin="anonymous";
    const item={name:f.name.replace(/\.[^.]+$/,""),objectURL:url,vid,duration:0};
    vid.addEventListener("loadedmetadata",()=>{item.duration=vid.duration;renderPlaylist();},{once:true});
    playlist.push(item);
  });
  renderPlaylist();
  if(currentIdx<0&&playlist.length)switchToIdx(0);
  e.target.value="";
});

$("btnClearPlaylist").onclick=()=>{
  playlist.forEach(item=>{
    if(audioSrcMap.has(item.vid)){try{audioSrcMap.get(item.vid).disconnect();}catch(_){}audioSrcMap.delete(item.vid);}
    URL.revokeObjectURL(item.objectURL);
  });
  playlist=[];currentIdx=-1;activeVid=null;
  renderPlaylist();updateSourceBadge();
};

function wireVideoAudio(vid) {
  if(!audioCtx||!vidGainNode)return;
  if(audioSrcMap.has(vid))return;
  try {
    const src=audioCtx.createMediaElementSource(vid);
    src.connect(vidGainNode);
    audioSrcMap.set(vid,src);
  } catch(e){console.warn("wireVideoAudio:",e);}
}

function switchToIdx(idx) {
  if(idx<0||idx>=playlist.length)return;
  if(activeVid&&activeVid!==playlist[idx]?.vid){activeVid.pause();activeVid.currentTime=0;}
  currentIdx=idx;
  const item=playlist[idx];
  activeVid=item.vid;
  wireVideoAudio(item.vid);
  item.vid.onended=()=>{
    const next=currentIdx+1;
    if(next<playlist.length){switchToIdx(next);activeVid.play().catch(()=>{});}
    else if($("loopPlaylist").checked){switchToIdx(0);playlist[0].vid.play().catch(()=>{});}
  };
  if(live){activeVid.play().catch(()=>{});$("btnPlayPause").textContent="⏸ Pause";}
  renderPlaylist();updateSourceBadge();
}

$("btnPlayPause").onclick=()=>{
  if(!activeVid){if(playlist.length)switchToIdx(0);return;}
  if(activeVid.paused){activeVid.play().catch(()=>{});$("btnPlayPause").textContent="⏸ Pause";}
  else{activeVid.pause();$("btnPlayPause").textContent="▶ Play";}
};
$("btnNextVideo").onclick=()=>{
  if(!playlist.length)return;
  switchToIdx((currentIdx+1)%playlist.length);
  activeVid?.play().catch(()=>{});$("btnPlayPause").textContent="⏸ Pause";
};
$("btnPrevVideo").onclick=()=>{
  if(!playlist.length)return;
  switchToIdx((currentIdx-1+playlist.length)%playlist.length);
  activeVid?.play().catch(()=>{});$("btnPlayPause").textContent="⏸ Pause";
};
$("videoSeek").addEventListener("input",()=>{
  if(!activeVid||!isFinite(activeVid.duration))return;
  activeVid.currentTime=($("videoSeek").value/100)*activeVid.duration;
});

function updateProgress(){
  const vid=activeVid;
  if(!vid||!isFinite(vid.duration)||!vid.duration)return;
  if(!$("videoSeek").matches(":active"))$("videoSeek").value=(vid.currentTime/vid.duration)*100;
  $("videoCurrentTime").textContent=fmtTime(vid.currentTime);
  $("videoDuration").textContent=fmtTime(vid.duration);
}

function updateSourceBadge(){
  const b=$("sourceBadge");
  if(source==="screen"){b.textContent="Screen Capture";b.style.color="var(--cyan)";}
  else if(source==="cam"){b.textContent="Live Camera";b.style.color="var(--green)";}
  else if(activeVid&&currentIdx>=0){b.textContent=playlist[currentIdx]?.name.toUpperCase().slice(0,32)||"Archive";b.style.color="var(--amber)";}
  else{b.textContent="No source";b.style.color="";}
}

// ─── MIXER ────────────────────────────────────────────────────────────────────
function syncR(id,v1,v2){const v=$(id).value;if(v1)$(v1).textContent=v;if(v2)$(v2).textContent=v+"%";}
$("micGain").oninput=()=>{syncR("micGain","micVal","micValRight");if(micGainNode)micGainNode.gain.value=$("muteMic").checked?0:Number($("micGain").value)/100;};
$("muteMic").onchange=()=>{if(micGainNode)micGainNode.gain.value=$("muteMic").checked?0:Number($("micGain").value)/100;};
$("muteVideoAudio").onchange=()=>{if(vidGainNode)vidGainNode.gain.value=$("muteVideoAudio").checked?0:1;};
$("videoBright").oninput=()=>syncR("videoBright","brightVal","brightValRight");
$("videoContrast").oninput=()=>syncR("videoContrast","contrastVal","contrastValRight");
$("videoSat").oninput=()=>syncR("videoSat","satVal","satValRight");
$("tickerSpeed").oninput=()=>$("tickerSpeedVal").textContent=$("tickerSpeed").value;

// ─── FLASH OVERLAY (urgent) ───────────────────────────────────────────────────
$("urgentFile").onchange=e=>{
  const f=e.target.files[0];
  $("btnUrgent").disabled=!f;
  if(!f){urgentImg=null;return;}
  const u=URL.createObjectURL(f);
  const img=new Image();
  img.onload=()=>{urgentImg=img;URL.revokeObjectURL(u);};
  img.src=u;
};
$("btnUrgent").onclick=()=>{
  if(!urgentImg)return;
  urgentUntil=performance.now()+(Number($("urgentDuration").value)||5)*1000;
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── OVERLAY SYSTEM (drag / resize / rotate) ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/*
  Each overlay is stored as:
  {
    id: string,
    name: string,
    type: "image" | "video",
    src: string,          // object URL
    el: HTMLElement,      // the .ov-node DOM node inside overlayLayer
    media: HTMLImageElement | HTMLVideoElement,
    x: number,            // % of canvas width (0-100)
    y: number,            // % of canvas height (0-100)
    w: number,            // % of canvas width
    h: number,            // % of canvas height
    rotation: number,     // degrees
    opacity: number,      // 0-100
    visible: boolean,
    loop: boolean,
    muted: boolean,
    thumb: string,        // data URL for list thumbnail
  }
*/
const overlays = [];
let selectedOverlayId = null;

// Canvas-relative coordinate helpers
function canvasRect() { return $("canvasWrap").getBoundingClientRect(); }
function pxToPercX(px) { return (px / canvasRect().width) * 100; }
function pxToPercY(py) { return (py / canvasRect().height) * 100; }
function percToPxX(p) { return (p / 100) * canvasRect().width; }
function percToPxY(p) { return (p / 100) * canvasRect().height; }

function applyNodeTransform(ov) {
  const rect = canvasRect();
  const left = (ov.x / 100) * rect.width;
  const top  = (ov.y / 100) * rect.height;
  const w    = (ov.w / 100) * rect.width;
  const h    = (ov.h / 100) * rect.height;
  ov.el.style.left    = left + "px";
  ov.el.style.top     = top + "px";
  ov.el.style.width   = w + "px";
  ov.el.style.height  = h + "px";
  ov.el.style.transform = `rotate(${ov.rotation}deg)`;
  ov.el.style.opacity = ov.opacity / 100;
  ov.el.style.display = ov.visible ? "" : "none";
}

function selectOverlay(id) {
  selectedOverlayId = id;
  overlays.forEach(ov => ov.el.classList.toggle("selected", ov.id === id));
  renderOverlayList();
  updateOverlayControlsPanel();
}

function deselectAll() {
  selectedOverlayId = null;
  overlays.forEach(ov => ov.el.classList.remove("selected"));
  renderOverlayList();
  $("overlayControlsPanel").style.display = "none";
}

function updateOverlayControlsPanel() {
  const ov = overlays.find(o => o.id === selectedOverlayId);
  const panel = $("overlayControlsPanel");
  if (!ov) { panel.style.display = "none"; return; }
  panel.style.display = "";
  $("ovCtlOpacity").value = ov.opacity;
  $("ovCtlOpVal").textContent = ov.opacity + "%";
  // Scale: use average of w,h relative to a "100% = full canvas width"
  $("ovCtlScale").value = Math.round(ov.w);
  $("ovCtlScaleVal").textContent = Math.round(ov.w) + "%";
  $("ovCtlRotation").value = ov.rotation;
  $("ovCtlRotVal").textContent = ov.rotation + "°";
  const isVid = ov.type === "video";
  $("ovCtlVideoRow").style.display = isVid ? "" : "none";
  if (isVid) {
    $("ovCtlLoop").checked = ov.loop;
    $("ovCtlMuted").checked = ov.muted;
  }
}

// Controls panel listeners
$("ovCtlOpacity").oninput = () => {
  const ov = overlays.find(o => o.id === selectedOverlayId); if (!ov) return;
  ov.opacity = Number($("ovCtlOpacity").value);
  $("ovCtlOpVal").textContent = ov.opacity + "%";
  applyNodeTransform(ov);
};
$("ovCtlScale").oninput = () => {
  const ov = overlays.find(o => o.id === selectedOverlayId); if (!ov) return;
  const s = Number($("ovCtlScale").value);
  const aspect = ov.media instanceof HTMLImageElement
    ? ov.media.naturalWidth / ov.media.naturalHeight
    : (ov.media.videoWidth || 16) / (ov.media.videoHeight || 9);
  const canvRect = canvasRect();
  const canvAspect = canvRect.width / canvRect.height;
  ov.w = s;
  ov.h = (s / aspect) * canvAspect;
  $("ovCtlScaleVal").textContent = s + "%";
  applyNodeTransform(ov);
};
$("ovCtlRotation").oninput = () => {
  const ov = overlays.find(o => o.id === selectedOverlayId); if (!ov) return;
  ov.rotation = Number($("ovCtlRotation").value);
  $("ovCtlRotVal").textContent = ov.rotation + "°";
  applyNodeTransform(ov);
};
$("ovCtlLoop").onchange = () => {
  const ov = overlays.find(o => o.id === selectedOverlayId); if (!ov || ov.type !== "video") return;
  ov.loop = $("ovCtlLoop").checked;
  ov.media.loop = ov.loop;
};
$("ovCtlMuted").onchange = () => {
  const ov = overlays.find(o => o.id === selectedOverlayId); if (!ov || ov.type !== "video") return;
  ov.muted = $("ovCtlMuted").checked;
  ov.media.muted = ov.muted;
};
$("ovCtlRemove").onclick = () => {
  if (selectedOverlayId) removeOverlay(selectedOverlayId);
};
$("ovCtlDuplicate").onclick = () => {
  const ov = overlays.find(o => o.id === selectedOverlayId); if (!ov) return;
  // Duplicate by re-adding the same src
  addOverlayFromSrc(ov.src, ov.name + " (copy)", ov.type);
};

function createOverlayNode(ov) {
  const node = document.createElement("div");
  node.className = "ov-node";
  node.dataset.id = ov.id;
  node.appendChild(ov.media);

  // Resize handles
  ["nw","ne","sw","se","rot"].forEach(dir => {
    const h = document.createElement("div");
    h.className = "ov-handle " + dir;
    h.dataset.handle = dir;
    node.appendChild(h);
  });

  $("overlayLayer").appendChild(node);
  ov.el = node;
  applyNodeTransform(ov);
  makeDraggable(ov);
  makeResizable(ov);

  node.addEventListener("mousedown", e => {
    if (e.target.dataset.handle) return; // handled by resize
    e.stopPropagation();
    selectOverlay(ov.id);
  });
}

function makeDraggable(ov) {
  let startX, startY, startOvX, startOvY;
  ov.el.addEventListener("mousedown", e => {
    if (e.target.dataset.handle) return;
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    startOvX = ov.x; startOvY = ov.y;
    const onMove = ev => {
      const rect = canvasRect();
      const dx = pxToPercX(ev.clientX - startX);
      const dy = pxToPercY(ev.clientY - startY);
      ov.x = Math.max(0, Math.min(100, startOvX + dx));
      ov.y = Math.max(0, Math.min(100, startOvY + dy));
      applyNodeTransform(ov);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function makeResizable(ov) {
  ov.el.querySelectorAll(".ov-handle").forEach(handle => {
    handle.addEventListener("mousedown", e => {
      e.preventDefault(); e.stopPropagation();
      const dir = handle.dataset.handle;

      if (dir === "rot") {
        // Rotation drag
        const rect = ov.el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
        const startRot = ov.rotation;
        const onMove = ev => {
          const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx);
          ov.rotation = startRot + Math.round((angle - startAngle) * 180 / Math.PI);
          applyNodeTransform(ov);
          if (selectedOverlayId === ov.id) {
            $("ovCtlRotation").value = ov.rotation;
            $("ovCtlRotVal").textContent = ov.rotation + "°";
          }
        };
        const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return;
      }

      // Corner resize
      const rect0 = canvasRect();
      const startW = ov.w, startH = ov.h, startX0 = ov.x, startY0 = ov.y;
      const sx = e.clientX, sy = e.clientY;
      const aspect = startW / startH;

      const onMove = ev => {
        const dxPx = ev.clientX - sx;
        const dyPx = ev.clientY - sy;
        const dw = pxToPercX(dxPx);
        const dh = pxToPercY(dyPx);
        let newW = startW, newH = startH, newX = startX0, newY = startY0;

        if (dir === "se") { newW = Math.max(2, startW + dw); newH = newW / aspect; }
        else if (dir === "sw") { newW = Math.max(2, startW - dw); newH = newW / aspect; newX = startX0 + startW - newW; }
        else if (dir === "ne") { newW = Math.max(2, startW + dw); newH = newW / aspect; newY = startY0 + startH - newH; }
        else if (dir === "nw") { newW = Math.max(2, startW - dw); newH = newW / aspect; newX = startX0 + startW - newW; newY = startY0 + startH - newH; }

        ov.w = newW; ov.h = newH; ov.x = newX; ov.y = newY;
        applyNodeTransform(ov);
        if (selectedOverlayId === ov.id) {
          $("ovCtlScale").value = Math.round(newW);
          $("ovCtlScaleVal").textContent = Math.round(newW) + "%";
        }
      };
      const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// Re-lay overlays when window resizes
window.addEventListener("resize", () => overlays.forEach(applyNodeTransform));

function addOverlayFromSrc(src, name, type) {
  const id = "ov_" + Date.now() + "_" + Math.random().toString(36).slice(2,6);
  let media;
  if (type === "video") {
    media = document.createElement("video");
    media.src = src; media.autoplay = true; media.loop = true; media.muted = true;
    media.playsInline = true; media.crossOrigin = "anonymous";
    media.play().catch(()=>{});
  } else {
    media = new Image();
    media.src = src; media.crossOrigin = "anonymous";
  }

  const ov = {
    id, name, type, src, el: null, media,
    x: 5, y: 5, w: 25, h: 0, // h will be set after media loads
    rotation: 0, opacity: 100, visible: true,
    loop: true, muted: true, thumb: null,
  };

  const finishAdd = () => {
    const nw = type === "video" ? media.videoWidth  : media.naturalWidth;
    const nh = type === "video" ? media.videoHeight : media.naturalHeight;
    const aspect = (nw || 16) / (nh || 9);
    const cr = canvasRect();
    const canvAspect = cr.width / cr.height;
    ov.h = (ov.w / aspect) * canvAspect;

    // thumb
    const tc = document.createElement("canvas");
    tc.width = 56; tc.height = 32;
    const tc2 = tc.getContext("2d");
    try { tc2.drawImage(media, 0, 0, 56, 32); ov.thumb = tc.toDataURL(); } catch(_){}

    overlays.push(ov);
    createOverlayNode(ov);
    selectOverlay(id);
    renderOverlayList();
  };

  if (type === "video") {
    media.addEventListener("loadedmetadata", finishAdd, { once: true });
    // fallback
    setTimeout(() => { if (!ov.el) finishAdd(); }, 1200);
  } else {
    if (media.complete && media.naturalWidth) finishAdd();
    else media.onload = finishAdd;
  }
}

function removeOverlay(id) {
  const idx = overlays.findIndex(o => o.id === id); if (idx < 0) return;
  const ov = overlays[idx];
  ov.el.remove();
  if (ov.type === "video") { ov.media.pause(); ov.media.src = ""; }
  URL.revokeObjectURL(ov.src);
  overlays.splice(idx, 1);
  if (selectedOverlayId === id) deselectAll();
  renderOverlayList();
}

function renderOverlayList() {
  const list = $("overlayList");
  list.innerHTML = "";
  overlays.forEach(ov => {
    const item = document.createElement("div");
    item.className = "overlay-list-item" + (ov.id === selectedOverlayId ? " active" : "");
    item.innerHTML = `
      ${ov.thumb ? `<img class="ov-thumb" src="${ov.thumb}" draggable="false"/>` : `<div class="ov-thumb" style="background:var(--s3)"></div>`}
      <div class="ov-item-info">
        <div class="ov-item-name">${ov.name}</div>
        <div class="ov-item-type">${ov.type.toUpperCase()}</div>
      </div>
      <button class="ov-vis-btn ${ov.visible?"on":""}" title="${ov.visible?"Hide":"Show"}">${ov.visible?"👁":"○"}</button>
      <button class="ov-del-btn" title="Remove">✕</button>
    `;
    item.querySelector(".ov-vis-btn").onclick = e => {
      e.stopPropagation();
      ov.visible = !ov.visible;
      applyNodeTransform(ov);
      renderOverlayList();
    };
    item.querySelector(".ov-del-btn").onclick = e => {
      e.stopPropagation();
      removeOverlay(ov.id);
    };
    item.onclick = () => { selectOverlay(ov.id); updateOverlayControlsPanel(); };
    list.appendChild(item);
  });
}

// Drop zone
const dropZone = $("overlayDropZone");
dropZone.onclick = () => $("overlayFileInput").click();
dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add("dragover"); };
dropZone.ondragleave = () => dropZone.classList.remove("dragover");
dropZone.ondrop = e => {
  e.preventDefault(); dropZone.classList.remove("dragover");
  Array.from(e.dataTransfer.files).forEach(f => handleOverlayFile(f));
};
$("overlayFileInput").onchange = e => {
  Array.from(e.target.files).forEach(f => handleOverlayFile(f));
  e.target.value = "";
};
function handleOverlayFile(f) {
  const isVid = f.type.startsWith("video/");
  const src = URL.createObjectURL(f);
  const name = f.name.replace(/\.[^.]+$/, "").slice(0, 24);
  addOverlayFromSrc(src, name, isVid ? "video" : "image");
}

// Click on overlay layer background → deselect
$("overlayLayer").addEventListener("mousedown", e => {
  if (e.target === $("overlayLayer")) deselectAll();
});

// ─── CANVAS DRAW ──────────────────────────────────────────────────────────────
function drawFrame() {
  frameCount++;
  const W=canvas.width,H=canvas.height;
  ctx.fillStyle="#000";ctx.fillRect(0,0,W,H);

  let vid;
  if(source==="screen")     vid = $("screenCapVideo");
  else if(source==="cam")   vid = hiddenVid;
  else                      vid = activeVid;

  if(vid&&vid.readyState>=2&&vid.videoWidth){
    ctx.filter=`brightness(${Number($("videoBright").value)/100}) contrast(${Number($("videoContrast").value)/100}) saturate(${Number($("videoSat").value)/100})`;
    const sc=Math.max(W/vid.videoWidth,H/vid.videoHeight);
    ctx.drawImage(vid,(W-vid.videoWidth*sc)/2,(H-vid.videoHeight*sc)/2,vid.videoWidth*sc,vid.videoHeight*sc);
    ctx.filter="none";
  }

  // ── Draw overlays onto canvas (for broadcast) ────────────────────────────
  overlays.forEach(ov => {
    if (!ov.visible) return;
    const media = ov.media;
    const isReady = ov.type === "image"
      ? media.complete && media.naturalWidth
      : media.readyState >= 2 && (media.videoWidth || media.naturalWidth);
    if (!isReady) return;
    ctx.save();
    // Convert ov.x, ov.y, ov.w, ov.h (%) to canvas px
    const cx = (ov.x / 100) * W + ((ov.w / 100) * W) / 2;
    const cy = (ov.y / 100) * H + ((ov.h / 100) * H) / 2;
    const dw = (ov.w / 100) * W;
    const dh = (ov.h / 100) * H;
    ctx.globalAlpha = ov.opacity / 100;
    ctx.translate(cx, cy);
    ctx.rotate(ov.rotation * Math.PI / 180);
    ctx.drawImage(media, -dw/2, -dh/2, dw, dh);
    ctx.restore();
  });

  if($("showLiveTag").checked){
    ctx.save();ctx.font="bold 18px monospace";const t="● Live",tw=ctx.measureText(t).width,px=12,py=6,x=W-tw-px*2-16,y=16;
    ctx.fillStyle="rgba(200,28,28,0.93)";ctx.beginPath();ctx.roundRect(x,y,tw+px*2,24+py,3);ctx.fill();
    ctx.fillStyle="#fff";ctx.fillText(t,x+px,y+19);ctx.restore();
  }

  if($("showDateTime").checked){
    const now=new Date(),str=now.toLocaleDateString("en-US")+" "+now.toLocaleTimeString("en-US",{hour12:false});
    ctx.save();ctx.font="15px monospace";ctx.fillStyle="rgba(0,0,0,0.6)";ctx.fillRect(10,12,195,26);
    ctx.fillStyle="#00ff88";ctx.fillText(str,14,29);ctx.restore();
  }

  const st=$("screenText").value.trim();
  if(st){
    ctx.save();ctx.font="bold 26px monospace";ctx.textAlign="center";ctx.strokeStyle="rgba(0,0,0,0.85)";ctx.lineWidth=5;ctx.fillStyle="#fff";
    const y=$("screenTextPos").value==="top"?58:$("screenTextPos").value==="center"?H/2:H-106;
    ctx.strokeText(st,W/2,y);ctx.fillText(st,W/2,y);ctx.restore();
  }

  if(urgentImg&&performance.now()<urgentUntil){
    ctx.save();ctx.fillStyle="rgba(0,0,0,0.45)";ctx.fillRect(0,0,W,H);
    const sc=Math.min(W/urgentImg.width,H/urgentImg.height);
    ctx.drawImage(urgentImg,(W-urgentImg.width*sc)/2,(H-urgentImg.height*sc)/2,urgentImg.width*sc,urgentImg.height*sc);
    ctx.restore();
  }

  if($("tickerOn").checked){
    const text=($("tickerText").value.trim()||"This broadcasting station may be setting up right now.")+"   ◆   ",speed=Number($("tickerSpeed").value)*1.1;
    tickerX-=speed;const bH=46,y0=H-bH;
    ctx.fillStyle="rgba(0,0,0,0.82)";ctx.fillRect(0,y0,W,bH);ctx.font="19px monospace";ctx.fillStyle="#ddd";
    const full=text+text,tw=ctx.measureText(full).width;
    if(tickerX<-tw)tickerX=W;
    ctx.save();ctx.rect(0,y0,W,bH);ctx.clip();ctx.fillText(full,tickerX,y0+30);ctx.restore();
  }

  updateVU();updateProgress();
  rafId=requestAnimationFrame(drawFrame);
}

// ─── AUDIO PIPELINE ───────────────────────────────────────────────────────────
async function buildAudio() {
  audioCtx=new AudioContext();
  if(audioCtx.state==="suspended")await audioCtx.resume();
  destNode=audioCtx.createMediaStreamDestination();
  micGainNode=audioCtx.createGain();
  vidGainNode=audioCtx.createGain();
  sbGainNode=audioCtx.createGain();
  micGainNode.gain.value=$("muteMic").checked?0:Number($("micGain").value)/100;
  vidGainNode.gain.value=$("muteVideoAudio").checked?0:1;
  sbGainNode.gain.value=Number($("sbMasterVol").value)/100;
  micGainNode.connect(destNode);
  vidGainNode.connect(destNode);
  sbGainNode.connect(destNode);
  analyser=audioCtx.createAnalyser();analyser.fftSize=256;analyserData=new Uint8Array(analyser.frequencyBinCount);
  micGainNode.connect(analyser);
  vidGainNode.connect(analyser);
  sbGainNode.connect(analyser);
}

async function tryConnectMic() {
  try {
    const micStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    const src=audioCtx.createMediaStreamSource(micStream);
    src.connect(micGainNode);
    micStreamSource=src;
    micStreamSource._tracks=micStream.getAudioTracks();
  } catch(e){console.warn("Mic unavailable:",e.message);}
}

async function startPipeline() {
  await buildAudio();
  if(source==="cam"){
    const deviceId=$("camSelect").value;
    const cs={video:{width:{ideal:1280},height:{ideal:720}},audio:true};
    if(deviceId)cs.video.deviceId={exact:deviceId};
    const camStream=await navigator.mediaDevices.getUserMedia(cs);
    hiddenVid.srcObject=camStream;await hiddenVid.play();
    const camAudioSrc=audioCtx.createMediaStreamSource(new MediaStream(camStream.getAudioTracks()));
    camAudioSrc.connect(micGainNode);micStreamSource=camAudioSrc;
    micStreamSource._tracks=camStream.getAudioTracks();
  } else if(source==="screen"){
    const scStream=window.getScreenCaptureStream&&window.getScreenCaptureStream();
    if(scStream){
      const audioTracks=scStream.getAudioTracks();
      if(audioTracks.length){
        const scAudioSrc=audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
        scAudioSrc.connect(vidGainNode);
      }
    }
    await tryConnectMic();
  } else {
    if(activeVid){wireVideoAudio(activeVid);activeVid.play().catch(()=>{});$("btnPlayPause").textContent="⏸ Pause";}
    await tryConnectMic();
  }
  sbRewire();
  updateSourceBadge();
  const vStream=canvas.captureStream(30);
  const aTrack=destNode.stream.getAudioTracks()[0];
  if(aTrack)vStream.addTrack(aTrack);
  outStream=vStream;
}

function teardownAudio(){
  playlist.forEach(item=>{if(audioSrcMap.has(item.vid)){try{audioSrcMap.get(item.vid).disconnect();}catch(_){}audioSrcMap.delete(item.vid);}});
  if(micStreamSource){
    try{micStreamSource.disconnect();}catch(_){}
    if(micStreamSource._tracks){micStreamSource._tracks.forEach(t=>t.stop());}
    micStreamSource=null;
  }
  sbPads.forEach(p=>{if(p.node){try{p.node.disconnect();}catch(_){} p.node=null;}if(p.a){p.a.pause();p.a=null;}p.on=false;});
  if(audioCtx){audioCtx.close().catch(()=>{});audioCtx=null;}
  destNode=null;micGainNode=null;vidGainNode=null;analyser=null;analyserData=null;sbGainNode=null;
}

function stopPipeline(){
  if(rafId){cancelAnimationFrame(rafId);rafId=null;}
  closeAllPeers();
  if(activeVid)activeVid.pause();
  $("btnPlayPause").textContent="▶ Play";
  if(hiddenVid.srcObject){hiddenVid.srcObject.getTracks().forEach(t=>t.stop());hiddenVid.srcObject=null;}
  teardownAudio();outStream=null;
  rafId=requestAnimationFrame(drawFrame);
}

// ─── SOUNDBOARD ────────────────────────────────────────────────────────────────
const sbPads = [];
function sbGetGain(){ return parseInt($("sbMasterVol").value)/100; }
$("sbMasterVol").oninput=()=>{$("sbVolVal").textContent=$("sbMasterVol").value+"%";if(sbGainNode)sbGainNode.gain.value=sbGetGain();};
function sbRewire(){
  if(!audioCtx||!sbGainNode)return;
  sbPads.forEach(p=>{
    if(p.a&&!p.node){
      try{const src=audioCtx.createMediaElementSource(p.a);src.connect(sbGainNode);p.node=src;}catch(e){console.warn("sbRewire:",e);}
    }
  });
}
function sbToggle(i){
  const p=sbPads[i];if(!p)return;
  if(!p.a){p.a=new Audio(p.url);p.a.crossOrigin="anonymous";p.a.volume=1;p.a.onended=()=>{p.on=false;sbRender();};}
  if(audioCtx&&sbGainNode&&!p.node){try{const src=audioCtx.createMediaElementSource(p.a);src.connect(sbGainNode);p.node=src;}catch(e){console.warn("sb wire:",e);}}
  if(p.on){p.a.pause();p.a.currentTime=0;p.on=false;}
  else{sbPads.forEach((q,j)=>{if(j!==i&&q.on&&q.a){q.a.pause();q.a.currentTime=0;q.on=false;}});if(!sbGainNode)p.a.volume=sbGetGain();p.a.play().catch(()=>{});p.on=true;}
  sbRender();
}
function sbRemove(i){
  const p=sbPads[i];if(!p)return;
  if(p.a){p.a.pause();}if(p.node){try{p.node.disconnect();}catch(_){}p.node=null;}
  URL.revokeObjectURL(p.url);sbPads.splice(i,1);sbRender();
}
function sbRender(){
  const grid=$("soundboardGrid"),addBtn=$("sbAddBtn");
  grid.querySelectorAll(".sb-btn").forEach(b=>b.remove());
  sbPads.forEach((p,i)=>{
    const b=document.createElement("button");b.className="sb-btn"+(p.on?" playing":"");b.title=p.name;
    b.innerHTML=`<span class="sb-icon">${p.on?"⏹":"▶"}</span><span class="sb-label">${p.name}</span>`;
    b.onclick=()=>sbToggle(i);b.oncontextmenu=e=>{e.preventDefault();sbRemove(i);};
    grid.insertBefore(b,addBtn);
  });
}
$("sbAddBtn").onclick=()=>$("sbFileInput").click();
$("sbFileInput").onchange=e=>{
  Array.from(e.target.files).forEach(f=>{sbPads.push({name:f.name.replace(/\.[^.]+$/,"").slice(0,18),url:URL.createObjectURL(f),a:null,node:null,on:false});});
  $("sbFileInput").value="";sbRender();
};

// ─── SCREEN CAPTURE ───────────────────────────────────────────────────────────
let screenStream=null;
window.getScreenCaptureStream=()=>screenStream;
function scSetState(on){
  $("screenCapNoSignal").style.display=on?"none":"flex";
  $("screenCapBadge").classList.toggle("on",on);
  $("btnStopScreenCap").disabled=!on;$("btnStartScreenCap").disabled=on;
  if(!on&&$("screenCapAsSource").checked){$("screenCapAsSource").checked=false;selectSource("file");}
}
$("btnStartScreenCap").onclick=async()=>{
  try{
    screenStream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:30},audio:true});
    $("screenCapVideo").srcObject=screenStream;scSetState(true);
    screenStream.getVideoTracks()[0].onended=()=>scKill();
    $("screenCapAsSource").checked=true;selectSource("screen");
  }catch(e){if(e.name!=="NotAllowedError")console.error(e);}
};
function scKill(){
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null;}
  $("screenCapVideo").srcObject=null;scSetState(false);
}
$("btnStopScreenCap").onclick=scKill;
$("screenCapAsSource").onchange=()=>{
  if($("screenCapAsSource").checked){
    if(!screenStream){alert("Start screen capture first.");$("screenCapAsSource").checked=false;return;}
    selectSource("screen");
  }else{selectSource("file");}
};
scSetState(false);

// ─── WEBRTC ───────────────────────────────────────────────────────────────────
socket.on("viewer-ready",async({viewerId})=>{
  if(!live||!outStream)return;
  viewers.add(viewerId);updateViewers();
  try{await openPeer(viewerId);}catch(e){console.error(e);viewers.delete(viewerId);updateViewers();}
});
socket.on("viewer-gone",({viewerId})=>{viewers.delete(viewerId);updateViewers();closePeer(viewerId);});
socket.on("signal",async({from,data})=>{
  const pc=peers.get(from);if(!pc)return;
  try{
    if(data.type==="answer"){await pc.setRemoteDescription(new RTCSessionDescription(data));const q=iceQueue.get(from);if(q){iceQueue.delete(from);for(const c of q)await pc.addIceCandidate(new RTCIceCandidate(c));}}
    else if(data.candidate){if(!pc.remoteDescription){let q=iceQueue.get(from);if(!q){q=[];iceQueue.set(from,q);}q.push(data.candidate);}else await pc.addIceCandidate(new RTCIceCandidate(data.candidate));}
  }catch(e){console.warn(e);}
});
function closePeer(id){iceQueue.delete(id);const pc=peers.get(id);if(pc){pc.close();peers.delete(id);}}
function closeAllPeers(){for(const id of peers.keys())closePeer(id);viewers.clear();updateViewers();}
async function openPeer(viewerId){
  const pc=new RTCPeerConnection(ICE);peers.set(viewerId,pc);
  outStream.getTracks().forEach(t=>pc.addTrack(t,outStream));
  pc.onicecandidate=ev=>{if(ev.candidate)socket.emit("signal",{to:viewerId,data:{candidate:ev.candidate}});};
  const offer=await pc.createOffer();await pc.setLocalDescription(offer);
  socket.emit("signal",{to:viewerId,data:offer});
}

// ─── GO LIVE ──────────────────────────────────────────────────────────────────
$("btnGoLive").onclick=async()=>{
  const raw=$("channelId").value.trim()||"Channel-"+Math.random().toString(36).slice(2,7);
  $("channelId").value=raw;
  if(rafId){cancelAnimationFrame(rafId);rafId=null;}
  try{await startPipeline();}catch(e){alert("Error: "+e.message);rafId=requestAnimationFrame(drawFrame);return;}
  socket.emit("broadcaster-register",raw,res=>{
    if(!res?.ok){alert(res?.error||"Error registering channel.");stopPipeline();return;}
    channelId=res.channelId;live=true;setLiveUI(true);
    rafId=requestAnimationFrame(drawFrame);
    startThumbLoop();
  });
};
$("btnStop").onclick=()=>{
  socket.emit("broadcaster-unregister");
  live=false;channelId="";stopPipeline();setLiveUI(false);
  stopThumbLoop();
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
setLiveUI(false);updateViewers();renderPlaylist();sbRender();
rafId=requestAnimationFrame(drawFrame);

socket.on("admin:forced-takedown",({reason})=>{
  if(!live)return;live=false;channelId="";stopPipeline();setLiveUI(false);
  stopThumbLoop();
  alert("⚠️ Your channel was taken off-air by an administrator.\n\n"+(reason||""));
});
