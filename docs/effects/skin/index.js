// Evolution of Skin & Subsurface Scattering (1975-2021) — Interactive RGBA16F Multi-Pass WebGL2 Controller.
// Genuine 3-MRT + 2-Pass Separable Screen-Space SSS (Jimenez 2015) + Burley Normalized Diffusion +
// Volumetric optical ear/nose thickness + Pre-Integrated Curvature LUT + Dual-Lobe GGX Specular!

import { clamp, cameraBasisFromOrbit, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import { SKIN_BASE_FS, SSSS_BLUR_FS, SKIN_COMPOSITE_FS } from "./shaders.js";

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

export function createSkinEffect(gl) {
  const hasFloat = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  gl.getExtension("OES_texture_float_linear");
  gl.getExtension("OES_texture_half_float_linear");

  const [progBase, progBlur, progComp] = linkPrograms(gl, [
    [FULL_VS, SKIN_BASE_FS],
    [FULL_VS, SSSS_BLUR_FS],
    [FULL_VS, SKIN_COMPOSITE_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uBase = uLoc(progBase, ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uTime", "uLightPos", "uStageLeft", "uStageRight", "uSplitX", "uScatterScale"]);
  const uBlur = uLoc(progBlur, ["uDiffTex", "uMetaTex", "uDir", "uScatterScale"]);
  const uComp = uLoc(progComp, ["uDiffBlurTex", "uSpecTex", "uMetaTex", "uShowThickness"]);
  const vao = gl.createVertexArray();

  let bufW = 0, bufH = 0;
  let fboBase = null, texDiff = null, texSpec = null, texMeta = null;
  let fboH = null, texH = null, fboV = null, texV = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const f of [fboBase, fboH, fboV]) if (f) gl.deleteFramebuffer(f);
    for (const t of [texDiff, texSpec, texMeta, texH, texV]) if (t) gl.deleteTexture(t);
    bufW = w; bufH = h;

    texDiff = makeTex(gl, w, h, hasFloat);
    texSpec = makeTex(gl, w, h, hasFloat);
    texMeta = makeTex(gl, w, h, hasFloat);
    fboBase = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBase);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texDiff, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texSpec, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texMeta, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    texH = makeTex(gl, w, h, hasFloat);
    fboH = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboH);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texH, 0);

    texV = makeTex(gl, w, h, hasFloat);
    fboV = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboV);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texV, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0;
  let scatterScale = 1.15;   // Natural warm skin scatter (action button boosts deep scatter / thickness!)
  let deepScatter = false;
  let showThickness = false;
  let manualLight = false;
  let lightAz = -2.25;       // Warm key/backlight positioned behind the sculpted ear for instant ruby glow!
  let lightEl = 0.16;

  return {
    id: "skin",
    maxPixels: 520000,
    defaultCamera: {
      yaw: 0.68,            // Classic 3/4 profile framing BOTH thin translucent ear AND nose/cheek terminator!
      pitch: 0.04,
      dist: 2.75,
      lookY: 0.02,
      fovDeg: 40,
      minDist: 1.45,
      maxDist: 3.8,
      minPitch: -0.35,
      maxPitch: 0.45,
      autoOrbitSpeed: 0.0,
    },

    enterStep() {
      showThickness = false;
    },

    onReset() {
      deepScatter = false;
      showThickness = false;
      scatterScale = 1.15;
      manualLight = false;
      lightAz = -2.25;
      lightEl = 0.16;
    },

    triggerAction(actionId) {
      if (actionId === "scatter") {
        deepScatter = !deepScatter;
        scatterScale = deepScatter ? 1.85 : 1.15;
      } else if (actionId === "thickness") {
        showThickness = !showThickness;
      } else if (actionId === "backlight") {
        manualLight = true;
        lightAz = (lightAz < -1.2) ? 0.55 : -2.35; // toggle Front Key <-> Backlit Ear!
        lightEl = 0.14;
      }
    },

    isActionActive(actionId) {
      if (actionId === "scatter") return deepScatter;
      if (actionId === "thickness") return showThickness;
      if (actionId === "backlight") return manualLight && lightAz < -1.2;
      return false;
    },

    // Clicking anywhere positions the studio light orb around the bust (click left/behind ear for ruby glow!)
    onCanvasClick(ndcX, ndcY) {
      manualLight = true;
      lightAz = -2.6 + (ndcX * 0.5 + 0.5) * 4.2;
      lightEl = clamp(ndcY * 0.65, -0.35, 0.65);
    },

    getTechBadge(stepIdx) {
      const mm = (scatterScale * 2.8).toFixed(1);
      const labels = [
        `1975 · PHONG PLASTIC (NO SSS)`,
        `2001 · JENSEN DIPOLE BSSRDF · ${mm} mm`,
        `2004 · WRAPPED DIFFUSE / HALF-LAMBERT`,
        `2007 · GPU GEMS 3 TEXTURE-SPACE DIFFUSION`,
        `2009 · JIMENEZ SCREEN-SPACE SSS`,
        `2011 · PENNER PRE-INTEGRATED CURVATURE LUT`,
        `2013–15 · DIGITAL IRA / SEPARABLE SSS + BURLEY`,
        `2021 · METAHUMAN-ERA RANDOM-WALK + DUAL SPEC`,
      ];
      return labels[stepIdx] || `SUBSURFACE SCATTERING · ${mm} mm`;
    },

    resize(w, h) { allocTargets(w, h); },

    update(dt, paused) {
      if (!paused) {
        simTime += dt;
        if (!manualLight) {
          // Sweep from dramatic backlit ruby ear (-2.35) -> raking 3/4 cheek terminator (-0.95)!
          lightAz = -2.28 + (0.5 - 0.5 * Math.cos(simTime * 0.62)) * 1.48;
          lightEl = 0.14 + Math.sin(simTime * 0.45) * 0.14;
        }
      }
    },

    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg || 40) * Math.PI) / 360);

      const lDist = 1.55;
      const lightPos = [
        Math.sin(lightAz) * Math.cos(lightEl) * lDist,
        0.12 + Math.sin(lightEl) * lDist,
        Math.cos(lightAz) * Math.cos(lightEl) * lDist,
      ];

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;

      // Pass 1: Raymarch sculpted bust + optical thickness + curvature -> 3 MRTs (oDiff, oSpec, oMeta)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboBase);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.useProgram(progBase);
      gl.bindVertexArray(vao);
      gl.uniform3fv(uBase.uCamPos, basis.pos);
      gl.uniform3fv(uBase.uCamRight, basis.right);
      gl.uniform3fv(uBase.uCamUp, basis.up);
      gl.uniform3fv(uBase.uCamFwd, basis.fwd);
      gl.uniform1f(uBase.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uBase.uAspect, aspect);
      gl.uniform1f(uBase.uTime, simTime);
      gl.uniform3fv(uBase.uLightPos, lightPos);
      gl.uniform1i(uBase.uStageLeft, stageLeft);
      gl.uniform1i(uBase.uStageRight, stageRight);
      gl.uniform1f(uBase.uSplitX, split.enabled ? split.pos : -1.0);
      gl.uniform1f(uBase.uScatterScale, scatterScale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 2: Jimenez Separable SSSS — Horizontal 1D Depth-Aware RGB Convolution
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboH);
      gl.useProgram(progBlur);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texDiff); gl.uniform1i(uBlur.uDiffTex, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texMeta); gl.uniform1i(uBlur.uMetaTex, 1);
      gl.uniform2f(uBlur.uDir, 1.0 / w, 0.0);
      gl.uniform1f(uBlur.uScatterScale, scatterScale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 3: Jimenez Separable SSSS — Vertical 1D Depth-Aware RGB Convolution
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboV);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texH); gl.uniform1i(uBlur.uDiffTex, 0);
      gl.uniform2f(uBlur.uDir, 0.0, 1.0 / h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 4: Composite scattered diffuse + crisp dual-lobe specular + filmic tone map
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(progComp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texV);    gl.uniform1i(uComp.uDiffBlurTex, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texSpec); gl.uniform1i(uComp.uSpecTex, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texMeta); gl.uniform1i(uComp.uMetaTex, 2);
      gl.uniform1f(uComp.uShowThickness, showThickness ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
