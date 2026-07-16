/* global io */
"use strict";

// ── INTERACTIVE BROADCASTER TUTORIAL ───────────────────────────────────────
// A lightweight, dependency-free "coach mark" tour that spotlights real
// panel elements one at a time with an explanatory card. Purely additive:
// it never touches app.js state and can be safely skipped/replayed anytime
// via the "? TUTORIAL" button in the topbar.
(function () {
  const STORAGE_KEY = "anchorage_broadcaster_tutorial_completed_v1";
  const $ = (id) => document.getElementById(id);

  // Returns the surrounding .card block for a given element id, so the whole
  // panel section lights up rather than just one control inside it.
  function cardOf(id) {
    const el = $(id);
    if (!el) return null;
    return el.closest(".card") || el;
  }

  const steps = [
    {
      title: "Welcome to the Broadcasting Panel",
      body: "Here's a quick tour of the controls you'll use to run your station — output preview, sources, mixer, overlays and more. Takes about a minute, and you can skip anytime.",
      target: null,
    },
    {
      title: "Output Preview",
      body: "This canvas is exactly what your viewers will see. Video, graphics, overlays and the ticker are all composited here in real time before being broadcast.",
      target: () => $("canvasWrap"),
    },
    {
      title: "Viewers & Channel Info",
      body: "Your live viewer count, current channel name, and encoder frame rate all show up here once you're on the air.",
      target: () => document.querySelector(".preview-meta"),
    },
    {
      title: "Name Your Channel",
      body: "Pick a Channel ID here — this is what viewers will select on the client app to tune into your station.",
      target: () => $("channelId"),
    },
    {
      title: "Go Live",
      body: "When you're ready, click ▶ Go Live to start broadcasting under that Channel ID. Click ■ Stop anytime to end the transmission — viewers will see “End of transmission”.",
      target: () => document.querySelector(".go-live-inner .btn-row"),
    },
    {
      title: "Video Source",
      body: "Broadcast from an uploaded video playlist, or switch to your webcam. Only one source feeds the output canvas at a time.",
      target: () => cardOf("srcFile"),
    },
    {
      title: "Screen Capture",
      body: "Share a window or your whole desktop instead — great for gameplay, presentations, or app demos. Turn on “Use as broadcast source” to switch the output to it.",
      target: () => cardOf("btnStartScreenCap"),
    },
    {
      title: "Mixer",
      body: "Balance your mic volume against video/screen audio, and fine-tune the picture's brightness, contrast and saturation.",
      target: () => cardOf("micGain"),
    },
    {
      title: "Soundboard",
      body: "Upload short sound effects or jingles here and fire them off with a single click while you're live.",
      target: () => cardOf("sbMasterVol"),
    },
    {
      title: "Graphics",
      body: "Add a live marker, date & time, on-screen text, or a scrolling news ticker — all rendered directly onto the broadcast.",
      target: () => cardOf("showLiveTag"),
    },
    {
      title: "Overlays",
      body: "Drop an image or video file here to create a draggable, resizable overlay right on top of your broadcast.",
      target: () => cardOf("overlayDropZone"),
    },
    {
      title: "Flash Overlay",
      body: "For urgent announcements — pushes a fullscreen image over the broadcast for a few seconds, then disappears automatically.",
      target: () => cardOf("urgentFile"),
    },
    {
      title: "You're all set!",
      body: "That's the full panel. Hit ▶ Go Live whenever you're ready — and revisit this tour anytime from the “? TUTORIAL” button up top.",
      target: null,
    },
  ];

  let idx = 0;
  let active = false;
  let backdrop, spotlight, card;

  function build() {
    if (backdrop) return;
    backdrop = document.createElement("div");
    backdrop.className = "tutorial-backdrop";

    spotlight = document.createElement("div");
    spotlight.className = "tutorial-spotlight";

    card = document.createElement("div");
    card.className = "tutorial-card";
    card.innerHTML = `
      <div class="tutorial-eyebrow" id="tutEyebrow"></div>
      <div class="tutorial-title" id="tutTitle"></div>
      <div class="tutorial-body" id="tutBody"></div>
      <div class="tutorial-dots" id="tutDots"></div>
      <div class="tutorial-actions">
        <button type="button" class="tutorial-skip" id="tutSkip">Skip tour</button>
        <div class="tutorial-nav">
          <button type="button" class="tutorial-back" id="tutBack">◀ Back</button>
          <button type="button" class="tutorial-next" id="tutNext">Next ▶</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(spotlight);
    document.body.appendChild(card);

    $("tutSkip").onclick = finish;
    $("tutBack").onclick = prev;
    $("tutNext").onclick = () => {
      if (idx >= steps.length - 1) finish();
      else next();
    };
  }

  function renderDots() {
    const dotsEl = $("tutDots");
    dotsEl.innerHTML = "";
    steps.forEach((_, i) => {
      const d = document.createElement("span");
      d.className = "tutorial-dot" + (i === idx ? " active" : "");
      dotsEl.appendChild(d);
    });
  }

  function positionFor(rect) {
    const margin = 16;
    const cardW = card.offsetWidth || 296;
    const cardH = card.offsetHeight || 170;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    let top;
    if (spaceBelow >= cardH + margin || spaceBelow >= spaceAbove) {
      top = rect.bottom + margin;
    } else {
      top = rect.top - cardH - margin;
    }
    top = Math.max(12, Math.min(top, window.innerHeight - cardH - 12));

    let left = rect.left + rect.width / 2 - cardW / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - cardW - 12));

    return { top, left };
  }

  function place() {
    if (!active) return;
    const step = steps[idx];
    const target = typeof step.target === "function" ? step.target() : null;

    if (!target) {
      // Centered "chapter" step — no real element to spotlight.
      spotlight.classList.remove("show");
      card.classList.add("center");
      card.style.top = "";
      card.style.left = "";
      card.classList.add("show");
      return;
    }

    card.classList.remove("center");
    const rect = target.getBoundingClientRect();
    const pad = 6;
    spotlight.style.top = rect.top - pad + "px";
    spotlight.style.left = rect.left - pad + "px";
    spotlight.style.width = rect.width + pad * 2 + "px";
    spotlight.style.height = rect.height + pad * 2 + "px";
    spotlight.classList.add("show");

    const pos = positionFor(rect);
    card.style.top = pos.top + "px";
    card.style.left = pos.left + "px";
    card.classList.add("show");
  }

  function render() {
    const step = steps[idx];
    $("tutEyebrow").textContent = `STEP ${idx + 1} OF ${steps.length}`;
    $("tutTitle").textContent = step.title;
    $("tutBody").textContent = step.body;
    renderDots();

    $("tutBack").style.visibility = idx === 0 ? "hidden" : "visible";
    $("tutNext").textContent = idx === steps.length - 1 ? "Finish" : "Next ▶";

    card.classList.remove("show");
    spotlight.classList.remove("show");

    const step2 = steps[idx];
    const target = typeof step2.target === "function" ? step2.target() : null;
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(place, 260);
    } else {
      place();
    }
  }

  function next() {
    if (idx < steps.length - 1) { idx++; render(); }
  }
  function prev() {
    if (idx > 0) { idx--; render(); }
  }

  function onKeydown(e) {
    if (!active) return;
    if (e.key === "Escape") finish();
    else if (e.key === "ArrowRight" || e.key === "Enter") next();
    else if (e.key === "ArrowLeft") prev();
  }

  function start() {
    build();
    idx = 0;
    active = true;
    backdrop.classList.add("show");
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKeydown);
    render();
  }

  function finish() {
    active = false;
    if (backdrop) backdrop.classList.remove("show");
    if (spotlight) spotlight.classList.remove("show");
    if (card) card.classList.remove("show");
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    document.removeEventListener("keydown", onKeydown);
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch (_) {}
  }

  const btn = $("btnTutorial");
  if (btn) btn.onclick = start;

  // Auto-launch once for first-time visitors; never again after that unless
  // they click the Tutorial button themselves.
  let alreadyDone = false;
  try { alreadyDone = localStorage.getItem(STORAGE_KEY) === "1"; } catch (_) {}
  if (!alreadyDone) {
    setTimeout(start, 700);
  }
})();
