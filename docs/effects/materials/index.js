// FX Lab #31: Material Sandbox — Interactive WebGL2 Studio Controller
// Exports both createMaterialsRenderer(gl) (reusable for video/Shorts capture)
// and createMaterialsEffect(gl, { canvas, params }) (interactive FX Lab module).

import {
  clamp, lerp, smoothstep, norm3, cross3, cameraBasisFromOrbit, FULL_VS, linkPrograms,
} from "../../src/gl-utils.js";
import { MATERIALS_FS } from "./shaders.js";

// 6 Material Presets in exact Short / storytelling order:
// 1) 2005 Plastic (Blinn-Phong)  2) Dry Clay (Oren-Nayar)  3) Brushed Steel (Anisotropic GGX)
// 4) Car Paint (Clearcoat+Flake) 5) Velvet (Sheen)         6) Heat-Blued Titanium (Thin-Film Iridescence)
export const MATERIAL_PRESETS = [
  {
    id: "M1",
    en: "2005 Plastic",
    pl: "Plastik 2005",
    badgeEn: "2005 BLINN-PHONG · NO ENERGY CONSERVATION",
    badgePl: "BLINN-PHONG 2005 · BRAK ZACHOWANIA ENERGII",
    baseColor:  [0.54, 0.14, 0.09], // Classic 2005 game terracotta-red wet plastic
    sheenColor: [0.0, 0.0, 0.0],
    roughness:  0.42,
    metallic:   0.00,
    clearcoat:  0.00,
    anisotropy: 0.00,
    iridescence:0.00,
    sheen:      0.00,
    flakes:     0.00,
    clayGrain:  0.00,
    phongMix:   1.00,
  },
  {
    id: "M2",
    en: "Dry Clay",
    pl: "Sucha glina",
    badgeEn: "OREN-NAYAR DIFFUSE · HIGH ROUGHNESS",
    badgePl: "OREN-NAYAR · WYSOKA CHROPOWATOŚĆ",
    baseColor:  [0.34, 0.118, 0.068], // Rich raw unfired terracotta clay
    sheenColor: [0.0, 0.0, 0.0],
    roughness:  0.94,
    metallic:   0.00,
    clearcoat:  0.00,
    anisotropy: 0.00,
    iridescence:0.00,
    sheen:      0.00,
    flakes:     0.00,
    clayGrain:  1.00,
    phongMix:   0.00,
  },
  {
    id: "M3",
    en: "Brushed Steel",
    pl: "Szczotkowana stal",
    badgeEn: "ANISOTROPIC GGX · DIRECTIONAL LATHE BRUSH",
    badgePl: "ANIZOTROPOWY GGX · KIERUNKOWE RYSY STALI",
    baseColor:  [0.74, 0.78, 0.84], // Raw machined stainless steel
    sheenColor: [0.0, 0.0, 0.0],
    roughness:  0.30,
    metallic:   1.00,
    clearcoat:  0.00,
    anisotropy: 0.88,
    iridescence:0.00,
    sheen:      0.00,
    flakes:     0.00,
    clayGrain:  0.00,
    phongMix:   0.00,
  },
  {
    id: "M4",
    en: "Car Paint",
    pl: "Lakier samochodowy",
    badgeEn: "DUAL-LAYER CLEARCOAT + 3D METAL FLAKES",
    badgePl: "LAKIER BEZBARWNY CLEARCOAT + ZIARNO METALIK",
    baseColor:  [0.022, 0.115, 0.56], // Deep metallic candy sapphire
    sheenColor: [0.0, 0.0, 0.0],
    roughness:  0.34,
    metallic:   0.76,
    clearcoat:  1.00,
    anisotropy: 0.00,
    iridescence:0.00,
    sheen:      0.00,
    flakes:     1.00,
    clayGrain:  0.00,
    phongMix:   0.00,
  },
  {
    id: "M5",
    en: "Velvet",
    pl: "Aksamit",
    badgeEn: "CHARLIE SHEEN BRDF · GRAZING MICRO-FIBER RIM",
    badgePl: "CHARLIE SHEEN · MIĘKKI MESZEK NA KRAWĘDZIACH",
    baseColor:  [0.088, 0.008, 0.026], // Deep plush royal burgundy core
    sheenColor: [1.00, 0.34, 0.50],    // Luminous velvet crimson-rose grazing halo
    roughness:  0.90,
    metallic:   0.00,
    clearcoat:  0.00,
    anisotropy: 0.00,
    iridescence:0.00,
    sheen:      1.00,
    flakes:     0.00,
    clayGrain:  0.18,
    phongMix:   0.00,
  },
  {
    id: "M6",
    en: "Heat-Blued Titanium",
    pl: "Tytan (irydescencja)",
    badgeEn: "AIRY THIN-FILM INTERFERENCE · 412 nm OXIDE",
    badgePl: "INTERFERENCJA CIENKICH WARSTW · TLENEK 412 nm",
    baseColor:  [0.74, 0.76, 0.82], // Aerospace titanium base F0
    sheenColor: [0.0, 0.0, 0.0],
    roughness:  0.14,
    metallic:   1.00,
    clearcoat:  0.22,
    anisotropy: 0.24,
    iridescence:0.45, // ~412 nm @ n=1.48 -> cobalt blue -> royal violet -> burnished gold!
    sheen:      0.00,
    flakes:     0.00,
    clayGrain:  0.00,
    phongMix:   0.00,
  },
];

const ENV_LABELS = [
  { en: "Studio Softbox", pl: "Studio Softbox" },
  { en: "Low Sun",        pl: "Niskie słońce" },
  { en: "Neon Night",     pl: "Nocny neon" },
];

const SHAPE_LABELS = [
  { en: "Shaderball", pl: "Shaderball" },
  { en: "Torus Knot", pl: "Węzeł torusa" },
];

const HERO_CENTER = [0, 0.96, 0];

function cloneMat(p) {
  return {
    baseColor:   [...p.baseColor],
    sheenColor:  [...p.sheenColor],
    roughness:   p.roughness,
    metallic:    p.metallic,
    clearcoat:   p.clearcoat,
    anisotropy:  p.anisotropy,
    iridescence: p.iridescence,
    sheen:       p.sheen,
    flakes:      p.flakes,
    clayGrain:   p.clayGrain,
    phongMix:    p.phongMix,
  };
}

function lerpMat(a, b, t) {
  return {
    baseColor:   [lerp(a.baseColor[0], b.baseColor[0], t), lerp(a.baseColor[1], b.baseColor[1], t), lerp(a.baseColor[2], b.baseColor[2], t)],
    sheenColor:  [lerp(a.sheenColor[0], b.sheenColor[0], t), lerp(a.sheenColor[1], b.sheenColor[1], t), lerp(a.sheenColor[2], b.sheenColor[2], t)],
    roughness:   lerp(a.roughness,   b.roughness,   t),
    metallic:    lerp(a.metallic,    b.metallic,    t),
    clearcoat:   lerp(a.clearcoat,   b.clearcoat,   t),
    anisotropy:  lerp(a.anisotropy,  b.anisotropy,  t),
    iridescence: lerp(a.iridescence, b.iridescence, t),
    sheen:       lerp(a.sheen,       b.sheen,       t),
    flakes:      lerp(a.flakes,      b.flakes,      t),
    clayGrain:   lerp(a.clayGrain,   b.clayGrain,   t),
    phongMix:    lerp(a.phongMix,    b.phongMix,    t),
  };
}

function computeSoftboxFrame(azimuth, elevation, radius = 3.25) {
  const ce = Math.cos(elevation);
  const pos = [
    Math.sin(azimuth) * ce * radius,
    HERO_CENTER[1] + Math.sin(elevation) * radius,
    Math.cos(azimuth) * ce * radius,
  ];
  const fwd = norm3(HERO_CENTER[0] - pos[0], HERO_CENTER[1] - pos[1], HERO_CENTER[2] - pos[2]);
  const right = norm3(...cross3(fwd, [0, 1, 0]));
  const up = cross3(right, fwd);
  return { pos, fwd, right, up };
}

// Reusable low-level WebGL2 renderer (ready for direct Short / X loop rendering too!)
export function createMaterialsRenderer(gl) {
  const [prog] = linkPrograms(gl, [[FULL_VS, MATERIALS_FS]]);
  const uNames = [
    "uRes", "uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uTime",
    "uShape", "uEnv", "uLightPos", "uLightRight", "uLightUp", "uLightFwd", "uSplitX", "uShowLightHandle",
    "uBaseColor", "uSheenColor", "uRoughness", "uMetallic", "uClearcoat", "uAnisotropy",
    "uIridescence", "uSheen", "uFlakes", "uClayGrain", "uPhongMix",
  ];
  const u = Object.fromEntries(uNames.map((n) => [n, gl.getUniformLocation(prog, n)]));
  const vao = gl.createVertexArray();

  return {
    renderFrame(w, h, cam, mat, opts = {}) {
      const aspect = w / Math.max(1, h);
      const fovRad = ((cam.fovDeg || 34) * Math.PI) / 180;
      const tanHalfFov = Math.tan(fovRad * 0.5);
      // Automatically pull back smoothly on tall portrait mobile screens so the full shaderball stays uncropped!
      const portraitScale = aspect < 0.85 ? clamp(0.88 / Math.max(aspect, 0.42), 1.0, 1.95) : 1.0;
      const basis = cameraBasisFromOrbit(
        cam.yaw,
        clamp(cam.pitch, -0.35, 1.15),
        cam.dist * portraitScale,
        (cam.lookY ?? HERO_CENTER[1]) - (portraitScale > 1.05 ? 0.22 : 0.0),
      );
      const light = computeSoftboxFrame(opts.lightAz ?? 0.65, opts.lightEl ?? 0.52);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.uniform2f(u.uRes, w, h);
      gl.uniform3fv(u.uCamPos, basis.pos);
      gl.uniform3fv(u.uCamRight, basis.right);
      gl.uniform3fv(u.uCamUp, basis.up);
      gl.uniform3fv(u.uCamFwd, basis.fwd);
      gl.uniform1f(u.uTanHalfFov, tanHalfFov);
      gl.uniform1f(u.uAspect, aspect);
      gl.uniform1f(u.uTime, opts.time || 0);

      gl.uniform1i(u.uShape, opts.shape || 0);
      gl.uniform1i(u.uEnv, opts.env || 0);
      gl.uniform3fv(u.uLightPos, light.pos);
      gl.uniform3fv(u.uLightRight, light.right);
      gl.uniform3fv(u.uLightUp, light.up);
      gl.uniform3fv(u.uLightFwd, light.fwd);
      gl.uniform1f(u.uSplitX, typeof opts.splitX === "number" ? opts.splitX : -1.0);
      gl.uniform1f(u.uShowLightHandle, opts.showLightHandle ? 1.0 : 0.0);

      gl.uniform3fv(u.uBaseColor, mat.baseColor);
      gl.uniform3fv(u.uSheenColor, mat.sheenColor);
      gl.uniform1f(u.uRoughness, mat.roughness);
      gl.uniform1f(u.uMetallic, mat.metallic);
      gl.uniform1f(u.uClearcoat, mat.clearcoat);
      gl.uniform1f(u.uAnisotropy, mat.anisotropy);
      gl.uniform1f(u.uIridescence, mat.iridescence);
      gl.uniform1f(u.uSheen, mat.sheen);
      gl.uniform1f(u.uFlakes, mat.flakes);
      gl.uniform1f(u.uClayGrain, mat.clayGrain);
      gl.uniform1f(u.uPhongMix, mat.phongMix);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      return { basis, light, tanHalfFov, aspect };
    },
  };
}

export function createMaterialsEffect(gl, { params } = {}) {
  const core = createMaterialsRenderer(gl);

  const pShape = params?.get("shape");
  const pEnv   = params?.get("env");
  const pMorph = params?.get("morph");
  const pOrbit = params?.get("orbit");

  let shapeIdx = (pShape === "knot" || pShape === "1") ? 1 : 0;
  let envIdx   = clamp(parseInt(pEnv || "0", 10) || 0, 0, 2);
  let orbitLight = pOrbit !== "0";
  let autoMorph  = pMorph === "1";

  let lightAz = 0.68;
  let lightEl = 0.48;
  let simTime = 0.0;
  let morphClock = 0.0;
  let activePresetIdx = 5;
  let draggingLight = false;
  let lastFrameInfo = null;

  // Smooth interpolation state when clicking presets
  let matFrom = cloneMat(MATERIAL_PRESETS[activePresetIdx]);
  let matTo   = cloneMat(MATERIAL_PRESETS[activePresetIdx]);
  let matCur  = cloneMat(MATERIAL_PRESETS[activePresetIdx]);
  let transitionT = 1.0;

  // Custom sandbox control panel inside #card (auto-hidden under body.no-hud / ?hud=0)
  let ctrlEl = null;
  let sliders = {};
  let valEls = {};
  let envBtns = [];
  let shapeBtns = [];
  let toggleBtns = {};
  let langListenerBound = false;

  const getLang = () => ((window.FXLAB?.lang?.() || document.documentElement.lang) === "pl" ? "pl" : "en");

  function projectLightToUv(cam, w, h) {
    const aspect = w / Math.max(1, h);
    const fovRad = ((cam.fovDeg || 34) * Math.PI) / 180;
    const tanHalfFov = Math.tan(fovRad * 0.5);
    const portraitScale = aspect < 0.85 ? clamp(0.88 / Math.max(aspect, 0.42), 1.0, 1.95) : 1.0;
    const basis = cameraBasisFromOrbit(
      cam.yaw,
      clamp(cam.pitch, -0.35, 1.15),
      cam.dist * portraitScale,
      (cam.lookY ?? HERO_CENTER[1]) - (portraitScale > 1.05 ? 0.22 : 0.0),
    );
    const light = computeSoftboxFrame(lightAz, lightEl);
    const toL = [light.pos[0] - basis.pos[0], light.pos[1] - basis.pos[1], light.pos[2] - basis.pos[2]];
    const zCam = toL[0] * basis.fwd[0] + toL[1] * basis.fwd[1] + toL[2] * basis.fwd[2];
    if (zCam <= 0.25) return null;
    const lx = (toL[0] * basis.right[0] + toL[1] * basis.right[1] + toL[2] * basis.right[2]) / (zCam * aspect * tanHalfFov);
    const ly = (toL[0] * basis.up[0]    + toL[1] * basis.up[1]    + toL[2] * basis.up[2])    / (zCam * tanHalfFov);
    return [lx * 0.5 + 0.5, ly * 0.5 + 0.5];
  }

  function aimLightFromNdc(ndcX, ndcY, cam) {
    // Map screen NDC intuitively around the current camera view so dragging moves the softbox directly under cursor!
    const baseYaw = cam?.yaw ?? 0.36;
    lightAz = baseYaw + ndcX * 1.48;
    lightEl = clamp(0.42 + ndcY * 0.72, 0.10, 1.18);
  }

  function applySliderOverride(key, val) {
    autoMorph = false;
    transitionT = 1.0;
    matCur[key] = val;
    // Leaving legacy 2005 Phong mode immediately when user explores PBR sliders!
    if (matCur.phongMix > 0.0 && (key === "metallic" || key === "clearcoat" || key === "anisotropy" || key === "iridescence")) {
      matCur.phongMix = 0.0;
    }
    if (key === "clearcoat" && val > 0.3 && activePresetIdx === 3) {
      matCur.flakes = clamp(val, 0.0, 1.0);
    }
    matFrom = cloneMat(matCur);
    matTo   = cloneMat(matCur);
    syncControlsUi();
  }

  function formatSliderVal(key, v) {
    if (key === "iridescence") {
      if (v <= 0.01) return "OFF";
      return `${Math.round(lerp(160, 720, v))}nm`;
    }
    return v.toFixed(2);
  }

  function syncControlsUi() {
    if (!ctrlEl) return;
    const pl = getLang() === "pl";
    const splitOn = !!window.FXLAB?.current?.().split;

    for (const key of ["roughness", "metallic", "clearcoat", "anisotropy", "iridescence"]) {
      const v = clamp(matCur[key], 0, 1);
      if (sliders[key]) sliders[key].value = String(Math.round(v * 100));
      if (valEls[key]) valEls[key].textContent = formatSliderVal(key, v);
    }

    const lblMap = {
      roughness:   pl ? "Chropow." : "Roughness",
      metallic:    pl ? "Metal"    : "Metallic",
      clearcoat:   pl ? "Lakier"   : "Clearcoat",
      anisotropy:  pl ? "Anizotr." : "Anisotropy",
      iridescence: pl ? "Irydesc." : "Iridescence",
    };
    const scaleMap = {
      roughness:   pl ? ["Lustro", "Mat"]               : ["Mirror", "Matte"],
      metallic:    pl ? ["Niemetal", "Metal"]           : ["Non-metal", "Raw metal"],
      clearcoat:   pl ? ["Brak", "Lakier"]              : ["None", "Car lacquer"],
      anisotropy:  pl ? ["Okrągły blik", "Szczotkowany"]: ["Round glow", "Brushed"],
      iridescence: pl ? ["Brak", "Tęcza 720nm"]         : ["Off", "Rainbow 720nm"],
    };
    for (const [k, txt] of Object.entries(lblMap)) {
      const el = ctrlEl.querySelector(`[data-mat-lbl="${k}"]`);
      if (el) el.textContent = txt;
      const lo = ctrlEl.querySelector(`[data-mat-lo="${k}"]`);
      const hi = ctrlEl.querySelector(`[data-mat-hi="${k}"]`);
      if (lo) lo.textContent = scaleMap[k][0];
      if (hi) hi.textContent = scaleMap[k][1];
    }

    const envLbl = ctrlEl.querySelector('[data-mat-row="env"]');
    if (envLbl) envLbl.textContent = "IBL";
    const shapeLbl = ctrlEl.querySelector('[data-mat-row="shape"]');
    if (shapeLbl) shapeLbl.textContent = pl ? "Bryła" : "Mesh";

    envBtns.forEach((b, i) => {
      b.textContent = ENV_LABELS[i][pl ? "pl" : "en"];
      b.classList.toggle("is-on", i === envIdx);
      b.setAttribute("aria-pressed", String(i === envIdx));
    });
    shapeBtns.forEach((b, i) => {
      b.textContent = SHAPE_LABELS[i][pl ? "pl" : "en"];
      b.classList.toggle("is-on", i === shapeIdx);
      b.setAttribute("aria-pressed", String(i === shapeIdx));
    });

    if (toggleBtns.orbit) {
      toggleBtns.orbit.textContent = pl ? "Orbita światła" : "Orbit Light";
      toggleBtns.orbit.classList.toggle("is-on", orbitLight);
      toggleBtns.orbit.setAttribute("aria-pressed", String(orbitLight));
    }
  }

  function ensureControls() {
    if (ctrlEl || typeof document === "undefined") return;
    const card = document.getElementById("card");
    if (!card) return;

    if (!document.getElementById("fxMatCtrlCss")) {
      const st = document.createElement("style");
      st.id = "fxMatCtrlCss";
      st.textContent = `
        .mat-ctrls{
          margin-top:8px;padding-top:8px;border-top:2px solid #312c46;
          display:flex;flex-direction:column;gap:5px;
          font:700 11px/1.2 var(--pix,"Courier New",monospace);color:var(--cream);
        }
        .mat-ctrls[hidden]{display:none!important}
        .mat-sliders{display:flex;flex-direction:column;gap:4px}
        .mat-srow{display:flex;align-items:flex-start;gap:7px;min-width:0}
        .mat-lbl{flex:none;width:72px;padding-top:3px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
        .mat-track{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
        .mat-rng{width:100%;height:14px;accent-color:var(--amber);cursor:pointer;margin:0}
        .mat-scale{
          display:flex;justify-content:space-between;gap:6px;
          font:600 9px/1.1 var(--sans,system-ui,sans-serif);color:#8f87a6;
          letter-spacing:.01em;pointer-events:none;user-select:none;
        }
        .mat-val{flex:none;width:42px;padding-top:2px;text-align:right;font-size:10.5px;color:#fff3dc;font-variant-numeric:tabular-nums}
        .mat-prow{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding-top:2px}
        .mat-rlbl{flex:none;min-width:36px;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--mint)}
        .mat-pill{
          padding:4px 8px;min-height:24px;font:700 10.5px/1 var(--sans);
          background:#262238;color:#d8c8ae;border:0;
          box-shadow:0 0 0 1.5px var(--ink),2px 2px 0 1px rgba(0,0,0,.35);
          cursor:pointer;white-space:nowrap;
        }
        .mat-pill:hover{background:#373152;color:#fff3dc}
        .mat-pill.is-on{background:var(--amber);color:var(--ink)}
        .mat-pill.is-on:hover{background:#f5b877;color:var(--ink)}
        .mat-pill.is-mint.is-on{background:var(--mint);color:var(--ink)}
        @media(max-width:780px){
          .mat-ctrls{margin-top:6px;padding-top:6px;gap:4px}
          .mat-sliders{gap:4px}
          .mat-lbl{width:64px;font-size:9.5px}
          .mat-scale{font-size:8.5px}
          .mat-val{width:38px;font-size:9.5px}
          .mat-pill{padding:3px 7px;min-height:22px;font-size:10px}
        }
        body.no-hud .mat-ctrls{display:none!important}
      `;
      document.head.appendChild(st);
    }

    ctrlEl = document.createElement("div");
    ctrlEl.className = "mat-ctrls";
    ctrlEl.innerHTML = `
      <div class="mat-sliders">
        <label class="mat-srow"><span class="mat-lbl" data-mat-lbl="roughness">Roughness</span><span class="mat-track"><input class="mat-rng" id="matRough" type="range" min="4" max="100" step="1"><span class="mat-scale"><span data-mat-lo="roughness">Mirror</span><span data-mat-hi="roughness">Matte</span></span></span><span class="mat-val" id="matRoughVal">0.14</span></label>
        <label class="mat-srow"><span class="mat-lbl" data-mat-lbl="metallic">Metallic</span><span class="mat-track"><input class="mat-rng" id="matMetal" type="range" min="0" max="100" step="1"><span class="mat-scale"><span data-mat-lo="metallic">Non-metal</span><span data-mat-hi="metallic">Raw metal</span></span></span><span class="mat-val" id="matMetalVal">1.00</span></label>
        <label class="mat-srow"><span class="mat-lbl" data-mat-lbl="clearcoat">Clearcoat</span><span class="mat-track"><input class="mat-rng" id="matCoat" type="range" min="0" max="100" step="1"><span class="mat-scale"><span data-mat-lo="clearcoat">None</span><span data-mat-hi="clearcoat">Car lacquer</span></span></span><span class="mat-val" id="matCoatVal">0.22</span></label>
        <label class="mat-srow"><span class="mat-lbl" data-mat-lbl="anisotropy">Anisotropy</span><span class="mat-track"><input class="mat-rng" id="matAniso" type="range" min="0" max="100" step="1"><span class="mat-scale"><span data-mat-lo="anisotropy">Round glow</span><span data-mat-hi="anisotropy">Brushed</span></span></span><span class="mat-val" id="matAnisoVal">0.24</span></label>
        <label class="mat-srow"><span class="mat-lbl" data-mat-lbl="iridescence">Iridescence</span><span class="mat-track"><input class="mat-rng" id="matIrid" type="range" min="0" max="100" step="1"><span class="mat-scale"><span data-mat-lo="iridescence">Off</span><span data-mat-hi="iridescence">Rainbow 720nm</span></span></span><span class="mat-val" id="matIridVal">496nm</span></label>
      </div>
      <div class="mat-prow" id="matEnvRow"><span class="mat-rlbl" data-mat-row="env">IBL</span></div>
      <div class="mat-prow" id="matShapeRow"><span class="mat-rlbl" data-mat-row="shape">Mesh</span></div>
    `;

    const hint = document.getElementById("hintLine");
    if (hint && hint.parentNode === card) card.insertBefore(ctrlEl, hint);
    else card.appendChild(ctrlEl);

    const sliderDefs = [
      ["roughness",   "#matRough", "#matRoughVal"],
      ["metallic",    "#matMetal", "#matMetalVal"],
      ["clearcoat",   "#matCoat",  "#matCoatVal"],
      ["anisotropy",  "#matAniso", "#matAnisoVal"],
      ["iridescence", "#matIrid",  "#matIridVal"],
    ];
    for (const [key, inpSel, valSel] of sliderDefs) {
      const inp = ctrlEl.querySelector(inpSel);
      sliders[key] = inp;
      valEls[key] = ctrlEl.querySelector(valSel);
      inp.addEventListener("input", () => applySliderOverride(key, Number(inp.value) / 100));
    }

    // 3 IBL environment presets
    const eRow = ctrlEl.querySelector("#matEnvRow");
    envBtns = ENV_LABELS.map((_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mat-pill";
      b.addEventListener("click", () => { envIdx = i; syncControlsUi(); });
      eRow.appendChild(b);
      return b;
    });

    // 2 Shape presets + Orbit Light toggle (Split vs 2005 Phong & Auto-Morph live cleanly in the main row above!)
    const sRow = ctrlEl.querySelector("#matShapeRow");
    shapeBtns = SHAPE_LABELS.map((_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mat-pill";
      b.addEventListener("click", () => { shapeIdx = i; syncControlsUi(); });
      sRow.appendChild(b);
      return b;
    });
    const orbitBtn = document.createElement("button");
    orbitBtn.type = "button";
    orbitBtn.className = "mat-pill is-mint";
    orbitBtn.style.marginLeft = "auto";
    orbitBtn.addEventListener("click", () => { orbitLight = !orbitLight; syncControlsUi(); });
    sRow.appendChild(orbitBtn);
    toggleBtns.orbit = orbitBtn;

    if (!langListenerBound) {
      langListenerBound = true;
      document.addEventListener("fxlab:lang", () => syncControlsUi());
    }
    syncControlsUi();
  }

  function selectPreset(idx, instant = false) {
    activePresetIdx = clamp(idx, 0, MATERIAL_PRESETS.length - 1);
    autoMorph = false;
    matFrom = cloneMat(matCur);
    matTo   = cloneMat(MATERIAL_PRESETS[activePresetIdx]);
    if (instant) {
      matCur = cloneMat(matTo);
      transitionT = 1.0;
    } else {
      transitionT = 0.0;
    }
    syncControlsUi();
  }

  return {
    id: "materials",
    maxPixels: 1100000,
    defaultCamera: {
      yaw: 0.32,
      pitch: 0.24,
      dist: 3.72,
      lookY: 0.86,
      fovDeg: 34,
      minDist: 2.0,
      maxDist: 6.4,
      minPitch: -0.08,
      maxPitch: 1.05,
      autoOrbitSpeed: 0.08,
    },

    setVisible(visible) {
      ensureControls();
      if (ctrlEl) ctrlEl.hidden = !visible;
    },

    enterStep(stepIdx) {
      ensureControls();
      if (ctrlEl) ctrlEl.hidden = false;
      const instant = params?.get("director") === "1";
      selectPreset(stepIdx, instant);
    },

    onReset() {
      shapeIdx = 0;
      envIdx = 0;
      orbitLight = true;
      autoMorph = false;
      lightAz = 0.68;
      lightEl = 0.48;
      selectPreset(activePresetIdx, true);
    },

    triggerAction(actionId) {
      if (actionId === "morph") {
        autoMorph = !autoMorph;
        if (autoMorph) morphClock = activePresetIdx * 3.2;
      } else if (actionId === "shape") {
        shapeIdx = (shapeIdx + 1) % 2;
      } else if (actionId === "env") {
        envIdx = (envIdx + 1) % 3;
      } else if (actionId === "orbit") {
        orbitLight = !orbitLight;
      }
      syncControlsUi();
    },

    isActionActive(actionId) {
      if (actionId === "morph") return autoMorph;
      if (actionId === "shape") return shapeIdx === 1;
      if (actionId === "orbit") return orbitLight;
      return false;
    },

    onPointerDown(ndcX, ndcY, w, h, _step, cam) {
      const lUv = projectLightToUv(cam, w, h);
      if (lUv) {
        const uvX = ndcX * 0.5 + 0.5;
        const uvY = ndcY * 0.5 + 0.5;
        if (Math.hypot((uvX - lUv[0]) * (w / Math.max(1, h)), uvY - lUv[1]) < 0.085) {
          draggingLight = true;
          orbitLight = false;
          aimLightFromNdc(ndcX, ndcY, cam);
          syncControlsUi();
          return true;
        }
      }
      return false;
    },

    onPointerMove(ndcX, ndcY, _w, _h, _step, cam) {
      if (!draggingLight) return;
      aimLightFromNdc(ndcX, ndcY, cam);
    },

    onPointerUp() {
      draggingLight = false;
    },

    onCanvasClick(ndcX, ndcY, _w, _h, _step, cam) {
      // Single click on the studio backdrop aims the rectangular softbox light directly there!
      orbitLight = false;
      aimLightFromNdc(ndcX, ndcY, cam);
      syncControlsUi();
    },

    getTechBadge(stepIdx) {
      const pl = getLang() === "pl";
      const p = MATERIAL_PRESETS[clamp(stepIdx, 0, MATERIAL_PRESETS.length - 1)];
      if (autoMorph) return pl ? "AUTO-MORPH · PŁYNNA INTERPOLACJA PBR" : "AUTO-MORPH · LIVE PBR INTERPOLATION";
      return `${pl ? p.badgePl : p.badgeEn} · ${ENV_LABELS[envIdx][pl ? "pl" : "en"].toUpperCase()}`;
    },

    // Scripting hook for clean Shorts / X loop recording via FXLAB.__director
    setMaterialParams(patch = {}) {
      if (typeof patch.preset === "number") selectPreset(patch.preset, true);
      if (typeof patch.shape === "number") shapeIdx = clamp(patch.shape, 0, 1);
      if (typeof patch.env === "number") envIdx = clamp(patch.env, 0, 2);
      if (typeof patch.orbitLight === "boolean") orbitLight = patch.orbitLight;
      if (typeof patch.autoMorph === "boolean") autoMorph = patch.autoMorph;
      if (typeof patch.lightAz === "number") lightAz = patch.lightAz;
      if (typeof patch.lightEl === "number") lightEl = clamp(patch.lightEl, 0.08, 1.25);
      for (const k of ["roughness", "metallic", "clearcoat", "anisotropy", "iridescence", "sheen", "flakes", "clayGrain", "phongMix"]) {
        if (typeof patch[k] === "number") matCur[k] = clamp(patch[k], 0, 1);
      }
      if (Array.isArray(patch.baseColor) && patch.baseColor.length === 3) matCur.baseColor = [...patch.baseColor];
      matFrom = cloneMat(matCur);
      matTo   = cloneMat(matCur);
      transitionT = 1.0;
      syncControlsUi();
      return { ...matCur, shapeIdx, envIdx, orbitLight, autoMorph, lightAz, lightEl };
    },

    resize() {},

    update(dt, paused) {
      if (paused) return;
      simTime += dt;

      if (orbitLight && !draggingLight) {
        lightAz += dt * 0.58;
        lightEl = 0.48 + Math.sin(simTime * 0.42) * 0.14;
      }

      if (autoMorph) {
        const segDur = 3.2; // 1.7s hold + 1.5s silky cubic morph
        morphClock += dt;
        const total = MATERIAL_PRESETS.length;
        const raw = (morphClock / segDur) % total;
        const i0 = Math.floor(raw);
        const i1 = (i0 + 1) % total;
        const frac = raw - i0;
        const blend = smoothstep(0.52, 1.0, frac);
        matCur = lerpMat(MATERIAL_PRESETS[i0], MATERIAL_PRESETS[i1], blend);
        // Update live sliders while Auto-Morph glides so user sees every physical parameter moving!
        for (const key of ["roughness", "metallic", "clearcoat", "anisotropy", "iridescence"]) {
          if (sliders[key]) sliders[key].value = String(Math.round(matCur[key] * 100));
          if (valEls[key]) valEls[key].textContent = formatSliderVal(key, matCur[key]);
        }
      } else if (transitionT < 1.0) {
        transitionT = Math.min(1.0, transitionT + dt * 3.0);
        const ease = smoothstep(0.0, 1.0, transitionT);
        matCur = lerpMat(matFrom, matTo, ease);
        for (const key of ["roughness", "metallic", "clearcoat", "anisotropy", "iridescence"]) {
          if (sliders[key]) sliders[key].value = String(Math.round(matCur[key] * 100));
          if (valEls[key]) valEls[key].textContent = formatSliderVal(key, matCur[key]);
        }
      }
    },

    render(w, h, _step, split, cam) {
      const hudHidden = typeof document !== "undefined" && document.body.classList.contains("no-hud");
      lastFrameInfo = core.renderFrame(w, h, cam, matCur, {
        time: simTime,
        shape: shapeIdx,
        env: envIdx,
        lightAz,
        lightEl,
        splitX: split.enabled ? split.pos : -1.0,
        showLightHandle: !hudHidden,
      });
      // Keep Split pill synced if user clicked native Split button or pressed S
      if (toggleBtns.split) {
        const isOn = !!split.enabled;
        if (toggleBtns.split.classList.contains("is-on") !== isOn) {
          toggleBtns.split.classList.toggle("is-on", isOn);
          toggleBtns.split.setAttribute("aria-pressed", String(isOn));
        }
      }
      return lastFrameInfo;
    },
  };
}
