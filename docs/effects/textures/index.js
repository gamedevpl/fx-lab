// Evolution of Texture Mapping (1994-2026) — Interactive WebGL2 Corridor Lab with Draggable 4x Loupe:
//   0: 1994 PS1 Affine Warping + GTE Vertex Snapping (exact noperspective via vAffUv/vClipW)
//   1: 1996 Quake 16-Pixel Span Perspective (Michael Abrash)
//   2: 1996 3dfx Voodoo Bilinear Filtering (blurry up close, wild horizon Moire shimmer)
//   3: 1996 Mipmapping & Trilinear (Williams 1983 noted; Voodoo/N64; Show Mip Levels overlay)
//   4: 1998 S3TC / DXT1 4x4 Block Compression (real RGB565 endpoints + 2-bit palette + Show 4x4 Blocks)
//   5: 2001 16x Anisotropic Filtering (GeForce 3 vs optional Radeon 8500 angle-dependent artifact!)
//   6: 2011 MegaTexture / Virtual Texturing (id Tech 5 / RAGE — unique murals + live Snap Turn tile pop-in!)
//   7: 2020-26 Sampler Feedback Streaming (DX12 Ultimate, emulated — proactive tile residency + Feedback Map!)

import { clamp, makeLookAt, makePerspective, FULL_VS, linkPrograms, makeTex2D } from "../../src/gl-utils.js";
import { buildCorridorGeometry } from "./mesh.js";
import { createTextureAtlases } from "./atlas.js";
import { CORRIDOR_VS, CORRIDOR_FS, LOUPE_FS } from "./shaders.js";

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

export function createTexturesEffect(gl) {
  const [prog, progLoupe] = linkPrograms(gl, [
    [CORRIDOR_VS, CORRIDOR_FS],
    [FULL_VS, LOUPE_FS],
  ]);
  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const u = uLoc(prog, [
    "uViewProj", "uVertexSnap", "uSnapSplitX",
    "uTexFloor", "uTexWall", "uTexCrate", "uPageTable",
    "uCamPos", "uRes", "uTime", "uSplitX",
    "uStageLeft", "uStageRight", "uDebugOn", "uBilinearLeft",
  ]);
  const uL = uLoc(progLoupe, ["uSrc", "uRes", "uLoupeTarget", "uLoupeOn", "uSplitX"]);

  const geom = buildCorridorGeometry();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  function bindAttr(loc, data, size) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  bindAttr(0, geom.positions, 3);
  bindAttr(1, geom.normals, 3);
  bindAttr(2, geom.uvs, 2);
  bindAttr(3, geom.mats, 1);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  const vaoEmpty = gl.createVertexArray();
  const atlases = createTextureAtlases(gl);

  // Offscreen FBO (color + depth renderbuffer) feeding Pass 2 (4x Pixel Magnifier Loupe!)
  let bufW = 0, bufH = 0;
  let texScene = null, rbDepth = null, fboScene = null;
  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    if (texScene) gl.deleteTexture(texScene);
    if (rbDepth) gl.deleteRenderbuffer(rbDepth);
    if (fboScene) gl.deleteFramebuffer(fboScene);
    bufW = w; bufH = h;
    texScene = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    rbDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    fboScene = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texScene, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  const pageMips = new Float32Array(64 * 64);
  const pageBytes = new Uint8Array(64 * 64 * 4);
  pageMips.fill(0.0);

  let simTime = 0;
  let ps1Jitter = true;
  let showMips = false;
  let showBlocks = false;
  let radeon8500 = false;
  let feedbackMap = false;
  let snapTurnTimer = 0.0;
  let prevCamYaw = 0.0;

  // Draggable 4x Loupe reticle (default aims right onto the grazing horizon floor seam!)
  let loupeTarget = [0.50, 0.34];
  let draggingLoupe = false;

  function evictPagesForPopIn() {
    for (let i = 0; i < 64 * 64; i++) {
      const h = Math.sin(i * 12.9898 + simTime * 7.1) * 43758.5453;
      pageMips[i] = 4.2 + (h - Math.floor(h)) * 2.4;
    }
  }

  function updatePageTable(dt, camYaw, isMegaStage) {
    const yawDelta = Math.abs(camYaw - prevCamYaw);
    prevCamYaw = camYaw;
    if (isMegaStage && yawDelta > 0.14) {
      for (let i = 0; i < 64 * 64; i++) {
        if ((i * 7 + Math.floor(simTime * 30)) % 3 === 0) pageMips[i] = Math.max(pageMips[i], 4.8);
      }
    }
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = y * 64 + x;
        if (pageMips[i] > 0.0) {
          const tileJitter = 0.55 + 0.9 * (((x * 37 + y * 17) & 15) / 15);
          pageMips[i] = Math.max(0.0, pageMips[i] - dt * 3.8 * tileJitter);
        }
        const quantMip = pageMips[i] > 0.2 ? Math.ceil(pageMips[i]) : 0;
        pageBytes[i * 4 + 0] = Math.min(255, Math.round((quantMip / 7.0) * 255));
        pageBytes[i * 4 + 1] = (y >= 2 && y <= 54 && Math.abs(x - 32) <= 26) ? 255 : 40;
        pageBytes[i * 4 + 2] = 0;
        pageBytes[i * 4 + 3] = 255;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, atlases.texPageTable);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pageBytes);
  }

  return {
    id: "textures",
    disableDblClickReset: true,
    maxPixels: 920000,
    defaultCamera: {
      yaw: 0.0,
      pitch: 0.04,
      dist: 4.1,
      lookY: 0.78,
      fovDeg: 58,
      minDist: 1.8,
      maxDist: 6.0,
      minPitch: -0.08,
      maxPitch: 0.55,
      autoOrbitSpeed: 0.0,
    },

    enterStep(stepIdx) {
      if (stepIdx !== 3) showMips = false;
      if (stepIdx !== 4) showBlocks = false;
      if (stepIdx !== 5) radeon8500 = false;
      if (stepIdx !== 7) feedbackMap = false;
      if (stepIdx === 6) evictPagesForPopIn();
      // Auto-aim 4x loupe reticle at the most dramatic visual artifact for each era (user can still drag anywhere!)
      const sweetSpots = [
        [0.50, 0.34], // 0: PS1 affine seam on floor stripe
        [0.50, 0.34], // 1: Quake 16-px spans
        [0.50, 0.45], // 2: Bilinear horizon Moire shimmer
        [0.50, 0.45], // 3: Mipmap/Trilinear grazing horizon blur
        [0.50, 0.35], // 4: S3TC 4x4 block quantization
        [0.50, 0.46], // 5: Trilinear mush vs 16x AF horizon razor sharpness!
        [0.55, 0.48], // 6: MegaTexture pop-in tiles
        [0.50, 0.45], // 7: Sampler Feedback streaming
      ];
      if (sweetSpots[stepIdx]) loupeTarget = [...sweetSpots[stepIdx]];
    },

    onReset() {
      ps1Jitter = true;
      showMips = false;
      showBlocks = false;
      radeon8500 = false;
      feedbackMap = false;
      snapTurnTimer = 0.0;
      loupeTarget = [0.50, 0.34];
      pageMips.fill(0.0);
    },

    triggerAction(actionId) {
      if (actionId === "ps1Jitter") ps1Jitter = !ps1Jitter;
      else if (actionId === "showMips") showMips = !showMips;
      else if (actionId === "showBlocks") showBlocks = !showBlocks;
      else if (actionId === "radeon8500") radeon8500 = !radeon8500;
      else if (actionId === "snapTurn") { snapTurnTimer = 1.65; evictPagesForPopIn(); }
      else if (actionId === "feedbackMap") feedbackMap = !feedbackMap;
    },

    isActionActive(actionId) {
      if (actionId === "ps1Jitter") return ps1Jitter;
      if (actionId === "showMips") return showMips;
      if (actionId === "showBlocks") return showBlocks;
      if (actionId === "radeon8500") return radeon8500;
      if (actionId === "feedbackMap") return feedbackMap;
      return false;
    },

    onPointerDown(ndcX, ndcY) {
      const uvX = ndcX * 0.5 + 0.5;
      const uvY = ndcY * 0.5 + 0.5;
      if (Math.hypot(uvX - loupeTarget[0], uvY - loupeTarget[1]) < 0.075) {
        draggingLoupe = true;
        return true;
      }
      return false;
    },
    onPointerMove(ndcX, ndcY) {
      if (!draggingLoupe) return;
      loupeTarget = [clamp(ndcX * 0.5 + 0.5, 0.06, 0.94), clamp(ndcY * 0.5 + 0.5, 0.08, 0.92)];
    },
    onPointerUp() { draggingLoupe = false; },
    onCanvasClick(ndcX, ndcY) {
      loupeTarget = [clamp(ndcX * 0.5 + 0.5, 0.06, 0.94), clamp(ndcY * 0.5 + 0.5, 0.08, 0.92)];
    },

    getTechBadge(stepIdx) {
      return [
        ps1Jitter ? "1994 · PS1 AFFINE + GTE VERTEX SNAP" : "1994 · PS1 AFFINE (NO VERTEX SNAP)",
        "1996 · QUAKE 16-PX SPAN PERSPECTIVE",
        "1996 · 3DFX VOODOO BILINEAR (NO MIPS)",
        showMips ? "1996 · COLOR-CODED MIP LEVELS" : "1996 · MIPMAPPING & TRILINEAR",
        showBlocks ? "1998 · S3TC / DXT1 4×4 BLOCK GRID" : "1998 · S3TC / DXT1 COMPRESSION",
        radeon8500 ? "2001 · RADEON 8500 ANGLE-DEP AF!" : "2001 · GEFORCE 3 8× / RADEON 16× AF",
        "2011 · RAGE MEGATEXTURE (POP-IN!)",
        feedbackMap ? "2020–26 · SAMPLER FEEDBACK HEATMAP" : "2020–26 · DX12 SAMPLER FEEDBACK",
      ][stepIdx] || "WEBGL2";
    },

    resize(w, h) { allocTargets(w, h); },

    update(dt, paused, step) {
      if (!paused) {
        simTime += dt;
        if (snapTurnTimer > 0.0) snapTurnTimer = Math.max(0.0, snapTurnTimer - dt);
      }
      updatePageTable(paused ? 0 : dt, simTime, step && step.stage === 6);
    },

    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const glideZ = Math.sin(simTime * 0.55) * 1.15;
      const swayX = Math.sin(simTime * 0.42) * 0.44;
      const snapWhip = snapTurnTimer > 0.0 ? Math.sin((snapTurnTimer / 1.65) * Math.PI) * 0.62 : 0.0;

      const yaw = cam.yaw + snapWhip + (radeon8500 ? Math.sin(simTime * 0.85) * 0.68 : 0.0);
      const pitch = clamp(cam.pitch, -0.10, 0.58);
      // Lower grazing floor angle -> dramatically magnifies Trilinear blur vs 16x AF & PS1 affine warp!
      const eye = [
        swayX + Math.sin(yaw) * 1.25,
        clamp(0.76 + pitch * 2.1, 0.40, 2.55),
        cam.dist + glideZ,
      ];
      const look = [
        Math.sin(yaw) * -10.5,
        clamp(0.74 - pitch * 1.3, 0.20, 2.2),
        eye[2] - Math.cos(yaw) * 12.0,
      ];

      const view = makeLookAt(eye, look, [0, 1, 0]);
      const proj = makePerspective(((cam.fovDeg || 58) * Math.PI) / 180, aspect, 0.12, 80.0);
      const vp = mulMat4(proj, view);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const hasPs1 = stageLeft === 0 || stageRight === 0;
      const snapSplit = split.enabled && stageLeft === 0 && stageRight !== 0 ? split.pos : -1.0;

      let debugOn = false;
      if (step.stage === 3) debugOn = showMips;
      else if (step.stage === 4) debugOn = showBlocks;
      else if (step.stage === 5) debugOn = radeon8500;
      else if (step.stage === 7) debugOn = feedbackMap;

      // Pass 1: Render 3D corridor into offscreen FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
      gl.viewport(0, 0, w, h);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.clearColor(0.08, 0.10, 0.15, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniform1f(u.uVertexSnap, hasPs1 && ps1Jitter ? 1.0 : 0.0);
      gl.uniform1f(u.uSnapSplitX, snapSplit);
      gl.uniform3fv(u.uCamPos, eye);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform1f(u.uTime, simTime);
      gl.uniform1f(u.uSplitX, split.enabled ? split.pos : -1.0);
      gl.uniform1i(u.uStageLeft, stageLeft);
      gl.uniform1i(u.uStageRight, stageRight);
      gl.uniform1f(u.uDebugOn, debugOn ? 1.0 : 0.0);
      gl.uniform1f(u.uBilinearLeft, step.bilinearMipSplit ? 1.0 : 0.0);

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlases.texFloor); gl.uniform1i(u.uTexFloor, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlases.texWall); gl.uniform1i(u.uTexWall, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, atlases.texCrate); gl.uniform1i(u.uTexCrate, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, atlases.texPageTable); gl.uniform1i(u.uPageTable, 3);
      gl.drawElements(gl.TRIANGLES, geom.indexCount, gl.UNSIGNED_SHORT, 0);

      // Pass 2: Fullscreen + draggable 4x Pixel Magnifier Loupe
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(progLoupe);
      gl.bindVertexArray(vaoEmpty);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texScene); gl.uniform1i(uL.uSrc, 0);
      gl.uniform2f(uL.uRes, w, h);
      gl.uniform2fv(uL.uLoupeTarget, loupeTarget);
      const hudHidden = typeof document !== "undefined" && document.body.classList.contains("no-hud");
      gl.uniform1f(uL.uLoupeOn, hudHidden ? 0.0 : 1.0);
      gl.uniform1f(uL.uSplitX, split.enabled ? split.pos : -1.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
