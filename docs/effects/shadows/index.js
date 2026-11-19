// Evolution of Shadows — 5-pass WebGL2 renderer (Shadow Map -> G-Buffer -> 8-Era Lighting -> Bloom -> ACES),
// interactive sun aiming, Wide Sun area-light toggle, and 88x88 Shadow Map texel grid overlay.

import {
  clamp, norm3, cross3, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import { SHADOW_MAP_FS, GBUFFER_FS, LIGHTING_FS, BLUR_FS, FINAL_FS } from "./shaders.js";

const SM_LOW = 88;
const SM_HI = 320;

// Default golden-hour sun shining nearly straight through the Gothic stained-glass arch!
const DEFAULT_AZ = -2.38; // aligns straight through ARCH_YAW=0.72 onto the center courtyard & step
const DEFAULT_EL = 0.50;  // ~29 degrees elevation -> bold stained-glass carpet + astrolabe shadows

function sunDirFromAngles(az, el) {
  const c = Math.cos(el);
  return norm3(Math.cos(az) * c, Math.sin(el), Math.sin(az) * c);
}

function sunBasis(lightDir) {
  const fwd = [-lightDir[0], -lightDir[1], -lightDir[2]];
  const right = norm3(...cross3(fwd, [0, 1, 0]));
  const up = cross3(right, fwd);
  return { right, up };
}

export function createShadowsEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progShadow, progGbuf, progLight, progBlur, progFinal] = linkPrograms(gl, [
    [FULL_VS, SHADOW_MAP_FS],
    [FULL_VS, GBUFFER_FS],
    [FULL_VS, LIGHTING_FS],
    [FULL_VS, BLUR_FS],
    [FULL_VS, FINAL_FS],
  ]);
  const vaoFull = gl.createVertexArray();

  // Persistent orthographic shadow-map targets (88x88 low-res for 2004, 320x320 hi-res for PCF/PCSS).
  const texShadowLow = makeTex2D(gl, SM_LOW, SM_LOW, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
  const fboShadowLow = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboShadowLow);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texShadowLow, 0);

  const texShadowHi = makeTex2D(gl, SM_HI, SM_HI, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
  const fboShadowHi = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboShadowHi);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texShadowHi, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  let bufW = 0, bufH = 0, bw = 0, bh = 0;
  let texAlbedoMat = null, texDepthNorm = null, fboGbuf = null;
  let texHdr = null, texBloom = null, fboLight = null;
  let texBlurA = null, texBlurB = null, fboBlurA = null, fboBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texAlbedoMat, texDepthNorm, texHdr, texBloom, texBlurA, texBlurB]) {
      if (t) gl.deleteTexture(t);
    }
    for (const f of [fboGbuf, fboLight, fboBlurA, fboBlurB]) {
      if (f) gl.deleteFramebuffer(f);
    }
    bufW = w; bufH = h;
    bw = Math.max(64, w >> 2);
    bh = Math.max(64, h >> 2);

    texAlbedoMat = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    texDepthNorm = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    fboGbuf = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboGbuf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texAlbedoMat, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texDepthNorm, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texHdr = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBloom = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboLight = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboLight);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdr, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texBloom, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texBlurA = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBlurB = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboBlurA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurA, 0);
    fboBlurB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurB, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0;
  let texelGridOn = false;
  let wideSunOn = false;
  let sunRadiusCur = 0.072;
  let sunAzCur = DEFAULT_AZ, sunAzTarget = DEFAULT_AZ;
  let sunElCur = DEFAULT_EL, sunElTarget = DEFAULT_EL;
  let sweepT = -1.0;

  function renderShadowPass(fbo, size, lightDir, basis) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, size, size);
    gl.useProgram(progShadow);
    gl.uniform3fv(gl.getUniformLocation(progShadow, "uLightDir"), lightDir);
    gl.uniform3fv(gl.getUniformLocation(progShadow, "uLightRight"), basis.right);
    gl.uniform3fv(gl.getUniformLocation(progShadow, "uLightUp"), basis.up);
    gl.uniform1f(gl.getUniformLocation(progShadow, "uTime"), simTime);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return {
    id: "shadows",
    maxPixels: 950000,
    defaultCamera: {
      yaw: 0.34,
      pitch: 0.44,
      dist: 7.7,
      lookY: 0.56,
      fovDeg: 38,
      minDist: 4.2,
      maxDist: 13.5,
      minPitch: 0.08,
      maxPitch: 1.25,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 3) texelGridOn = false;
      if (stepIdx === 7) sweepT = 0.0;
    },
    onReset() {
      sunAzTarget = DEFAULT_AZ;
      sunElTarget = DEFAULT_EL;
      sweepT = -1.0;
    },
    triggerAction(actionId) {
      if (actionId === "grid") texelGridOn = !texelGridOn;
      else if (actionId === "wide") wideSunOn = !wideSunOn;
      else if (actionId === "sweep") {
        sweepT = 0.0;
        sunAzTarget = DEFAULT_AZ;
        sunElTarget = DEFAULT_EL;
      }
    },
    isActionActive(actionId) {
      if (actionId === "grid") return texelGridOn;
      if (actionId === "wide") return wideSunOn;
      if (actionId === "sweep") return sweepT >= 0.0 && sweepT < 5.5;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      // Intersect camera ray with the courtyard plane y = 0 and aim the sun opposite the clicked spot
      // so the cast shadows glide toward where the user clicked!
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const rx = basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0];
      const ry = basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1];
      const rz = basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2];
      if (ry >= -0.04) return false;

      const t = -basis.pos[1] / ry;
      if (t <= 0) return false;
      const wx = basis.pos[0] + rx * t;
      const wz = basis.pos[2] + rz * t;
      const r = Math.hypot(wx, wz);
      if (r > 2.65) return false;

      // Cast shadow from center toward clicked point => sun sits on the opposite side.
      sweepT = -1.0;
      sunAzTarget = Math.atan2(-wz, -wx);
      sunElTarget = clamp(0.88 - r * 0.16, 0.34, 0.96);
      return true;
    },
    update(dt, paused) {
      if (paused) return;
      simTime += dt;
      if (sweepT >= 0.0) {
        sweepT += dt;
        if (sweepT > 5.5) sweepT = -1.0;
      }

      const targetRadius = wideSunOn ? 0.145 : 0.070;
      sunRadiusCur += (targetRadius - sunRadiusCur) * Math.min(1, dt * 7.5);

      // Wrap shortest angular distance for smooth sun azimuth gliding.
      let dAz = sunAzTarget - sunAzCur;
      while (dAz > Math.PI) dAz -= Math.PI * 2;
      while (dAz < -Math.PI) dAz += Math.PI * 2;
      sunAzCur += dAz * Math.min(1, dt * 6.0);
      sunElCur += (sunElTarget - sunElCur) * Math.min(1, dt * 6.0);
    },
    getTechBadge(stepIdx) {
      const tags = [
        "1988 · GROUND DISC",
        "1996 · Y=0 PROJECTION",
        "2000 · STENCIL VOLUMES",
        "2004 · 88×88 DEPTH MAP",
        "2008 · 16-TAP PCF",
        "2012 · PCSS CONTACT",
        "2018 · RT AREA + AO",
        "2026 · GLASS GI · CLICK FLOOR",
      ];
      return tags[stepIdx] || "";
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const wipeX = split.enabled ? split.pos : 0.0;

      // Subtle sun sweep arc during Step 8 Sweep Sun action (returns smoothly to hero angle).
      let az = sunAzCur;
      let el = sunElCur;
      let lightRad = sunRadiusCur;
      if (sweepT >= 0.0) {
        const p = sweepT / 5.5;
        const env = Math.sin(p * Math.PI);
        az += Math.sin(p * Math.PI * 2.0) * 0.42 * env;
        el += Math.sin(p * Math.PI) * 0.14 - 0.08 * Math.sin(p * Math.PI * 2.0);
        if (!wideSunOn) lightRad = 0.068 + 0.055 * Math.pow(Math.sin(p * Math.PI), 2.0);
      }

      const lightDir = sunDirFromAngles(az, el);
      const lBasis = sunBasis(lightDir);

      gl.bindVertexArray(vaoFull);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // Pass 1: Render orthographic shadow maps only when active stages need them!
      if (stageLeft === 3 || stageRight === 3) {
        renderShadowPass(fboShadowLow, SM_LOW, lightDir, lBasis);
      }
      if (stageLeft === 4 || stageRight === 4 || stageLeft === 5 || stageRight === 5) {
        renderShadowPass(fboShadowHi, SM_HI, lightDir, lBasis);
      }

      // Pass 2: Camera SDF G-buffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboGbuf);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progGbuf);
      gl.uniform3fv(gl.getUniformLocation(progGbuf, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progGbuf, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progGbuf, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progGbuf, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progGbuf, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progGbuf, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progGbuf, "uTime"), simTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 3: 8-era deferred shadow & lighting pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboLight);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progLight);
      const binds = [
        ["uTexAlbedoMat", texAlbedoMat],
        ["uTexDepthNorm", texDepthNorm],
        ["uTexShadowLow", texShadowLow],
        ["uTexShadowHi", texShadowHi],
      ];
      for (let i = 0; i < binds.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, binds[i][1]);
        gl.uniform1i(gl.getUniformLocation(progLight, binds[i][0]), i);
      }
      gl.uniform3fv(gl.getUniformLocation(progLight, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progLight, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progLight, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progLight, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progLight, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progLight, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progLight, "uTime"), simTime);
      gl.uniform3fv(gl.getUniformLocation(progLight, "uLightDir"), lightDir);
      gl.uniform3fv(gl.getUniformLocation(progLight, "uLightRight"), lBasis.right);
      gl.uniform3fv(gl.getUniformLocation(progLight, "uLightUp"), lBasis.up);
      gl.uniform1f(gl.getUniformLocation(progLight, "uLightRadius"), lightRad);
      gl.uniform1f(gl.getUniformLocation(progLight, "uShowTexelGrid"), texelGridOn ? 1.0 : 0.0);
      gl.uniform1i(gl.getUniformLocation(progLight, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progLight, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progLight, "uWipeX"), wipeX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 4: Separable Gaussian HDR bloom (Steps 7-8)
      if (stageLeft >= 6 || stageRight >= 6) {
        gl.useProgram(progBlur);
        gl.viewport(0, 0, bw, bh);
        const uDir = gl.getUniformLocation(progBlur, "uDir");
        gl.uniform1i(gl.getUniformLocation(progBlur, "uTex"), 0);
        gl.activeTexture(gl.TEXTURE0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texBloom);
        gl.uniform2f(uDir, 1.0 / bw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texBlurA);
        gl.uniform2f(uDir, 0.0, 1.0 / bh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texBlurB);
        gl.uniform2f(uDir, 2.0 / bw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texBlurA);
        gl.uniform2f(uDir, 0.0, 2.0 / bh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Pass 5: ACES filmic tone map -> screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texHdr);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uTexHdr"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texBlurB);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uTexBloom"), 1);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progFinal, "uWipeX"), wipeX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
