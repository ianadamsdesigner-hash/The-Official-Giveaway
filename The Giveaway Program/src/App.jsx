import React, { useState, useRef, useEffect, useCallback } from "react";

/* ════════════════════════════════════════════════════════════════════════════
   TROCAS MAMALONAS — GIVEAWAY DRAW

   ANIMATION ARCHITECTURE (this is what prevents glitching — do not change it):

   1. ONE requestAnimationFrame loop. Started once on mount, runs until unmount.
      Never cancelled, never restarted, never duplicated. Two loops can never
      fight over the canvas because there is only ever one.

   2. Motion is driven by ACCUMULATED time with a clamped per-frame delta —
      never by reading the wall clock. If the browser starves us of frames
      (other tabs, background load, throttling) the reel advances a little
      less that frame instead of teleporting forward to catch up. Teleporting
      is what produced the ghosting/skipping.

   3. Canvas resizing happens inside the loop and only when dimensions really
      changed. Assigning canvas.width wipes the bitmap, so doing it on every
      React render caused stutter.

   4. The reel stops at its natural velocity-matched distance and the winner
      is placed into whichever slot lands centre — we never force the reel to
      travel to wherever the winner happens to sit, which used to demand
      hundreds of times the intended distance and caused a violent lurch.

   5. All phase seams are velocity-matched, so speed is continuous end to end.
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Fonts ───────────────────────────────────────────────────────────────── */
(() => {
  if (typeof document === "undefined") return;
  if (document.getElementById("gw-fonts")) return;
  const l = document.createElement("link");
  l.id = "gw-fonts";
  l.rel = "stylesheet";
  l.href =
    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&family=Bebas+Neue&family=Oswald:wght@400;600;700&display=swap";
  document.head.appendChild(l);
})();

const FONTS = {
  grotesk: { label: "Space Grotesk", head: "'Space Grotesk', sans-serif", body: "'Inter', sans-serif" },
  inter: { label: "Inter", head: "'Inter', sans-serif", body: "'Inter', sans-serif" },
  bebas: { label: "Bebas Neue", head: "'Bebas Neue', sans-serif", body: "'Inter', sans-serif" },
  oswald: { label: "Oswald", head: "'Oswald', sans-serif", body: "'Inter', sans-serif" },
};

/* ── Defaults ────────────────────────────────────────────────────────────── */
const DEFAULTS = {
  /* identity */
  drawTitle: "GIVEAWAY DRAW",
  accent: "#C9A84C",
  winnerTextColor: "#0F0900",
  fontKey: "grotesk",

  /* motion */
  cruiseSpeed: 30,      // names per second
  cruiseMaxSec: 20,     // cap on the cruise phase
  burstSec: 2.5,        // how long the speed-up lasts
  burstPct: 220,        // peak speed, % of cruise
  burstCurve: "gentle", // gentle | linear | aggressive
  slowSec: 4,           // deceleration length
  slowCurve: "soft",    // soft | normal | snap

  /* draw behaviour */
  countdown: 3,         // seconds, 0 = off
  tease: false,         // creep one extra name after it looks stopped
  teaseMs: 900,
  excludePrev: true,    // drop previous winners on the next draw
  freezeWinner: false,  // lock the result against stray clicks

  /* look */
  rows: 5,              // 3 | 5 | 7
  textSize: 32,         // pt
  pillWidth: 88,        // % of tumbler width
  pillRound: 100,       // % of max roundness
  pillGlow: 60,         // 0-100
  shineSec: 2.6,        // winner shine sweep period
  hideNumbers: false,   // strip "#123456 - " when displaying

  /* background */
  overlayColor: "#000000",
  overlayOpacity: 45,

  /* production */
  sound: true,
  volume: 40,
  hideCursor: true,

  /* security */
  adminPin: "",
};

const PRESETS = {
  quick: { label: "Quick Draw", cruiseMaxSec: 6, burstSec: 1, burstPct: 180, burstCurve: "linear", slowSec: 2, slowCurve: "snap", countdown: 0, tease: false },
  drama: { label: "Full Drama", cruiseMaxSec: 20, burstSec: 3, burstPct: 260, burstCurve: "gentle", slowSec: 6, slowCurve: "soft", countdown: 3, tease: true },
  slow: { label: "Slow Burn", cruiseMaxSec: 40, burstSec: 5, burstPct: 150, burstCurve: "gentle", slowSec: 12, slowCurve: "soft", countdown: 5, tease: true },
};

/* ── Small helpers ───────────────────────────────────────────────────────── */
function hexA(hex, a) {
  const h = String(hex || "#000000").replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16);
  if (isNaN(n)) return `rgba(0,0,0,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function stripNumber(name) {
  return String(name).replace(/^#\s*\d+\s*[-–—:]\s*/, "");
}

/* Burst velocity shapes. s(u) goes 0→1; Is(u) is its integral.
   Every shape ends at s(1)=1 so the burst always finishes at exactly peak
   speed, which keeps the seam into the slowdown velocity-continuous. */
const BURST = {
  gentle: { s: (u) => u * u * (3 - 2 * u), I: (u) => u * u * u - (u * u * u * u) / 2 },
  linear: { s: (u) => u, I: (u) => (u * u) / 2 },
  aggressive: { s: (u) => 1 - Math.pow(1 - u, 3), I: (u) => u - (1 - Math.pow(1 - u, 4)) / 4 },
};

/* Slowdown shapes. p(0)=0, p(1)=1, p'(1)=0. k = p'(0) is used to
   velocity-match the entry into the slowdown. */
const SLOW = {
  soft:   { p: (t) => 1 - Math.pow(1 - t, 4), k: 4 },
  normal: { p: (t) => 1 - Math.pow(1 - t, 3), k: 3 },
  snap:   { p: (t) => 1 - Math.pow(1 - t, 6), k: 6 },
};

/* ── Media helpers ───────────────────────────────────────────────────────── */
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error("read failed"));
    fr.onload = (e) => res(e.target.result);
    fr.readAsDataURL(file);
  });
}

function drawToJpeg(src, w, h, maxW) {
  const s = Math.min(1, maxW / w);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

async function compressImage(file, maxW = 1600) {
  const raw = await readAsDataURL(file);
  if (typeof createImageBitmap === "function") {
    try {
      const b = await createImageBitmap(file);
      const out = drawToJpeg(b, b.width, b.height, maxW);
      if (b.close) b.close();
      return out;
    } catch (e) { /* fall through */ }
  }
  try {
    return await new Promise((res, rej) => {
      const img = new Image();
      img.onerror = () => rej(new Error("decode"));
      img.onload = () => {
        try { res(drawToJpeg(img, img.naturalWidth || img.width, img.naturalHeight || img.height, maxW)); }
        catch (e2) { rej(e2); }
      };
      img.src = raw;
    });
  } catch (e) { /* fall through */ }
  return raw;
}

/* ── Storage ─────────────────────────────────────────────────────────────── */
const DB_NAME = "trocas-media";
const STORE = "kv";

function idbOpen() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const q = tx.objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result ?? null);
    q.onerror = () => rej(q.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("trocas-cfg");
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  return { ...DEFAULTS };
}
function saveSettings(cfg) {
  try { localStorage.setItem("trocas-cfg", JSON.stringify(cfg)); } catch (e) { /* ignore */ }
}

function downloadFile(name, text, type = "text/plain") {
  try {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) { return false; }
}

/* ── Sound (synthesised — no asset files) ────────────────────────────────── */
function makeAudio() {
  let ctx = null;
  const ensure = () => {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    } catch (e) { ctx = null; }
    return ctx;
  };
  return {
    resume() { const c = ensure(); if (c && c.state === "suspended") { try { c.resume(); } catch (e) {} } },
    tick(vol) {
      const c = ensure(); if (!c || vol <= 0) return;
      try {
        const o = c.createOscillator(), g = c.createGain();
        o.type = "square"; o.frequency.value = 1100;
        g.gain.value = 0.0001;
        o.connect(g); g.connect(c.destination);
        const t = c.currentTime;
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * 0.05), t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
        o.start(t); o.stop(t + 0.05);
      } catch (e) { /* ignore */ }
    },
    win(vol) {
      const c = ensure(); if (!c || vol <= 0) return;
      try {
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          const o = c.createOscillator(), g = c.createGain();
          o.type = "triangle"; o.frequency.value = f;
          o.connect(g); g.connect(c.destination);
          const t = c.currentTime + i * 0.085;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * 0.22), t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
          o.start(t); o.stop(t + 0.8);
        });
      } catch (e) { /* ignore */ }
    },
    beep(vol, freq) {
      const c = ensure(); if (!c || vol <= 0) return;
      try {
        const o = c.createOscillator(), g = c.createGain();
        o.type = "sine"; o.frequency.value = freq;
        o.connect(g); g.connect(c.destination);
        const t = c.currentTime;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * 0.2), t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.start(t); o.stop(t + 0.32);
      } catch (e) { /* ignore */ }
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   RENDERER — pure function of (canvas, state)
   ════════════════════════════════════════════════════════════════════════════ */
function paint(canvas, s) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = s.dpr;
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  if (!W || !H) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const rows = s.rows;
  const crow = Math.floor(rows / 2);
  const slotH = H / rows;
  const cy = H / 2;
  const accent = s.accent;
  const headFont = s.headFont;
  const bodyFont = s.bodyFont;
  const entries = s.entries;
  const n = entries.length;

  const disp = (nm) => (s.hideNumbers ? stripNumber(nm) : String(nm));

  /* Countdown overlay state */
  if (s.phase === "count") {
    const left = Math.max(0, Math.ceil((s.countMs - s.pe) / 1000));
    const frac = 1 - ((s.pe % 1000) / 1000);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 3;
    const size = Math.min(W * 0.34, H * 0.55) * (0.82 + frac * 0.18);
    ctx.font = `700 ${Math.round(size)}px ${headFont}`;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.35 + frac * 0.65;
    ctx.fillText(String(left || 1), W / 2, cy);
    ctx.globalAlpha = 1;
    ctx.restore();
    return;
  }

  /* Idle / ready */
  if (s.phase === "empty" || s.phase === "ready" || n === 0) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 2;
    if (s.phase === "ready" && n > 0) {
      ctx.font = `700 20px ${headFont}`;
      ctx.fillStyle = accent;
      ctx.fillText("ENTRIES LOADED", W / 2, cy - 16);
      ctx.font = `600 14px ${bodyFont}`;
      ctx.fillStyle = "rgba(255,255,255,0.78)";
      ctx.fillText("READY TO DRAW", W / 2, cy + 16);
    } else {
      ctx.font = `600 15px ${bodyFont}`;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText("Upload your entries to begin", W / 2, cy);
    }
    ctx.restore();
    return;
  }

  const won = s.phase === "won";

  /* Scrolling names — hidden entirely once the winner is locked in */
  if (!won) {
    const offset = s.offset * slotH;
    const first = Math.floor(offset / slotH);
    const rem = offset - first * slotH;
    const baseFs = Math.max(20, Math.min(W * 0.055, 46)) * s.textScale;
    const rowMaxW = W - 90;

    for (let r = -1; r <= rows + 1; r++) {
      const idx = (((first + r) % n) + n) % n;
      const y = r * slotH - rem;
      if (y + slotH < 0 || y > H) continue;

      const rowCy = y + slotH / 2;
      const dist = Math.abs(rowCy - cy);
      const prox = Math.max(0, 1 - dist / cy);
      const alpha = 0.18 + prox * 0.82;
      const scale = 0.66 + prox * 0.34;
      const name = disp(entries[idx] || "");
      let fs = Math.max(10, Math.round(baseFs * scale));

      ctx.save();
      ctx.translate(W / 2, rowCy);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.shadowColor = "rgba(0,0,0,0.85)";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 2;
      ctx.font = `700 ${fs}px ${bodyFont}`;
      let guard = 0;
      while (fs > 10 && guard < 60 && ctx.measureText(name).width > rowMaxW) {
        fs -= 1; guard++;
        ctx.font = `700 ${fs}px ${bodyFont}`;
      }
      ctx.fillText(name, 0, 0);
      ctx.restore();
    }
  }

  /* ── Centre pill ─────────────────────────────────────────────────────── */
  const pillH = Math.max(28, slotH - 12);
  const pillY = cy - pillH / 2;
  const maxR = pillH / 2;
  const pillR = Math.max(4, (Math.min(100, Math.max(0, s.pillRound)) / 100) * maxR);
  const innerW = W * (Math.min(100, Math.max(40, s.pillWidth)) / 100);
  const pad = Math.max(8, (W - innerW) / 2);

  const pillPath = () => {
    const x0 = pad, x1 = W - pad;
    ctx.beginPath();
    ctx.moveTo(x0 + pillR, pillY);
    ctx.lineTo(x1 - pillR, pillY);
    ctx.arcTo(x1, pillY, x1, pillY + pillR, pillR);
    ctx.lineTo(x1, pillY + pillH - pillR);
    ctx.arcTo(x1, pillY + pillH, x1 - pillR, pillY + pillH, pillR);
    ctx.lineTo(x0 + pillR, pillY + pillH);
    ctx.arcTo(x0, pillY + pillH, x0, pillY + pillH - pillR, pillR);
    ctx.lineTo(x0, pillY + pillR);
    ctx.arcTo(x0, pillY, x0 + pillR, pillY, pillR);
    ctx.closePath();
  };

  const glow = Math.min(100, Math.max(0, s.pillGlow)) / 100;

  if (won) {
    const pulse = 0.5 + 0.5 * Math.sin(s.clock / 900);

    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = (18 + pulse * 30) * glow;
    pillPath();
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.restore();

    /* travelling shine */
    const per = Math.max(400, s.shineSec * 1000);
    const sweep = (s.clock % per) / per;
    const g = ctx.createLinearGradient(pad, 0, W - pad, 0);
    const a1 = Math.max(0, Math.min(1, sweep - 0.16));
    const a2 = Math.max(a1, Math.min(1, sweep));
    const a3 = Math.max(a2, Math.min(1, sweep + 0.16));
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(a1, "rgba(255,255,255,0)");
    g.addColorStop(a2, "rgba(255,255,255,0.55)");
    g.addColorStop(a3, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    pillPath(); ctx.fillStyle = g; ctx.fill();

    /* metallic gloss */
    const gl = ctx.createLinearGradient(0, pillY, 0, pillY + pillH);
    gl.addColorStop(0, "rgba(255,255,255,0.42)");
    gl.addColorStop(0.45, "rgba(255,255,255,0.05)");
    gl.addColorStop(0.55, "rgba(0,0,0,0.04)");
    gl.addColorStop(1, "rgba(0,0,0,0.20)");
    pillPath(); ctx.fillStyle = gl; ctx.fill();

    pillPath();
    ctx.strokeStyle = "#8a6a12";
    ctx.lineWidth = 2;
    ctx.stroke();

    /* Winner name — always the entry that was actually selected */
    const name = disp(s.winnerName || "");
    let fs = Math.round(Math.max(20, Math.min(W * 0.055, 46)) * s.textScale) + 4;
    const maxTextW = innerW - 2 * pillR - 26;
    ctx.save();
    ctx.translate(W / 2, cy);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = s.winnerTextColor;
    ctx.font = `900 ${fs}px ${headFont}`;
    let guard = 0;
    while (fs > 11 && guard < 90 && ctx.measureText(name).width > maxTextW) {
      fs -= 1; guard++;
      ctx.font = `900 ${fs}px ${headFont}`;
    }
    ctx.fillText(name, 0, 0);
    ctx.restore();
  } else {
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 18 * glow;
    pillPath();
    const pg = ctx.createLinearGradient(0, pillY, 0, pillY + pillH);
    pg.addColorStop(0, "rgba(255,255,255,0.15)");
    pg.addColorStop(0.5, "rgba(255,255,255,0.07)");
    pg.addColorStop(1, "rgba(255,255,255,0.15)");
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.restore();

    pillPath();
    ctx.strokeStyle = hexA(accent, 0.72);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.restore();
}

/* ════════════════════════════════════════════════════════════════════════════
   DRAW SCREEN
   ════════════════════════════════════════════════════════════════════════════ */
function DrawScreen({ cfg, media, onAdmin }) {
  const shellRef = useRef(null);
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const audioRef = useRef(null);
  if (!audioRef.current) audioRef.current = makeAudio();

  const S = useRef({
    phase: "empty",       // empty|ready|count|cruise|burst|slow|tease|won
    entries: [],
    pool: [],             // master list as uploaded
    offset: 0,
    winnerName: null,
    pe: 0,
    last: 0,
    clock: 0,
    /* plan */
    countMs: 0,
    cruiseMs: 0, cruiseDist: 0,
    burstMs: 0, burstDist: 0, v0: 0, vPeak: 0, burstShape: BURST.gentle,
    slowMs: 0, slowDist: 0, slowShape: SLOW.soft,
    teaseFrom: 0, teaseTo: 0, teaseMs: 0,
    finOff: 0,
    /* view */
    slotH: 100, dpr: 1, cssW: 0, cssH: 0,
    rows: 5, accent: "#C9A84C", textScale: 1,
    headFont: FONTS.grotesk.head, bodyFont: FONTS.grotesk.body,
    pillWidth: 88, pillRound: 100, pillGlow: 60, shineSec: 2.6,
    hideNumbers: false, winnerTextColor: "#0F0900",
    /* sound */
    soundOn: true, vol: 0.4, lastTickRow: 0, lastBeep: -1,
  });

  const [ui, setUi] = useState({ phase: "empty", count: 0, file: "" });
  const [history, setHistory] = useState([]);
  const [locked, setLocked] = useState(false);
  const [fs, setFs] = useState(false);

  /* Mirror settings into the animation state */
  useEffect(() => {
    const s = S.current;
    const f = FONTS[cfg.fontKey] || FONTS.grotesk;
    s.rows = [3, 5, 7].includes(cfg.rows) ? cfg.rows : 5;
    s.accent = cfg.accent;
    s.textScale = (cfg.textSize || 32) / 32;
    s.headFont = f.head;
    s.bodyFont = f.body;
    s.pillWidth = cfg.pillWidth;
    s.pillRound = cfg.pillRound;
    s.pillGlow = cfg.pillGlow;
    s.shineSec = cfg.shineSec;
    s.hideNumbers = !!cfg.hideNumbers;
    s.winnerTextColor = cfg.winnerTextColor;
    s.soundOn = !!cfg.sound;
    s.vol = Math.max(0, Math.min(100, cfg.volume ?? 40)) / 100;
    s.slotH = s.cssH ? s.cssH / s.rows : s.slotH;
  }, [cfg]);

  /* ── THE loop ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    let alive = true;

    const sizeCanvas = () => {
      const cv = canvasRef.current, wrap = wrapRef.current;
      if (!cv || !wrap) return;
      const cssW = Math.min(wrap.clientWidth, 1100);
      if (cssW <= 0) return;
      const vh = window.innerHeight || 800;
      const cssH = Math.max(320, Math.min(vh * 0.58, cssW * 0.8, 640));
      const dpr = window.devicePixelRatio || 1;
      const s = S.current;
      if (s.cssW !== cssW || s.cssH !== cssH || s.dpr !== dpr) {
        cv.width = Math.round(cssW * dpr);
        cv.height = Math.round(cssH * dpr);
        cv.style.width = cssW + "px";
        cv.style.height = cssH + "px";
        s.cssW = cssW; s.cssH = cssH; s.dpr = dpr;
        s.slotH = cssH / s.rows;
      }
    };

    const tick = (now) => {
      if (!alive) return;
      const s = S.current;

      if (typeof document !== "undefined" && document.hidden) {
        s.last = now;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const raw = s.last ? now - s.last : 0;
      const dt = raw > 0 ? Math.min(raw, 50) : 0;
      s.last = now;
      s.clock += dt;

      sizeCanvas();

      const A = audioRef.current;
      const prevOffset = s.offset;

      if (s.phase === "count") {
        s.pe += dt;
        const left = Math.ceil((s.countMs - s.pe) / 1000);
        if (s.soundOn && left !== s.lastBeep && left > 0) {
          s.lastBeep = left;
          A.beep(s.vol, 620);
        }
        if (s.pe >= s.countMs) {
          s.pe = 0;
          s.phase = "cruise";
          s.lastBeep = -1;
          setUi((u) => ({ ...u, phase: "cruise" }));
        }
      } else if (s.phase === "cruise") {
        s.pe += dt;
        const t = Math.min(s.pe / s.cruiseMs, 1);
        s.offset = t * s.cruiseDist;
        if (s.pe >= s.cruiseMs) { s.phase = "burst"; s.pe -= s.cruiseMs; }
      } else if (s.phase === "burst") {
        s.pe += dt;
        const u = Math.min(s.pe / s.burstMs, 1);
        const Ts = s.burstMs;
        s.offset = s.cruiseDist + Ts * (s.v0 * u + (s.vPeak - s.v0) * s.burstShape.I(u));
        if (s.pe >= s.burstMs) {
          s.offset = s.cruiseDist + s.burstDist;
          s.phase = "slow";
          s.pe -= s.burstMs;
        }
      } else if (s.phase === "slow") {
        s.pe += dt;
        const t = Math.min(s.pe / s.slowMs, 1);
        s.offset = s.cruiseDist + s.burstDist + s.slowShape.p(t) * s.slowDist;
        if (s.pe >= s.slowMs) {
          s.offset = s.teaseMs > 0 ? s.teaseFrom : s.finOff;
          s.pe -= s.slowMs;
          if (s.teaseMs > 0) {
            s.phase = "tease";
          } else {
            s.phase = "won";
            if (s.soundOn) A.win(s.vol);
            setUi((u) => ({ ...u, phase: "won" }));
          }
        }
      } else if (s.phase === "tease") {
        s.pe += dt;
        const t = Math.min(s.pe / s.teaseMs, 1);
        const e = 1 - Math.pow(1 - t, 3);
        s.offset = s.teaseFrom + e * (s.teaseTo - s.teaseFrom);
        if (s.pe >= s.teaseMs) {
          s.offset = s.finOff;
          s.phase = "won";
          if (s.soundOn) A.win(s.vol);
          setUi((u) => ({ ...u, phase: "won" }));
        }
      }

      /* tick sound, rate-limited so fast scrolling doesn't machine-gun */
      if (s.soundOn && (s.phase === "cruise" || s.phase === "burst" || s.phase === "slow" || s.phase === "tease")) {
        const row = Math.floor(s.offset);
        if (row !== s.lastTickRow) {
          const jumped = Math.abs(row - s.lastTickRow);
          s.lastTickRow = row;
          if (jumped <= 2 || s.phase === "slow" || s.phase === "tease") A.tick(s.vol);
        }
      }
      void prevOffset;

      paint(canvasRef.current, s);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { alive = false; if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  /* ── Upload ───────────────────────────────────────────────────────────── */
  const applyEntries = (names, fileName) => {
    const s = S.current;
    s.pool = names;
    s.entries = names;
    s.offset = 0;
    s.winnerName = null;
    s.phase = names.length ? "ready" : "empty";
    setHistory([]);
    setLocked(false);
    setUi({ phase: s.phase, count: names.length, file: fileName || "" });
  };

  const onUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = (ev) => {
      const names = String(ev.target.result)
        .split("\n").map((x) => x.trim()).filter(Boolean);
      applyEntries(names, file.name);
    };
    fr.readAsText(file);
    e.target.value = "";
  };

  /* ── Start a draw ─────────────────────────────────────────────────────── */
  const startDraw = useCallback((opts) => {
    const s = S.current;
    if (["count", "cruise", "burst", "slow", "tease"].includes(s.phase)) return;

    const nextPlace = (opts && opts.nextPlace) || false;

    /* Build the pool for this draw */
    let pool = s.pool;
    if (nextPlace && cfg.excludePrev && history.length) {
      const taken = new Set(history.map((h) => h.name));
      pool = pool.filter((x) => !taken.has(x));
    }
    if (!pool.length) return;
    if (!nextPlace) setHistory([]);

    s.entries = shuffle(pool);
    const n = s.entries.length;
    /* Motion is planned in SLOT units (1 = one name), not pixels. The painter
       multiplies by the live slot height, so rounding, resizes or fullscreen
       mid-draw can never drift the reel off the winner. */
    const slotH = 1;

    const wIdx = Math.floor(Math.random() * n);
    const wName = s.entries[wIdx];

    /* ── Plan the motion (all in px/ms) ─────────────────────────────────── */
    const speed = Math.max(1, cfg.cruiseSpeed || 30);
    const v0 = (speed * slotH) / 1000;
    const cruiseSec = Math.min(n / speed, Math.max(1, cfg.cruiseMaxSec || 20));
    const cruiseMs = cruiseSec * 1000;
    const cruiseDist = v0 * cruiseMs;

    const burstShape = BURST[cfg.burstCurve] || BURST.gentle;
    const burstMs = Math.max(120, (cfg.burstSec || 2.5) * 1000);
    const vPeak = v0 * Math.max(1, (cfg.burstPct || 100) / 100);
    /* exact area under the burst velocity curve */
    const burstDist = burstMs * (v0 + (vPeak - v0) * burstShape.I(1));

    const slowShape = SLOW[cfg.slowCurve] || SLOW.soft;
    const slowSec = Math.max(0.5, cfg.slowSec || 4);
    const slowGuess = (vPeak * slowSec * 1000) / slowShape.k;

    const useTease = !!cfg.tease;
    const teaseMs = useTease ? Math.max(200, cfg.teaseMs || 900) : 0;
    /* when teasing, the reel stops one slot short and then creeps forward */
    const extraSlots = useTease ? 1 : 0;

    const before = cruiseDist + burstDist;
    let finSlots = Math.round((before + slowGuess) / slotH);
    const minSlots = Math.ceil(before / slotH) + 1;
    if (finSlots < minSlots) finSlots = minSlots;

    const stopOff = finSlots * slotH;             // where the slowdown ends
    const slowDist = stopOff - before;            // always > 0
    /* velocity-match the entry into the slowdown: vPeak = k·D/T  →  T = k·D/v */
    const slowMs = Math.max(250, (slowShape.k * slowDist) / vPeak);

    const finOff = (finSlots + extraSlots) * slotH;
    const crow = Math.floor(s.rows / 2);
    const centreIdx = ((((finSlots + extraSlots) + crow) % n) + n) % n;

    /* Place the winner in the slot that will land centre (pure permutation —
       every entry keeps exactly the number of tickets it had) */
    const tmp = s.entries[centreIdx];
    s.entries[centreIdx] = wName;
    s.entries[wIdx] = tmp;

    s.winnerName = wName;
    s.offset = 0;
    s.v0 = v0; s.vPeak = vPeak;
    s.cruiseMs = cruiseMs; s.cruiseDist = cruiseDist;
    s.burstMs = burstMs; s.burstDist = burstDist; s.burstShape = burstShape;
    s.slowMs = slowMs; s.slowDist = slowDist; s.slowShape = slowShape;
    s.teaseMs = teaseMs; s.teaseFrom = stopOff; s.teaseTo = finOff;
    s.finOff = finOff;
    s.pe = 0; s.last = 0; s.lastTickRow = 0; s.lastBeep = -1;

    const cd = Math.max(0, cfg.countdown || 0);
    s.countMs = cd * 1000;
    s.phase = cd > 0 ? "count" : "cruise";

    setLocked(false);
    if (audioRef.current) audioRef.current.resume();
    setUi((u) => ({ ...u, phase: s.phase }));
  }, [cfg, history]);

  /* Record the winner once the reel lands */
  useEffect(() => {
    if (ui.phase !== "won") return;
    const name = S.current.winnerName;
    if (!name) return;
    setHistory((h) => (h.length && h[h.length - 1].name === name ? h : [...h, {
      place: h.length + 1,
      name,
      time: new Date().toLocaleTimeString(),
    }]));
    if (cfg.freezeWinner) setLocked(true);
  }, [ui.phase, cfg.freezeWinner]);

  const closeDraw = () => {
    const s = S.current;
    s.entries = []; s.pool = []; s.offset = 0; s.winnerName = null; s.phase = "empty";
    setHistory([]); setLocked(false);
    setUi({ phase: "empty", count: 0, file: "" });
  };

  const resetToReady = () => {
    const s = S.current;
    if (!s.pool.length) return;
    s.entries = s.pool; s.offset = 0; s.winnerName = null; s.phase = "ready";
    setHistory([]); setLocked(false);
    setUi((u) => ({ ...u, phase: "ready" }));
  };

  /* ── Fullscreen ───────────────────────────────────────────────────────── */
  const toggleFs = useCallback(() => {
    const el = shellRef.current;
    try {
      if (!document.fullscreenElement) {
        if (el && el.requestFullscreen) el.requestFullscreen();
      } else if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    } catch (e) { /* ignore */ }
  }, []);

  useEffect(() => {
    const h = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  /* ── Keyboard ─────────────────────────────────────────────────────────── */
  const actions = useRef({});
  actions.current = { startDraw, closeDraw, resetToReady, toggleFs, ui, locked };

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      const a = actions.current;
      const busy = ["count", "cruise", "burst", "slow", "tease"].includes(a.ui.phase);
      if (e.code === "Space") {
        e.preventDefault();
        if (!busy && !a.locked) a.startDraw();
      } else if (e.key === "r" || e.key === "R") {
        if (!busy && !a.locked) a.startDraw();
      } else if (e.key === "f" || e.key === "F") {
        a.toggleFs();
      } else if (e.key === "Escape") {
        if (!document.fullscreenElement) a.resetToReady();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── Derived UI ───────────────────────────────────────────────────────── */
  const busy = ["count", "cruise", "burst", "slow", "tease"].includes(ui.phase);
  const won = ui.phase === "won";
  const loaded = ui.count > 0;
  const accent = cfg.accent;
  const F = FONTS[cfg.fontKey] || FONTS.grotesk;
  const hasMedia = !!(media.bgVideo || media.bgImage);
  const fileLabel = ui.file ? ui.file.replace(/\.[^.]+$/, "").replace(/_/g, " ") : "";
  const remaining = cfg.excludePrev
    ? S.current.pool.length - history.length
    : S.current.pool.length;

  const btn = (bg, color, extra) => ({
    padding: "18px 0",
    fontSize: ".95rem",
    fontFamily: F.head,
    fontWeight: 700,
    letterSpacing: ".2em",
    background: bg,
    color,
    border: "none",
    borderRadius: 100,
    cursor: "pointer",
    transition: "all .2s",
    ...extra,
  });

  const ghost = {
    background: "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.82)",
    border: "1px solid rgba(255,255,255,0.16)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
  };

  return (
    <div
      ref={shellRef}
      style={{
        minHeight: "100vh",
        background: "#06060e",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "0 22px 20px",
        fontFamily: F.head,
        color: "#fff",
        position: "relative",
        overflow: "hidden",
        cursor: busy && cfg.hideCursor ? "none" : "auto",
      }}
    >
      <style>{`
        @keyframes gwShim{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
        @keyframes gwPulse{0%,100%{opacity:1}50%{opacity:.35}}
        .gw-b:hover:not(:disabled){filter:brightness(1.08);transform:translateY(-1px)}
        .gw-b:active:not(:disabled){transform:translateY(0)}
        .gw-g:hover{background:rgba(255,255,255,0.12) !important}
      `}</style>

      {/* Background media */}
      {media.bgVideo ? (
        <video
          key="bgv" autoPlay loop muted playsInline src={media.bgVideo}
          style={{
            position: "absolute", inset: 0, width: "100%", height: "100%",
            objectFit: "cover", zIndex: 0,
            filter: busy ? "blur(6px) brightness(0.8)" : "none",
            transform: busy ? "scale(1.04)" : "scale(1)",
            transition: "filter 1s ease, transform 1s ease",
          }}
        />
      ) : media.bgImage ? (
        <div
          style={{
            position: "absolute", inset: 0,
            backgroundImage: `url(${media.bgImage})`,
            backgroundSize: "cover", backgroundPosition: "center", zIndex: 0,
            filter: busy ? "blur(6px) brightness(0.8)" : "none",
            transform: busy ? "scale(1.04)" : "scale(1)",
            transition: "filter 1s ease, transform 1s ease",
          }}
        />
      ) : null}

      <div
        style={{
          position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none",
          background: hasMedia
            ? hexA(cfg.overlayColor, (cfg.overlayOpacity ?? 45) / 100)
            : "radial-gradient(ellipse at 50% 55%, rgba(90,58,0,.45) 0%, rgba(10,8,0,.9) 70%, rgba(0,0,0,.95) 100%)",
          transition: "background .3s ease",
        }}
      />

      <div style={{ position: "relative", zIndex: 1, width: "100%", flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {/* Header */}
        <div style={{ width: "100%", maxWidth: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: "22px 0 12px", position: "relative" }}>
          <h1
            style={{
              margin: 0,
              fontSize: "clamp(1rem,2vw,1.5rem)",
              fontWeight: 700,
              letterSpacing: ".18em",
              background: `linear-gradient(90deg,${accent},${hexA(accent, 0.65)},${accent})`,
              backgroundSize: "200% 200%",
              animation: "gwShim 3s ease infinite",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {cfg.drawTitle}
          </h1>

          <div style={{ position: "absolute", right: 0, display: "flex", gap: 4 }}>
            <button onClick={toggleFs} title="Fullscreen (F)" style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,.3)", padding: 4 }}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                {fs ? (
                  <path d="M8 3v5H3M12 17v-5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <path d="M3 8V3h5M17 12v5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                )}
              </svg>
            </button>
            <button onClick={onAdmin} title="Settings" style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,.3)", padding: 4 }}>
              <svg width="21" height="21" viewBox="0 0 20 20" fill="none">
                <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tumbler */}
        <div ref={wrapRef} style={{ width: "100%", maxWidth: 1100, position: "relative", marginTop: "auto" }}>
          <canvas ref={canvasRef} style={{ display: "block", width: "100%" }} />
          {busy && (
            <div style={{
              position: "absolute", top: 14, right: 14,
              background: "rgba(220,45,45,0.85)", border: "1px solid rgba(255,255,255,0.22)",
              backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
              borderRadius: 20, padding: "4px 12px", fontSize: ".55rem",
              fontWeight: 700, letterSpacing: ".18em", fontFamily: F.body,
              animation: "gwPulse .8s infinite",
            }}>● LIVE</div>
          )}
          {won && history.length > 1 && (
            <div style={{
              position: "absolute", top: 14, left: 14,
              background: hexA(accent, 0.18), border: `1px solid ${hexA(accent, 0.5)}`,
              borderRadius: 20, padding: "4px 14px", fontSize: ".6rem",
              fontWeight: 700, letterSpacing: ".16em", fontFamily: F.body, color: accent,
            }}>
              PLACE {history.length}
            </div>
          )}
        </div>

        {/* Controls */}
        <div style={{ marginTop: 16, marginBottom: "auto", width: "100%", maxWidth: 1100, display: "flex", flexDirection: "column", gap: 10 }}>
          {!won && !busy && (
            <label className="gw-g" style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              cursor: "pointer", padding: "15px 28px",
              border: `1px solid ${hexA(accent, 0.45)}`, borderRadius: 100,
              color: "#fff", fontSize: ".76rem", letterSpacing: ".14em", fontWeight: 600,
              fontFamily: F.body, background: "rgba(255,255,255,0.06)",
              backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
              boxSizing: "border-box", transition: "all .2s",
            }}>
              {fileLabel ? (fileLabel.length > 44 ? fileLabel.slice(0, 42) + "…" : fileLabel) : "UPLOAD ENTRIES"}
              <input type="file" accept=".txt,.csv" onChange={onUpload} style={{ display: "none" }} />
            </label>
          )}

          {locked ? (
            <button className="gw-b" onClick={() => setLocked(false)}
              style={btn(hexA(accent, 0.18), accent, { border: `1px solid ${hexA(accent, 0.5)}` })}>
              🔒 RESULT LOCKED — TAP TO UNLOCK
            </button>
          ) : won ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="gw-b" onClick={() => startDraw()} style={{ ...btn(accent, "#000"), flex: "1 1 180px", boxShadow: `0 8px 34px ${hexA(accent, 0.4)}` }}>
                REDRAW
              </button>
              {remaining > 0 && (
                <button className="gw-b gw-g" onClick={() => startDraw({ nextPlace: true })} style={{ ...btn("", "", ghost), flex: "1 1 180px" }}>
                  NEXT WINNER
                </button>
              )}
              <button className="gw-b gw-g" onClick={closeDraw} style={{ ...btn("", "", ghost), flex: "1 1 120px" }}>
                CLOSE
              </button>
            </div>
          ) : (
            <button className="gw-b" onClick={() => startDraw()} disabled={busy || !loaded}
              style={btn(
                !loaded || busy ? "rgba(255,255,255,0.05)" : accent,
                !loaded || busy ? "rgba(255,255,255,0.35)" : "#000",
                {
                  border: !loaded || busy ? "1px solid rgba(255,255,255,0.12)" : "none",
                  cursor: !loaded || busy ? "not-allowed" : "pointer",
                  boxShadow: !loaded || busy ? "none" : `0 8px 34px ${hexA(accent, 0.4)}`,
                }
              )}>
              {busy ? "DRAWING" : "START THE DRAW"}
            </button>
          )}

          {/* Winner history */}
          {history.length > 0 && (
            <div style={{
              marginTop: 2, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
              justifyContent: "center", fontFamily: F.body,
            }}>
              {history.map((h) => (
                <span key={h.place} style={{
                  fontSize: ".62rem", letterSpacing: ".08em",
                  color: "rgba(255,255,255,.62)",
                  background: "rgba(255,255,255,.06)",
                  border: "1px solid rgba(255,255,255,.1)",
                  padding: "5px 12px", borderRadius: 100,
                }}>
                  <b style={{ color: accent }}>#{h.place}</b>{" "}
                  {cfg.hideNumbers ? stripNumber(h.name) : h.name}
                </span>
              ))}
              <button
                onClick={() => downloadFile(
                  "draw-log.csv",
                  "place,entry,time\n" + history.map((h) => `${h.place},"${String(h.name).replace(/"/g, '""')}",${h.time}`).join("\n"),
                  "text/csv"
                )}
                style={{
                  fontSize: ".6rem", letterSpacing: ".1em", cursor: "pointer",
                  background: "none", border: "1px solid rgba(255,255,255,.14)",
                  color: "rgba(255,255,255,.5)", padding: "5px 12px", borderRadius: 100,
                  fontFamily: F.body,
                }}
              >
                EXPORT LOG
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   ADMIN PIECES
   ════════════════════════════════════════════════════════════════════════════ */
const INP = {
  width: "100%", padding: "11px 12px", boxSizing: "border-box",
  background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.12)",
  borderRadius: 6, color: "#fff", fontSize: ".9rem",
  fontFamily: "'Inter', sans-serif", fontWeight: 500, outline: "none",
};

function Sec({ title, accent, children }) {
  return (
    <div style={{ background: "rgba(255,255,255,.04)", borderRadius: 10, border: "1px solid rgba(255,255,255,.07)", overflow: "hidden", marginBottom: 14 }}>
      <div style={{ padding: "12px 18px", background: "rgba(255,255,255,.05)", borderBottom: "1px solid rgba(255,255,255,.07)", fontSize: ".7rem", letterSpacing: ".2em", color: accent, fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700 }}>
        {title}
      </div>
      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
    </div>
  );
}

function Fld({ label, hint, children }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: ".7rem", color: "rgba(255,255,255,.6)", letterSpacing: ".06em", fontFamily: "'Inter', sans-serif", fontWeight: 700 }}>{label}</label>
        {hint && <span style={{ fontSize: ".62rem", color: "rgba(255,255,255,.35)" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Slider({ label, min, max, step = 1, unit, value, onChange, accent }) {
  const v = Number(value);
  const pct = (((v - min) / (max - min)) * 100).toFixed(1);
  return (
    <Fld label={label} hint={`${v}${unit || ""}`}>
      <input type="range" min={min} max={max} step={step} value={v}
        onChange={(e) => onChange(+e.target.value)}
        style={{
          width: "100%", height: 4, borderRadius: 2, outline: "none", cursor: "pointer",
          appearance: "none", WebkitAppearance: "none",
          background: `linear-gradient(to right,${accent} 0%,${accent} ${pct}%,rgba(255,255,255,.15) ${pct}%,rgba(255,255,255,.15) 100%)`,
        }} />
    </Fld>
  );
}

function Toggle({ label, desc, value, onChange, accent }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14 }}>
      <div>
        <div style={{ fontSize: ".7rem", color: "rgba(255,255,255,.72)", letterSpacing: ".06em", fontFamily: "'Inter', sans-serif", fontWeight: 700 }}>{label}</div>
        {desc && <div style={{ fontSize: ".65rem", color: "rgba(255,255,255,.35)", marginTop: 3, lineHeight: 1.4 }}>{desc}</div>}
      </div>
      <div onClick={() => onChange(!value)} style={{
        width: 48, height: 26, borderRadius: 13, flexShrink: 0,
        background: value ? accent : "rgba(255,255,255,.14)",
        position: "relative", cursor: "pointer", transition: "background .25s",
      }}>
        <div style={{
          position: "absolute", top: 3, left: value ? "calc(100% - 23px)" : 3,
          width: 20, height: 20, borderRadius: "50%", background: "#fff",
          transition: "left .25s", boxShadow: "0 1px 5px rgba(0,0,0,.45)",
        }} />
      </div>
    </div>
  );
}

function Choice({ label, options, value, onChange, accent }) {
  return (
    <Fld label={label}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {options.map((o) => {
          const on = String(value) === String(o.v);
          return (
            <button key={String(o.v)} onClick={() => onChange(o.v)} style={{
              flex: "1 1 auto", minWidth: 72, padding: "10px 12px", borderRadius: 8,
              cursor: "pointer", fontFamily: "'Inter', sans-serif", fontWeight: 600,
              fontSize: ".68rem", letterSpacing: ".06em",
              background: on ? accent : "rgba(255,255,255,.06)",
              color: on ? "#000" : "rgba(255,255,255,.7)",
              border: on ? "none" : "1px solid rgba(255,255,255,.12)",
            }}>{o.l}</button>
          );
        })}
      </div>
    </Fld>
  );
}

function PtInput({ label, min, max, step, value, onChange, accent }) {
  const clamp = (x) => Math.max(min, Math.min(max, x));
  const v = clamp(value || min);
  const b = (dis) => ({
    width: 36, height: 36, borderRadius: 7, background: "rgba(255,255,255,.07)",
    border: "1px solid rgba(255,255,255,.13)", color: "#fff", fontSize: "1.15rem",
    fontWeight: 600, cursor: dis ? "not-allowed" : "pointer", opacity: dis ? 0.35 : 1,
    flexShrink: 0, fontFamily: "'Inter', sans-serif",
  });
  return (
    <Fld label={label} hint={`${min}–${max}pt`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => onChange(clamp(v - step))} disabled={v <= min} style={b(v <= min)}>−</button>
        <div style={{ position: "relative", flex: 1 }}>
          <input type="number" value={v} min={min} max={max}
            onChange={(e) => { const x = parseInt(e.target.value, 10); onChange(isNaN(x) ? min : clamp(x)); }}
            style={{ ...INP, textAlign: "center", paddingRight: 34, fontWeight: 600 }} />
          <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: ".72rem", color: hexA(accent, 0.7), fontWeight: 600, fontFamily: "'Inter', sans-serif", pointerEvents: "none" }}>pt</span>
        </div>
        <button onClick={() => onChange(clamp(v + step))} disabled={v >= max} style={b(v >= max)}>+</button>
      </div>
    </Fld>
  );
}

function Swatches({ list, value, onPick }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
      {list.map((p) => (
        <div key={p.c} onClick={() => onPick(p.c)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <div style={{
            width: 34, height: 34, borderRadius: "50%", background: p.c, transition: "all .2s",
            border: String(value).toLowerCase() === p.c.toLowerCase() ? "3px solid #fff" : "3px solid rgba(255,255,255,.18)",
          }} />
          <span style={{ fontSize: ".5rem", color: "rgba(255,255,255,.4)", letterSpacing: ".06em" }}>{p.l}</span>
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   ADMIN SCREEN
   ════════════════════════════════════════════════════════════════════════════ */
function AdminScreen({ cfg, media, onSave, onBack }) {
  const [s, setS] = useState({ ...cfg });
  const [m, setM] = useState({ ...media });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const set = (k, v) => setS((p) => ({ ...p, [k]: v }));
  const a = s.accent;

  const applyPreset = (key) => {
    const p = PRESETS[key];
    if (!p) return;
    const { label, ...vals } = p;
    setS((prev) => ({ ...prev, ...vals }));
    setNote(`${label} applied — save to keep it.`);
    setTimeout(() => setNote(""), 3000);
  };

  const pickImage = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setErr("");
    const heic = /\.(heic|heif)$/i.test(f.name);
    try {
      const b64 = await compressImage(f, 1600);
      const ok = await new Promise((res) => {
        const t = new Image();
        t.onload = () => res(true);
        t.onerror = () => res(false);
        t.src = b64;
      });
      if (!ok) {
        setErr(heic
          ? "That's an iPhone HEIC photo, which this browser can't display. Export it as JPG first (or set iPhone → Camera → Formats → Most Compatible)."
          : "That image format isn't supported. Please use a JPG or PNG.");
        e.target.value = "";
        return;
      }
      setM((p) => ({ ...p, bgImage: b64 }));
    } catch (x) {
      setErr("Could not read that image. Please use a JPG or PNG.");
    }
    e.target.value = "";
  };

  const pickVideo = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setErr("");
    if (f.size > 30 * 1024 * 1024) {
      setErr("Video is over 30MB — please use a smaller file (10MB or less is best).");
      e.target.value = "";
      return;
    }
    try {
      const data = await readAsDataURL(f);
      const ok = await new Promise((res) => {
        const v = document.createElement("video");
        let done = false;
        const fin = (x) => { if (!done) { done = true; res(x); } };
        v.onloadeddata = () => fin(true);
        v.onerror = () => fin(false);
        setTimeout(() => fin(false), 8000);
        v.muted = true; v.playsInline = true; v.preload = "auto";
        v.src = data;
      });
      if (!ok) {
        setErr("This browser can't play that video. iPhone .MOV clips usually won't work — convert it to MP4 (H.264).");
        e.target.value = "";
        return;
      }
      setM((p) => ({ ...p, bgVideo: data }));
    } catch (x) {
      setErr("Could not read that video.");
    }
    e.target.value = "";
  };

  const exportSettings = () => {
    const { adminPin, ...safe } = s;
    downloadFile("giveaway-settings.json", JSON.stringify(safe, null, 2), "application/json");
  };

  const importSettings = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setErr("");
    try {
      const txt = await f.text();
      const obj = JSON.parse(txt);
      if (!obj || typeof obj !== "object") throw new Error("bad");
      setS((prev) => ({ ...DEFAULTS, ...prev, ...obj, adminPin: prev.adminPin }));
      setNote("Settings loaded — save to keep them.");
      setTimeout(() => setNote(""), 3000);
    } catch (x) {
      setErr("That settings file couldn't be read.");
    }
    e.target.value = "";
  };

  const save = async () => {
    setBusy(true);
    const warn = await onSave(s, m);
    if (warn) setErr(warn);
    setBusy(false);
  };

  const mediaBox = (kind) => {
    const isImg = kind === "image";
    const has = isImg ? m.bgImage : m.bgVideo;
    return (
      <Fld label={isImg ? "BACKGROUND IMAGE" : "BACKGROUND VIDEO"} hint={has ? "loaded" : isImg ? "JPG or PNG" : "MP4, under 10MB"}>
        <label style={{
          display: "block", cursor: "pointer", borderRadius: 9, overflow: "hidden",
          border: `2px dashed ${hexA(a, 0.35)}`, height: 128, position: "relative",
          background: isImg && has ? `url(${m.bgImage}) center/cover` : "rgba(255,255,255,.03)",
        }}>
          {!isImg && has && (
            <video src={m.bgVideo} autoPlay loop muted playsInline
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
          )}
          <div style={{
            position: "absolute", inset: 0, background: "rgba(0,0,0,.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: ".7rem", color: a, letterSpacing: ".12em", fontWeight: 600,
          }}>
            {has ? (isImg ? "CHANGE IMAGE" : "CHANGE VIDEO") : (isImg ? "UPLOAD IMAGE" : "UPLOAD VIDEO")}
          </div>
          <input type="file" accept={isImg ? "image/*" : "video/*"} onChange={isImg ? pickImage : pickVideo} style={{ display: "none" }} />
        </label>
        {has && (
          <button onClick={() => setM((p) => ({ ...p, [isImg ? "bgImage" : "bgVideo"]: null }))}
            style={{ marginTop: 8, background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,.5)", fontSize: ".64rem", letterSpacing: ".12em" }}>
            {isImg ? "REMOVE IMAGE" : "REMOVE VIDEO"}
          </button>
        )}
      </Fld>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: "#08080f", color: "#fff", fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:17px;height:17px;border-radius:50%;background:${a};cursor:pointer;box-shadow:0 0 8px ${hexA(a, 0.55)}}
        input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
        input[type=number]{-moz-appearance:textfield}
      `}</style>

      <div style={{
        position: "sticky", top: 0, zIndex: 40, background: "rgba(8,8,15,.96)",
        backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(255,255,255,.07)",
        padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,.55)", fontSize: ".68rem", letterSpacing: ".14em", fontWeight: 700 }}>← BACK</button>
        <div style={{ fontSize: ".66rem", letterSpacing: ".26em", color: a, fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700 }}>SETTINGS</div>
        <button onClick={save} disabled={busy} style={{
          background: a, border: "none", borderRadius: 100, padding: "9px 22px",
          cursor: busy ? "not-allowed" : "pointer", fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700, fontSize: ".62rem", letterSpacing: ".14em", color: "#000", opacity: busy ? 0.6 : 1,
        }}>{busy ? "SAVING…" : "SAVE"}</button>
      </div>

      <div style={{ padding: "18px 16px 60px", maxWidth: 620, margin: "0 auto" }}>
        {err && (
          <div style={{ background: "rgba(200,40,40,.15)", border: "1px solid rgba(255,90,90,.4)", color: "#ffb0b0", borderRadius: 8, padding: "12px 14px", fontSize: ".75rem", marginBottom: 14, lineHeight: 1.5 }}>{err}</div>
        )}
        {note && (
          <div style={{ background: hexA(a, 0.14), border: `1px solid ${hexA(a, 0.4)}`, color: a, borderRadius: 8, padding: "12px 14px", fontSize: ".75rem", marginBottom: 14 }}>{note}</div>
        )}

        <Sec accent={a} title="PRESETS">
          <p style={{ margin: 0, fontSize: ".72rem", color: "rgba(255,255,255,.42)", lineHeight: 1.55 }}>
            One tap sets every timing value below. Tweak afterwards if you like.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(PRESETS).map(([k, p]) => (
              <button key={k} onClick={() => applyPreset(k)} style={{
                flex: "1 1 120px", padding: "13px 10px", borderRadius: 9, cursor: "pointer",
                background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.13)",
                color: "#fff", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700,
                fontSize: ".7rem", letterSpacing: ".1em",
              }}>{p.label}</button>
            ))}
          </div>
        </Sec>

        <Sec accent={a} title="SPEED-UP (BURST)">
          <p style={{ margin: 0, fontSize: ".72rem", color: "rgba(255,255,255,.42)", lineHeight: 1.55 }}>
            After cruising, the reel accelerates into a burst before it slows onto the winner. This is the dramatic part.
          </p>
          <Slider label="BURST LENGTH" min={0.2} max={10} step={0.1} unit="s" value={s.burstSec} onChange={(v) => set("burstSec", v)} accent={a} />
          <Slider label="BURST INTENSITY" min={100} max={500} unit="% of cruise speed" value={s.burstPct} onChange={(v) => set("burstPct", v)} accent={a} />
          <Choice label="BURST RAMP" accent={a} value={s.burstCurve} onChange={(v) => set("burstCurve", v)}
            options={[{ v: "gentle", l: "Gentle" }, { v: "linear", l: "Linear" }, { v: "aggressive", l: "Aggressive" }]} />
        </Sec>

        <Sec accent={a} title="CRUISE & SLOWDOWN">
          <Slider label="CRUISE SPEED" min={1} max={150} unit=" names/sec" value={s.cruiseSpeed} onChange={(v) => set("cruiseSpeed", v)} accent={a} />
          <Slider label="MAX CRUISE TIME" min={2} max={120} unit="s" value={s.cruiseMaxSec} onChange={(v) => set("cruiseMaxSec", v)} accent={a} />
          <Slider label="SLOWDOWN LENGTH" min={0.5} max={25} step={0.5} unit="s" value={s.slowSec} onChange={(v) => set("slowSec", v)} accent={a} />
          <Choice label="SLOWDOWN FEEL" accent={a} value={s.slowCurve} onChange={(v) => set("slowCurve", v)}
            options={[{ v: "soft", l: "Soft landing" }, { v: "normal", l: "Normal" }, { v: "snap", l: "Hard snap" }]} />
        </Sec>

        <Sec accent={a} title="DRAW BEHAVIOUR">
          <Slider label="COUNTDOWN" min={0} max={10} unit={s.countdown ? "s" : " — off"} value={s.countdown} onChange={(v) => set("countdown", v)} accent={a} />
          <Toggle label="NEAR-MISS TEASE" accent={a}
            desc="After it looks stopped, the reel creeps one more name onto the real winner."
            value={s.tease} onChange={(v) => set("tease", v)} />
          {s.tease && (
            <Slider label="TEASE LENGTH" min={300} max={3000} step={100} unit="ms" value={s.teaseMs} onChange={(v) => set("teaseMs", v)} accent={a} />
          )}
          <Toggle label="EXCLUDE PREVIOUS WINNERS" accent={a}
            desc="“Next winner” skips anyone who has already won in this session."
            value={s.excludePrev} onChange={(v) => set("excludePrev", v)} />
          <Toggle label="LOCK THE RESULT" accent={a}
            desc="After a win, buttons lock so a stray click can't redraw."
            value={s.freezeWinner} onChange={(v) => set("freezeWinner", v)} />
        </Sec>

        <Sec accent={a} title="APPEARANCE">
          <Fld label="TITLE">
            <input style={INP} value={s.drawTitle} onChange={(e) => set("drawTitle", e.target.value)} placeholder="GIVEAWAY DRAW" />
          </Fld>
          <Choice label="FONT" accent={a} value={s.fontKey} onChange={(v) => set("fontKey", v)}
            options={Object.entries(FONTS).map(([k, f]) => ({ v: k, l: f.label }))} />
          <Choice label="VISIBLE ROWS" accent={a} value={s.rows} onChange={(v) => set("rows", v)}
            options={[{ v: 3, l: "3" }, { v: 5, l: "5" }, { v: 7, l: "7" }]} />
          <PtInput label="ENTRY NAME SIZE" min={12} max={96} step={2} value={s.textSize} onChange={(v) => set("textSize", v)} accent={a} />
          <Toggle label="HIDE ENTRY NUMBERS" accent={a}
            desc="Shows just the name, dropping the “#123456 –” prefix."
            value={s.hideNumbers} onChange={(v) => set("hideNumbers", v)} />
          <Slider label="PILL WIDTH" min={40} max={100} unit="%" value={s.pillWidth} onChange={(v) => set("pillWidth", v)} accent={a} />
          <Slider label="PILL ROUNDNESS" min={0} max={100} unit="%" value={s.pillRound} onChange={(v) => set("pillRound", v)} accent={a} />
          <Slider label="PILL GLOW" min={0} max={100} unit="%" value={s.pillGlow} onChange={(v) => set("pillGlow", v)} accent={a} />
          <Slider label="SHINE SPEED" min={0.6} max={8} step={0.2} unit="s per sweep" value={s.shineSec} onChange={(v) => set("shineSec", v)} accent={a} />
        </Sec>

        <Sec accent={a} title="COLORS">
          <Fld label="ACCENT">
            <Swatches value={s.accent} onPick={(c) => set("accent", c)} list={[
              { l: "Gold", c: "#C9A84C" }, { l: "Amber", c: "#E0A82E" }, { l: "Silver", c: "#B0B8C0" },
              { l: "White", c: "#F0F0F0" }, { l: "Red", c: "#C62828" }, { l: "Blue", c: "#3A7BD5" },
            ]} />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...INP, flex: 1 }} value={s.accent} onChange={(e) => set("accent", e.target.value)} placeholder="#C9A84C" />
              <div style={{ width: 38, height: 38, borderRadius: 7, background: a, border: "1px solid rgba(255,255,255,.18)", flexShrink: 0 }} />
            </div>
          </Fld>
          <Fld label="WINNER TEXT">
            <Swatches value={s.winnerTextColor} onPick={(c) => set("winnerTextColor", c)} list={[
              { l: "Black", c: "#0F0900" }, { l: "Ink", c: "#1B1B1B" }, { l: "White", c: "#FFFFFF" },
              { l: "Wine", c: "#5A0A18" }, { l: "Navy", c: "#0B1A33" },
            ]} />
          </Fld>
        </Sec>

        <Sec accent={a} title="BACKGROUND">
          <p style={{ margin: 0, fontSize: ".72rem", color: "rgba(255,255,255,.42)", lineHeight: 1.55 }}>
            Video takes priority if both are set.
          </p>
          {mediaBox("image")}
          {mediaBox("video")}
          <Fld label="OVERLAY COLOR">
            <Swatches value={s.overlayColor} onPick={(c) => set("overlayColor", c)} list={[
              { l: "Black", c: "#000000" }, { l: "Charcoal", c: "#1C1C22" }, { l: "Navy", c: "#0B1A33" },
              { l: "Brown", c: "#2B1A08" }, { l: "Wine", c: "#2A0A12" }, { l: "White", c: "#FFFFFF" },
            ]} />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...INP, flex: 1 }} value={s.overlayColor} onChange={(e) => set("overlayColor", e.target.value)} placeholder="#000000" />
              <div style={{ width: 38, height: 38, borderRadius: 7, background: s.overlayColor, border: "1px solid rgba(255,255,255,.18)", flexShrink: 0 }} />
            </div>
          </Fld>
          <Slider label="OVERLAY STRENGTH" min={0} max={90} unit="%" value={s.overlayOpacity} onChange={(v) => set("overlayOpacity", v)} accent={a} />
        </Sec>

        <Sec accent={a} title="SOUND & STAGE">
          <Toggle label="SOUND" accent={a} desc="Ticks while scrolling, a chime on the winner, beeps on countdown."
            value={s.sound} onChange={(v) => set("sound", v)} />
          {s.sound && <Slider label="VOLUME" min={0} max={100} unit="%" value={s.volume} onChange={(v) => set("volume", v)} accent={a} />}
          <Toggle label="HIDE CURSOR WHILE DRAWING" accent={a}
            desc="Keeps the pointer out of shot when you're on screen or streaming."
            value={s.hideCursor} onChange={(v) => set("hideCursor", v)} />
          <div style={{ fontSize: ".68rem", color: "rgba(255,255,255,.38)", lineHeight: 1.7, borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 14 }}>
            <b style={{ color: "rgba(255,255,255,.6)" }}>Shortcuts</b><br />
            Space or R — draw / redraw<br />
            F — fullscreen<br />
            Esc — reset back to ready
          </div>
        </Sec>

        <Sec accent={a} title="BACKUP">
          <p style={{ margin: 0, fontSize: ".72rem", color: "rgba(255,255,255,.42)", lineHeight: 1.55 }}>
            Save this whole configuration to a file and load it on any other computer. Background media isn't included.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={exportSettings} style={{
              flex: "1 1 140px", padding: "13px", borderRadius: 9, cursor: "pointer",
              background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.13)",
              color: "#fff", fontWeight: 600, fontSize: ".7rem", letterSpacing: ".1em",
            }}>EXPORT SETTINGS</button>
            <label style={{
              flex: "1 1 140px", padding: "13px", borderRadius: 9, cursor: "pointer",
              background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.13)",
              color: "#fff", fontWeight: 600, fontSize: ".7rem", letterSpacing: ".1em",
              textAlign: "center", boxSizing: "border-box",
            }}>
              IMPORT SETTINGS
              <input type="file" accept="application/json,.json" onChange={importSettings} style={{ display: "none" }} />
            </label>
          </div>
        </Sec>

        <Sec accent={a} title="SECURITY">
          <Fld label="ADMIN PIN" hint="blank = no lock">
            <input style={INP} type="password" value={s.adminPin} onChange={(e) => set("adminPin", e.target.value)} placeholder="Set a PIN to protect settings" />
          </Fld>
        </Sec>

        <button onClick={save} disabled={busy} style={{
          width: "100%", padding: "18px", background: a, border: "none", borderRadius: 100,
          cursor: busy ? "not-allowed" : "pointer", fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700, fontSize: ".82rem", letterSpacing: ".2em", color: "#000", opacity: busy ? 0.65 : 1,
        }}>{busy ? "SAVING…" : "SAVE SETTINGS"}</button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PIN
   ════════════════════════════════════════════════════════════════════════════ */
function PinScreen({ pin, onOk, onCancel, accent }) {
  const [val, setVal] = useState("");
  const [bad, setBad] = useState(false);
  const press = (d) => {
    if (val.length >= 8) return;
    const next = val + d;
    setVal(next); setBad(false);
    if (next.length >= pin.length) {
      if (next === pin) setTimeout(onOk, 140);
      else { setBad(true); setTimeout(() => { setVal(""); setBad(false); }, 620); }
    }
  };
  return (
    <div style={{ minHeight: "100vh", background: "#08080f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28, padding: 24, fontFamily: "'Space Grotesk', sans-serif", color: "#fff" }}>
      <p style={{ fontSize: ".64rem", letterSpacing: ".4em", color: "rgba(255,255,255,.45)", margin: 0 }}>ADMIN ACCESS</p>
      <div style={{ display: "flex", gap: 14 }}>
        {Array.from({ length: Math.max(pin.length, 4) }).map((_, i) => (
          <div key={i} style={{ width: 14, height: 14, borderRadius: "50%", transition: "all .15s", background: i < val.length ? (bad ? "#e53935" : accent) : "rgba(255,255,255,.15)" }} />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,74px)", gap: 12 }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map((d, i) => (
          <button key={i} disabled={d === ""} onClick={() => {
            if (d === "⌫") { setVal((v) => v.slice(0, -1)); setBad(false); }
            else if (d !== "") press(String(d));
          }} style={{
            height: 74, borderRadius: 14, border: "none",
            background: d === "" ? "transparent" : "rgba(255,255,255,.07)",
            color: "#fff", fontSize: d === "⌫" ? "1.15rem" : "1.45rem",
            fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600,
            cursor: d === "" ? "default" : "pointer",
          }}>{d}</button>
        ))}
      </div>
      <button onClick={onCancel} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,.3)", fontSize: ".62rem", letterSpacing: ".15em" }}>CANCEL</button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   ERROR BOUNDARY
   ════════════════════════════════════════════════════════════════════════════ */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { e: null, info: null }; }
  static getDerivedStateFromError(e) { return { e }; }
  componentDidCatch(e, info) { this.setState({ info }); }
  render() {
    if (this.state.e) {
      return (
        <div style={{ minHeight: "100vh", background: "#1a0505", color: "#ff9a9a", padding: "40px 22px", fontFamily: "monospace", fontSize: 13, whiteSpace: "pre-wrap", overflow: "auto" }}>
          <div style={{ fontSize: 17, marginBottom: 18, color: "#ffc2c2" }}>Something broke</div>
          <div style={{ background: "#2a0808", padding: 12, borderRadius: 8, marginBottom: 16 }}>{String(this.state.e && this.state.e.message)}</div>
          <div style={{ background: "#2a0808", padding: 12, borderRadius: 8, fontSize: 11 }}>{String((this.state.info && this.state.info.componentStack) || "")}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   APP
   ════════════════════════════════════════════════════════════════════════════ */
function AppInner() {
  const [cfg, setCfg] = useState(() => loadSettings());
  const [media, setMedia] = useState({ bgImage: null, bgVideo: null });
  const [page, setPage] = useState("draw");
  const [pinOpen, setPinOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stored = await idbGet("bg");
        if (alive && stored) setMedia({ bgImage: stored.bgImage || null, bgVideo: stored.bgVideo || null });
      } catch (e) { /* none stored */ }
    })();
    return () => { alive = false; };
  }, []);

  const save = async (next, nextMedia) => {
    setCfg(next);
    saveSettings(next);
    setMedia(nextMedia);
    let warn = "";
    try {
      await idbSet("bg", { bgImage: nextMedia.bgImage || null, bgVideo: nextMedia.bgVideo || null });
    } catch (e) {
      warn = "Background applied for this session, but it couldn't be stored permanently (browser storage is full or blocked). It will need re-uploading after a refresh.";
    }
    setPage("draw");
    return warn;
  };

  if (pinOpen) {
    return <PinScreen pin={cfg.adminPin} accent={cfg.accent}
      onOk={() => { setPinOpen(false); setPage("admin"); }}
      onCancel={() => setPinOpen(false)} />;
  }
  if (page === "admin") {
    return <AdminScreen cfg={cfg} media={media} onSave={save} onBack={() => setPage("draw")} />;
  }
  return <DrawScreen cfg={cfg} media={media} onAdmin={() => (cfg.adminPin ? setPinOpen(true) : setPage("admin"))} />;
}

export default function App() {
  return (
    <Boundary>
      <AppInner />
    </Boundary>
  );
}
