/* global io */
"use strict";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const socket = io({ path: "/socket.io" });
const $ = id => document.getElementById(id);

let channels = [], currentChannel = null, pc = null;
let pendingIn = [], pendingOut = [], bcSocketId = null;
let mediaStream = null;
const thumbnails = {};      // channelId → latest snapshot dataURL (Station Content Preview)
const previewEls  = {};     // channelId → <div class="preview-placeholder"> element to update in place

// Clock
setInterval(()=>{ $("clockDisplay").textContent = new Date().toLocaleTimeString("pt-BR",{hour12:false}); }, 1000);
$("clockDisplay").textContent = new Date().toLocaleTimeString("pt-BR",{hour12:false});

// Volume
$("volControl").oninput = () => { $("tvVideo").volume = $("volControl").value; };

function setStatus(live, msg) {
  $("statusDot").classList.toggle("live", live);
  $("statusText").textContent = msg;
}

function renderChannels() {
  const listEl = $("channelList");
  const gridEl = $("channelGrid"); // The .scene div
  
  listEl.innerHTML = "";
  gridEl.innerHTML = ""; // Clear the grid for fresh previews
  for (const k in previewEls) delete previewEls[k];

  if (!channels.length) { 
    $("noChannels").classList.remove("hidden"); 
    return; 
  }
  
  $("noChannels").classList.add("hidden");

  channels.forEach((id, i) => {
    const chNum = String(i + 1).padStart(2, "0");

    // --- 1. Update the List (Bottom part) ---
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.innerHTML = `<span class="ch-dot"></span><span class="ch-num">CH ${chNum}</span>${id}`;
    btn.onclick = () => tuneChannel(id);
    li.appendChild(btn);
    listEl.appendChild(li);

    // --- 2. Update the Preview Grid (The small screens) ---
    const preview = document.createElement("div");
    preview.className = "mini-screen";
    preview.onclick = () => tuneChannel(id); // Clicking the screen also tunes it
    
    preview.innerHTML = `
      <div class="screen-label">
        <span class="scrolling-meta">CH ${chNum} // ${id.toUpperCase()}</span>
        <span class="status-tag">LIVE</span>
      </div>
      <div class="preview-placeholder"></div> 
    `;

    // Station Content Preview: if we already have a snapshot for this
    // channel (e.g. it was live before this client connected), show it
    // right away instead of the plain placeholder.
    const previewBox = preview.querySelector(".preview-placeholder");
    previewEls[id] = previewBox;
    if (thumbnails[id]) applyThumbnail(id, thumbnails[id]);

    gridEl.appendChild(preview);
  });
}

// Applies (or refreshes) a live snapshot onto a channel's preview box.
function applyThumbnail(id, dataUrl) {
  const box = previewEls[id];
  if (!box) return;
  box.style.backgroundImage = `url("${dataUrl}")`;
  box.style.backgroundSize = "cover";
  box.style.backgroundPosition = "center";
  box.style.opacity = "1";
}

socket.on("channel-thumbnail", ({ channelId, dataUrl }) => {
  if (!channelId || !dataUrl) return;
  thumbnails[channelId] = dataUrl;
  applyThumbnail(channelId, dataUrl);
});
socket.on("channels-updated", list => {
  channels = Array.isArray(list) ? list : [];
  const live = new Set(channels);
  for (const id in thumbnails) if (!live.has(id)) delete thumbnails[id];
  renderChannels();
});
socket.on("viewer-error", ({message}) => { alert(message||"Erro"); showScan(); });
socket.on("broadcaster-left", () => {
  $("tvOverlayMsg").textContent = "End of transmission or lost signal";
  $("tvOverlay").classList.remove("hidden");
  setStatus(false, "Lost Signal");
  if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  $("tvVideo").srcObject = null;
  teardown();
});

function teardown() {
  pendingIn=[]; pendingOut=[]; bcSocketId=null;
  if (pc) { pc.close(); pc=null; }
}

function showScan() {
  if (currentChannel) { socket.emit("viewer-leave", currentChannel); currentChannel=null; }
  teardown();
  if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  $("tvVideo").srcObject=null;
  $("scanSection").classList.remove("hidden");
  $("tvSection").classList.add("hidden");
  setStatus(false,"Waiting...");
}

function showTV(ch) {
  $("scanSection").classList.add("hidden");
  $("tvSection").classList.remove("hidden");
  $("tunedChannel").textContent = "▸ "+ch.toUpperCase();
  $("tvOverlay").classList.add("hidden");
  setStatus(false,"Connecting...");
}

socket.on("signal", async ({from, data}) => {
  if (!pc||!currentChannel) return;
  try {
    if (data.type==="offer") {
      bcSocketId=from;
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("signal",{to:from,data:ans});
      // flush queued out candidates
      while(pendingOut.length) socket.emit("signal",{to:from,data:{candidate:pendingOut.shift()}});
      // flush queued in candidates
      while(pendingIn.length) await pc.addIceCandidate(pendingIn.shift());
    } else if (data.candidate) {
      const c = new RTCIceCandidate(data.candidate);
      if (!pc.remoteDescription) pendingIn.push(c);
      else await pc.addIceCandidate(c);
    }
  } catch(e) { console.error(e); }
});

async function tuneChannel(ch) {
  teardown();
  if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }

  mediaStream = new MediaStream();
  $("tvVideo").srcObject = mediaStream;
  $("tvVideo").volume = $("volControl").value;

  pc = new RTCPeerConnection(ICE);

  pc.ontrack = ev => {
    mediaStream.addTrack(ev.track);
    $("tvOverlay").classList.add("hidden");
    $("tvVideo").play().catch(()=>{});
    setStatus(true,"Live · "+ch.toUpperCase());
  };

  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    if (pc.iceConnectionState==="failed") {
      $("tvOverlayMsg").textContent="Something went wrong. (code 1)";
      $("tvOverlay").classList.remove("hidden");
      setStatus(false,"Something went really wrong (code 2)");
    } else if (pc.iceConnectionState==="disconnected") {
      setStatus(false,"Unstable Signal!");
    }
  };

  pc.onicecandidate = ev => {
    if (!ev.candidate) return;
    if (bcSocketId) socket.emit("signal",{to:bcSocketId,data:{candidate:ev.candidate}});
    else pendingOut.push(ev.candidate);
  };

  currentChannel = ch;
  showTV(ch);
  socket.emit("viewer-join", ch);
}

$("btnBack").onclick = () => showScan();

// ── ADMIN COMMANDS ────────────────────────────────────────────────────────────
// The server can push overlay commands to viewers at any time.

let adminAudioEl = null;
let adminImgTimeout = null;
let adminVidTimeout = null;

function adminRemoveOverlay(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// Overlays render *inside* the TV screen (the video transmission itself)
// instead of covering the whole site. Falls back to <body> if, for some
// reason, the screen element isn't on the page (e.g. a future layout).
function overlayHost() {
  return document.getElementById("tvScreen") || document.body;
}

// Maps a 9-point position keyword to flex alignment, anchored within the
// TV screen. Defaults to center when no/unknown position is given.
const POSITION_MAP = {
  "top-left":      { ai: "flex-start", jc: "flex-start" },
  "top-center":    { ai: "flex-start", jc: "center"     },
  "top-right":     { ai: "flex-start", jc: "flex-end"   },
  "middle-left":   { ai: "center",     jc: "flex-start" },
  "center":        { ai: "center",     jc: "center"     },
  "middle-right":  { ai: "center",     jc: "flex-end"   },
  "bottom-left":   { ai: "flex-end",   jc: "flex-start" },
  "bottom-center": { ai: "flex-end",   jc: "center"     },
  "bottom-right":  { ai: "flex-end",   jc: "flex-end"   },
};
function posAlign(position) {
  return POSITION_MAP[position] || POSITION_MAP.center;
}

// ── HTML SANITIZER ────────────────────────────────────────────────────────────
// Allows a rich but safe subset of HTML for toast titles and messages.
// Permitted elements: a, b, i, em, strong, u, s, br, span, small, code, img, svg, use
// Permitted on <a>: href (must be http/https/# or /path), target, rel
// Permitted on <img>: src (http/https or data:image), alt, width, height, style
// Permitted on <svg>/<use>: standard SVG presentation + xlink:href / href (relative or http)
// Strips: script, style, iframe, object, embed, form, input — and ALL on* attributes.
(function() {
  const ALLOWED_TAGS = new Set([
    "a","b","i","em","strong","u","s","strike","br","span","small","code","pre",
    "img","svg","use","symbol","defs","path","circle","rect","g","title",
    "ul","ol","li","p","hr",
  ]);

  const ALLOWED_ATTRS = {
    // Global safe attrs
    "*":   /^(class|id|style|title|lang|dir|aria-[a-z-]+|role|tabindex|data-[a-z-]+)$/i,
    "a":   /^(href|target|rel|download)$/i,
    "img": /^(src|alt|width|height|loading|decoding|crossorigin)$/i,
    "svg": /^(xmlns|viewbox|width|height|fill|stroke|stroke-width|aria-hidden|focusable|role|version|x|y|preserveaspectratio)$/i,
    "use": /^(href|xlink:href|x|y|width|height|transform)$/i,
    "path|circle|rect|g|symbol|defs|title": /^(d|cx|cy|r|x|y|width|height|fill|stroke|stroke-width|transform|id|viewbox|preserveaspectratio|aria-label|role)$/i,
  };

  // Allowed URL schemes per attribute
  function isSafeUrl(val) {
    const v = val.trim().toLowerCase();
    return (
      v.startsWith("http://")  ||
      v.startsWith("https://") ||
      v.startsWith("/")        ||   // relative path (SVG sprites, CDN)
      v.startsWith("#")        ||   // fragment (SVG <use href="#id">)
      v.startsWith("data:image/") // inline images only
    );
  }

  function isSafeStyleValue(val) {
    // Block expressions and url() with non-data sources to prevent CSS injection
    const v = val.toLowerCase();
    if (/expression\s*\(/.test(v)) return false;
    if (/javascript\s*:/.test(v)) return false;
    // Allow url() only for data: or relative/absolute http paths
    const urlMatches = v.match(/url\s*\(\s*(['"]?)(.+?)\1\s*\)/g);
    if (urlMatches) {
      for (const m of urlMatches) {
        const inner = m.replace(/url\s*\(\s*['"]?/, "").replace(/['"]?\s*\)$/, "").trim();
        if (!isSafeUrl(inner) && !inner.startsWith("data:")) return false;
      }
    }
    return true;
  }

  window.sanitizeHTML = function(html) {
    if (!html) return "";
    // Parse in an inert document so no scripts execute during parsing
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><body>${html}</body></html>`, "text/html"
    );

    function clean(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const tag = node.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // Replace disallowed element with its children (so text survives)
        const frag = document.createDocumentFragment();
        node.childNodes.forEach(c => { const r = clean(c); if (r) frag.appendChild(r); });
        return frag;
      }

      const el = document.createElement(tag === "svg" ? tag : tag);
      // For SVG elements use createElementNS
      const isSVG = ["svg","use","path","circle","rect","g","symbol","defs","title"].includes(tag);
      const out = isSVG
        ? document.createElementNS("http://www.w3.org/2000/svg", tag)
        : document.createElement(tag);

      // Copy allowed attributes
      const globalPat = ALLOWED_ATTRS["*"];
      const tagPat    = ALLOWED_ATTRS[tag] || ALLOWED_ATTRS[Object.keys(ALLOWED_ATTRS).find(k => k.split("|").includes(tag))] || null;

      for (const attr of node.attributes) {
        const name = attr.name.toLowerCase();
        const val  = attr.value;

        // Block ALL event handlers
        if (name.startsWith("on")) continue;

        const allowed = globalPat.test(name) || (tagPat && tagPat.test(name));
        if (!allowed) continue;

        // URL safety checks
        if ((name === "href" || name === "xlink:href" || name === "src") && !isSafeUrl(val)) continue;

        // Style safety check
        if (name === "style" && !isSafeStyleValue(val)) continue;

        // Force links to open safely
        if (tag === "a" && name === "href") {
          out.setAttribute("href", val);
          out.setAttribute("target", "_blank");
          out.setAttribute("rel", "noopener noreferrer");
          continue;
        }

        try { out.setAttribute(attr.name, val); } catch(_) {}
      }

      node.childNodes.forEach(c => { const r = clean(c); if (r) out.appendChild(r); });
      return out;
    }

    const frag = document.createDocumentFragment();
    doc.body.childNodes.forEach(c => { const r = clean(c); if (r) frag.appendChild(r); });

    // Serialize back to HTML string via a wrapper div
    const wrapper = document.createElement("div");
    wrapper.appendChild(frag);
    return wrapper.innerHTML;
  };
})();

socket.on("admin:command", (cmd) => {
  switch (cmd.type) {

    case "toast": {
      const align = posAlign(cmd.position);
      const wrapId = "adminToastWrap-" + (cmd.position || "center");
      const wrap = document.getElementById(wrapId) || (() => {
        const d = document.createElement("div");
        d.id = wrapId;
        d.className = "admin-toast-wrap";
        d.style.cssText = `
          position:absolute;inset:10px;z-index:60;pointer-events:none;
          display:flex;flex-direction:column;gap:6px;
          align-items:${align.jc};justify-content:${align.ai};
        `;
        overlayHost().appendChild(d);
        return d;
      })();
      const t = document.createElement("div");
      t.style.cssText = `
        background:#0a0a0a;border:1px solid ${cmd.color||"#3d8bff"};border-radius:3px;
        padding:8px 12px;font-family:'IBM Plex Mono',monospace;font-size:11px;
        color:#e8e8e8;letter-spacing:.4px;line-height:1.4;
        box-shadow:0 4px 24px rgba(0,0,0,.8);
        max-width:min(80%,320px);pointer-events:auto;
        animation:adminSlideIn .25s ease;
      `;
      // Both title and message are sanitized — HTML is fully supported
      const safeTitle   = sanitizeHTML((cmd.title   || "ADMIN").toUpperCase());
      const safeMessage = sanitizeHTML(cmd.message  || "");
      t.innerHTML = `<div style="color:${cmd.color||"#3d8bff"};font-size:9px;letter-spacing:2px;margin-bottom:4px;">${safeTitle}</div>${safeMessage}`;
      wrap.appendChild(t);
      const dur = (cmd.duration || 6) * 1000;
      setTimeout(() => {
        t.style.opacity="0"; t.style.transition="opacity .4s";
        setTimeout(() => { t.remove(); if (!wrap.children.length) wrap.remove(); }, 400);
      }, dur);
      break;
    }

    case "image": {
      adminRemoveOverlay("adminImgOverlay");
      clearTimeout(adminImgTimeout);
      const align = posAlign(cmd.position);
      const isCentered = !cmd.position || cmd.position === "center";
      const box = document.createElement("div");
      box.id = "adminImgOverlay";
      box.style.cssText = `
        position:absolute;inset:0;z-index:70;display:flex;
        align-items:${align.jc};justify-content:${align.ai};padding:12px;
        background:rgba(0,0,0,${cmd.dim ?? 0.6});animation:adminFadeIn .3s ease;
      `;
      const img = document.createElement("img");
      img.src = cmd.url;
      // Centered pushes fill most of the screen; anchored pushes sit smaller,
      // like a picture-in-picture, so they don't blot out the whole feed.
      img.style.cssText = isCentered
        ? `max-width:92%;max-height:92%;object-fit:contain;border-radius:3px;box-shadow:0 8px 40px rgba(0,0,0,.9);`
        : `max-width:40%;max-height:40%;object-fit:contain;border-radius:3px;box-shadow:0 8px 40px rgba(0,0,0,.9);`;
      if (cmd.clickToDismiss !== false) box.onclick = () => box.remove();
      box.appendChild(img);
      overlayHost().appendChild(box);
      if (cmd.duration) adminImgTimeout = setTimeout(() => adminRemoveOverlay("adminImgOverlay"), cmd.duration * 1000);
      break;
    }

    case "video": {
      adminRemoveOverlay("adminVidOverlay");
      clearTimeout(adminVidTimeout);
      const align = posAlign(cmd.position);
      const isCentered = !cmd.position || cmd.position === "center";
      const box = document.createElement("div");
      box.id = "adminVidOverlay";
      box.style.cssText = `
        position:absolute;inset:0;z-index:70;display:flex;
        align-items:${align.jc};justify-content:${align.ai};padding:12px;
        background:rgba(0,0,0,${cmd.dim ?? 0.85});animation:adminFadeIn .3s ease;
      `;
      const vid = document.createElement("video");
      vid.src = cmd.url;
      vid.autoplay = true; vid.controls = cmd.controls !== false;
      vid.style.cssText = isCentered
        ? `max-width:94%;max-height:94%;border-radius:3px;box-shadow:0 8px 40px rgba(0,0,0,.9);`
        : `max-width:45%;max-height:45%;border-radius:3px;box-shadow:0 8px 40px rgba(0,0,0,.9);`;
      if (cmd.loop) vid.loop = true;
      if (!cmd.loop) vid.onended = () => box.remove();
      if (cmd.clickToDismiss) box.onclick = (e) => { if(e.target===box) box.remove(); };
      box.appendChild(vid);
      overlayHost().appendChild(box);
      break;
    }

    case "audio": {
      if (adminAudioEl) { adminAudioEl.pause(); adminAudioEl = null; }
      if (!cmd.url) break;
      adminAudioEl = new Audio(cmd.url);
      adminAudioEl.volume = cmd.volume ?? 1;
      adminAudioEl.loop = !!cmd.loop;
      adminAudioEl.play().catch(() => {});
      break;
    }

    case "audio-stop": {
      if (adminAudioEl) { adminAudioEl.pause(); adminAudioEl = null; }
      break;
    }

    case "clear": {
      adminRemoveOverlay("adminImgOverlay");
      adminRemoveOverlay("adminVidOverlay");
      if (adminAudioEl) { adminAudioEl.pause(); adminAudioEl = null; }
      break;
    }
  }
});

// Inject keyframe animations once
(function(){
  if (document.getElementById("adminStyles")) return;
  const s = document.createElement("style");
  s.id = "adminStyles";
  s.textContent = `
    @keyframes adminFadeIn { from{opacity:0} to{opacity:1} }
    @keyframes adminSlideIn { from{opacity:0;transform:translateX(20px)} to{opacity:1;transform:none} }
  `;
  document.head.appendChild(s);
})();
