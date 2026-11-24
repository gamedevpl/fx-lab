// FX Lab #29: HD-2D Miniature Diorama (8 Steps) — Real-Time WebGL2 Controller
// Authentic 3D pixel-art dungeon courtyard with nearest-neighbor diffuse & normal maps,
// directional shadow map, 12 flickering HDR point lights, low-res 3D (or 2D sprite) duelists,
// separable RGBA16F HDR bloom, drifting foreground mist, and 1904 Scheimpflug Tilt-Shift DoF!

import {
  clamp, lerp, cameraBasisFromOrbit, makeLookAt, makePerspective,
  FULL_VS, linkPrograms, hdrFormat,
} from "../../src/gl-utils.js";
import { createHd2dTextures } from "./textures.js";
import { VERT_FLOATS, buildStaticDungeon, buildDynamicFrame } from "./scene.js";
import {
  SHADOW_VS, SHADOW_FS, SCENE_VS, SCENE_FS,
  BILLBOARD_VS, BILLBOARD_FS, BLOOM_FS, COMPOSITE_FS,
} from "./shaders.js";

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

function makeOrtho(l, r, b, t, n, f) {
  const rl = 1 / (r - l), tb = 1 / (t - b), fn = 1 / (f - n);
  return new Float32Array([
    2 * rl, 0, 0, 0,
    0, 2 * tb, 0, 0,
    0, 0, -2 * fn, 0,
    -(r + l) * rl, -(t + b) * tb, -(f + n) * fn, 1,
  ]);
}

function makeRenderTex(gl, w, h, internalFmt, fmt, type, filter = gl.LINEAR) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function setupMeshVao(gl, vbo, ibo) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  const stride = VERT_FLOATS * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 36);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 44);
  gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 3, gl.FLOAT, false, stride, 48);
  gl.bindVertexArray(null);
  return vao;
}

// Reusable low-level WebGL2 renderer shared by FX Lab AND the 9:16 / 16:9 Short film scenes!
export function createHd2dRenderer(gl) {
  const hdr = hdrFormat(gl);
  const [progShadow, progScene, progBill, progBloom, progComp] = linkPrograms(gl, [
    [SHADOW_VS, SHADOW_FS],
    [SCENE_VS, SCENE_FS],
    [BILLBOARD_VS, BILLBOARD_FS],
    [FULL_VS, BLOOM_FS],
    [FULL_VS, COMPOSITE_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uSh = uLoc(progShadow, ["uLightVP"]);
  const uSc = uLoc(progScene, [
    "uViewProj", "uView", "uLightVP", "uTorchVP", "uAlbedoArr", "uNormRoughArr", "uShadowMap", "uTorchShadowMap",
    "uCamPos", "uTime", "uStage", "uNormalOn", "uCoolAmbient", "uLightPosRad", "uLightColInt",
  ]);
  const uBl = uLoc(progBill, ["uViewProj", "uView", "uCamRight", "uCamUp", "uSprites", "uStage"]);
  const uBm = uLoc(progBloom, ["uSrc", "uDir", "uExtract"]);
  const uCp = uLoc(progComp, [
    "uHdrL", "uDepthL", "uBloomL", "uHdrR", "uDepthR", "uBloomR",
    "uRes", "uTime", "uSplitX", "uStageL", "uStageR", "uDualBuf",
    "uFocusY", "uTiltAngle", "uTiltShiftOn", "uFrontMistOn", "uShowFocusMap",
    "uClickUv", "uClickPulse",
  ]);

  const textures = createHd2dTextures(gl);
  const staticGeo = buildStaticDungeon();

  // Static main dungeon VBO/IBO/VAO
  const vboMain = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboMain);
  gl.bufferData(gl.ARRAY_BUFFER, staticGeo.main.verts, gl.STATIC_DRAW);
  const iboMain = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, iboMain);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, staticGeo.main.indices, gl.STATIC_DRAW);
  const vaoMain = setupMeshVao(gl, vboMain, iboMain);
  const mainCount = staticGeo.main.indices.length;

  // Optional Step-1 roof overhang VBO/IBO/VAO
  const vboRoof = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboRoof);
  gl.bufferData(gl.ARRAY_BUFFER, staticGeo.roof.verts, gl.STATIC_DRAW);
  const iboRoof = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, iboRoof);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, staticGeo.roof.indices, gl.STATIC_DRAW);
  const vaoRoof = setupMeshVao(gl, vboRoof, iboRoof);
  const roofCount = staticGeo.roof.indices.length;

  // Dynamic character VBO/IBO/VAO
  const vboChar = gl.createBuffer();
  const iboChar = gl.createBuffer();
  const vaoChar = setupMeshVao(gl, vboChar, iboChar);

  // Instanced billboard VAO (flames, arcane orb, golden sparks & optional 2D sprites)
  const vaoBill = gl.createVertexArray();
  gl.bindVertexArray(vaoBill);
  const vboQuad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboQuad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const vboInst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboInst);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);

  const vaoFull = gl.createVertexArray();

  // Dual 1024x1024 Shadow Maps:
  // 1) Orthographic Moonlight Shadow Map (high front-right, NEVER blocked by back L-wall!)
  // 2) Perspective Primary Courtyard Torch Shadow Map (from inner duel corner sconce casting dramatic moving shadows!)
  const SHADOW_RES = 1024;
  function makeShadowFbo() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_RES, SHADOW_RES, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }
  const shMoon = makeShadowFbo();
  const shTorch = makeShadowFbo();

  // Moonlight directional VP (front-upper-right grazing across bridge, crates & fighters toward back-left!)
  const lightView = makeLookAt([9.2, 13.8, 8.2], [-0.4, 0.3, -0.4], [0, 1, 0]);
  const lightProj = makeOrtho(-10.5, 10.5, -10.5, 10.5, 2.0, 32.0);
  const lightVP = mulMat4(lightProj, lightView);

  // Primary Duel Corner Torch Perspective VP (positioned at corner torch, casting crisp dramatic shadows out onto flagstones!)
  const torchView = makeLookAt([0.72, 2.25, -0.96], [-0.45, 0.05, 1.45], [0, 1, 0]);
  const torchProj = makePerspective((120 * Math.PI) / 180, 1.0, 0.40, 15.0);
  const torchVP = mulMat4(torchProj, torchView);

  // Render target slots (L and optional R for true dual-stage Split-Screen!)
  let curW = 0, curH = 0, halfW = 0, halfH = 0;
  function makeSlot(w, h) {
    const hw = Math.max(8, Math.ceil(w / 2));
    const hh = Math.max(8, Math.ceil(h / 2));
    const texHdr = makeRenderTex(gl, w, h, hdr.internalFmt, hdr.fmt, hdr.type, gl.LINEAR);
    const texDepth = makeRenderTex(gl, w, h, hdr.internalFmt, hdr.fmt, hdr.type, gl.NEAREST);
    const rboDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rboDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    const fboScene = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdr, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texDepth, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rboDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    const texBloomA = makeRenderTex(gl, hw, hh, hdr.internalFmt, hdr.fmt, hdr.type, gl.LINEAR);
    const fboBloomA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBloomA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBloomA, 0);

    const texBloomB = makeRenderTex(gl, hw, hh, hdr.internalFmt, hdr.fmt, hdr.type, gl.LINEAR);
    const fboBloomB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBloomB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBloomB, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fboScene, texHdr, texDepth, rboDepth, fboBloomA, texBloomA, fboBloomB, texBloomB };
  }

  function freeSlot(s) {
    if (!s) return;
    gl.deleteFramebuffer(s.fboScene);
    gl.deleteFramebuffer(s.fboBloomA);
    gl.deleteFramebuffer(s.fboBloomB);
    gl.deleteRenderbuffer(s.rboDepth);
    gl.deleteTexture(s.texHdr);
    gl.deleteTexture(s.texDepth);
    gl.deleteTexture(s.texBloomA);
    gl.deleteTexture(s.texBloomB);
  }

  let slotL = null, slotR = null;
  function ensureTargets(w, h) {
    if (w === curW && h === curH && slotL && slotR) return;
    freeSlot(slotL); freeSlot(slotR);
    curW = w; curH = h;
    halfW = Math.max(8, Math.ceil(w / 2));
    halfH = Math.max(8, Math.ceil(h / 2));
    slotL = makeSlot(w, h);
    slotR = makeSlot(w, h);
  }

  const lightPosArr = new Float32Array(12 * 4);
  const lightColArr = new Float32Array(12 * 4);

  function renderStageIntoSlot(slot, stage, w, h, cam, opts, dyn, charCount) {
    const aspect = w / Math.max(1, h);
    // Stage 0 (Pass 1) OR Step-2 toggle: wide 50-degree perspective camera (pulled closer so courtyard fills frame)
    const isWideFov = (stage === 0) || (stage === 1 && opts.wideCamStep2);
    const baseFov = cam.fovDeg || 24;
    const fovDeg = isWideFov ? 50 : baseFov;
    const fovRad = (fovDeg * Math.PI) / 180;
    const baseRad = (baseFov * Math.PI) / 180;
    // Preserve framing scale at the duel center when toggling FOV so the depth-compression effect is dramatic!
    const distScale = isWideFov ? (Math.tan(baseRad * 0.5) / Math.tan(fovRad * 0.5)) : 1.0;
    const dist = cam.dist * distScale;

    const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, dist, cam.lookY ?? 0.68);
    const view = makeLookAt(basis.pos, basis.target, [0, 1, 0]);
    const proj = makePerspective(fovRad, aspect, 0.5, 70.0);
    const viewProj = mulMat4(proj, view);

    // Draw scene geometry into MRT FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fboScene);
    gl.viewport(0, 0, w, h);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    const bg = (stage <= 1) ? [0.12, 0.14, 0.19, 1.0]
             : (stage === 2 ? [0.06, 0.08, 0.12, 1.0]
             : (opts.coolAmbient ? [0.015, 0.028, 0.068, 1.0] : [0.02, 0.02, 0.025, 1.0]));
    gl.clearBufferfv(gl.COLOR, 0, bg);
    gl.clearBufferfv(gl.COLOR, 1, [32.0, 0.0, 0.0, 1.0]);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    gl.useProgram(progScene);
    gl.uniformMatrix4fv(uSc.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(uSc.uView, false, view);
    gl.uniformMatrix4fv(uSc.uLightVP, false, lightVP);
    gl.uniformMatrix4fv(uSc.uTorchVP, false, torchVP);
    gl.uniform3fv(uSc.uCamPos, basis.pos);
    gl.uniform1f(uSc.uTime, opts.time);
    gl.uniform1i(uSc.uStage, stage);
    gl.uniform1i(uSc.uNormalOn, opts.normalOn ? 1 : 0);
    gl.uniform1i(uSc.uCoolAmbient, opts.coolAmbient ? 1 : 0);
    gl.uniform4fv(uSc.uLightPosRad, lightPosArr);
    gl.uniform4fv(uSc.uLightColInt, lightColArr);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, textures.texAlbedo);
    gl.uniform1i(uSc.uAlbedoArr, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, textures.texNormRough);
    gl.uniform1i(uSc.uNormRoughArr, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, shMoon.tex);
    gl.uniform1i(uSc.uShadowMap, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, shTorch.tex);
    gl.uniform1i(uSc.uTorchShadowMap, 3);

    // 1. Static dungeon courtyard
    gl.bindVertexArray(vaoMain);
    gl.drawElements(gl.TRIANGLES, mainCount, gl.UNSIGNED_INT, 0);

    // 2. Step 1 roof rafters (sliced off cleanly starting at Step 2!)
    if (stage === 0) {
      gl.bindVertexArray(vaoRoof);
      gl.drawElements(gl.TRIANGLES, roofCount, gl.UNSIGNED_INT, 0);
    }

    // 3. Animated Blender-sculpted fighting characters + HP bar (Step 5+, i.e. stage >= 4!)
    if (stage >= 4 && charCount > 0) {
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(vaoChar);
      gl.drawElements(gl.TRIANGLES, charCount, gl.UNSIGNED_INT, 0);
      gl.enable(gl.CULL_FACE);
    }

    // 4. Emissive HDR flames, arcane crystal halo, golden sparks & optional 2D character sprites!
    gl.disable(gl.CULL_FACE);
    if (stage >= 3 && dyn.fxCount > 0) {
      gl.useProgram(progBill);
      gl.uniformMatrix4fv(uBl.uViewProj, false, viewProj);
      gl.uniformMatrix4fv(uBl.uView, false, view);
      gl.uniform3fv(uBl.uCamRight, basis.right);
      gl.uniform3fv(uBl.uCamUp, basis.up);
      gl.uniform1i(uBl.uStage, stage);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, textures.texSprites);
      gl.uniform1i(uBl.uSprites, 0);
      gl.bindVertexArray(vaoBill);

      // Separate opaque 2D sprites (last 2 instances when use2dSprites) vs additive HDR flames/sparks!
      const spriteCount = (stage >= 4 && opts.use2dSprites) ? 2 : 0;
      const fxTotal = dyn.fxCount;
      // On stage 3 (Pass 4, before Step 5 characters/sparks), draw only the 12 static torch/brazier/orb flames!
      const glowCount = (stage === 3) ? 12 : (fxTotal - spriteCount);

      if (spriteCount > 0) {
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.bindBuffer(gl.ARRAY_BUFFER, vboInst);
        gl.bufferData(gl.ARRAY_BUFFER, dyn.fx.subarray((fxTotal - spriteCount) * 8), gl.DYNAMIC_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, spriteCount);
      }

      // Additive HDR flames & golden sparks — write ONLY to COLOR_ATTACHMENT0 so Z depth stays clean!
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboInst);
      gl.bufferData(gl.ARRAY_BUFFER, dyn.fx.subarray(0, glowCount * 8), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glowCount);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    }

    // 5. Separable Half-Res HDR Bloom (needed when stage >= 5)
    if (stage >= 5) {
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(vaoFull);
      gl.useProgram(progBloom);

      // Extract bright HDR highlights (> 0.75) -> BloomA
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fboBloomA);
      gl.viewport(0, 0, halfW, halfH);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.texHdr);
      gl.uniform1i(uBm.uSrc, 0);
      gl.uniform2f(uBm.uDir, 1 / w, 1 / h);
      gl.uniform1i(uBm.uExtract, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Horizontal Gaussian -> BloomB
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fboBloomB);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.texBloomA);
      gl.uniform2f(uBm.uDir, 1.4 / halfW, 0);
      gl.uniform1i(uBm.uExtract, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Vertical Gaussian -> BloomA (2nd wide pass for lush cinema torch halation!)
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fboBloomA);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.texBloomB);
      gl.uniform2f(uBm.uDir, 0, 1.4 / halfH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Second broader soft halo pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fboBloomB);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.texBloomA);
      gl.uniform2f(uBm.uDir, 2.6 / halfW, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fboBloomA);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.texBloomB);
      gl.uniform2f(uBm.uDir, 0, 2.6 / halfH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  return {
    renderFrame(w, h, cam, stageL, stageR, splitX, opts) {
      ensureTargets(w, h);
      const dyn = buildDynamicFrame(opts.time, opts.burstPhase || 0, !!opts.use2dSprites);
      for (let i = 0; i < 12; i++) {
        const L = dyn.lights[i];
        lightPosArr[i * 4 + 0] = L[0];
        lightPosArr[i * 4 + 1] = L[1];
        lightPosArr[i * 4 + 2] = L[2];
        lightPosArr[i * 4 + 3] = L[3];
        lightColArr[i * 4 + 0] = L[4];
        lightColArr[i * 4 + 1] = L[5];
        lightColArr[i * 4 + 2] = L[6];
        lightColArr[i * 4 + 3] = L[7];
      }

      // Upload dynamic fighters VBO/IBO
      gl.bindBuffer(gl.ARRAY_BUFFER, vboChar);
      gl.bufferData(gl.ARRAY_BUFFER, dyn.chars.verts, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, iboChar);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, dyn.chars.indices, gl.DYNAMIC_DRAW);
      const charCount = dyn.chars.indices.length;

      // Dual Shadow Map Passes (Moonlight Ortho + Primary Courtyard Torch Perspective!)
      const maxStage = Math.max(stageL, splitX > 0 ? stageR : stageL);
      if (maxStage >= 3) {
        gl.viewport(0, 0, SHADOW_RES, SHADOW_RES);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.useProgram(progShadow);

        for (const [fbo, vp] of [[shMoon.fbo, lightVP], [shTorch.fbo, torchVP]]) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.uniformMatrix4fv(uSh.uLightVP, false, vp);
          // Back-face culling off during shadow pass so thin shields, capes & hooded cowls cast crisp solid shadows!
          gl.disable(gl.CULL_FACE);
          gl.bindVertexArray(vaoMain);
          gl.drawElements(gl.TRIANGLES, mainCount, gl.UNSIGNED_INT, 0);
          if (maxStage >= 4 && charCount > 0) {
            gl.bindVertexArray(vaoChar);
            gl.drawElements(gl.TRIANGLES, charCount, gl.UNSIGNED_INT, 0);
          }
        }
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
      }

      // Determine whether L and R need separate 3D scene passes (only when scene-level features differ!)
      const sceneBucket = s => (s <= 4 ? s : 5);
      const needDual = (splitX > 0.0 && splitX < 1.0) && (sceneBucket(stageL) !== sceneBucket(stageR));

      renderStageIntoSlot(slotL, stageL, w, h, cam, opts, dyn, charCount);
      if (needDual) {
        renderStageIntoSlot(slotR, stageR, w, h, cam, opts, dyn, charCount);
      }

      // Final Fullscreen Composite: Foreground Mist + 1904 Scheimpflug Tilt-Shift DoF + ACES Grade + Split
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);

      gl.useProgram(progComp);
      gl.bindVertexArray(vaoFull);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slotL.texHdr);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, slotL.texDepth);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, slotL.texBloomA);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, needDual ? slotR.texHdr : slotL.texHdr);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, needDual ? slotR.texDepth : slotL.texDepth);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, needDual ? slotR.texBloomA : slotL.texBloomA);

      gl.uniform1i(uCp.uHdrL, 0);
      gl.uniform1i(uCp.uDepthL, 1);
      gl.uniform1i(uCp.uBloomL, 2);
      gl.uniform1i(uCp.uHdrR, 3);
      gl.uniform1i(uCp.uDepthR, 4);
      gl.uniform1i(uCp.uBloomR, 5);

      gl.uniform2f(uCp.uRes, w, h);
      gl.uniform1f(uCp.uTime, opts.time);
      gl.uniform1f(uCp.uSplitX, splitX);
      gl.uniform1i(uCp.uStageL, stageL);
      gl.uniform1i(uCp.uStageR, stageR);
      gl.uniform1i(uCp.uDualBuf, needDual ? 1 : 0);
      gl.uniform1f(uCp.uFocusY, opts.focusY ?? 0.50);
      gl.uniform1f(uCp.uTiltAngle, opts.tiltAngle ?? 0.16);
      gl.uniform1i(uCp.uTiltShiftOn, opts.tiltShiftOn ? 1 : 0);
      gl.uniform1i(uCp.uFrontMistOn, opts.frontMistOn ? 1 : 0);
      gl.uniform1i(uCp.uShowFocusMap, opts.showFocusMap ? 1 : 0);
      gl.uniform2fv(uCp.uClickUv, opts.clickUv || [0.5, 0.5]);
      gl.uniform1f(uCp.uClickPulse, opts.clickPulse || 0.0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}

export function createHd2dEffect(gl) {
  const core = createHd2dRenderer(gl);

  let simTime = 0.0;
  let burstPhase = 0.0;
  let focusY = 0.51;
  let targetFocusY = 0.51;
  let tiltAngle = 0.22;
  let wideCamStep2 = false;
  let normalOn = true;
  let coolAmbient = true;
  let use2dSprites = false;
  let frontMistOn = true;
  let showFocusMap = false;
  let tiltShiftOn = true;
  let clickUv = [0.5, 0.5];
  let clickPulse = 0.0;

  const api = {
    id: "hd2d",
    maxPixels: 720000,
    defaultCamera: {
      yaw: -0.66,
      pitch: 0.64,
      dist: 17.5,
      lookY: 0.72,
      fovDeg: 24,
      minDist: 10.5,
      maxDist: 25.0,
      minPitch: 0.28,
      maxPitch: 0.96,
      autoOrbitSpeed: 0.0,
    },

    enterStep(stepIdx) {
      if (stepIdx !== 6) showFocusMap = false;
      if (stepIdx !== 1) wideCamStep2 = false;
    },

    onReset() {
      targetFocusY = 0.51;
      focusY = 0.51;
      tiltAngle = 0.22;
      wideCamStep2 = false;
      normalOn = true;
      coolAmbient = true;
      use2dSprites = false;
      frontMistOn = true;
      showFocusMap = false;
      tiltShiftOn = true;
      clickPulse = 0.0;
      burstPhase = 0.0;
    },

    triggerAction(actionId) {
      if (actionId === "wideCam") wideCamStep2 = !wideCamStep2;
      else if (actionId === "normals") normalOn = !normalOn;
      else if (actionId === "coolAmb") coolAmbient = !coolAmbient;
      else if (actionId === "sprites") use2dSprites = !use2dSprites;
      else if (actionId === "frontMist") frontMistOn = !frontMistOn;
      else if (actionId === "focusMap") showFocusMap = !showFocusMap;
      else if (actionId === "tiltShift") tiltShiftOn = !tiltShiftOn;
    },

    isActionActive(actionId) {
      if (actionId === "wideCam") return wideCamStep2;
      if (actionId === "normals") return normalOn;
      if (actionId === "coolAmb") return coolAmbient;
      if (actionId === "sprites") return use2dSprites;
      if (actionId === "frontMist") return frontMistOn;
      if (actionId === "focusMap") return showFocusMap;
      if (actionId === "tiltShift") return tiltShiftOn;
      return false;
    },

    // Clicking anywhere shifts the Scheimpflug Tilt-Shift focal strip to that spot & triggers a golden spell burst!
    onCanvasClick(ndcX, ndcY) {
      const u = clamp(ndcX * 0.5 + 0.5, 0.05, 0.95);
      const v = clamp(ndcY * 0.5 + 0.5, 0.14, 0.86);
      clickUv = [u, v];
      clickPulse = 1.0;
      targetFocusY = clamp(v - tiltAngle * (u - 0.5), 0.18, 0.82);
      burstPhase = 1.0;
    },

    getTechBadge(stepIdx) {
      const labels = [
        "PASS 1 · RAW NEAREST-NEIGHBOR PIXEL 3D (50° FOV)",
        `PASS 2 · CUTAWAY WALLS + ${wideCamStep2 ? "WIDE 50°" : "DIORAMA 24° TELEPHOTO"}`,
        `PASS 3 · PIXEL-ART NORMAL MAPS (${normalOn ? "ON" : "OFF"})`,
        `PASS 4 · 12 HDR TORCHES + ${coolAmbient ? "COOL BLUE AMBIENT" : "FLAT AMBIENT"}`,
        `PASS 5 · ${use2dSprites ? "2D BILLBOARD SPRITES (OCTOPATH)" : "LOW-RES 3D FIGHTERS"} + SPARKS`,
        `PASS 6 · RGBA16F BLOOM + FRONT MIST (${frontMistOn ? "ON" : "OFF"})`,
        showFocusMap ? "SCHEIMPFLUG 1904 FOCAL BAND (CYAN NEAR · GREEN SHARP · GOLD FAR)" : "PASS 7 · 1904 SCHEIMPFLUG TILT-SHIFT DOF",
        `PASS 8 · FULL HD-2D DIORAMA · TILT-SHIFT ${tiltShiftOn ? "ON" : "OFF"}`,
      ];
      return labels[stepIdx] || "HD-2D DIORAMA";
    },

    resize() {},

    update(dt, paused) {
      const h = Math.min(dt, 0.04);
      focusY = lerp(focusY, targetFocusY, Math.min(1, h * 7.5));
      clickPulse = Math.max(0, clickPulse - h * 1.4);
      burstPhase = Math.max(0, burstPhase - h * 1.3);
      if (paused) return;
      simTime += h;
    },

    render(w, h, step, split, cam) {
      const stageL = split.enabled ? step.compareLeft : step.stage;
      const stageR = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : -1.0;
      core.renderFrame(w, h, cam, stageL, stageR, splitX, {
        time: simTime,
        burstPhase,
        focusY,
        tiltAngle,
        wideCamStep2,
        normalOn,
        coolAmbient,
        use2dSprites,
        frontMistOn,
        showFocusMap,
        tiltShiftOn,
        clickUv,
        clickPulse,
      });
    },
  };

  // Expose deterministic hook for FX Lab OG-card & capture tooling (mirrors window.__fxAscii)
  window.__fxHd2d = {
    setSimTime(t) { simTime = t; },
    setParams(p = {}) {
      if ("focusY" in p) { focusY = p.focusY; targetFocusY = p.focusY; }
      if ("tiltAngle" in p) tiltAngle = p.tiltAngle;
      if ("normalOn" in p) normalOn = !!p.normalOn;
      if ("coolAmbient" in p) coolAmbient = !!p.coolAmbient;
      if ("use2dSprites" in p) use2dSprites = !!p.use2dSprites;
      if ("frontMistOn" in p) frontMistOn = !!p.frontMistOn;
      if ("showFocusMap" in p) showFocusMap = !!p.showFocusMap;
      if ("tiltShiftOn" in p) tiltShiftOn = !!p.tiltShiftOn;
      if ("burstPhase" in p) burstPhase = p.burstPhase;
    },
  };

  return api;
}
