// FX Lab controller: lazy-loaded WebGL2 effects, scalable catalog overlay, orbit/zoom camera,
// draggable split-screen divider, URL deep-linking, and window.FXLAB API.

import { EFFECTS, UI, REPO_TREE_BASE, getEffect } from "./catalog.js?v=6";
import { clamp } from "./gl-utils.js";
import { getEffectIconSvg } from "./icons.js";
import { createAudioEngine } from "./audio.js";
import { initSiteMenu } from "./site-menu.js";

const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl2", {
  antialias: false,
  alpha: false,
  depth: true,
  preserveDrawingBuffer: true,
});

const $ = id => document.getElementById(id);

if (!gl) {
  $("nogl").hidden = false;
  $("noglTitle").textContent = UI.en.noglTitle;
  $("noglBody").textContent = UI.en.noglBody;
  throw new Error("WebGL2 unavailable");
}

// Dynamic loaders: each effect lives in its own self-contained docs/effects/<id>/ folder.
const LOADERS = {
  splats: () => import("../effects/splats/index.js").then(m => m.createSplatsEffect),
  fire: () => import("../effects/fire/index.js").then(m => m.createFireEffect),
  water: () => import("../effects/water/index.js").then(m => m.createWaterEffect),
  shadows: () => import("../effects/shadows/index.js").then(m => m.createShadowsEffect),
  cloth: () => import("../effects/cloth/index.js").then(m => m.createClothEffect),
  fur: () => import("../effects/fur/index.js").then(m => m.createFurEffect),
  glass: () => import("../effects/glass/index.js").then(m => m.createGlassEffect),
  clouds: () => import("../effects/clouds/index.js").then(m => m.createCloudsEffect),
  grass: () => import("../effects/grass/index.js").then(m => m.createGrassEffect),
  pathtracing: () => import("../effects/pathtracing/index.js").then(m => m.createPathtracingEffect),
  toon: () => import("../effects/toon/index.js").then(m => m.createToonEffect),
  aa: () => import("../effects/aa/index.js").then(m => m.createAaEffect),
  reflections: () => import("../effects/reflections/index.js").then(m => m.createReflectionsEffect),
  surface: () => import("../effects/surface/index.js").then(m => m.createSurfaceEffect),
  fog: () => import("../effects/fog/index.js").then(m => m.createFogEffect),
  gi: () => import("../effects/gi/index.js").then(m => m.createGiEffect),
  textures: () => import("../effects/textures/index.js").then(m => m.createTexturesEffect),
  portals: () => import("../effects/portals/index.js").then(m => m.createPortalsEffect),
  tonemapping: () => import("../effects/tonemapping/index.js").then(m => m.createTonemappingEffect),
  pixel3d: () => import("../effects/pixel3d/index.js").then(m => m.createPixel3dEffect),
  animation: () => import("../effects/animation/index.js").then(m => m.createAnimationEffect),
  skin: () => import("../effects/skin/index.js").then(m => m.createSkinEffect),
  terrain: () => import("../effects/terrain/index.js").then(m => m.createTerrainEffect),
  motionblur: () => import("../effects/motionblur/index.js").then(m => m.createMotionblurEffect),
  dof: () => import("../effects/dof/index.js").then(m => m.createDofEffect),
  destruction: () => import("../effects/destruction/index.js").then(m => m.createDestructionEffect),
  collisions: () => import("../effects/collisions/index.js").then(m => m.createCollisionsEffect),
  ascii: () => import("../effects/ascii/index.js").then(m => m.createAsciiEffect),
  hd2d: () => import("../effects/hd2d/index.js").then(m => m.createHd2dEffect),
  dithering: () => import("../effects/dithering/index.js").then(m => m.createDitheringEffect),
  materials: () => import("../effects/materials/index.js").then(m => m.createMaterialsEffect),
  pixelwave: () => import("../effects/pixelwave/index.js").then(m => m.createPixelwaveEffect),
};
const engines = new Map();
const moduleCache = new Map();
let loadingEffectId = null;

function prefetchEffect(id) {
  if (!LOADERS[id] || engines.has(id) || moduleCache.has(id)) return;
  const p = LOADERS[id]().catch(err => {
    moduleCache.delete(id);
    throw err;
  });
  moduleCache.set(id, p);
}

const nextFrame = () => new Promise(r => requestAnimationFrame(r));

async function loadEngine(id) {
  if (!engines.has(id)) {
    prefetchEffect(id);
    const factory = await moduleCache.get(id);
    // Double rAF guarantees the browser paints & composites the pixel loader before synchronous GLSL/WGSL compile.
    await nextFrame();
    await nextFrame();
    engines.set(id, await factory(gl, { canvas, params }));
  }
  return engines.get(id);
}

// Parse initial URL state (supports clean /splats/, /fire/, /water/ routes and legacy ?fx=...)
const basePath = new URL("../", import.meta.url).pathname;
const params = new URLSearchParams(location.search);
const directorMode = params.get("director") === "1";
let directorMaxPixels = Number(params.get("maxPixels")) || 0;
if (params.get("hud") === "0") document.body.classList.add("no-hud");
const audio = createAudioEngine({ mutedByUrl: directorMode || params.get("mute") === "1" || params.get("hud") === "0" });
let hasBooted = false;
let lang = params.get("lang") === "pl" ? "pl" : "en";
let currentEffect = getEffect(params.get("fx") || document.documentElement.dataset.fx);
let currentStepIdx = (() => {
  const s = params.get("step");
  if (!s) return currentEffect.defaultStep;
  const byId = currentEffect.steps.findIndex(st => st.id.toLowerCase() === s.toLowerCase());
  if (byId >= 0) return byId;
  const n = parseInt(s, 10);
  if (!Number.isNaN(n)) return clamp(n - 1, 0, currentEffect.steps.length - 1);
  return currentEffect.defaultStep;
})();

const split = {
  enabled: params.has("split") ? params.get("split") !== "0" : currentEffect.defaultSplit,
  pos: 0.5,
};

let paused = false;
let activeEngine = null;
let cam = null;
let userInteracted = false;
let switchSeq = 0;

// Catalog overlay filter state (filter bar auto-appears once catalog reaches 6+ effects)
let catalogOpen = false;
let filterCat = "all";
let filterQuery = "";
let cardCollapsed = window.matchMedia("(max-width: 780px)").matches;

const STORAGE_VISITED = "fxlab_visited_v1";
const visitedIds = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_VISITED) || "[]");
  if (Array.isArray(saved)) saved.forEach(id => visitedIds.add(id));
} catch {}
function markVisited(id) {
  if (!id || visitedIds.has(id)) return;
  visitedIds.add(id);
  try { localStorage.setItem(STORAGE_VISITED, JSON.stringify([...visitedIds])); } catch {}
}

let introDismissed = false;
try { introDismissed = sessionStorage.getItem("fxlab_intro_dismissed") === "1"; } catch {}

function stepEffect(delta) {
  const i = EFFECTS.findIndex(e => e.id === currentEffect.id);
  const nextIdx = (i + delta + EFFECTS.length) % EFFECTS.length;
  selectEffect(EFFECTS[nextIdx].id);
}

function randomEffect() {
  const unvisited = EFFECTS.filter(e => e.id !== currentEffect.id && !visitedIds.has(e.id));
  const pool = unvisited.length ? unvisited : EFFECTS.filter(e => e.id !== currentEffect.id);
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  selectEffect(pick.id);
}

let copyTimer = null;
function copyCurrentLink() {
  const url = location.href;
  const u = UI[lang];
  const done = () => {
    const btn = $("copyLinkBtn");
    const lbl = $("copyLinkLabel");
    if (!btn || !lbl) return;
    btn.classList.add("is-copied");
    lbl.textContent = u.copied;
    audio.playUi("click");
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      btn.classList.remove("is-copied");
      lbl.textContent = UI[lang].copyLink;
    }, 1600);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => {
      try {
        const ta = document.createElement("textarea");
        ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
        done();
      } catch {}
    });
  } else {
    try {
      const ta = document.createElement("textarea");
      ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      done();
    } catch {}
  }
}

const SVG_CODE_ICON = `<svg viewBox="0 0 16 12" width="13" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 2 1.5 6 5 10"/><line x1="9.5" y1="1.5" x2="6.5" y2="10.5"/><polyline points="11 2 14.5 6 11 10"/></svg>`;
const SVG_LINK_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.8 9.2a3.4 3.4 0 0 0 4.8 0l1.8-1.8a3.4 3.4 0 0 0-4.8-4.8L7.5 3.7"/><path d="M9.2 6.8a3.4 3.4 0 0 0-4.8 0L2.6 8.6a3.4 3.4 0 0 0 4.8 4.8l1.1-1.1"/></svg>`;

function ensureCardCollapseUi() {
  const card = $("card");
  if (!card || $("cardToggle")) return;
  const kicker = $("kicker");
  const title = $("stepTitle");

  if (!$("cardIntro")) {
    const intro = document.createElement("div");
    intro.id = "cardIntro";
    intro.className = "card-intro";
    intro.innerHTML = `<span class="card-intro-text" id="cardIntroText"></span><button id="cardIntroBrowse" class="card-intro-browse" type="button"></button><button id="cardIntroClose" class="card-intro-close" type="button">×</button>`;
    card.insertBefore(intro, kicker);
    $("cardIntroBrowse").addEventListener("click", () => setCatalogOpen(true));
    $("cardIntroClose").addEventListener("click", () => {
      introDismissed = true;
      try { sessionStorage.setItem("fxlab_intro_dismissed", "1"); } catch {}
      intro.hidden = true;
      audio.playUi("click");
    });
  }

  const head = document.createElement("div");
  head.className = "card-head-row";
  const actions = document.createElement("div");
  actions.className = "card-head-actions";

  const mobPrev = document.createElement("button");
  mobPrev.id = "mobPrevFxBtn";
  mobPrev.type = "button";
  mobPrev.className = "card-mob-step";
  mobPrev.textContent = "◀";
  mobPrev.addEventListener("click", () => stepEffect(-1));

  const mobNext = document.createElement("button");
  mobNext.id = "mobNextFxBtn";
  mobNext.type = "button";
  mobNext.className = "card-mob-step";
  mobNext.textContent = "▶";
  mobNext.addEventListener("click", () => stepEffect(1));

  const copyBtn = document.createElement("button");
  copyBtn.id = "copyLinkBtn";
  copyBtn.type = "button";
  copyBtn.className = "card-copy";
  copyBtn.innerHTML = `${SVG_LINK_ICON}<span id="copyLinkLabel">Copy link</span>`;
  copyBtn.addEventListener("click", copyCurrentLink);

  let srcLink = $("sourceLink");
  if (!srcLink) {
    srcLink = document.createElement("a");
    srcLink.id = "sourceLink";
    srcLink.target = "_blank";
    srcLink.rel = "noopener";
  }
  srcLink.className = "card-source";
  srcLink.innerHTML = `${SVG_CODE_ICON}<span id="sourceLabel">Source</span>`;

  const btn = document.createElement("button");
  btn.id = "cardToggle";
  btn.type = "button";
  btn.className = "card-toggle";
  btn.addEventListener("click", () => {
    cardCollapsed = !cardCollapsed;
    syncCardCollapse();
    audio.playUi("click");
  });
  title.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 780px)").matches) {
      cardCollapsed = !cardCollapsed;
      syncCardCollapse();
      audio.playUi("click");
    }
  });
  card.insertBefore(head, kicker);
  actions.append(mobPrev, mobNext, copyBtn, srcLink, btn);
  head.append(kicker, actions, title);
  syncCardCollapse();
}

function syncCardCollapse() {
  const card = $("card");
  const btn = $("cardToggle");
  if (!card || !btn) return;
  card.classList.toggle("is-collapsed", cardCollapsed);
  btn.setAttribute("aria-expanded", String(!cardCollapsed));
  btn.textContent = cardCollapsed
    ? (lang === "pl" ? "Opis ▴" : "Info ▴")
    : (lang === "pl" ? "Ukryj ▾" : "Hide ▾");
}
ensureCardCollapseUi();

const siteMenu = initSiteMenu({
  currentSite: "fx-lab",
  getLang: () => lang,
  getGithubUrl: () => REPO_TREE_BASE + currentEffect.sourcePath,
  githubSub: "fx-lab",
  onBeforeOpen: () => { if (catalogOpen) setCatalogOpen(false); },
  onToggle: () => audio.playUi("click"),
});

function renderSiteMenu() {
  siteMenu?.render();
}

function setMenuOpen(open, restoreFocus = false) {
  siteMenu?.setOpen(open, restoreFocus);
}

function ensureAudioControls() {
  let grp = $("fxAudioGrp");
  if (!grp) {
    const nav = document.querySelector("header nav");
    const langBtn = $("lang");
    if (!nav) return null;
    grp = document.createElement("div");
    grp.id = "fxAudioGrp";
    grp.className = "fx-audio-grp";

    const sBtn = document.createElement("button");
    sBtn.id = "audioBtn";
    sBtn.type = "button";
    sBtn.className = "fx-audio-btn";
    sBtn.addEventListener("click", () => {
      const st = audio.getState();
      if (st.soundEnabled && !st.unlocked) {
        audio.unlock();
        audio.playUi("click");
      } else {
        audio.toggleSound();
      }
    });

    const mBtn = document.createElement("button");
    mBtn.id = "musicBtn";
    mBtn.type = "button";
    mBtn.className = "fx-audio-btn";
    mBtn.addEventListener("click", () => audio.toggleMusic());

    grp.append(sBtn, mBtn);
    if (langBtn && langBtn.parentNode === nav) nav.insertBefore(grp, langBtn);
    else nav.appendChild(grp);
    audio.subscribe(updateAudioControls);
  }
  return grp;
}

const SVG_SPEAKER_ON = `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true"><rect x="1" y="4" width="2" height="4" fill="currentColor"/><rect x="3" y="3" width="2" height="6" fill="currentColor"/><rect x="5" y="2" width="1" height="8" fill="currentColor"/><rect x="8" y="4" width="1" height="4" fill="currentColor"/><rect x="10" y="3" width="1" height="6" fill="currentColor"/></svg>`;
const SVG_SPEAKER_OFF = `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true"><rect x="1" y="4" width="2" height="4" fill="currentColor"/><rect x="3" y="3" width="2" height="6" fill="currentColor"/><rect x="5" y="2" width="1" height="8" fill="currentColor"/><rect x="8" y="4" width="1" height="1" fill="#ff6b6b"/><rect x="10" y="4" width="1" height="1" fill="#ff6b6b"/><rect x="9" y="5" width="1" height="2" fill="#ff6b6b"/><rect x="8" y="7" width="1" height="1" fill="#ff6b6b"/><rect x="10" y="7" width="1" height="1" fill="#ff6b6b"/></svg>`;
const SVG_MUSIC_ON = `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true"><rect x="4" y="2" width="6" height="2" fill="currentColor"/><rect x="4" y="4" width="1" height="5" fill="currentColor"/><rect x="9" y="4" width="1" height="4" fill="currentColor"/><rect x="2" y="8" width="3" height="2" fill="currentColor"/><rect x="7" y="7" width="3" height="2" fill="currentColor"/></svg>`;
const SVG_MUSIC_OFF = `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true"><rect x="4" y="2" width="6" height="2" fill="currentColor"/><rect x="4" y="4" width="1" height="5" fill="currentColor"/><rect x="9" y="4" width="1" height="4" fill="currentColor"/><rect x="2" y="8" width="3" height="2" fill="currentColor"/><rect x="7" y="7" width="3" height="2" fill="currentColor"/><rect x="2" y="2" width="1" height="1" fill="#ff6b6b"/><rect x="3" y="3" width="1" height="1" fill="#ff6b6b"/><rect x="4" y="4" width="1" height="1" fill="#ff6b6b"/><rect x="5" y="5" width="1" height="1" fill="#ff6b6b"/><rect x="6" y="6" width="1" height="1" fill="#ff6b6b"/><rect x="7" y="7" width="1" height="1" fill="#ff6b6b"/><rect x="8" y="8" width="1" height="1" fill="#ff6b6b"/><rect x="9" y="9" width="1" height="1" fill="#ff6b6b"/></svg>`;

function updateAudioControls() {
  ensureAudioControls();
  const sBtn = $("audioBtn"), mBtn = $("musicBtn");
  if (!sBtn || !mBtn) return;
  const u = UI[lang];
  const st = audio.getState();
  sBtn.innerHTML = st.soundEnabled ? SVG_SPEAKER_ON : SVG_SPEAKER_OFF;
  sBtn.setAttribute("aria-pressed", String(st.soundEnabled));
  sBtn.classList.toggle("is-locked", st.soundEnabled && !st.unlocked);
  const sTitle = !st.soundEnabled ? u.soundOff : (st.unlocked ? u.soundOn : u.soundReady);
  sBtn.title = sTitle;
  sBtn.setAttribute("aria-label", sTitle);

  const mOn = st.soundEnabled && st.musicEnabled;
  mBtn.innerHTML = mOn ? SVG_MUSIC_ON : SVG_MUSIC_OFF;
  mBtn.setAttribute("aria-pressed", String(mOn));
  const mTitle = mOn ? u.musicOn : u.musicOff;
  mBtn.title = mTitle;
  mBtn.setAttribute("aria-label", mTitle);
}

function resetCamera() {
  if (!activeEngine) return;
  cam = { ...activeEngine.defaultCamera };
  userInteracted = false;
  if (typeof activeEngine.onReset === "function") activeEngine.onReset();
}

function syncUrl() {
  const q = new URLSearchParams();
  if (currentStepIdx !== currentEffect.defaultStep) q.set("step", String(currentStepIdx + 1));
  if (split.enabled !== currentEffect.defaultSplit) q.set("split", split.enabled ? "1" : "0");
  if (lang !== "en") q.set("lang", lang);
  const qs = q.toString();
  const target = `${basePath}${currentEffect.id}/${qs ? `?${qs}` : ""}`;
  if (location.protocol === "http:" || location.protocol === "https:") {
    history.replaceState(null, "", target);
  }
}

function currentStep() {
  return currentEffect.steps[currentStepIdx];
}

function ensureLoader() {
  let el = $("fxLoader");
  if (!el) {
    el = document.createElement("div");
    el.id = "fxLoader";
    el.className = "fx-loader";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.hidden = true;
    document.querySelector("main")?.appendChild(el);
  }
  return el;
}

function renderLoader(fx) {
  const el = ensureLoader();
  if (!fx) {
    el.classList.remove("visible");
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      if (!loadingEffectId) el.hidden = true;
    }, 170);
    return;
  }
  clearTimeout(el._hideTimer);
  const u = UI[lang];
  const title = lang === "pl" ? fx.pl : fx.en;
  el.style.setProperty("--fx-accent", fx.accent || "#eea75e");
  el.innerHTML = `
    <div class="fx-loader-box">
      <div class="fx-loader-ico">${getEffectIconSvg(fx.id, "fx-ico fx-ico-lg")}</div>
      <div class="fx-loader-meta">
        <b>${title}</b>
        <span>${u.loadingTitle}</span>
        <div class="fx-loader-bar" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </div>
  `;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("visible"));
}

function updateRibbonOverflow() {
  const rib = $("fxRibbon");
  if (!rib) return;
  const maxScroll = Math.max(0, rib.scrollWidth - rib.clientWidth);
  const hasLeft = rib.scrollLeft > 4;
  const hasRight = maxScroll - rib.scrollLeft > 4;
  rib.classList.toggle("has-left", hasLeft);
  rib.classList.toggle("has-right", hasRight);
  const prev = $("fxRibPrev"), next = $("fxRibNext");
  if (prev) prev.hidden = !hasLeft;
  if (next) next.hidden = !hasRight;
}

function ensureRibbon() {
  let rib = $("fxRibbon");
  if (!rib) {
    const wrap = document.createElement("div");
    wrap.id = "fxRibbonWrap";
    wrap.className = "fx-ribbon-wrap";

    const prev = document.createElement("button");
    prev.id = "fxRibPrev";
    prev.type = "button";
    prev.className = "fx-scroll-btn prev";
    prev.textContent = "‹";
    prev.hidden = true;
    prev.addEventListener("click", () => {
      rib.scrollBy({ left: -240, behavior: "smooth" });
    });

    rib = document.createElement("div");
    rib.id = "fxRibbon";
    rib.className = "fx-ribbon";
    rib.setAttribute("role", "navigation");
    rib.setAttribute("aria-label", "Effects");
    rib.addEventListener("scroll", updateRibbonOverflow, { passive: true });
    rib.addEventListener("wheel", ev => {
      if (rib.scrollWidth <= rib.clientWidth) return;
      if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
        ev.preventDefault();
        rib.scrollLeft += ev.deltaY;
      }
    }, { passive: false });

    const next = document.createElement("button");
    next.id = "fxRibNext";
    next.type = "button";
    next.className = "fx-scroll-btn next";
    next.textContent = "›";
    next.hidden = true;
    next.addEventListener("click", () => {
      rib.scrollBy({ left: 240, behavior: "smooth" });
    });

    wrap.append(prev, rib, next);
    const hdr = document.querySelector("header");
    const nav = hdr?.querySelector("nav");
    if (hdr && nav) hdr.insertBefore(wrap, nav);
    window.addEventListener("resize", updateRibbonOverflow);
  }
  return rib;
}

function ensureFxStepControls() {
  let grp = $("fxStepGrp");
  if (!grp) {
    const nav = document.querySelector("header nav");
    const catBtn = $("catalogBtn");
    if (!nav) return null;
    grp = document.createElement("div");
    grp.id = "fxStepGrp";
    grp.className = "fx-step-grp";

    const prev = document.createElement("button");
    prev.id = "prevFxBtn";
    prev.type = "button";
    prev.className = "fx-step-btn";
    prev.textContent = "◀";
    prev.addEventListener("click", () => stepEffect(-1));

    const next = document.createElement("button");
    next.id = "nextFxBtn";
    next.type = "button";
    next.className = "fx-step-btn";
    next.textContent = "▶";
    next.addEventListener("click", () => stepEffect(1));

    const rand = document.createElement("button");
    rand.id = "randFxBtn";
    rand.type = "button";
    rand.className = "fx-step-btn";
    rand.textContent = "↻";
    rand.addEventListener("click", randomEffect);

    grp.append(prev, next, rand);
    if (catBtn && catBtn.parentNode === nav) nav.insertBefore(grp, catBtn);
    else nav.prepend(grp);
  }
  return grp;
}

function renderPicker() {
  ensureFxStepControls();
  const u = UI[lang];
  const fxIdx = EFFECTS.findIndex(e => e.id === currentEffect.id);
  const dot = $("pickerDot");
  dot.style.background = "transparent";
  dot.style.boxShadow = "none";
  dot.innerHTML = getEffectIconSvg(currentEffect.id, "fx-ico fx-ico-sm");
  const isMob = window.matchMedia("(max-width: 780px)").matches;
  $("pickerName").textContent = isMob
    ? (lang === "pl" ? currentEffect.shortPl : currentEffect.shortEn)
    : u.effectsBtn(EFFECTS.length);
  $("pickerCount").textContent = `${fxIdx + 1}/${EFFECTS.length}`;
  $("catalogBtn").setAttribute("aria-expanded", String(catalogOpen));

  // Populate always-visible scrollable top effect switcher strip with crisp pixel-art icons
  const rib = ensureRibbon();
  const prevBtn = $("fxRibPrev"), nextBtn = $("fxRibNext");
  if (prevBtn) prevBtn.setAttribute("aria-label", u.scrollLeft);
  if (nextBtn) nextBtn.setAttribute("aria-label", u.scrollRight);

  const prevScroll = rib.scrollLeft;
  rib.innerHTML = "";
  for (const fx of EFFECTS) {
    const isCur = fx.id === currentEffect.id;
    const isLoad = fx.id === loadingEffectId;
    const isSeen = visitedIds.has(fx.id) && !isCur;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fx-pill" + (isLoad ? " is-loading" : "") + (isSeen ? " is-seen" : "");
    b.dataset.fx = fx.id;
    b.setAttribute("aria-current", String(isCur));
    b.title = lang === "pl" ? fx.pl : fx.en;
    const label = lang === "pl" ? fx.shortPl : fx.shortEn;
    b.innerHTML = `${getEffectIconSvg(fx.id)}<span>${label}</span>`;
    b.addEventListener("pointerenter", () => prefetchEffect(fx.id));
    b.addEventListener("focus", () => prefetchEffect(fx.id));
    b.addEventListener("click", () => {
      if (fx.id !== currentEffect.id) selectEffect(fx.id);
    });
    rib.appendChild(b);
  }
  rib.scrollLeft = prevScroll;
  const activePill = rib.querySelector('[aria-current="true"]');
  if (activePill) activePill.scrollIntoView({ block: "nearest", inline: "center" });
  requestAnimationFrame(updateRibbonOverflow);
}

function ensureCatalogScroll() {
  const grid = $("catalogGrid");
  if (!grid) return null;
  if (!grid.parentElement?.classList.contains("catalog-scroll")) {
    const wrap = document.createElement("div");
    wrap.className = "catalog-scroll";
    grid.parentElement.insertBefore(wrap, grid);
    wrap.appendChild(grid);
  }
  return grid;
}

function renderCatalogModal() {
  const u = UI[lang];
  $("catalogTitle").textContent = u.catalogTitle;
  $("catalogSub").textContent = u.catalogSub(EFFECTS.length, visitedIds.size);
  $("catalogClose").setAttribute("aria-label", u.catalogClose);
  $("catalogSearch").placeholder = u.catalogSearch;

  const showFilters = EFFECTS.length >= 6;
  $("catalogFilters").hidden = !showFilters;
  if (showFilters) {
    const cats = [{ id: "all", label: u.catalogAll }];
    const seen = new Set();
    for (const fx of EFFECTS) {
      if (fx.category && !seen.has(fx.category)) {
        seen.add(fx.category);
        cats.push({ id: fx.category, label: lang === "pl" ? fx.categoryPl : fx.categoryEn });
      }
    }
    const catsHost = $("catalogCats");
    catsHost.innerHTML = "";
    for (const c of cats) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", String(filterCat === c.id));
      b.textContent = c.label;
      b.addEventListener("click", () => { audio.playUi("click"); filterCat = c.id; renderCatalogModal(); });
      catsHost.appendChild(b);
    }
  }

  const q = filterQuery.trim().toLowerCase();
  const grid = ensureCatalogScroll();
  grid.innerHTML = "";
  for (const fx of EFFECTS) {
    if (showFilters && filterCat !== "all" && fx.category !== filterCat) continue;
    if (showFilters && q) {
      const hay = `${fx.en} ${fx.pl} ${fx.summaryEn} ${fx.summaryPl} ${(fx.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const isCur = fx.id === currentEffect.id;
    const isSeen = visitedIds.has(fx.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fx-card";
    btn.dataset.fx = fx.id;
    btn.style.setProperty("--fx-accent", fx.accent || "#eea75e");
    btn.setAttribute("aria-current", String(isCur));
    const catLbl = lang === "pl" ? fx.categoryPl : fx.categoryEn;
    const stepsLbl = u.stepsCount(fx.steps.length, fx.isEra);
    const title = lang === "pl" ? fx.pl : fx.en;
    const summary = lang === "pl" ? fx.summaryPl : fx.summaryEn;
    const tagsHtml = (fx.tags || []).map(t => `<span>${t}</span>`).join("");
    const thumbSrc = `${basePath}thumbs/${fx.id}.jpg`;
    const statusBadge = isCur
      ? `<span class="fx-card-active">${u.catalogActive}</span>`
      : (isSeen ? `<span class="fx-card-seen">${u.catalogSeen}</span>` : "");
    btn.innerHTML = `
      <div class="fx-card-thumb"><img src="${thumbSrc}" loading="lazy" alt="${title}"></div>
      <div class="fx-card-body">
        <div class="fx-card-top">
          <span class="fx-card-meta">${catLbl} · ${stepsLbl}</span>
          ${statusBadge}
        </div>
        <h3 class="fx-card-title">${getEffectIconSvg(fx.id, "fx-ico")}<span>${title}</span></h3>
        <p>${summary}</p>
        <div class="fx-card-tags">${tagsHtml}</div>
      </div>
    `;
    btn.addEventListener("pointerenter", () => prefetchEffect(fx.id));
    btn.addEventListener("focus", () => prefetchEffect(fx.id));
    btn.addEventListener("click", () => {
      setCatalogOpen(false);
      selectEffect(fx.id);
    });
    grid.appendChild(btn);
  }
}

function setCatalogOpen(open) {
  const prev = catalogOpen;
  catalogOpen = !!open;
  if (catalogOpen && siteMenu?.isOpen()) setMenuOpen(false);
  $("catalogModal").hidden = !catalogOpen;
  if (prev !== catalogOpen) audio.playUi("catalog", catalogOpen);
  renderPicker();
  if (catalogOpen) {
    renderCatalogModal();
    const curCard = $("catalogGrid").querySelector('[aria-current="true"]') || $("catalogClose");
    curCard?.focus();
  } else {
    $("catalogBtn").focus();
  }
}

function renderStepsBar() {
  const host = $("stepsBar");
  host.innerHTML = "";
  currentEffect.steps.forEach((st, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.role = "tab";
    btn.setAttribute("aria-selected", String(idx === currentStepIdx));
    const num = String(idx + 1).padStart(2, "0");
    btn.innerHTML = `<small>${num} · ${st.era}</small><b>${lang === "pl" ? st.tabPl : st.tabEn}</b>`;
    btn.addEventListener("click", () => selectStep(idx));
    host.appendChild(btn);
  });
}

function updateSplitOverlay() {
  const st = currentStep();
  $("splitUi").hidden = !split.enabled;
  document.documentElement.style.setProperty("--wipe", String(split.pos));
  $("splitHit").setAttribute("aria-valuenow", String(Math.round(split.pos * 100)));
  const lt = $("splitLeftTag");
  const rt = $("splitRightTag");
  lt.textContent = lang === "pl" ? st.leftTagPl : st.leftTagEn;
  rt.textContent = lang === "pl" ? st.rightTagPl : st.rightTagEn;
  // Prevent split labels from clipping off-screen when sweeping divider near viewport edges
  lt.style.opacity = split.pos < 0.24 ? "0" : "1";
  rt.style.opacity = split.pos > 0.76 ? "0" : "1";
  const u = UI[lang];
  const btn = $("splitBtn");
  btn.textContent = split.enabled ? u.splitOn : u.splitOff;
  btn.setAttribute("aria-pressed", String(split.enabled));
}

function updateCard() {
  const u = UI[lang];
  const st = currentStep();
  const n = currentEffect.steps.length;
  const ready = activeEngine && activeEngine.id === currentEffect.id;
  const badge = ready ? activeEngine.getTechBadge(currentStepIdx) : u.loading;

  document.documentElement.lang = lang;
  document.title = `${lang === "pl" ? currentEffect.pl : currentEffect.en} — FX Lab | gamedev.pl`;
  if ($("backLink")) $("backLink").textContent = u.back;
  renderSiteMenu();
  const srcLink = $("sourceLink");
  if (srcLink) {
    const srcLabel = $("sourceLabel");
    if (srcLabel) srcLabel.textContent = u.source;
    else srcLink.textContent = u.source;
    srcLink.href = REPO_TREE_BASE + currentEffect.sourcePath;
    const fxName = lang === "pl" ? currentEffect.pl : currentEffect.en;
    const srcTip = lang === "pl" ? `Kod źródłowy: ${fxName} (GitHub)` : `Source code: ${fxName} (GitHub)`;
    srcLink.title = srcTip;
    srcLink.setAttribute("aria-label", srcTip);
  }
  const intro = $("cardIntro");
  if (intro) {
    intro.hidden = introDismissed || directorMode;
    $("cardIntroText").innerHTML = u.introLine(EFFECTS.length);
    $("cardIntroBrowse").textContent = u.introBrowse(EFFECTS.length);
    $("cardIntroClose").setAttribute("aria-label", u.introDismiss);
    $("cardIntroClose").title = u.introDismiss;
  }
  const copyBtn = $("copyLinkBtn");
  if (copyBtn) {
    if (!copyBtn.classList.contains("is-copied")) $("copyLinkLabel").textContent = u.copyLink;
    copyBtn.title = u.copyLink;
    copyBtn.setAttribute("aria-label", u.copyLink);
  }
  const setTip = (id, tip) => { const el = $(id); if (el) { el.title = tip; el.setAttribute("aria-label", tip); } };
  setTip("prevFxBtn", u.prevFx);
  setTip("nextFxBtn", u.nextFx);
  setTip("randFxBtn", u.randomFx);
  setTip("mobPrevFxBtn", u.prevFx);
  setTip("mobNextFxBtn", u.nextFx);
  $("lang").textContent = lang === "en" ? "PL" : "EN";
  $("prev").setAttribute("aria-label", u.prev);
  $("next").setAttribute("aria-label", u.next);
  $("pauseBtn").textContent = paused ? u.resume : u.pause;
  $("resetBtn").textContent = u.resetCam;

  $("kicker").textContent = `${u.stepLabel(currentStepIdx, n)} · ${badge}`;
  $("stepTitle").textContent = lang === "pl" ? st.pl : st.en;
  $("stepNote").textContent = lang === "pl" ? st.notePl : st.noteEn;
  $("count").textContent = `${String(currentStepIdx + 1).padStart(2, "0")} / ${String(n).padStart(2, "0")}`;

  const actBtn = $("actionBtn");
  if (st.action) {
    actBtn.hidden = false;
    actBtn.textContent = lang === "pl" ? st.action.pl : st.action.en;
    actBtn.setAttribute("aria-pressed", st.action.toggle && ready ? String(activeEngine.isActionActive(st.action.id)) : "false");
  } else {
    actBtn.hidden = true;
  }

  const isWaterLive = currentEffect.id === "water" && st.stage === 7;
  const isShadows = currentEffect.id === "shadows";
  const isCloth = currentEffect.id === "cloth" && st.stage >= 3;
  const isFurLive = currentEffect.id === "fur" && st.stage === 7;
  const isGlass = currentEffect.id === "glass";
  const isClouds = currentEffect.id === "clouds";
  const isGrass = currentEffect.id === "grass" && st.stage >= 4;
  const isPathtracing = currentEffect.id === "pathtracing" && st.stage >= 6;
  const isToon = currentEffect.id === "toon";
  const isAa = currentEffect.id === "aa";
  const isReflections = currentEffect.id === "reflections";
  const isSurface = currentEffect.id === "surface";
  const isFog = currentEffect.id === "fog";
  const isGi = currentEffect.id === "gi";
  const isTextures = currentEffect.id === "textures";
  const isPortals = currentEffect.id === "portals";
  const isTonemapping = currentEffect.id === "tonemapping";
  const isPixel3d = currentEffect.id === "pixel3d";
  const isAnimation = currentEffect.id === "animation";
  const isSkin = currentEffect.id === "skin";
  const isTerrain = currentEffect.id === "terrain";
  const isDestruction = currentEffect.id === "destruction";
  const isCollisions = currentEffect.id === "collisions";
  const isAscii = currentEffect.id === "ascii";
  const isHd2d = currentEffect.id === "hd2d";
  const isDithering = currentEffect.id === "dithering";
  const isMaterials = currentEffect.id === "materials";
  const isPixelwave = currentEffect.id === "pixelwave";
  $("hintLine").textContent = isWaterLive
    ? u.waterClickHint
    : (isShadows ? u.shadowsClickHint : (isCloth ? u.clothClickHint : (isFurLive ? u.furClickHint : (isGlass ? u.glassClickHint : (isClouds ? u.cloudsClickHint : (isGrass ? u.grassClickHint : (isPathtracing ? u.pathtracingClickHint : (isToon ? u.toonClickHint : (isAa ? u.aaClickHint : (isReflections ? u.reflectionsClickHint : (isSurface ? u.surfaceClickHint : (isFog ? u.fogClickHint : (isGi ? u.giClickHint : (isTextures ? u.texturesClickHint : (isPortals ? u.portalsClickHint : (isTonemapping ? u.tonemappingClickHint : (isPixel3d ? u.pixel3dClickHint : (isAnimation ? u.animationClickHint : (isSkin ? u.skinClickHint : (isTerrain ? u.terrainClickHint : (isDestruction ? u.destructionClickHint : (isCollisions ? u.collisionsClickHint : (isAscii ? u.asciiClickHint : (isHd2d ? u.hd2dClickHint : (isDithering ? u.ditheringClickHint : (isMaterials ? u.materialsClickHint : (isPixelwave ? u.pixelwaveClickHint : u.dragHint)))))))))))))))))))))))))));
  const linkLabel = u[currentEffect.videoLabelKey] || u.channelLink;
  const filmLine = $("filmLine");
  filmLine.innerHTML = `<span>${u.videoPrefix} <a href="${currentEffect.videoUrl}" target="_blank" rel="noopener">${linkLabel}</a></span><span>·</span><button type="button" class="film-more" id="moreFxBtn">${u.moreEffects(EFFECTS.length)}</button>`;
  $("moreFxBtn")?.addEventListener("click", () => setCatalogOpen(true));

  updateAudioControls();
  syncCardCollapse();
  updateSplitOverlay();
  renderPicker();
  renderStepsBar();
  if (catalogOpen) renderCatalogModal();

  const activeTab = $("stepsBar").querySelector('[aria-selected="true"]');
  if (activeTab) activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
}

let renderW = 1, renderH = 1;
function resizeCanvas(skipCard = false) {
  if (!activeEngine) return;
  const cssW = Math.max(1, window.innerWidth);
  const cssH = Math.max(1, window.innerHeight);
  const dpr = directorMode ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
  const maxPx = directorMaxPixels > 0 ? directorMaxPixels : (activeEngine.maxPixels || 1200000);
  const scale = Math.min(dpr, Math.sqrt(maxPx / (cssW * cssH)));
  const w = Math.max(240, Math.round(cssW * scale));
  const h = Math.max(240, Math.round(cssH * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  renderW = w;
  renderH = h;
  if (typeof activeEngine.resize === "function") activeEngine.resize(w, h);
  if (!skipCard) updateCard();
}
window.addEventListener("resize", () => resizeCanvas(false));

async function selectEffect(effectId, stepIdx = null, splitOpt = null) {
  const nextFx = getEffect(effectId);
  const seq = ++switchSeq;
  const changed = nextFx.id !== currentEffect.id || !activeEngine;
  const needsCompile = !engines.has(nextFx.id);

  // Update visible card, picker, step strip, loader and Source deeplink immediately before shader compile.
  currentEffect = nextFx;
  markVisited(nextFx.id);
  currentStepIdx = stepIdx === null ? currentEffect.defaultStep : clamp(stepIdx, 0, currentEffect.steps.length - 1);
  if (splitOpt !== null) split.enabled = !!splitOpt;
  else if (changed) split.enabled = currentEffect.defaultSplit;
  if (needsCompile) {
    loadingEffectId = nextFx.id;
    renderLoader(nextFx);
  }
  syncUrl();
  updateCard();
  audio.setScene(nextFx.id, nextFx.category, currentStepIdx);
  if (hasBooted && changed) audio.playUi("effectSwitch", nextFx.category);
  hasBooted = true;

  try {
    const eng = await loadEngine(nextFx.id);
    if (seq !== switchSeq) return;

    if (activeEngine && activeEngine !== eng && typeof activeEngine.setVisible === "function") {
      activeEngine.setVisible(false);
    }
    activeEngine = eng;
    if (typeof activeEngine.setVisible === "function") {
      activeEngine.setVisible(true);
    }
    canvas.style.opacity = activeEngine.usesExternalCanvas ? "0" : "";
    resetCamera();
    activeEngine.enterStep(currentStepIdx);
    resizeCanvas(true);
    // Render one frame immediately before fading out the loader so the new scene is already live underneath!
    activeEngine.render(renderW, renderH, currentStep(), split, cam);
  } finally {
    if (seq === switchSeq) {
      loadingEffectId = null;
      renderLoader(null);
      updateCard();
    }
  }
}

function selectStep(idx) {
  if (!activeEngine) return;
  const n = currentEffect.steps.length;
  currentStepIdx = ((idx % n) + n) % n;
  activeEngine.enterStep(currentStepIdx);
  audio.setStep(currentStepIdx);
  audio.playUi("step", currentStepIdx);
  syncUrl();
  updateCard();
}

function setLang(next) {
  lang = next === "pl" ? "pl" : "en";
  audio.playUi("lang");
  syncUrl();
  updateCard();
  document.dispatchEvent(new CustomEvent("fxlab:lang", { detail: { lang } }));
}

// UI event bindings
$("catalogBtn").addEventListener("click", () => setCatalogOpen(!catalogOpen));
$("catalogClose").addEventListener("click", () => setCatalogOpen(false));
$("catalogModal").addEventListener("click", ev => {
  if (ev.target === $("catalogModal")) setCatalogOpen(false);
});
$("catalogSearch").addEventListener("input", ev => {
  filterQuery = ev.target.value;
  renderCatalogModal();
});

$("prev").addEventListener("click", () => selectStep(currentStepIdx - 1));
$("next").addEventListener("click", () => selectStep(currentStepIdx + 1));
$("splitBtn").addEventListener("click", () => {
  split.enabled = !split.enabled;
  audio.playUi("splitToggle", split.enabled);
  syncUrl();
  updateSplitOverlay();
});
$("actionBtn").addEventListener("click", () => {
  const st = currentStep();
  if (!st.action || !activeEngine) return;
  activeEngine.triggerAction(st.action.id);
  const actOn = st.action.toggle ? activeEngine.isActionActive(st.action.id) : false;
  audio.playUi("action", st.action.id, actOn);
  updateCard();
});
$("pauseBtn").addEventListener("click", () => {
  paused = !paused;
  audio.setPaused(paused);
  audio.playUi("pause", paused);
  updateCard();
});
$("resetBtn").addEventListener("click", () => {
  resetCamera();
  audio.playUi("reset");
});
$("lang").addEventListener("click", () => setLang(lang === "en" ? "pl" : "en"));

// Keyboard shortcuts
window.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && catalogOpen) {
    ev.preventDefault();
    setCatalogOpen(false);
    return;
  }
  if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
  if (ev.key === "e" || ev.key === "E") { ev.preventDefault(); setCatalogOpen(!catalogOpen); return; }
  if (ev.key === "m" || ev.key === "M") { ev.preventDefault(); audio.toggleSound(); return; }
  if (ev.key === "b" || ev.key === "B") { ev.preventDefault(); audio.toggleMusic(); return; }
  if (catalogOpen) return;
  if (ev.key === "ArrowRight") { ev.preventDefault(); selectStep(currentStepIdx + 1); }
  else if (ev.key === "ArrowLeft") { ev.preventDefault(); selectStep(currentStepIdx - 1); }
  else if (ev.code === "BracketLeft") { ev.preventDefault(); stepEffect(-1); }
  else if (ev.code === "BracketRight") { ev.preventDefault(); stepEffect(1); }
  else if (ev.key === " ") { ev.preventDefault(); paused = !paused; audio.setPaused(paused); audio.playUi("pause", paused); updateCard(); }
  else if (ev.key === "s" || ev.key === "S") {
    split.enabled = !split.enabled; audio.playUi("splitToggle", split.enabled); syncUrl(); updateSplitOverlay();
  } else if (ev.key === "r" || ev.key === "R") {
    resetCamera(); audio.playUi("reset");
  } else if (ev.key >= "1" && ev.key <= "9") {
    const idx = parseInt(ev.key, 10) - 1;
    if (idx < EFFECTS.length) selectEffect(EFFECTS[idx].id);
  } else if (ev.key === "0") {
    if (EFFECTS.length >= 10) selectEffect(EFFECTS[9].id);
  }
});

// Pointer drag camera orbit + wheel zoom + double-click reset + effect drag/click
let draggingCam = false;
let draggingEffect = false;
let dragMoved = 0;
let lastX = 0, lastY = 0;
const pointers = new Map();
let pinchDist0 = 0, pinchCamDist0 = 0;

function pointerToNdc(ev) {
  const rect = canvas.getBoundingClientRect();
  return [
    ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2.0 - 1.0,
    1.0 - ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2.0,
  ];
}

canvas.addEventListener("pointerdown", ev => {
  if (!cam) return;
  if (ev.button !== 0 && ev.pointerType === "mouse") return;
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 1) {
    const [ndcX, ndcY] = pointerToNdc(ev);
    if (activeEngine && typeof activeEngine.onPointerDown === "function"
        && activeEngine.onPointerDown(ndcX, ndcY, renderW, renderH, currentStep(), cam)) {
      draggingEffect = true;
      draggingCam = false;
      canvas.classList.add("dragging");
      return;
    }
    draggingEffect = false;
    draggingCam = true;
    dragMoved = 0;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.classList.add("dragging");
  } else if (pointers.size === 2) {
    if (draggingEffect && activeEngine && typeof activeEngine.onPointerUp === "function") activeEngine.onPointerUp();
    draggingEffect = false;
    draggingCam = false;
    const pts = [...pointers.values()];
    pinchDist0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pinchCamDist0 = cam.dist;
  }
});

canvas.addEventListener("pointermove", ev => {
  if (!cam || !pointers.has(ev.pointerId)) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2 && pinchDist0 > 10) {
    const pts = [...pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    cam.dist = clamp(pinchCamDist0 * (pinchDist0 / Math.max(10, d)), cam.minDist, cam.maxDist);
    userInteracted = true;
    return;
  }
  if (draggingEffect) {
    const [ndcX, ndcY] = pointerToNdc(ev);
    if (activeEngine && typeof activeEngine.onPointerMove === "function") {
      activeEngine.onPointerMove(ndcX, ndcY, renderW, renderH, currentStep(), cam);
      if (currentEffect.id === "fur") audio.playCue({ type: "furPet" });
    }
    return;
  }
  if (!draggingCam) return;
  const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
  lastX = ev.clientX; lastY = ev.clientY;
  dragMoved += Math.hypot(dx, dy);
  cam.yaw -= dx * 0.0065;
  cam.pitch = clamp(cam.pitch + dy * 0.0055, cam.minPitch, cam.maxPitch);
  userInteracted = true;
});

function endCanvasPointer(ev) {
  const wasClick = draggingCam && dragMoved < 7;
  const wasEffect = draggingEffect;
  pointers.delete(ev.pointerId);
  if (pointers.size === 0) {
    draggingCam = false;
    draggingEffect = false;
    canvas.classList.remove("dragging");
  }
  if (wasEffect && activeEngine && typeof activeEngine.onPointerUp === "function") {
    activeEngine.onPointerUp();
    return;
  }
  if (wasClick && activeEngine && typeof activeEngine.onCanvasClick === "function") {
    const [ndcX, ndcY] = pointerToNdc(ev);
    activeEngine.onCanvasClick(ndcX, ndcY, renderW, renderH, currentStep(), cam);
    audio.playCanvasClick(currentEffect.id, currentStepIdx, ndcX);
  }
}
canvas.addEventListener("pointerup", endCanvasPointer);
canvas.addEventListener("pointercancel", endCanvasPointer);
canvas.addEventListener("dblclick", () => {
  if (!activeEngine?.disableDblClickReset) { resetCamera(); audio.playUi("reset"); }
});

canvas.addEventListener("wheel", ev => {
  if (!cam) return;
  ev.preventDefault();
  cam.dist = clamp(cam.dist * (1 + ev.deltaY * 0.001), cam.minDist, cam.maxDist);
  userInteracted = true;
}, { passive: false });

// Draggable amber split-screen handle
let draggingSplit = false;
const splitHit = $("splitHit");
splitHit.addEventListener("pointerdown", ev => {
  ev.stopPropagation();
  draggingSplit = true;
  splitHit.setPointerCapture(ev.pointerId);
});
splitHit.addEventListener("pointermove", ev => {
  if (!draggingSplit) return;
  split.pos = clamp(ev.clientX / Math.max(1, window.innerWidth), 0.08, 0.92);
  audio.playUi("splitDrag", split.pos);
  updateSplitOverlay();
});
splitHit.addEventListener("pointerup", () => { draggingSplit = false; });
splitHit.addEventListener("pointercancel", () => { draggingSplit = false; });
splitHit.addEventListener("keydown", ev => {
  if (ev.key === "ArrowLeft") { ev.preventDefault(); split.pos = clamp(split.pos - 0.05, 0.08, 0.92); audio.playUi("splitDrag", split.pos); updateSplitOverlay(); }
  else if (ev.key === "ArrowRight") { ev.preventDefault(); split.pos = clamp(split.pos + 0.05, 0.08, 0.92); audio.playUi("splitDrag", split.pos); updateSplitOverlay(); }
});

// Public API for the optional in-browser mascot assistant
window.FXLAB = {
  EFFECTS,
  audio,
  lang: () => lang,
  backend: () => activeEngine?.backend || "webgl2",
  current: () => ({ effect: currentEffect, step: currentStep(), stepIdx: currentStepIdx, split: split.enabled, backend: activeEngine?.backend || "webgl2" }),
  show(effectId, stepRef, splitOpt = null) {
    const fx = EFFECTS.find(e => e.id === effectId);
    if (!fx) return false;
    let idx = fx.defaultStep;
    if (typeof stepRef === "number") idx = clamp(stepRef, 0, fx.steps.length - 1);
    else if (typeof stepRef === "string") {
      const hit = fx.steps.findIndex(s => s.id.toLowerCase() === stepRef.toLowerCase());
      if (hit >= 0) idx = hit;
    }
    selectEffect(fx.id, idx, splitOpt);
    return true;
  },
  showByStepId(stepId) {
    for (const fx of EFFECTS) {
      const idx = fx.steps.findIndex(s => s.id.toLowerCase() === String(stepId).toLowerCase());
      if (idx >= 0) { selectEffect(fx.id, idx); return true; }
    }
    return false;
  },
  setSplit(enabled, pos = null) {
    split.enabled = !!enabled;
    if (typeof pos === "number") split.pos = clamp(pos, 0.08, 0.92);
    syncUrl();
    updateSplitOverlay();
    return true;
  },
  triggerAction() {
    const st = currentStep();
    if (!st.action || !activeEngine) return false;
    activeEngine.triggerAction(st.action.id);
    updateCard();
    return true;
  },
  openCatalog(open = true) {
    setCatalogOpen(open);
    return true;
  },
};

// Boot initial effect non-blockingly so UI shell paints immediately.
const initialBootPromise = selectEffect(currentEffect.id, currentStepIdx, split.enabled);

if (directorMode) {
  const ds = document.createElement("style");
  ds.id = "fxDirectorStyle";
  ds.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;} #filmLine{display:none!important;}";
  document.head.appendChild(ds);
  let directorTime = 0;
  const directorAudioLog = [];
  const logAudio = (ev) => directorAudioLog.push({ t: Number(directorTime.toFixed(6)), ...ev });

  window.FXLAB.__director = {
    async waitReady() {
      await initialBootPromise;
      if (typeof activeEngine?.finishFrame === "function") await activeEngine.finishFrame();
      return { fx: currentEffect.id, stepIdx: currentStepIdx, w: renderW, h: renderH, backend: activeEngine?.backend || "webgl2" };
    },
    async select(effectId, stepIdx = null, splitOpt = null) {
      await selectEffect(effectId, stepIdx, splitOpt);
      if (typeof activeEngine?.finishFrame === "function") await activeEngine.finishFrame();
      logAudio({ kind: "scene", fx: currentEffect.id, category: currentEffect.category, step: currentStepIdx });
      return { fx: currentEffect.id, stepIdx: currentStepIdx, w: renderW, h: renderH, backend: activeEngine?.backend || "webgl2" };
    },
    setStep(idx) {
      selectStep(idx);
      logAudio({ kind: "ui", name: "step", arg: currentStepIdx, fx: currentEffect.id });
      return currentStepIdx;
    },
    setHud(visible) {
      document.body.classList.toggle("no-hud", !visible);
      return visible;
    },
    setSplit(enabled, pos = null, emitDragSound = false) {
      split.enabled = !!enabled;
      if (typeof pos === "number") split.pos = clamp(pos, 0.08, 0.92);
      updateSplitOverlay();
      if (emitDragSound) logAudio({ kind: "ui", name: "splitDrag", arg: split.pos });
      return { enabled: split.enabled, pos: split.pos };
    },
    setCamera(patch = {}) {
      if (!cam) return null;
      for (const k of ["yaw", "pitch", "dist", "lookY", "fovDeg"]) {
        if (typeof patch[k] === "number") cam[k] = patch[k];
      }
      userInteracted = true;
      return { ...cam };
    },
    getCamera() { return cam ? { ...cam } : null; },
    setMaxPixels(n) {
      directorMaxPixels = Number(n) || 0;
      resizeCanvas(true);
      return { w: renderW, h: renderH };
    },
    getRenderSize() { return { w: renderW, h: renderH, backend: activeEngine?.backend || "webgl2" }; },
    triggerAction() {
      const st = currentStep();
      if (!st.action || !activeEngine) return false;
      activeEngine.triggerAction(st.action.id);
      updateCard();
      logAudio({ kind: "action", fx: currentEffect.id, action: st.action.id, step: currentStepIdx });
      return true;
    },
    clickCanvas(ndcX, ndcY) {
      if (!activeEngine || typeof activeEngine.onCanvasClick !== "function") return false;
      activeEngine.onCanvasClick(ndcX, ndcY, renderW, renderH, currentStep(), cam);
      logAudio({ kind: "canvasClick", fx: currentEffect.id, step: currentStepIdx, ndcX, ndcY });
      return true;
    },
    pointerDown(ndcX, ndcY) {
      if (!activeEngine || typeof activeEngine.onPointerDown !== "function") return false;
      return !!activeEngine.onPointerDown(ndcX, ndcY, renderW, renderH, currentStep(), cam);
    },
    pointerMove(ndcX, ndcY) {
      if (!activeEngine || typeof activeEngine.onPointerMove !== "function") return false;
      activeEngine.onPointerMove(ndcX, ndcY, renderW, renderH, currentStep(), cam);
      return true;
    },
    pointerUp() {
      if (typeof activeEngine?.onPointerUp === "function") activeEngine.onPointerUp();
    },
    resetEffect() {
      if (!activeEngine) return false;
      if (typeof activeEngine.onReset === "function") activeEngine.onReset();
      activeEngine.enterStep(currentStepIdx);
      resetCamera();
      return true;
    },
    setMaterialParams(patch = {}) {
      if (!activeEngine || typeof activeEngine.setMaterialParams !== "function") return null;
      return activeEngine.setMaterialParams(patch);
    },
    setPixelwaveParams(patch = {}) {
      if (!activeEngine || typeof activeEngine.setPixelwaveParams !== "function") return null;
      return activeEngine.setPixelwaveParams(patch);
    },
    setTime(t) { directorTime = Number(t) || 0; },
    getTime() { return directorTime; },
    async step(dt = 1 / 60, doRender = true) {
      if (!activeEngine || !cam) return false;
      directorTime += dt;
      const st = currentStep();
      activeEngine.update(dt, false, st, split);
      if (doRender) {
        activeEngine.render(renderW, renderH, st, split, cam);
        if (typeof activeEngine.finishFrame === "function") await activeEngine.finishFrame();
      }
      return true;
    },
    drainAudioEvents() {
      return directorAudioLog.splice(0, directorAudioLog.length);
    },
    getElementRect(sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },
  };
} else {
  let prevNow = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.0, (now - prevNow) / 1000));
    prevNow = now;
    if (activeEngine && cam) {
      if (!paused && !userInteracted && activeEngine.defaultCamera.autoOrbitSpeed) {
        cam.yaw += activeEngine.defaultCamera.autoOrbitSpeed * dt;
      }
      const st = currentStep();
      activeEngine.update(dt, paused, st, split);
      activeEngine.render(renderW, renderH, st, split, cam);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
