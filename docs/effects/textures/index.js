// Evolution of Texture Mapping (1994-2026) — Interactive WebGL2 Corridor Lab:
//   0: 1994 PS1 Affine Warping + GTE Vertex Snapping (exact noperspective via vAffUv/vClipW)
//   1: 1996 Quake 16-Pixel Span Perspective (Michael Abrash)
//   2: 1996 3dfx Voodoo Bilinear Filtering (blurry up close, wild horizon Moire shimmer)
//   3: 1996 Mipmapping & Trilinear (Williams 1983 noted; Voodoo/N64; Show Mip Levels overlay)
//   4: 1998 S3TC / DXT1 4x4 Block Compression (real RGB565 endpoints + 2-bit palette + Show 4x4 Blocks)
//   5: 2001 16x Anisotropic Filtering (GeForce 3 vs optional Radeon 8500 angle-dependent artifact!)
//   6: 2011 MegaTexture / Virtual Texturing (id Tech 5 / RAGE — unique murals + live Snap Turn tile pop-in!)
//   7: 2020-26 Sampler Feedback Streaming (DX12 Ultimate, emulated — proactive tile residency + Feedback Map!)

import { clamp, makeLookAt, makePerspective, linkProgram } from "../../src/gl-utils.js";
import { buildCorridorGeometry } from "./mesh.js";
import { createTextureAtlases } from "./atlas.js";
import { CORRIDOR_VS, CORRIDOR_FS } from "./shaders.js";

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
  const prog = linkProgram(gl, CORRIDOR_VS, CORRIDOR_FS);
  const uLoc = names => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(prog, n)]));
  const u = uLoc([
    "uViewProj", "uVertexSnap", "uSnapSplitX",
    "uTexFloor", "uTexWall", "uTexCrate", "uPageTable",
    "uCamPos", "uRes", "uTime", "uSplitX",
    "uStageLeft", "uStageRight", "uDebugOn", "uBilinearLeft",
  ]);

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

  const atlases = createTextureAtlases(gl);

  // Live 64x64 Virtual Page Table (R = residentMip [0..7] -> 0..255, G = samplerFeedbackTouched [0..255])
  const pageMips = new Float32Array(64 * 64);
  const pageBytes = new Uint8Array(64 * 64 * 4);
  pageMips.fill(0.0);

  let simTime = 0;
  let ps1Jitter = true;       // Stage 0: PS1 GTE vertex snapping toggle
  let showMips = false;       // Stage 3: color-coded mip level bands
  let showBlocks = false;     // Stage 4: S3TC 4x4 block wireframe
  let radeon8500 = false;     // Stage 5: Radeon 8500 angle-dependent AF optimization!
  let feedbackMap = false;    // Stage 7: Sampler Feedback active tile heatmap
  let snapTurnTimer = 0.0;    // Stage 6: triggers rapid camera whip + MegaTexture pop-in!
  let customPitchBias = 0.0;  // Clicking floor tilts viewing angle shallower/steeper!
  let prevCamYaw = 0.0;

  function evictPagesForPopIn() {
    for (let i = 0; i < 64 * 64; i++) {
      // Deterministic pseudo-random coarse mip eviction (mip 4..6) so tiles stream back in staggered chunks!
      const h = Math.sin(i * 12.9898 + simTime * 7.1) * 43758.5453;
      pageMips[i] = 4.2 + (h - Math.floor(h)) * 2.4;
    }
  }

  function updatePageTable(dt, camYaw, isMegaStage) {
    // Detect rapid manual camera rotation -> evict newly visible pages on MegaTexture stage!
    const yawDelta = Math.abs(camYaw - prevCamYaw);
    prevCamYaw = camYaw;
    if (isMegaStage && yawDelta > 0.14) {
      for (let i = 0; i < 64 * 64; i++) {
        if ((i * 7 + Math.floor(simTime * 30)) % 3 === 0) {
          pageMips[i] = Math.max(pageMips[i], 4.8);
        }
      }
    }

    // Stream evicted virtual pages back to crisp mip 0 in staggered tile batches (authentic RAGE pop-in!)
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = y * 64 + x;
        if (pageMips[i] > 0.0) {
          const tileJitter = 0.55 + 0.9 * (((x * 37 + y * 17) & 15) / 15);
          // Slight discrete step drop so pages visibly pop from mip 6 -> 4 -> 2 -> 0!
          pageMips[i] = Math.max(0.0, pageMips[i] - dt * 3.8 * tileJitter);
        }
        const quantMip = pageMips[i] > 0.2 ? Math.ceil(pageMips[i]) : 0;
        pageBytes[i * 4 + 0] = Math.min(255, Math.round((quantMip / 7.0) * 255));
        // Feedback touched mask: tiles inside central view frustum band
        const inFrustum = (y >= 2 && y <= 54 && Math.abs(x - 32) <= 26) ? 255 : 40;
        pageBytes[i * 4 + 1] = inFrustum;
        pageBytes[i * 4 + 2] = 0;
        pageBytes[i * 4 + 3] = 255;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, atlases.texPageTable);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pageBytes);
  }

  return {
    id: "textures",
    maxPixels: 920000,
    defaultCamera: {
      yaw: 0.0,
      pitch: 0.13,
      dist: 4.1,
      lookY: 1.12,
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
      if (stepIdx === 6) {
        // Trigger an immediate crisp tile pop-in showcase when entering 2011 RAGE MegaTexture!
        evictPagesForPopIn();
      }
    },

    onReset() {
      ps1Jitter = true;
      showMips = false;
      showBlocks = false;
      radeon8500 = false;
      feedbackMap = false;
      snapTurnTimer = 0.0;
      customPitchBias = 0.0;
      pageMips.fill(0.0);
    },

    triggerAction(actionId) {
      if (actionId === "ps1Jitter") ps1Jitter = !ps1Jitter;
      else if (actionId === "showMips") showMips = !showMips;
      else if (actionId === "showBlocks") showBlocks = !showBlocks;
      else if (actionId === "radeon8500") radeon8500 = !radeon8500;
      else if (actionId === "snapTurn") {
        snapTurnTimer = 1.65;
        evictPagesForPopIn();
      } else if (actionId === "feedbackMap") feedbackMap = !feedbackMap;
    },

    isActionActive(actionId) {
      if (actionId === "ps1Jitter") return ps1Jitter;
      if (actionId === "showMips") return showMips;
      if (actionId === "showBlocks") return showBlocks;
      if (actionId === "radeon8500") return radeon8500;
      if (actionId === "feedbackMap") return feedbackMap;
      return false;
    },

    onCanvasClick(_ndcX, ndcY) {
      // Click higher/lower in corridor to tilt viewing grazing angle (shallower angle exaggerates AF & PS1 warp!)
      customPitchBias = clamp(ndcY * 0.22, -0.16, 0.24);
    },

    getTechBadge(stepIdx) {
      return [
        ps1Jitter ? "1994 · PS1 AFFINE + GTE VERTEX SNAP" : "1994 · PS1 AFFINE (NO VERTEX SNAP)",
        "1996 · QUAKE 16-PX SPAN PERSPECTIVE",
        "1996 · 3DFX VOODOO BILINEAR (NO MIPS)",
        showMips ? "1996 · COLOR-CODED MIP LEVELS" : "1996 · MIPMAPPING & TRILINEAR",
        showBlocks ? "1998 · S3TC / DXT1 4×4 BLOCK GRID" : "1998 · S3TC / DXT1 COMPRESSION",
        radeon8500 ? "2001 · RADEON 8500 ANGLE-DEP AF!" : "2001 · GEFORCE 3 16× ANISOTROPIC",
        "2011 · RAGE MEGATEXTURE (POP-IN!)",
        feedbackMap ? "2020–26 · SAMPLER FEEDBACK HEATMAP" : "2020–26 · DX12 SAMPLER FEEDBACK",
      ][stepIdx] || "WEBGL2";
    },

    resize() {},

    update(dt, paused, step) {
      if (!paused) {
        simTime += dt;
        if (snapTurnTimer > 0.0) {
          snapTurnTimer = Math.max(0.0, snapTurnTimer - dt);
        }
      }
      const isMega = step && step.stage === 6;
      updatePageTable(paused ? 0 : dt, simTime, isMega);
    },

    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);
      // Gentle forward/sidewalk glide in corridor so PS1 warping, Bilinear shimmer, and Radeon 8500 angle-dep AF pop alive!
      const glideZ = Math.sin(simTime * 0.55) * 1.15;
      const swayX = Math.sin(simTime * 0.42) * 0.48;
      const snapWhip = snapTurnTimer > 0.0 ? Math.sin((snapTurnTimer / 1.65) * Math.PI) * 0.62 : 0.0;

      const yaw = cam.yaw + snapWhip + (radeon8500 ? Math.sin(simTime * 0.85) * 0.42 : 0.0);
      const pitch = clamp(cam.pitch + customPitchBias, -0.10, 0.58);
      const eye = [
        swayX + Math.sin(yaw) * 1.35,
        clamp(1.18 + pitch * 2.2, 0.55, 2.85),
        cam.dist + glideZ,
      ];
      const look = [
        Math.sin(yaw) * -10.5,
        clamp(1.05 - pitch * 1.4, 0.25, 2.4),
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

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
      gl.bindVertexArray(null);
      gl.disable(gl.DEPTH_TEST);
    },
  };
}
