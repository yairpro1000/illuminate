/* ============================================================
   YAIR BEN-DAVID — main.js
   Dual canvas animations · Theme switcher · Scroll reveal · Nav
   ============================================================ */

const SITE_OBS = window.siteObservability || null;

/* ── Canvas & animation state ──────────────────────────────── */
const canvas = document.getElementById('background-waves');
const ctx    = canvas ? canvas.getContext('2d') : null;
let   time   = 0;
let   rafId  = null;
let   orbs   = [];
let   orbsPaused = false;

/* Grayscale + orb pause while recognition markers are visible.
   Any visible trigger = gray background + stars paused.
   No visible triggers  = full colour + stars running. */
const bgLayer = document.getElementById('bg-layer');
const recCardEls = document.querySelectorAll('.recognition__card');
// const recCardEl = document.querySelector('.recognition__card-type');
// const recBridgeEl = document.querySelector('.recognition__bridge');
const heroHeadingEl = document.querySelector('#hero-heading');

// const moodTriggers = [recCardEl, recBridgeEl].filter(Boolean);
const moodTriggers = [...recCardEls].filter(Boolean);

if (moodTriggers.length) {
  const visibleTriggers = new Set();
  let isHeroHeadingVisible = false;

  const moodObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (heroHeadingEl && entry.target === heroHeadingEl) {
        isHeroHeadingVisible = entry.isIntersecting;
        return;
      }

      if (entry.isIntersecting) visibleTriggers.add(entry.target);
      else visibleTriggers.delete(entry.target);
    });

    const isMoodActive = visibleTriggers.size > 0 && !isHeroHeadingVisible;
    orbsPaused = isMoodActive;
    if (bgLayer) bgLayer.classList.toggle('bg-grayscale', isMoodActive);
  }, { threshold: 1 });

  moodTriggers.forEach((el) => moodObserver.observe(el));
  if (heroHeadingEl) moodObserver.observe(heroHeadingEl);
  
}

/* ── 1. DARK THEME — Divine Light Rays + Valley Embers ─────── */
// Three colour families: valley teal (stream), electric blue (sword), divine gold (halo)
// Layer A: 8 near-vertical light shafts that breathe/pulse slowly
// Layer B: ~55 tiny luminous embers drifting upward (valley fireflies / celestial motes)

const DIVINE_PALETTES = [
  { r:  60, g: 200, b: 190, blur: 18 }, // valley teal
  { r:  35, g: 175, b: 168, blur: 22 }, // deeper teal
  { r: 100, g: 175, b: 255, blur: 16 }, // electric blue (sword)
  { r:  70, g: 150, b: 255, blur: 20 }, // deeper electric blue
  { r: 255, g: 210, b: 100, blur: 14 }, // divine gold (halo)
  { r: 220, g: 240, b: 255, blur: 12 }, // silver-white radiance
];

let rays = [];
let embers = [];

function initRays() {
  if (!canvas) return;
  rays = [];
  const count = 9;
  for (let i = 0; i < count; i++) {
    const palIdx = Math.floor(Math.random() * DIVINE_PALETTES.length);
    rays.push({
      x:           0.04 + (i / (count - 1)) * 0.92 + (Math.random() - 0.5) * 0.05,
      width:       30 + Math.random() * 90,
      tilt:        (Math.random() - 0.5) * 0.06,
      phase:       Math.random() * Math.PI * 2,
      speed:       0.004 + Math.random() * 0.006,   // ~30-42s cycle — slow divine breathing
      baseOpacity: 0.10 + Math.random() * 0.14,     // much more visible
      topFade:     0.0 + Math.random() * 0.15,       // start closer to top
      palette:     DIVINE_PALETTES[palIdx],
    });
  }
}

function drawDivineRays() {
  const t = time;
  rays.forEach((ray) => {
    const pulse   = (Math.sin(t * ray.speed + ray.phase) + 1) / 2;
    const opacity = ray.baseOpacity * (0.15 + pulse * 0.85);  // breathes from ~15% to 100%
    if (opacity < 0.008) return;

    const cx      = ray.x * canvas.width;
    const tilt    = ray.tilt;
    const topY    = canvas.height * ray.topFade;
    const botY    = canvas.height;
    const topX    = cx + tilt * topY;
    const botX    = cx + tilt * botY;
    const halfW   = ray.width / 2;
    const { r, g, b, blur } = ray.palette;

    const grad = ctx.createLinearGradient(cx, topY, cx + tilt * canvas.height, botY);
    grad.addColorStop(0,    `rgba(${r},${g},${b},0)`);
    grad.addColorStop(0.22, `rgba(${r},${g},${b},${opacity * 0.55})`);
    grad.addColorStop(0.55, `rgba(${r},${g},${b},${opacity})`);
    grad.addColorStop(0.82, `rgba(${r},${g},${b},${opacity * 0.65})`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(topX - halfW, topY);
    ctx.lineTo(topX + halfW, topY);
    ctx.lineTo(botX + halfW, botY);
    ctx.lineTo(botX - halfW, botY);
    ctx.closePath();
    ctx.shadowBlur  = blur + pulse * 40;
    ctx.shadowColor = `rgba(${r},${g},${b},${Math.min(opacity * 1.2, 1)})`;
    ctx.fillStyle   = grad;
    ctx.fill();
    ctx.restore();
    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';
  });
}

function initEmbers() {
  if (!canvas) return;
  embers = [];
  for (let i = 0; i < 55; i++) {
    const palIdx = Math.floor(Math.random() * DIVINE_PALETTES.length);
    embers.push({
      x:          Math.random() * (canvas.width  || 1200),
      y:          Math.random() * (canvas.height || 800),
      size:       0.8 + Math.random() * 2.6,
      phase:      Math.random() * Math.PI * 2,
      freq:       0.016 + Math.random() * 0.026,
      maxOpacity: 0.25 + Math.random() * 0.45,
      driftX:     (Math.random() - 0.5) * 0.10,
      driftY:     +(0.07 + Math.random() * 0.16),   // always downward
      palette:    DIVINE_PALETTES[palIdx],
    });
  }
}

function drawEmbers() {
  const t = time;
  embers.forEach((e) => {
    const tNorm  = (Math.sin(t * e.freq + e.phase) + 1) / 2;
    const opacity = tNorm * e.maxOpacity;
    if (opacity < 0.008) {
      e.x += e.driftX;
      e.y += e.driftY;
      wrapEmber(e);
      return;
    }
    const sz = e.size * (0.3 + tNorm * 0.7);
    const { r, g, b, blur } = e.palette;
    ctx.shadowBlur  = blur + sz * 4;
    ctx.shadowColor = `rgba(${r},${g},${b},${Math.min(opacity * 1.4, 1)})`;
    ctx.fillStyle   = `rgba(${r},${g},${b},${opacity})`;
    ctx.beginPath();
    ctx.arc(e.x, e.y, sz, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';
    e.x += e.driftX;
    e.y += e.driftY;
    wrapEmber(e);
  });
}

function wrapEmber(e) {
  const m = 20;
  if (e.x < -m)                e.x = canvas.width + m;
  if (e.x > canvas.width + m)  e.x = -m;
  if (e.y > canvas.height + m) e.y = -m;   // drifted off bottom → respawn at top
  if (e.y < -m)                e.y = canvas.height + m;
}

/* ── Divine waves — sine synthesis in the bottom half, divine palette colors ── */
const divineWaveConfig = [
  {
    y: 0.62,
    speed: 0.0013,
    r: 60, g: 200, b: 190,   // valley teal
    opacity: 0.22,
    components: [{ amplitude: 55, frequency: 0.00110 }, { amplitude: 18, frequency: 0.00300 }],
  },
  {
    y: 0.70,
    speed: -0.0018,
    r: 100, g: 175, b: 255,  // electric blue (sword)
    opacity: 0.18,
    components: [{ amplitude: 75, frequency: 0.00085 }, { amplitude: 28, frequency: 0.00200 }],
  },
  {
    y: 0.78,
    speed: 0.0022,
    r: 255, g: 210, b: 100,  // divine gold (halo)
    opacity: 0.14,
    components: [{ amplitude: 95, frequency: 0.00065 }, { amplitude: 38, frequency: 0.00145 }],
  },
  {
    y: 0.85,
    speed: -0.0010,
    r: 35, g: 175, b: 168,   // deeper teal
    opacity: 0.12,
    components: [{ amplitude: 60, frequency: 0.00095 }, { amplitude: 22, frequency: 0.00250 }],
  },
];

function drawDivineWaves() {
  const t = time;
  divineWaveConfig.forEach((wave) => {
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    for (let x = 0; x < canvas.width; x++) {
      let y = 0;
      wave.components.forEach((c) => {
        y += Math.sin(x * c.frequency + t * wave.speed) * c.amplitude;
      });
      ctx.lineTo(x, y + canvas.height * wave.y);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    ctx.fillStyle = `rgba(${wave.r},${wave.g},${wave.b},${wave.opacity})`;
    ctx.fill();
  });
}

function drawDivine() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // drawDivineRays();
  drawDivineWaves();
  // drawEmbers();
}

function runDivine() {
  drawDivine();
  time += 1;
  rafId = requestAnimationFrame(runDivine);
}

/* ── 2. LIGHT THEME — Sparkle animation ────────────────────── */
// Simulates: sun glinting on lake water or fresh snow.
// Two particle types:
//   circle  — tiny background twinkle points
//   star    — 4-pointed sun-glint shape that flashes in/out
//
// All colours are whites and near-whites only.
// Size scales WITH opacity so each glint "flashes" rather than fading flat.

const SPARK_PALETTES = [
  { fill: [255, 248, 210], shadow: [255, 215,  80], blur: 8  }, // divine gold — warm shimmer
  { fill: [210, 235, 255], shadow: [150, 200, 255], blur: 9  }, // celestial silver-blue
  { fill: [255, 252, 230], shadow: [255, 235, 160], blur: 7  }, // pale gold-cream
  { fill: [235, 248, 255], shadow: [180, 220, 255], blur: 10 }, // cool silver-white
];

const randP = () => SPARK_PALETTES[Math.floor(Math.random() * SPARK_PALETTES.length)];

function createOrbs() {
  if (!canvas) return;
  orbs = [];

  // ── Tiny background twinkle circles — lower 40% zone only
  for (let i = 0; i < 66; i++) {
    orbs.push({
      type:       'circle',
      x:          Math.random() * canvas.width,
      y:          canvas.height * 0.50 + Math.random() * canvas.height * 0.50,
      size:       0.5 + Math.random() * 1.8,
      phase:      Math.random() * Math.PI * 2,
      freq:       0.055 + Math.random() * 0.080,
      maxOpacity: 0.55 + Math.random() * 0.40,
      driftX:     (Math.random() - 0.5) * 0.16,
      driftY:     (Math.random() - 0.5) * 0.09,
      palette:    randP(),
    });
  }

  // ── Medium star sparkles — lower 40% zone only
  for (let i = 0; i < 48; i++) {
    orbs.push({
      type:       'star',
      x:          Math.random() * canvas.width,
      y:          canvas.height * 0.50 + Math.random() * canvas.height * 0.50,
      size:       4 + Math.random() * 9,
      armRatio:   0.80 + Math.random() * 0.40,
      rotation:   Math.random() * Math.PI,
      rotSpeed:   (Math.random() - 0.5) * 0.012,
      phase:      Math.random() * Math.PI * 2,
      freq:       0.030 + Math.random() * 0.045,
      maxOpacity: 0.60 + Math.random() * 0.35,
      driftX:     (Math.random() - 0.5) * 0.10,
      driftY:     (Math.random() - 0.5) * 0.06,
      palette:    randP(),
    });
  }

  // ── Large rare star sparkles — lower 40% zone only, faster flash
  for (let i = 0; i < 11; i++) {
    orbs.push({
      type:       'star',
      x:          Math.random() * canvas.width,
      y:          canvas.height * 0.52 + Math.random() * canvas.height * 0.45,
      size:       14 + Math.random() * 14,
      armRatio:   0.75 + Math.random() * 0.50,
      rotation:   Math.random() * Math.PI,
      rotSpeed:   (Math.random() - 0.5) * 0.006,
      phase:      Math.random() * Math.PI * 2,
      freq:       0.022 + Math.random() * 0.030,  // doubled from before
      maxOpacity: 0.38 + Math.random() * 0.28,
      driftX:     (Math.random() - 0.5) * 0.05,
      driftY:     (Math.random() - 0.5) * 0.03,
      palette:    SPARK_PALETTES[Math.floor(Math.random() * 2)],
    });
  }
}

/* Draw a 4-pointed star (sun-glint shape).
   Arms taper to sharp points; a hot-spot dot sits at the centre.
   The arms are asymmetric (armRatio ≠ 1) for a natural, non-mechanical look. */
function drawStar(cx, cy, arm, armRatio, rotation, palette, opacity) {
  const { fill, shadow, blur } = palette;
  const hArm   = arm * armRatio;     // horizontal reach
  const vArm   = arm;                // vertical reach
  const inner  = arm * 0.07;         // width of the arm at the waist — keep very thin

  // Glow halo — the blur is the primary visual signal of "light"
  ctx.shadowBlur  = blur + arm * 2.2;
  ctx.shadowColor = `rgba(${shadow[0]},${shadow[1]},${shadow[2]},${Math.min(opacity * 1.35, 1)})`;
  ctx.fillStyle   = `rgba(${fill[0]},${fill[1]},${fill[2]},${opacity})`;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);

  // 4-pointed star: 8 vertices — outer tips alternating with inner waist points
  ctx.beginPath();
  ctx.moveTo(0,      -vArm);   // top tip
  ctx.lineTo(inner,  -inner);  // waist (top-right)
  ctx.lineTo(hArm,    0);      // right tip
  ctx.lineTo(inner,   inner);  // waist (bottom-right)
  ctx.lineTo(0,       vArm);   // bottom tip
  ctx.lineTo(-inner,  inner);  // waist (bottom-left)
  ctx.lineTo(-hArm,   0);      // left tip
  ctx.lineTo(-inner, -inner);  // waist (top-left)
  ctx.closePath();
  ctx.fill();

  // Bright centre hot-spot
  ctx.beginPath();
  ctx.arc(0, 0, inner * 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
  ctx.shadowBlur  = 0;
  ctx.shadowColor = 'transparent';
}

function drawOrbs() {
  if (orbsPaused) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const t = time;

  orbs.forEach((orb) => {
    // tNorm: 0 → 1 → 0, smoothly — drives both opacity AND size
    const tNorm  = (Math.sin(t * orb.freq + orb.phase) + 1) / 2;
    const opacity = tNorm * orb.maxOpacity;

    if (opacity < 0.012) {
      orb.x += orb.driftX;
      orb.y += orb.driftY;
      wrapOrb(orb);
      return;
    }

    // Size scales with brightness — the glint "flashes" as it brightens
    const currentSize = orb.size * (0.25 + tNorm * 0.75);

    if (orb.type === 'star') {
      orb.rotation += orb.rotSpeed;
      drawStar(orb.x, orb.y, currentSize, orb.armRatio, orb.rotation, orb.palette, opacity);
    } else {
      const { fill, shadow, blur } = orb.palette;
      ctx.shadowBlur  = blur + currentSize * 3.5;
      ctx.shadowColor = `rgba(${shadow[0]},${shadow[1]},${shadow[2]},${Math.min(opacity * 1.2, 1)})`;
      ctx.fillStyle   = `rgba(${fill[0]},${fill[1]},${fill[2]},${opacity})`;
      ctx.beginPath();
      ctx.arc(orb.x, orb.y, currentSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur  = 0;
      ctx.shadowColor = 'transparent';
    }

    orb.x += orb.driftX;
    orb.y += orb.driftY;
    wrapOrb(orb);
  });
}

function wrapOrb(orb) {
  const m    = 20;
  const topY = canvas.height * 0.50; // hard ceiling — particles stay in lower 50%
  if (orb.x < -m)                orb.x = canvas.width + m;
  if (orb.x > canvas.width + m)  orb.x = -m;
  if (orb.y < topY - m)          orb.y = canvas.height + m;  // drifted up → reset to bottom
  if (orb.y > canvas.height + m) orb.y = topY;               // fell off bottom → back to top of zone
}

function runOrbs() {
  drawOrbs();
  time += 1;
  rafId = requestAnimationFrame(runOrbs);
}

/* ── 3. Canvas resize ───────────────────────────────────────── */
function resizeCanvas() {
  if (!canvas) return;
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  // Re-scatter particles after resize so they fill the new dimensions
  if (orbs.length)   createOrbs();
  if (rays.length)   initRays();
  if (embers.length) initEmbers();
}

window.addEventListener('resize', resizeCanvas, { passive: true });
resizeCanvas();

/* ── 4. Animation switcher ──────────────────────────────────── */
function startAnimation(theme) {
  if (rafId) cancelAnimationFrame(rafId);
  if (!canvas || !ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (theme === 'light') {
    if (!orbs.length) createOrbs();
    runOrbs();
  } else {
    if (!rays.length)   initRays();
    if (!embers.length) initEmbers();
    runDivine();
  }
}

// Pause when tab is hidden — saves CPU/battery
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
  } else {
    const isLight = document.body.classList.contains('theme-light');
    startAnimation(isLight ? 'light' : 'dark');
  }
});

/* ── 5. Theme toggle ────────────────────────────────────────── */
function setTheme(theme, save = true) {
  document.body.classList.toggle('theme-light', theme === 'light');
  if (save) localStorage.setItem('yb-theme', theme);
  startAnimation(theme);

  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.setAttribute(
      'aria-label',
      theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'
    );
    const tip = btn.querySelector('.theme-toggle__tip');
    if (tip) tip.textContent = theme === 'light' ? 'dark mode' : 'light mode';
  }

  const mobileBtn = document.getElementById('mobile-theme-toggle');
  if (mobileBtn) {
    const label = mobileBtn.querySelector('.mobile-theme-label');
    if (label) label.textContent = theme === 'light' ? 'Dark Mode' : 'Light Mode';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isLight = document.body.classList.contains('theme-light');
      setTheme(isLight ? 'dark' : 'light');
      // Dismiss hint on click
      toggleBtn.classList.remove('theme-toggle--hint');
      localStorage.setItem('yb-theme-hint-seen', '1');
    });
  }

  const mobileToggleBtn = document.getElementById('mobile-theme-toggle');
  if (mobileToggleBtn) {
    mobileToggleBtn.addEventListener('click', () => {
      const isLight = document.body.classList.contains('theme-light');
      setTheme(isLight ? 'dark' : 'light');
      localStorage.setItem('yb-theme-hint-seen', '1');
      // Close the menu
      const menu = document.querySelector('.nav__mobile');
      const hamburger = document.querySelector('.nav__hamburger');
      if (menu) menu.classList.remove('open');
      if (hamburger) {
        hamburger.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
        hamburger.setAttribute('aria-label', 'Open menu');
      }
    });
  }

  // Read saved preference (set in <head> inline script to avoid FOUC,
  // but also initialise here in case script order differs)
  const saved = localStorage.getItem('yb-theme') || 'dark';
  setTheme(saved, false);

  // First-visit: pulse + tooltip
  if (toggleBtn && !localStorage.getItem('yb-theme-hint-seen')) {
    const tip = toggleBtn.querySelector('.theme-toggle__tip');
    const isLight = document.body.classList.contains('theme-light');
    if (tip) tip.textContent = isLight ? 'dark mode' : 'light mode';

    // Small delay so the page settles before drawing attention
    setTimeout(() => {
      toggleBtn.classList.add('theme-toggle--pulse', 'theme-toggle--hint');

      // Auto-dismiss tooltip after 4s
      setTimeout(() => {
        toggleBtn.classList.remove('theme-toggle--hint');
        localStorage.setItem('yb-theme-hint-seen', '1');
      }, 1000);
    }, 1200);
  }
});

/* ── 6. Section background fade-in ─────────────────────────── */
(function initSectionReveal() {
  const sections = document.querySelectorAll('.section');
  if (!sections.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        entry.target.classList.toggle('section-in-view', entry.isIntersecting);
      });
    },
    { threshold: 0.08 }
  );

  const finalObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        entry.target.classList.toggle('section-in-view', entry.isIntersecting);
      });
    },
    { threshold: 0.60 }
  );

  const earlyObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        entry.target.classList.toggle('section-in-view', entry.isIntersecting);
      });
    },
    { threshold: 0 }
  );

  sections.forEach((s) => {
    if (s.id === 'final') finalObserver.observe(s);
    else if (s.id === 'about') earlyObserver.observe(s);
    else observer.observe(s);
  });
})();

/* ── Who cards: focal-zone highlight ───────────────────────── */
// On every scroll frame, find the single card whose vertical centre sits
// closest to the focal point (40% from top — where eyes tend to rest on
// mobile and desktop alike). Only that one card gets the elevated state.
// Hover/touch still works independently via CSS :hover.
(function initWhoCardFocus() {
  const cards = Array.from(document.querySelectorAll('.who__card'));
  if (!cards.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let currentFocal = null;

  function updateFocal() {
    const vh          = window.innerHeight;
    const focalY      = vh * 0.35;   // focal point: 35% from top
    const maxDist     = vh * 0.32;   // card must be within 32% of focal point

    let best     = null;
    let bestDist = Infinity;

    cards.forEach((card) => {
      const rect       = card.getBoundingClientRect();
      const cardCenter = rect.top + rect.height / 2;
      const dist       = Math.abs(cardCenter - focalY);

      // Card must be on-screen and closer than any previous candidate
      if (rect.bottom > 0 && rect.top < vh && dist < bestDist) {
        bestDist = dist;
        best     = card;
      }
    });

    // Deactivate if the closest card is still too far from focal point
    if (bestDist > maxDist) best = null;

    if (best !== currentFocal) {
      if (currentFocal) currentFocal.classList.remove('who__card--focal');
      currentFocal = best;
      if (currentFocal) currentFocal.classList.add('who__card--focal');
    }
  }

  window.addEventListener('scroll', updateFocal, { passive: true });
  window.addEventListener('resize', updateFocal, { passive: true });
  updateFocal();
})();

/* ── CTA buttons: focal-zone highlight ─────────────────────── */
(function initBtnFocus() {
  const btns = Array.from(document.querySelectorAll('.btn-primary, .btn-arrow'));
  if (!btns.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let currentFocal = null;

  function updateFocal() {
    const vh      = window.innerHeight;
    const focalY  = vh * 0.35;
    const maxDist = vh * 0.32;

    let best     = null;
    let bestDist = Infinity;

    btns.forEach((btn) => {
      const rect       = btn.getBoundingClientRect();
      const btnCenter  = rect.top + rect.height / 2;
      const dist       = Math.abs(btnCenter - focalY);

      if (rect.bottom > 0 && rect.top < vh && dist < bestDist) {
        bestDist = dist;
        best     = btn;
      }
    });

    if (bestDist > maxDist) best = null;

    if (best !== currentFocal) {
      if (currentFocal) currentFocal.classList.remove('btn--focal');
      currentFocal = best;
      if (currentFocal) currentFocal.classList.add('btn--focal');
    }
  }

  window.addEventListener('scroll', updateFocal, { passive: true });
  window.addEventListener('resize', updateFocal, { passive: true });
  updateFocal();
})();

/* ── 8. Scroll Reveal (IntersectionObserver) ───────────────── */
(function initScrollReveal() {
  const elements = document.querySelectorAll('.fade-up');
  if (!elements.length) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    elements.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
        } else {
          entry.target.classList.remove('is-visible');
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  elements.forEach((el) => observer.observe(el));
})();

/* ── 7. Sticky Navbar ───────────────────────────────────────── */
(function initNavbar() {
  const nav = document.querySelector('.nav');
  if (!nav) return;

  const onScroll = () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

/* ── 8. Mobile Menu ─────────────────────────────────────────── */
(function initMobileMenu() {
  const btn  = document.querySelector('.nav__hamburger');
  const menu = document.querySelector('.nav__mobile');
  if (!btn || !menu) return;

  btn.addEventListener('click', () => {
    const isOpen = menu.classList.toggle('open');
    btn.classList.toggle('open', isOpen);
    btn.setAttribute('aria-expanded', String(isOpen));
    btn.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
  });

  menu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      menu.classList.remove('open');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    });
  });
})();

/* ── 9. Smooth anchor scroll with nav offset ────────────────── */
(function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const target = document.querySelector(anchor.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
})();
