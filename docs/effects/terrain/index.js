// Evolution of Terrain & Level of Detail (1992-2024) — Watertight GPU Alpine Terrain Controller.
//   0: 1992      Comanche Voxel Space (NovaLogic vertical heightmap column strips, 0 polygons)
//   1: 1996-97   Lindstrom CLOD & ROAM (Watertight forced-split diamond binary triangle tree!)
//   2: 2000      GeoMipMapping (Willem de Boer — fixed quadtree exposing T-junction cracks & pop-in!)
//   3: 2002      Chunked LOD with Skirts (Thatcher Ulrich, SIGGRAPH 2002 — vertical skirts seal cracks!)
//   4: 2004-05   Geometry Clipmaps (Losasso & Hoppe, SIGGRAPH '04 — concentric nested GPU grid rings!)
//   5: 2009-10   CDLOD Geomorphing (Filip Strugar '09) & H.A.W.X 2 DX11 Tessellation ('10, emulated)
//   6: 2011-12   Battlefield 3 Virtual Terrain Texturing (Frostbite 2, GDC 2012)
//   7: 2021-24   UE5 Nanite Cluster LOD (UE5 '21 -> Nanite Landscape UE 5.3+ '23, emulated meshlets)

import { clamp, norm3, cross3, makeLookAt, makePerspective, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import {
  loadAlpineHeightmap, buildGridPatchGeometry, buildClipmapRingGeometry,
  selectQuadtreePatches, createWatertightROAM,
} from "./lod.js";
import { SKY_FS, VOXEL_FS, TERRAIN_VS, TERRAIN_FS, FRUSTUM_VS, FRUSTUM_FS } from "./shaders.js";

function mulMat4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c*4 + r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
    }
  }
  return o;
}

function makePatchVao(gl, geom) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, geom.data, gl.STATIC_DRAW);
  const stride = 6 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 20);
  gl.bindVertexArray(null);
  return { vao, vertCount: geom.vertCount, N: geom.N || geom.M };
}

export async function createTerrainEffect(gl) {
  const baseUrl = new URL("./", import.meta.url).href;
  const hmap = await loadAlpineHeightmap(baseUrl);

  // Upload 384x384 RGBA8 alpine-height.png with GL_NEAREST (exact 16-bit texelFetch bilinear in shader -> zero carry spikes!)
  const heightTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, hmap.w, hmap.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, hmap.rgba);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const [progSky, progVoxel, progTerrain, progFrust] = linkPrograms(gl, [
    [FULL_VS, SKY_FS],
    [FULL_VS, VOXEL_FS],
    [TERRAIN_VS, TERRAIN_FS],
    [FRUSTUM_VS, FRUSTUM_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uSky   = uLoc(progSky,     ["uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uCrackFlash", "uTime"]);
  const uVox   = uLoc(progVoxel,   ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uHeightMap"]);
  const uTer   = uLoc(progTerrain, ["uViewProj", "uCamPos", "uLodCamPos", "uPatchRect", "uMorphRange", "uDrawMode",
                                    "uUseMorph", "uPatchLod", "uPatchId", "uHeightMap", "uVisMode", "uRichDetail", "uShowSkirts"]);
  const uFrust = uLoc(progFrust,   ["uViewProj"]);

  const fullVao = gl.createVertexArray();

  // Static GPU patch VAOs (zero per-frame allocations, zero jumping!)
  const patchCoarse     = makePatchVao(gl, buildGridPatchGeometry(8,  false, 2)); // 2000 GeoMipMapping
  const patchSkirts     = makePatchVao(gl, buildGridPatchGeometry(8,  true,  2)); // 2002 Chunked LOD + Skirts
  const patchFine       = makePatchVao(gl, buildGridPatchGeometry(16, false, 8)); // CDLOD / BF3 / Nanite (64 micro-meshlets/patch!)
  const clipRingSolid   = makePatchVao(gl, buildClipmapRingGeometry(28, false)); // Clipmap Level 0 center
  // 9 exact-aligned hollow Clipmap VAOs for child offset (dx, dz) in {-1, 0, +1} -> ZERO gaps, ZERO overlap!
  const clipRingHollows = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      clipRingHollows.push(makePatchVao(gl, buildClipmapRingGeometry(28, true, dx, dz)));
    }
  }

  // Dynamic VBO for watertight diamond ROAM bintree (Stage 1)
  const roamBuilder = createWatertightROAM(hmap, 26000);
  const roamVao = gl.createVertexArray();
  const roamVbo = gl.createBuffer();
  gl.bindVertexArray(roamVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, roamVbo);
  gl.bufferData(gl.ARRAY_BUFFER, 26000 * 3 * 6 * 4, gl.DYNAMIC_DRAW);
  const rStride = 6 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, rStride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, rStride, 8);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, rStride, 16);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, rStride, 20);
  gl.bindVertexArray(null);

  // Frustum wireframe VBO (16 line endpoints = 8 edges)
  const frVao = gl.createVertexArray();
  const frVbo = gl.createBuffer();
  gl.bindVertexArray(frVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, frVbo);
  gl.bufferData(gl.ARRAY_BUFFER, 24 * 3 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
  gl.bindVertexArray(null);

  let simTime = 0;
  let wireframeOn = true;
  let freezeFrustum = false;
  let frozenCam = null;
  let showSkirts = false;
  let errScale = 1.0;
  let lastTriCount = 0;

  // Smooth scenic helicopter flight INSIDE the fixed [-80, +80] alpine massif (zero world-origin snaps, exact 36s loop!)
  function makeFlightCamera(cam, aspect) {
    const ph = (simTime / 36.0) * Math.PI * 2.0;
    // Glide gracefully through the wide glacial valley gazing at the heroic eroded Matterhorn massif!
    const anchorX = Math.sin(ph) * 18.0 - 2.0;
    const anchorZ = Math.cos(ph) * 20.0 + 4.0;
    const anchorY = Math.max(hmap.sampleHeight(anchorX, anchorZ) + 4.2, 11.5);
    const flightYaw = Math.atan2(18.0 - anchorX, 6.0 - anchorZ) + Math.PI; // Gaze toward the tallest peak (uv 0.74, 0.57 -> x~+38, z~+11)!

    const yaw = flightYaw + cam.yaw;
    const cp = Math.cos(cam.pitch);
    const px = clamp(anchorX + Math.sin(yaw) * cp * cam.dist, -64, 64);
    const pz = clamp(anchorZ + Math.cos(yaw) * cp * cam.dist, -64, 64);
    const groundAtCam = hmap.sampleHeight(px, pz);
    const py = Math.max(groundAtCam + 3.6, anchorY + Math.sin(cam.pitch) * cam.dist);

    const pos = [px, py, pz];
    const target = [anchorX + 12.0, anchorY - 2.0, anchorZ + 2.0];
    const fwd = norm3(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
    const right = norm3(...cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    const fovRad = ((cam.fovDeg || 50) * Math.PI) / 180;
    const tanHalfFov = Math.tan(fovRad * 0.5);
    return {
      pos, target, fwd, right, up,
      fovRad, tanHalfFov, tanHalfH: tanHalfFov * aspect,
      cullFrustum: false,
    };
  }

  function drawFrozenFrustum(vp, fc) {
    const d = 34.0;
    const hY = d * fc.tanHalfFov * 0.85;
    const hX = d * fc.tanHalfH * 0.85;
    const p = fc.pos;
    const c = [p[0] + fc.fwd[0]*d, p[1] + fc.fwd[1]*d, p[2] + fc.fwd[2]*d];
    const tl = [c[0] - fc.right[0]*hX + fc.up[0]*hY, c[1] - fc.right[1]*hX + fc.up[1]*hY, c[2] - fc.right[2]*hX + fc.up[2]*hY];
    const tr = [c[0] + fc.right[0]*hX + fc.up[0]*hY, c[1] + fc.right[1]*hX + fc.up[1]*hY, c[2] + fc.right[2]*hX + fc.up[2]*hY];
    const bl = [c[0] - fc.right[0]*hX - fc.up[0]*hY, c[1] - fc.right[1]*hX - fc.up[1]*hY, c[2] - fc.right[2]*hX - fc.up[2]*hY];
    const br = [c[0] + fc.right[0]*hX - fc.up[0]*hY, c[1] + fc.right[1]*hX - fc.up[1]*hY, c[2] + fc.right[2]*hX - fc.up[2]*hY];
    const pts = new Float32Array([
      ...p, ...tl, ...p, ...tr, ...p, ...bl, ...p, ...br,
      ...tl, ...tr, ...tr, ...br, ...br, ...bl, ...bl, ...tl,
    ]);
    gl.useProgram(progFrust);
    gl.bindVertexArray(frVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, frVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pts);
    gl.uniformMatrix4fv(uFrust.uViewProj, false, vp);
    gl.drawArrays(gl.LINES, 0, 16);
  }

  function renderStage(stage, vp, viewCam, lodCam, forceVis) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightTex);

    if (stage === 0) {
      // 1992 Comanche Voxel Space (0 triangles!)
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(progVoxel);
      gl.bindVertexArray(fullVao);
      gl.uniform3fv(uVox.uCamPos, viewCam.pos);
      gl.uniform3fv(uVox.uCamRight, viewCam.right);
      gl.uniform3fv(uVox.uCamUp, viewCam.up);
      gl.uniform3fv(uVox.uCamFwd, viewCam.fwd);
      gl.uniform1f(uVox.uTanHalfFov, viewCam.tanHalfFov);
      gl.uniform1f(uVox.uAspect, viewCam.tanHalfH / Math.max(1e-4, viewCam.tanHalfFov));
      gl.uniform1i(uVox.uHeightMap, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      lastTriCount = 0;
      return;
    }

    // 1) Golden-hour Swiss Alps Sky backdrop
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(progSky);
    gl.bindVertexArray(fullVao);
    gl.uniform3fv(uSky.uCamRight, viewCam.right);
    gl.uniform3fv(uSky.uCamUp, viewCam.up);
    gl.uniform3fv(uSky.uCamFwd, viewCam.fwd);
    gl.uniform1f(uSky.uTanHalfFov, viewCam.tanHalfFov);
    gl.uniform1f(uSky.uAspect, viewCam.tanHalfH / Math.max(1e-4, viewCam.tanHalfFov));
    gl.uniform1f(uSky.uCrackFlash, stage === 2 ? 1.0 : 0.0);
    gl.uniform1f(uSky.uTime, simTime);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2) Setup Terrain Shader Uniforms
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(progTerrain);
    gl.uniformMatrix4fv(uTer.uViewProj, false, vp);
    gl.uniform3fv(uTer.uCamPos, viewCam.pos);
    gl.uniform3fv(uTer.uLodCamPos, lodCam.pos);
    gl.uniform1i(uTer.uHeightMap, 0);

    let visMode = 0;
    if (forceVis !== null) visMode = forceVis;
    else if (stage === 7 && wireframeOn) visMode = 2; // Nanite pastel clusters!
    else if (stage === 6 && wireframeOn) visMode = 3; // BF3 Virtual Texture page grid!
    else if (wireframeOn && stage !== 2 && stage !== 3) visMode = 1; // Color-coded LOD wireframe!

    gl.uniform1i(uTer.uVisMode, visMode);
    gl.uniform1i(uTer.uRichDetail, stage >= 6 ? 1 : 0);
    gl.uniform1f(uTer.uShowSkirts, showSkirts ? 1.0 : 0.0);

    let tris = 0;

    if (stage === 1) {
      // 1996-97 Watertight Forced-Split Diamond ROAM Bintree (ZERO cracks, ZERO world jumping!)
      const roam = roamBuilder.build(lodCam, errScale);
      gl.bindVertexArray(roamVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, roamVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, roam.data.subarray(0, roam.vertCount * 6));
      gl.uniform1i(uTer.uDrawMode, 2);
      gl.uniform1f(uTer.uUseMorph, 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, roam.vertCount);
      tris = Math.floor(roam.vertCount / 3);
    } else if (stage === 4) {
      // 2004-05 Losasso & Hoppe Nested Concentric Geometry Clipmaps (5 rings with exact child-hole alignment -> ZERO cracks!)
      gl.uniform1i(uTer.uDrawMode, 1);
      gl.uniform1f(uTer.uUseMorph, 1.0);
      const baseCell = 0.62;
      let prevOx = 0, prevOz = 0;
      for (let L = 0; L < 5; L++) {
        const cell = baseCell * (1 << L);
        const snap = cell * 2.0; // Snap strictly to parent grid spacing -> zero swimming & exact boundary lock!
        const ox = Math.round(lodCam.pos[0] / snap) * snap;
        const oz = Math.round(lodCam.pos[2] / snap) * snap;
        let vaoObj = clipRingSolid;
        if (L > 0) {
          const dxi = clamp(Math.round((prevOx - ox) / cell), -1, 1);
          const dzi = clamp(Math.round((prevOz - oz) / cell), -1, 1);
          vaoObj = clipRingHollows[(dzi + 1) * 3 + (dxi + 1)];
        }
        gl.bindVertexArray(vaoObj.vao);
        gl.uniform4f(uTer.uPatchRect, ox, oz, cell, vaoObj.N);
        gl.uniform1f(uTer.uPatchLod, L);
        gl.uniform1f(uTer.uPatchId, L);
        gl.drawArrays(gl.TRIANGLES, 0, vaoObj.vertCount);
        tris += Math.floor(vaoObj.vertCount / 3);
        prevOx = ox; prevOz = oz;
      }
    } else {
      // Fixed-Root World-Space Quadtree Patches (GeoMip Cracks / Chunked Skirts / CDLOD Morph / BF3 / Nanite!)
      const mode = stage === 2 ? "geomip_cracks"
                 : stage === 3 ? "chunked_skirts"
                 : stage === 5 ? "cdlod"
                 : stage === 6 ? "bf3" : "nanite";
      const patches = selectQuadtreePatches(lodCam, mode, errScale);
      const vaoObj = stage === 2 ? patchCoarse : (stage === 3 ? patchSkirts : patchFine);
      const useMorph = (stage >= 5) ? 1.0 : 0.0;

      gl.bindVertexArray(vaoObj.vao);
      gl.uniform1i(uTer.uDrawMode, 0);
      gl.uniform1f(uTer.uUseMorph, useMorph);
      for (let i = 0; i < patches.length; i++) {
        const p = patches[i];
        gl.uniform4f(uTer.uPatchRect, p.x0, p.z0, p.size, vaoObj.N);
        gl.uniform2f(uTer.uMorphRange, p.morphStart, p.morphEnd);
        gl.uniform1f(uTer.uPatchLod, p.level);
        gl.uniform1f(uTer.uPatchId, p.patchId);
        gl.drawArrays(gl.TRIANGLES, 0, vaoObj.vertCount);
        tris += Math.floor(vaoObj.vertCount / 3);
      }
    }

    lastTriCount = tris;
    if (freezeFrustum && frozenCam) {
      drawFrozenFrustum(vp, frozenCam);
    }
  }

  return {
    id: "terrain",
    maxPixels: 920000,
    defaultCamera: {
      yaw: 0.0,
      pitch: 0.24,
      dist: 24.0,
      lookY: 0.0,
      fovDeg: 50,
      minDist: 10.0,
      maxDist: 46.0,
      minPitch: 0.06,
      maxPitch: 1.05,
      autoOrbitSpeed: 0.0,
    },

    enterStep(stepIdx) {
      freezeFrustum = false;
      frozenCam = null;
      showSkirts = stepIdx === 3;
      wireframeOn = stepIdx === 1 || stepIdx === 4 || stepIdx === 7;
    },

    onReset() {
      freezeFrustum = false;
      frozenCam = null;
      errScale = 1.0;
      wireframeOn = true;
      showSkirts = false;
    },

    triggerAction(actionId) {
      if (actionId === "wire") wireframeOn = !wireframeOn;
      else if (actionId === "skirts") showSkirts = !showSkirts;
      else if (actionId === "freeze") {
        freezeFrustum = !freezeFrustum;
        if (!freezeFrustum) frozenCam = null;
      }
    },

    isActionActive(actionId) {
      if (actionId === "wire") return wireframeOn;
      if (actionId === "skirts") return showSkirts;
      if (actionId === "freeze") return freezeFrustum;
      return false;
    },

    onCanvasClick(ndcX) {
      errScale = clamp(0.65 + (ndcX * 0.5 + 0.5) * 0.90, 0.65, 1.55);
    },

    getTechBadge(stepIdx) {
      const tris = lastTriCount ? ` · ${(lastTriCount / 1000).toFixed(1)}k tris` : "";
      const labels = [
        "1992 · COMANCHE VOXEL SPACE · 0 POLYS",
        `1996–97 · LINDSTROM / ROAM DIAMOND BINTREE${tris}`,
        `2000 · GEOMIPMAPPING (T-JUNCTION CRACKS)${tris}`,
        `2002 · CHUNKED LOD + VERTICAL SKIRTS${tris}`,
        `2004–05 · GEOMETRY CLIPMAPS (NESTED RINGS)${tris}`,
        `2009–10 · CDLOD GEOMORPH + TESSELLATION${tris}`,
        `2011–12 · BF3 VIRTUAL TERRAIN TEXTURE${tris}`,
        `2021–24 · NANITE CLUSTER LOD (EMULATED)${tris}`,
      ];
      return labels[stepIdx] || `TERRAIN LOD${tris}`;
    },

    resize() {},

    update(dt, paused) {
      if (!paused && !freezeFrustum) simTime += dt;
    },

    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);
      const viewCam = makeFlightCamera(cam, aspect);
      if (freezeFrustum && !frozenCam) {
        frozenCam = { ...viewCam, pos: [...viewCam.pos], fwd: [...viewCam.fwd], right: [...viewCam.right], up: [...viewCam.up], cullFrustum: true };
      }
      const lodCam = (freezeFrustum && frozenCam) ? frozenCam : viewCam;

      const view = makeLookAt(viewCam.pos, viewCam.target, [0, 1, 0]);
      const proj = makePerspective(viewCam.fovRad, aspect, 0.4, 220.0);
      const vp = mulMat4(proj, view);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);

      if (split.enabled) {
        const sx = Math.max(1, Math.min(w - 1, Math.round(split.pos * w)));
        gl.enable(gl.SCISSOR_TEST);
        const sameStage = step.compareLeft === step.compareRight;
        gl.scissor(0, 0, sx, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        renderStage(step.compareLeft, vp, viewCam, lodCam, sameStage ? 0 : null);

        const rightVis = sameStage ? (step.stage === 7 ? 2 : (step.stage === 6 ? 3 : 1))
          : (step.compareRight === 7 ? 2 : (step.compareRight === 5 ? 1 : 0));
        gl.scissor(sx, 0, w - sx, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        renderStage(step.compareRight, vp, viewCam, lodCam, rightVis);
        gl.disable(gl.SCISSOR_TEST);
      } else {
        gl.disable(gl.SCISSOR_TEST);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        renderStage(step.stage, vp, viewCam, lodCam, null);
      }
      gl.bindVertexArray(null);
    },
  };
}
