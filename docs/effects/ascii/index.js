// #28 Real-Time 3D World-Space ASCII & CRT — Interactive WebGL2 Controller.
// Contrasts 2D Screen-Space ASCII post-processing (Steps 2-3: swims & blurs) against
// True 3D World-Space ASCII (Steps 4-8: world-locked courtyard/cathedral grids + ~10,500
// hardware-instanced 3D upright camera-facing billboard glyphs with real depth occlusion,
// animated Joseon gat-hat vampire sentinel, spectral dash afterimages & subtle analog CRT bloom!).

import { clamp, cameraBasisFromOrbit, makeLookAt, makePerspective, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import { createGlyphAtlasTexture } from "./atlas.js";
import { buildSceneMeshes, buildGlyphCloud } from "./scene3d.js";
import { MESH_VS, MESH_FS, GLYPH_VS, GLYPH_FS, EDGE_FS, COMPOSITE_CRT_FS } from "./shaders.js";

function mulMat4(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function makeTex(gl, w, h, useFloat) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    useFloat ? gl.RGBA16F : gl.RGBA8,
    w, h, 0, gl.RGBA,
    useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const CHARSET_NAMES = ["ASCII 3D", "Code", "Hangul"];
const PALETTE_NAMES = ["Noir", "Vampire", "Amber", "Green"];

export function createAsciiEffect(gl) {
  const hasFloat = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  gl.getExtension("OES_texture_float_linear");
  gl.getExtension("OES_texture_half_float_linear");

  const [progMesh, progGlyph, progEdge, progComp] = linkPrograms(gl, [
    [MESH_VS, MESH_FS],
    [GLYPH_VS, GLYPH_FS],
    [FULL_VS, EDGE_FS],
    [FULL_VS, COMPOSITE_CRT_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uMesh = uLoc(progMesh, [
    "uViewProj", "uHeroPos", "uHeroYaw", "uSwordAngle", "uWalkPhase", "uWalkAmp", "uTime",
    "uAtlasTex", "uCamPos", "uLightPos", "uRenderMode", "uWorldStage", "uTileScale", "uCharset", "uPalette",
  ]);
  const uGlyph = uLoc(progGlyph, [
    "uViewProj", "uCamRight", "uCamUp", "uCamPos", "uHeroPos", "uHeroYaw", "uSwordAngle",
    "uWalkPhase", "uWalkAmp", "uTime", "uDashAmt", "uDashDir", "uSizeScale", "uWorldStage", "uCharset", "uPalette", "uAtlasTex",
  ]);
  const uEdge = uLoc(progEdge, ["uColorTex", "uNormDepthTex", "uTexel", "uEdgeThresh"]);
  const uComp = uLoc(progComp, [
    "uLitTex", "uNormDepthTex", "uEdgeTex", "uWorldTex", "uAtlasTex",
    "uRes", "uCellPx", "uStageLeft", "uStageRight", "uSplitX",
    "uShowEdges", "uCrtEnabled", "uCharset", "uPalette", "uTime",
  ]);

  const texAtlas = createGlyphAtlasTexture(gl);
  const fullVao = gl.createVertexArray();

  // Build static + hero 3D mesh VAO
  const mesh = buildSceneMeshes();
  const meshVao = gl.createVertexArray();
  const meshVbo = gl.createBuffer();
  gl.bindVertexArray(meshVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, meshVbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
  const strideM = 11 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, strideM, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, strideM, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, strideM, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, strideM, 32);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, strideM, 36);
  gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, strideM, 40);

  // Build instanced 3D billboard glyph cloud VAO (~10,300 instances, 1 single GPU draw call!)
  const cloud = buildGlyphCloud();
  const glyphVao = gl.createVertexArray();
  const quadCornerVbo = gl.createBuffer();
  const glyphVbo = gl.createBuffer();
  gl.bindVertexArray(glyphVao);
  // Per-vertex quad corners (divisor = 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, quadCornerVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 0);
  // Per-instance attributes (divisor = 1)
  gl.bindBuffer(gl.ARRAY_BUFFER, glyphVbo);
  gl.bufferData(gl.ARRAY_BUFFER, cloud.data, gl.STATIC_DRAW);
  const strideG = 12 * 4;
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, strideG, 0);  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, strideG, 16); gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, strideG, 32); gl.vertexAttribDivisor(3, 1);
  gl.bindVertexArray(null);

  // Framebuffers (Lit+MRT, Edge, World-Space 3D ASCII + Depth)
  let bufW = 0, bufH = 0;
  let fboLit = null, texLit = null, texNormDepth = null, rboLitDepth = null;
  let fboEdge = null, texEdge = null;
  let fboWorld = null, texWorld = null, texWorldNorm = null, rboWorldDepth = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const f of [fboLit, fboEdge, fboWorld]) if (f) gl.deleteFramebuffer(f);
    for (const t of [texLit, texNormDepth, texEdge, texWorld, texWorldNorm]) if (t) gl.deleteTexture(t);
    for (const r of [rboLitDepth, rboWorldDepth]) if (r) gl.deleteRenderbuffer(r);
    bufW = w; bufH = h;

    // 1. Clean 3D Lit + Normals/Depth MRT
    texLit = makeTex(gl, w, h, hasFloat);
    texNormDepth = makeTex(gl, w, h, hasFloat);
    rboLitDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rboLitDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    fboLit = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboLit);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texLit, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texNormDepth, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rboLitDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    // 2. 3x3 Sobel Edge Pass
    texEdge = makeTex(gl, w, h, false);
    fboEdge = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboEdge);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texEdge, 0);

    // 3. True 3D World-Space ASCII + Hardware Z-Buffer (RGBA8 so hardware alpha blending works on ALL WebGL2 GPUs!)
    texWorld = makeTex(gl, w, h, false);
    texWorldNorm = makeTex(gl, w, h, false);
    rboWorldDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rboWorldDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    fboWorld = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboWorld);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texWorld, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texWorldNorm, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rboWorldDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0.0;
  let cellPx = 11;        // 7..18 px (drives Screen-Space cell size + World-Space glyph scale!)
  let edgeThresh = 0.20;  // 0.08..0.55 Sobel threshold for Step 3 comparison
  let charset = 0;        // 0=ASCII 3D, 1=Code, 2=Hangul
  let palette = 0;        // 0=Noir, 1=Vampire, 2=Amber, 3=Green
  let showEdges = false;
  let crtEnabled = true;
  let wideCam = true;     // Start in Wide Isometric Cathedral so micro-glyphs optically fuse until you zoom in!
  let camZoomBlend = 1.0; // Smoothly interpolated 0=7.4x Deep Close-Up ASCII Reveal .. 1=Wide Painterly Cathedral
  let zoomAnimating = false; // True only while easing toward a button/step zoom preset; wheel immediately takes over!
  let manualZoomOverride = false; // True when external driver (video timeline/QA) sets camZoomBlend directly
  let lastCamDist = null; // Detects interactive mouse-wheel zoom so wheel smoothly zooms 4.2..48.0!
  let dashPulse = 0.0;    // Interactive or periodic spectral dash impulse!
  let manualLight = false;
  let lightPos = [-1.4, 2.1, 1.4];
  let fpsSmooth = 60.0, fpsAccum = 0.0, fpsFrames = 0;

  // Compact interactive ASCII controls panel (auto-hidden under body.no-hud / ?hud=0)
  let ctrlEl = null;
  let fpsEl = null, cellValEl = null, edgeValEl = null, cellInput = null, edgeInput = null;
  let charBtns = [], palBtns = [], viewBtns = [];

  function syncControlsUi() {
    if (!ctrlEl) return;
    if (cellInput) cellInput.value = String(cellPx);
    if (cellValEl) cellValEl.textContent = `${cellPx}px`;
    if (edgeInput) edgeInput.value = String(Math.round(edgeThresh * 100));
    if (edgeValEl) edgeValEl.textContent = edgeThresh.toFixed(2);
    charBtns.forEach((b, i) => b.classList.toggle("is-on", i === charset));
    palBtns.forEach((b, i) => b.classList.toggle("is-on", i === palette));
    viewBtns.forEach((b, i) => b.classList.toggle("is-on", i === (wideCam ? 1 : 0)));
  }

  function ensureControls() {
    if (ctrlEl || typeof document === "undefined") return;
    const card = document.getElementById("card");
    if (!card) return;
    if (!document.getElementById("fxAsciiCtrlCss")) {
      const st = document.createElement("style");
      st.id = "fxAsciiCtrlCss";
      st.textContent = `
        .ascii-ctrls{margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.10);display:flex;flex-direction:column;gap:5px;font:600 11px/1.2 "JetBrains Mono",ui-monospace,monospace;color:#cdd6f4}
        .ascii-ctrls[hidden]{display:none!important}
        .ascii-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .ascii-lbl{color:#9aa7c7;min-width:50px;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
        .ascii-rng{flex:1;min-width:82px;accent-color:#e2e6f0;height:4px;cursor:pointer}
        .ascii-val{min-width:34px;text-align:right;color:#fdebc8;font-size:10px}
        .ascii-pill{padding:3px 7px;border-radius:4px;border:1px solid rgba(255,255,255,.18);background:rgba(12,13,20,.82);color:#cdd6f4;font:600 10px/1 "JetBrains Mono",monospace;cursor:pointer}
        .ascii-pill.is-on{background:#f0ece6;border-color:#ffffff;color:#08090e}
        .ascii-fps{margin-left:auto;padding:2px 6px;border-radius:4px;background:rgba(139,196,176,.16);border:1px solid rgba(139,196,176,.40);color:#9ee0c8;font-size:10px}
        body.no-hud .ascii-ctrls{display:none!important}
      `;
      document.head.appendChild(st);
    }

    ctrlEl = document.createElement("div");
    ctrlEl.className = "ascii-ctrls";
    ctrlEl.innerHTML = `
      <div class="ascii-row">
        <span class="ascii-lbl">Scale</span>
        <input class="ascii-rng" id="asciiCellRng" type="range" min="7" max="18" step="1" value="${cellPx}">
        <span class="ascii-val" id="asciiCellVal">${cellPx}px</span>
        <span class="ascii-fps" id="asciiFpsBadge">60 FPS</span>
      </div>
      <div class="ascii-row">
        <span class="ascii-lbl">Edges</span>
        <input class="ascii-rng" id="asciiEdgeRng" type="range" min="8" max="55" step="1" value="${Math.round(edgeThresh * 100)}">
        <span class="ascii-val" id="asciiEdgeVal">${edgeThresh.toFixed(2)}</span>
      </div>
      <div class="ascii-row" id="asciiViewRow"><span class="ascii-lbl">Camera</span></div>
      <div class="ascii-row" id="asciiCharRow"><span class="ascii-lbl">Glyphs</span></div>
      <div class="ascii-row" id="asciiPalRow"><span class="ascii-lbl">Palette</span></div>
    `;
    const hint = document.getElementById("hintLine");
    if (hint && hint.parentNode === card) card.insertBefore(ctrlEl, hint);
    else card.appendChild(ctrlEl);

    fpsEl = ctrlEl.querySelector("#asciiFpsBadge");
    cellInput = ctrlEl.querySelector("#asciiCellRng");
    cellValEl = ctrlEl.querySelector("#asciiCellVal");
    edgeInput = ctrlEl.querySelector("#asciiEdgeRng");
    edgeValEl = ctrlEl.querySelector("#asciiEdgeVal");

    cellInput.addEventListener("input", () => { cellPx = clamp(Number(cellInput.value), 7, 18); syncControlsUi(); });
    edgeInput.addEventListener("input", () => { edgeThresh = clamp(Number(edgeInput.value) / 100, 0.08, 0.55); syncControlsUi(); });

    const viewRow = ctrlEl.querySelector("#asciiViewRow");
    viewBtns = ["Close-Up", "Wide Cathedral"].map((name, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ascii-pill"; b.textContent = name;
      b.addEventListener("click", () => { wideCam = i === 1; manualZoomOverride = false; zoomAnimating = true; syncControlsUi(); });
      viewRow.appendChild(b);
      return b;
    });

    const charRow = ctrlEl.querySelector("#asciiCharRow");
    charBtns = CHARSET_NAMES.map((name, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ascii-pill"; b.textContent = name;
      b.addEventListener("click", () => { charset = i; syncControlsUi(); });
      charRow.appendChild(b);
      return b;
    });

    const palRow = ctrlEl.querySelector("#asciiPalRow");
    palBtns = PALETTE_NAMES.map((name, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ascii-pill"; b.textContent = name;
      b.addEventListener("click", () => { palette = i; syncControlsUi(); });
      palRow.appendChild(b);
      return b;
    });
    syncControlsUi();
  }

  function computeHeroKinematics(t, stage) {
    // Real continuous bipedal walking patrol around the gothic cathedral courtyard!
    // Facing direction (heroYaw) is ALWAYS aligned 1:1 to velocity vector (atan2(vx, vz)) -> ZERO sideways sliding!
    const w = 0.34;
    const ang = t * w + 0.45;
    const rx = 2.65, rz = 1.32;
    const hx = rx * Math.sin(ang);
    const hz = 0.42 - rz * Math.cos(ang);
    const vx = rx * w * Math.cos(ang);
    const vz = rz * w * Math.sin(ang);
    const speed = Math.hypot(vx, vz) || 0.6;
    const yaw = Math.atan2(vx, vz); // Faces exact direction of travel!
    const dirX = vx / speed, dirZ = vz / speed;

    // Periodic dramatic Spectral Dash acceleration (or click trigger) along exact walking path!
    const cyc = (t * 0.20) % 1.0;
    let dashAuto = 0.0;
    if (stage >= 6 && !manualZoomOverride) {
      const burst = Math.exp(-Math.pow((cyc - 0.55) / 0.14, 2.0));
      dashAuto = clamp(burst, 0.0, 1.0);
    }
    const dashAmt = clamp(Math.max(dashAuto, dashPulse), 0.0, 1.0);

    // 1:1 foot-to-ground stride rhythm (~1.5 dignified footsteps/sec; accelerates cleanly on dash!)
    const walkPhase = t * 4.85;
    const walkAmp = clamp(speed / 0.55 + dashAmt * 0.35, 0.72, 1.25);
    const swordAngle = Math.sin(t * 1.15) * 0.06;

    return {
      heroPos: [hx, 0.0, hz],
      heroYaw: yaw,
      swordAngle,
      walkPhase,
      walkAmp,
      dashAmt,
      dashDir: [dirX, 0.0, dirZ],
    };
  }

  const api = {
    id: "ascii",
    maxPixels: 920000,
    defaultCamera: {
      // Fixed telephoto isometric angle (18 deg FOV, yaw=-0.34, pitch=0.54) -> pure straight-in / straight-out 7.4x optical zoom!
      yaw: -0.34,
      pitch: 0.54,
      dist: 38.5,
      lookY: 1.08,
      fovDeg: 18,
      minDist: 4.2,
      maxDist: 48.0,
      minPitch: 0.14,
      maxPitch: 0.92,
      autoOrbitSpeed: 0.0,
    },

    setVisible(visible) {
      ensureControls();
      if (ctrlEl) ctrlEl.hidden = !visible;
    },

    enterStep(stepIdx) {
      ensureControls();
      if (ctrlEl) ctrlEl.hidden = false;
      manualZoomOverride = false;
      if (stepIdx !== 2) showEdges = false;
      if (stepIdx === 6 || stepIdx === 7) {
        wideCam = true; // Wide Isometric Cathedral where micro-glyphs optically fuse!
        zoomAnimating = true;
        if (stepIdx === 6) dashPulse = 1.0;
      } else if (stepIdx === 4 || stepIdx === 5) {
        wideCam = false; // 7.4x Zoom-In revealing crisp S Z z N H # typography!
        zoomAnimating = true;
      }
      if (stepIdx === 7) crtEnabled = true;
      syncControlsUi();
    },

    onReset() {
      manualLight = false;
      cellPx = 11;
      edgeThresh = 0.20;
      charset = 0;
      palette = 0;
      showEdges = false;
      crtEnabled = true;
      wideCam = true;
      camZoomBlend = 1.0;
      zoomAnimating = false;
      manualZoomOverride = false;
      lastCamDist = null;
      dashPulse = 0.0;
      syncControlsUi();
    },

    triggerAction(actionId) {
      if (actionId === "edges") showEdges = !showEdges;
      else if (actionId === "zoom") { wideCam = !wideCam; manualZoomOverride = false; zoomAnimating = true; }
      else if (actionId === "dash") dashPulse = 1.0;
      else if (actionId === "charset") charset = (charset + 1) % CHARSET_NAMES.length;
      else if (actionId === "palette") palette = (palette + 1) % PALETTE_NAMES.length;
      else if (actionId === "crt") crtEnabled = !crtEnabled;
      syncControlsUi();
    },

    isActionActive(actionId) {
      if (actionId === "edges") return showEdges;
      if (actionId === "zoom") return wideCam;
      if (actionId === "crt") return crtEnabled;
      return false;
    },

    getTechBadge(stepIdx) {
      const badges = [
        "Isometric 3D Gothic Courtyard · Clean Geometry",
        "2D Screen-Space Luma Grid (Swims on Orbit!)",
        "2D Screen-Space Sobel / \\ | _ (Still Glued to Monitor)",
        "100% Camera-Facing 3D Billboards · Zero UV Textures",
        `3D Billboard Glyph Cloud · ${cloud.instanceCount.toLocaleString()} Upright Glyphs`,
        "3D Lighting + Per-Material Alphabets (Tree · Grass · Fence)",
        "Spectral Dash Afterimages · Wide Cathedral Zoom",
        `Screen-Space vs 3D World-Space · ${PALETTE_NAMES[palette]}`,
      ];
      return badges[clamp(stepIdx, 0, badges.length - 1)];
    },

    setAsciiParams(p = {}) {
      if (typeof p.cellPx === "number") cellPx = clamp(p.cellPx, 7, 18);
      if (typeof p.edgeThresh === "number") edgeThresh = clamp(p.edgeThresh, 0.06, 0.65);
      if (typeof p.charset === "number") charset = ((p.charset % 3) + 3) % 3;
      if (typeof p.palette === "number") palette = ((p.palette % 4) + 4) % 4;
      if (typeof p.showEdges === "boolean") showEdges = p.showEdges;
      if (typeof p.crtEnabled === "boolean") crtEnabled = p.crtEnabled;
      if (typeof p.wideCam === "boolean") { wideCam = p.wideCam; manualZoomOverride = false; }
      if (typeof p.camZoomBlend === "number") { camZoomBlend = clamp(p.camZoomBlend, 0.0, 1.0); manualZoomOverride = true; }
      if (typeof p.dashPulse === "number") dashPulse = clamp(p.dashPulse, 0.0, 1.0);
      syncControlsUi();
    },

    getAsciiParams() {
      return {
        cellPx, edgeThresh, charset, palette, showEdges, crtEnabled, wideCam,
        instances: cloud.instanceCount, fps: Math.round(fpsSmooth),
      };
    },

    setSimTime(t) {
      simTime = t;
    },

    onCanvasClick(ndcX, ndcY) {
      // Trigger spectral dash + shift warm lantern light!
      dashPulse = 1.0;
      manualLight = true;
      lightPos = [clamp(ndcX * 4.5, -5.0, 5.0), clamp(1.8 + ndcY * 1.4, 0.8, 3.6), clamp(1.2 - ndcY * 1.5, -2.5, 3.2)];
    },

    resize(w, h) {
      allocTargets(w, h);
    },

    update(dt, paused) {
      if (!paused) {
        simTime += dt;
        if (!manualZoomOverride && zoomAnimating) {
          const targetZoom = wideCam ? 1.0 : 0.0;
          camZoomBlend += (targetZoom - camZoomBlend) * Math.min(1.0, dt * 2.6);
          if (Math.abs(targetZoom - camZoomBlend) < 0.002) {
            camZoomBlend = targetZoom;
            zoomAnimating = false;
          }
        }
        dashPulse = Math.max(0.0, dashPulse - dt * 0.55);
        if (!manualLight) {
          lightPos = [Math.sin(simTime * 0.6) * 2.2, 1.95 + Math.sin(simTime * 1.1) * 0.3, 1.25];
        }
      }
      if (dt > 0.001 && dt < 0.25 && fpsEl) {
        fpsAccum += dt;
        fpsFrames++;
        if (fpsAccum >= 0.35) {
          fpsSmooth = fpsFrames / fpsAccum;
          fpsEl.textContent = `${Math.round(fpsSmooth)} FPS · 3D`;
          fpsAccum = 0; fpsFrames = 0;
        }
      }
    },

    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);

      const stageR = split.enabled ? (step.compareRight ?? step.stage ?? 7) : (step.stage ?? 7);
      const stageL = split.enabled ? (step.compareLeft ?? 1) : stageR;
      const splitX = split.enabled ? split.pos : -1.0;

      // Active world stage is the higher world-space stage if either side uses >= 3
      const activeWorldStage = Math.max(stageL, stageR);
      const kin = computeHeroKinematics(simTime, activeWorldStage);

      // TRUE EXPONENTIAL STRAIGHT-IN / STRAIGHT-OUT 7.4x OPTICAL ZOOM (zero yaw/pitch twist during zoom!)
      // Close-Up dist ~ 5.5 <-> Wide Cathedral dist ~ 40.5 (constant perceived magnification speed!)
      const distClose = manualZoomOverride ? clamp(cam.dist, 4.2, 9.5) : 5.50;
      const distWide = 40.5;
      if (!manualZoomOverride && lastCamDist !== null && Math.abs(cam.dist - lastCamDist) > 0.02) {
        // User scrolled the mouse wheel! Cancel preset ease & sync camZoomBlend directly to log(cam.dist)!
        zoomAnimating = false;
        camZoomBlend = clamp(Math.log(clamp(cam.dist, distClose, distWide) / distClose) / Math.log(distWide / distClose), 0.0, 1.0);
        wideCam = camZoomBlend > 0.5;
        syncControlsUi();
      }
      const zB = camZoomBlend;
      const baseDist = distClose * Math.pow(distWide / distClose, zB);
      if (!manualZoomOverride) {
        cam.dist = baseDist;
        lastCamDist = baseDist;
      }
      const effDist = aspect < 1.0 ? baseDist * clamp(1.10 / Math.sqrt(aspect), 1.0, 1.38) : baseDist;
      // Keep camera yaw & pitch LOCKED during zoom (pure optical zoom-in / zoom-out on the exact same painting!)
      const effPitch = cam.pitch;
      const effYaw = cam.yaw;
      // Keep hero DEAD-CENTER through the entire punch zoom (only shift slightly toward full cathedral above zB > 0.65)!
      const focusW = clamp((zB - 0.60) / 0.40, 0.0, 1.0);
      const focusSmooth = focusW * focusW * (3.0 - 2.0 * focusW);
      const effLookY = cam.lookY * (1.0 - focusSmooth) + 2.05 * focusSmooth;

      // Smoothly center on walking priest from Close-Up through mid-zoom <-> full cathedral + tree at Wide!
      const trackX = kin.heroPos[0] * (1.0 - focusSmooth) + (-1.45) * focusSmooth;
      const trackZ = kin.heroPos[2] * (1.0 - focusSmooth) + 0.85 * focusSmooth;
      const basis = cameraBasisFromOrbit(effYaw, effPitch, effDist, effLookY);
      const eye = [basis.pos[0] + trackX, basis.pos[1], basis.pos[2] + trackZ];
      const target = [trackX, effLookY, trackZ];
      const view = makeLookAt(eye, target, [0, 1, 0]);
      const proj = makePerspective(cam.fovDeg * Math.PI / 180, aspect, 0.5, 110.0);
      const viewProj = mulMat4(proj, view);

      const needsLit = (stageL <= 2) || (stageR <= 2);
      const needsSobel = (stageL === 2) || (stageR === 2);
      const needsWorld = (stageL >= 3) || (stageR >= 3);
      const tileScale = cellPx / 11.0;

      // ---- PASS 1: Clean 3D Lit + MRT (when Original 3D or Screen-Space Luma/Sobel is visible!) ----
      if (needsLit) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboLit);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.clearColor(0.014, 0.014, 0.022, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(progMesh);
        gl.bindVertexArray(meshVao);
        gl.uniformMatrix4fv(uMesh.uViewProj, false, viewProj);
        gl.uniform3fv(uMesh.uHeroPos, kin.heroPos);
        gl.uniform1f(uMesh.uHeroYaw, kin.heroYaw);
        gl.uniform1f(uMesh.uSwordAngle, kin.swordAngle);
        gl.uniform1f(uMesh.uWalkPhase, kin.walkPhase);
        gl.uniform1f(uMesh.uWalkAmp, kin.walkAmp);
        gl.uniform1f(uMesh.uTime, simTime);
        gl.uniform3fv(uMesh.uCamPos, eye);
        gl.uniform3fv(uMesh.uLightPos, lightPos);
        gl.uniform1i(uMesh.uRenderMode, 0);
        gl.uniform1i(uMesh.uWorldStage, activeWorldStage);
        gl.uniform1f(uMesh.uTileScale, tileScale);
        gl.uniform1i(uMesh.uCharset, charset);
        gl.uniform1i(uMesh.uPalette, palette);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texAtlas); gl.uniform1i(uMesh.uAtlasTex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
      }

      // ---- PASS 2: 3x3 Sobel Edge Pass (only when Screen-Space Sobel Stage 2 is visible!) ----
      if (needsSobel) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboEdge);
        gl.viewport(0, 0, w, h);
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(progEdge);
        gl.bindVertexArray(fullVao);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texLit); gl.uniform1i(uEdge.uColorTex, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texNormDepth); gl.uniform1i(uEdge.uNormDepthTex, 1);
        gl.uniform2f(uEdge.uTexel, 1.0 / w, 1.0 / h);
        gl.uniform1f(uEdge.uEdgeThresh, edgeThresh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // ---- PASS 3: TRUE 3D WORLD-SPACE ASCII (Surface Grids + Opaque Depth Core + ~10,500 3D Billboard Glyphs!) ----
      if (needsWorld) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboWorld);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.clearColor(0.012, 0.012, 0.018, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // 3a) Draw 3D World-Space Surface ASCII (courtyard < > + ; ~, cathedral [ ] = H I #, amber windows) + black hero core
        gl.useProgram(progMesh);
        gl.bindVertexArray(meshVao);
        gl.uniformMatrix4fv(uMesh.uViewProj, false, viewProj);
        gl.uniform3fv(uMesh.uHeroPos, kin.heroPos);
        gl.uniform1f(uMesh.uHeroYaw, kin.heroYaw);
        gl.uniform1f(uMesh.uSwordAngle, kin.swordAngle);
        gl.uniform1f(uMesh.uWalkPhase, kin.walkPhase);
        gl.uniform1f(uMesh.uWalkAmp, kin.walkAmp);
        gl.uniform1f(uMesh.uTime, simTime);
        gl.uniform3fv(uMesh.uCamPos, eye);
        gl.uniform3fv(uMesh.uLightPos, lightPos);
        gl.uniform1i(uMesh.uRenderMode, 1);
        gl.uniform1i(uMesh.uWorldStage, activeWorldStage);
        gl.uniform1f(uMesh.uTileScale, tileScale);
        gl.uniform1i(uMesh.uCharset, charset);
        gl.uniform1i(uMesh.uPalette, palette);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texAtlas); gl.uniform1i(uMesh.uAtlasTex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);

        // 3b) Draw ~10,300 Hardware-Instanced 3D Upright Billboard Glyphs (courtyard < > + ; ~, hero S Z z N #, tree, grass, dash!)
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(true);
        gl.useProgram(progGlyph);
        gl.bindVertexArray(glyphVao);
        gl.uniformMatrix4fv(uGlyph.uViewProj, false, viewProj);
        gl.uniform3fv(uGlyph.uCamRight, basis.right);
        gl.uniform3fv(uGlyph.uCamUp, basis.up);
        gl.uniform3fv(uGlyph.uCamPos, eye);
        gl.uniform3fv(uGlyph.uHeroPos, kin.heroPos);
        gl.uniform1f(uGlyph.uHeroYaw, kin.heroYaw);
        gl.uniform1f(uGlyph.uSwordAngle, kin.swordAngle);
        gl.uniform1f(uGlyph.uWalkPhase, kin.walkPhase);
        gl.uniform1f(uGlyph.uWalkAmp, kin.walkAmp);
        gl.uniform1f(uGlyph.uTime, simTime);
        gl.uniform1f(uGlyph.uDashAmt, kin.dashAmt);
        gl.uniform3fv(uGlyph.uDashDir, kin.dashDir);
        gl.uniform1f(uGlyph.uSizeScale, 0.85 + 0.15 * tileScale);
        gl.uniform1i(uGlyph.uWorldStage, activeWorldStage);
        gl.uniform1i(uGlyph.uCharset, charset);
        gl.uniform1i(uGlyph.uPalette, palette);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texAtlas); gl.uniform1i(uGlyph.uAtlasTex, 0);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cloud.instanceCount);
        gl.disable(gl.BLEND);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      }

      // ---- PASS 4: Composite Split-Screen + Subtle Dark-Room Analog CRT Halation & Phosphor Bloom ----
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(progComp);
      gl.bindVertexArray(fullVao);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texLit);       gl.uniform1i(uComp.uLitTex, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texNormDepth); gl.uniform1i(uComp.uNormDepthTex, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texEdge);      gl.uniform1i(uComp.uEdgeTex, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, texWorld);     gl.uniform1i(uComp.uWorldTex, 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, texAtlas);     gl.uniform1i(uComp.uAtlasTex, 4);
      gl.uniform2f(uComp.uRes, w, h);
      const scaledCell = Math.max(5.0, cellPx * (Math.min(w, h) / 720.0));
      gl.uniform1f(uComp.uCellPx, scaledCell);
      gl.uniform1i(uComp.uStageLeft, stageL);
      gl.uniform1i(uComp.uStageRight, stageR);
      gl.uniform1f(uComp.uSplitX, splitX);
      gl.uniform1i(uComp.uShowEdges, showEdges ? 1 : 0);
      gl.uniform1i(uComp.uCrtEnabled, crtEnabled ? 1 : 0);
      gl.uniform1i(uComp.uCharset, charset);
      gl.uniform1i(uComp.uPalette, palette);
      gl.uniform1f(uComp.uTime, simTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindVertexArray(null);
    },
  };
  if (typeof window !== "undefined") window.__fxAscii = api;
  return api;
}
