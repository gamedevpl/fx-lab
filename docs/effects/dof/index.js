// Evolution of Depth of Field & Bokeh (1998-2024) — Interactive 4-Pass RGBA16F HDR Optical WebGL2 Controller.
// Genuine Thin-Lens CoC, Separable Half-Res Near-Field Dilation (Crysis/UE4), 32 Real RGBA16F HDR Night Bokeh Lights,
// 6-Blade Hexagonal Aperture, Vogel Disk + Spherical Aberration Rim, Cat's-Eye Vignetting, Anamorphic LoCA & Click-to-Focus!

import { clamp, lerp, cameraBasisFromOrbit, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import { DOF_SCENE_FS, DOF_NEAR_DILATE_FS, DOF_RESOLVE_FS } from "./shaders.js";

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

export function createDofEffect(gl) {
  const hasFloat = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  gl.getExtension("OES_texture_float_linear");
  gl.getExtension("OES_texture_half_float_linear");

  const [progScene, progNear, progResolve] = linkPrograms(gl, [
    [FULL_VS, DOF_SCENE_FS],
    [FULL_VS, DOF_NEAR_DILATE_FS],
    [FULL_VS, DOF_RESOLVE_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uScene = uLoc(progScene, ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uTime", "uFocusDist", "uAperture"]);
  const uNear  = uLoc(progNear,  ["uSrcTex", "uDir", "uIsFirstPass"]);
  const uRes   = uLoc(progResolve, ["uHdrTex", "uCocTex", "uNearTex", "uStageLeft", "uStageRight", "uSplitX", "uShowCoc", "uAspect", "uFocusClickUv", "uFocusPulse"]);
  const vao = gl.createVertexArray();

  let bufW = 0, bufH = 0, halfW = 0, halfH = 0;
  let fboScene = null, texHdr = null, texCoc = null;
  let fboNearH = null, texNearH = null, fboNearV = null, texNearV = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const f of [fboScene, fboNearH, fboNearV]) if (f) gl.deleteFramebuffer(f);
    for (const t of [texHdr, texCoc, texNearH, texNearV]) if (t) gl.deleteTexture(t);
    bufW = w; bufH = h;
    halfW = Math.max(8, Math.ceil(w / 2));
    halfH = Math.max(8, Math.ceil(h / 2));

    texHdr = makeTex(gl, w, h, hasFloat);
    texCoc = makeTex(gl, w, h, hasFloat);
    fboScene = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdr, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texCoc, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texNearH = makeTex(gl, halfW, halfH, hasFloat);
    fboNearH = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboNearH);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texNearH, 0);

    texNearV = makeTex(gl, halfW, halfH, hasFloat);
    fboNearV = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboNearV);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texNearV, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0.0;
  let focusDist = 3.65;        // Default focus locked onto sharp center optical hero!
  let targetFocusDist = 3.65;
  let focusPreset = 1;         // 0 = Near Crystal (1.9m), 1 = Hero Lens (3.65m), 2 = Far Bokeh Lights (7.2m)
  let aperture = 1.4;          // Wide-open f/1.4 cinema aperture (toggleable f/1.4 <-> f/4.0!)
  let showCoc = false;
  let focusClickUv = [0.5, 0.5];
  let focusPulse = 0.0;

  return {
    id: "dof",
    maxPixels: 500000,
    defaultCamera: {
      yaw: 0.06,
      pitch: 0.08,
      dist: 3.65,
      lookY: 0.94,
      fovDeg: 42,
      minDist: 2.3,
      maxDist: 5.8,
      minPitch: -0.04,
      maxPitch: 0.55,
      autoOrbitSpeed: 0.0,
    },

    enterStep() {
      showCoc = false;
    },

    onReset() {
      focusDist = 3.65;
      targetFocusDist = 3.65;
      focusPreset = 1;
      aperture = 1.4;
      showCoc = false;
      focusPulse = 0.0;
    },

    triggerAction(actionId) {
      if (actionId === "rack") {
        focusPreset = (focusPreset + 1) % 3;
        targetFocusDist = focusPreset === 0 ? 1.92 : (focusPreset === 1 ? 3.65 : 7.40);
        focusClickUv = focusPreset === 0 ? [0.24, 0.42] : (focusPreset === 1 ? [0.50, 0.52] : [0.74, 0.66]);
        focusPulse = 1.0;
      } else if (actionId === "aperture") {
        aperture = aperture < 2.2 ? 4.0 : 1.4;
      } else if (actionId === "coc") {
        showCoc = !showCoc;
      }
    },

    isActionActive(actionId) {
      if (actionId === "aperture") return aperture < 2.2;
      if (actionId === "coc") return showCoc;
      if (actionId === "rack") return focusPreset !== 1;
      return false;
    },

    // Live Click-to-Focus (Rack Focus!) reading exact linear depth directly from our GPU CoC/Depth MRT!
    onCanvasClick(ndcX, ndcY) {
      const u = clamp(ndcX * 0.5 + 0.5, 0.02, 0.98);
      const v = clamp(ndcY * 0.5 + 0.5, 0.02, 0.98);
      focusClickUv = [u, v];
      focusPulse = 1.0;
      if (fboScene && bufW > 0 && bufH > 0) {
        const px = clamp(Math.round(u * (bufW - 1)), 0, bufW - 1);
        const py = clamp(Math.round(v * (bufH - 1)), 0, bufH - 1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        const pix = hasFloat ? new Float32Array(4) : new Uint8Array(4);
        try {
          gl.readPixels(px, py, 1, 1, gl.RGBA, hasFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, pix);
          const sampledZ = hasFloat ? pix[1] : (pix[1] / 255 * 14.0);
          if (Number.isFinite(sampledZ) && sampledZ > 0.6 && sampledZ < 13.0) {
            targetFocusDist = clamp(sampledZ, 1.65, 8.5);
          }
        } catch (_) {
          // Fallback to zone depth if float readback is restricted
          targetFocusDist = u < 0.34 ? 1.92 : (u > 0.68 ? 7.20 : 3.65);
        }
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    },

    getTechBadge(stepIdx) {
      const fStr = `f/${aperture.toFixed(1)} · ${focusDist.toFixed(1)}m`;
      const labels = [
        "1998 · PINHOLE CAMERA (NO DEPTH OF FIELD)",
        "2001 · NAIVE GAUSSIAN Z-BLUR (EDGE HALO!)",
        "2004 · GPU GEMS 1 DEPTH-AWARE GATHER",
        "2007 · CRYSIS LAYERED NEAR / FAR FIELD",
        `2011 · BF3 6-BLADE HEXAGONAL BOKEH · ${fStr}`,
        `2014 · UE4 VOGEL DISK + OPTICAL RIM · ${fStr}`,
        `2018 · CAT'S-EYE BARREL VIGNETTING · ${fStr}`,
        `2024 · ANAMORPHIC + CHROMATIC BOKEH · ${fStr}`,
      ];
      return showCoc ? `CIRCLE OF CONFUSION HEATMAP · ${fStr}` : (labels[stepIdx] || "DEPTH OF FIELD");
    },

    resize() {},

    update(dt, paused) {
      const h = Math.min(dt, 0.04);
      // Smooth cinema rack-focus motor works even when paused!
      focusDist = lerp(focusDist, targetFocusDist, Math.min(1, h * 7.5));
      focusPulse = Math.max(0, focusPulse - h * 1.45);
      if (paused) return;
      simTime += h;
    },

    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const fovRad = ((cam.fovDeg || 42) * Math.PI) / 180;
      const tanHalfFov = Math.tan(fovRad * 0.5);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY || 0.94);

      const stageL = split.enabled ? step.compareLeft : step.stage;
      const stageR = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : -1.0;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      // PASS 1: 3D HDR Optical Studio + 32 HDR Bokeh Lights -> MRT0 HDR Color + MRT1 CoC/Depth!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progScene);
      gl.uniform3fv(uScene.uCamPos, basis.pos);
      gl.uniform3fv(uScene.uCamRight, basis.right);
      gl.uniform3fv(uScene.uCamUp, basis.up);
      gl.uniform3fv(uScene.uCamFwd, basis.fwd);
      gl.uniform1f(uScene.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uScene.uAspect, aspect);
      gl.uniform1f(uScene.uTime, simTime);
      gl.uniform1f(uScene.uFocusDist, focusDist);
      gl.uniform1f(uScene.uAperture, aperture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 2: Half-Res Horizontal Near-Field CoC Dilation
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboNearH);
      gl.viewport(0, 0, halfW, halfH);
      gl.useProgram(progNear);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texCoc);
      gl.uniform1i(uNear.uSrcTex, 0);
      gl.uniform2f(uNear.uDir, 1 / halfW, 0);
      gl.uniform1i(uNear.uIsFirstPass, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 3: Half-Res Vertical Near-Field CoC Dilation
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboNearV);
      gl.viewport(0, 0, halfW, halfH);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texNearH);
      gl.uniform1i(uNear.uSrcTex, 0);
      gl.uniform2f(uNear.uDir, 0, 1 / halfH);
      gl.uniform1i(uNear.uIsFirstPass, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 4: Full Optical Bokeh Resolve + ACES Filmic Tone Mapping!
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progResolve);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHdr);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texCoc);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texNearV);
      gl.uniform1i(uRes.uHdrTex, 0);
      gl.uniform1i(uRes.uCocTex, 1);
      gl.uniform1i(uRes.uNearTex, 2);
      gl.uniform1i(uRes.uStageLeft, stageL);
      gl.uniform1i(uRes.uStageRight, stageR);
      gl.uniform1f(uRes.uSplitX, splitX);
      gl.uniform1i(uRes.uShowCoc, showCoc ? 1 : 0);
      gl.uniform1f(uRes.uAspect, aspect);
      gl.uniform2fv(uRes.uFocusClickUv, focusClickUv);
      gl.uniform1f(uRes.uFocusPulse, focusPulse);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindVertexArray(null);
    },
  };
}
