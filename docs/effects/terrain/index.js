// Evolution of Terrain & Level of Detail (1992-2024) — Interactive WebGL2 Controller.
//   0: 1992      Comanche Voxel Space (NovaLogic vertical heightmap column strips, 0 polygons)
//   1: 1996-97   Lindstrom CLOD & ROAM (CPU adaptive binary triangle tree / bintree!)
//   2: 2000      GeoMipMapping (Willem de Boer — quadtree tiles exposing T-junction cracks & popping!)
//   3: 2002      Chunked LOD with Skirts (Thatcher Ulrich, SIGGRAPH 2002 — vertical skirts seal cracks!)
//   4: 2004-05   Geometry Clipmaps (Losasso & Hoppe, SIGGRAPH '04 — concentric nested grid rings!)
//   5: 2009-10   CDLOD Geomorphing (Filip Strugar '09) & H.A.W.X 2 DX11 Tessellation ('10, emulated)
//   6: 2011-12   Battlefield 3 Virtual Terrain Texturing (Frostbite 2, GDC 2012)
//   7: 2021-24   UE5 Nanite Cluster LOD (UE5 '21 -> Nanite Landscape UE 5.3+ '23, emulated meshlets)

import { clamp, norm3, cross3, makeLookAt, makePerspective, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import { createTerrainMeshBuilder, sampleHeight } from "./lod.js";
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

export function createTerrainEffect(gl) {
  const [progSky, progVoxel, progTerrain, progFrust] = linkPrograms(gl, [
    [FULL_VS, SKY_FS],
    [FULL_VS, VOXEL_FS],
    [TERRAIN_VS, TERRAIN_FS],
    [FRUSTUM_VS, FRUSTUM_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uSky   = uLoc(progSky,     ["uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uCrackFlash"]);
  const uVox   = uLoc(progVoxel,   ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect"]);
  const uTer   = uLoc(progTerrain, ["uViewProj", "uCamPos", "uVisMode", "uRichDetail", "uShowSkirts"]);
  const uFrust = uLoc(progFrust,   ["uViewProj"]);

  const fullVao = gl.createVertexArray();

  // Dynamic terrain VBO (reused every frame, zero GC!)
  const builder = createTerrainMeshBuilder(26000);
  const terVao = gl.createVertexArray();
  const terVbo = gl.createBuffer();
  gl.bindVertexArray(terVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, terVbo);
  gl.bufferData(gl.ARRAY_BUFFER, 26000 * 3 * 10 * 4, gl.DYNAMIC_DRAW);
  const stride = 10 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 36);
  gl.bindVertexArray(null);

  // Frustum wireframe VBO (16 line endpoints = 8 edges!)
  const frVao = gl.createVertexArray();
  const frVbo = gl.createBuffer();
  gl.bindVertexArray(frVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, frVbo);
  gl.bufferData(gl.ARRAY_BUFFER, 24 * 3 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
  gl.bindVertexArray(null);

  let simTime = 0;
  let wireframeOn = true;    // Shows crisp color-coded LOD wireframe (super informative!)
  let freezeFrustum = false;
  let frozenCam = null;
  let showSkirts = false;
  let errScale = 1.0;        // Click canvas X adjusts screen-space LOD error budget (0.55..1.65)!
  let lastTriCount = 0;

  function makeFlightCamera(cam, aspect) {
    // Camera glides smoothly forward down the alpine glacial valley!
    const flyZ = -simTime * 2.8;
    const flyX = Math.sin(flyZ * 0.085) * 4.5;
    const baseY = Math.max(sampleHeight(flyX, flyZ, false) + 3.4, 5.8);
    const target = [flyX, baseY - 1.4, flyZ - 14.0];
    const cp = Math.cos(cam.pitch);
    const pos = [
      target[0] + Math.sin(cam.yaw) * cp * cam.dist,
      Math.max(sampleHeight(target[0] + Math.sin(cam.yaw) * cp * cam.dist, target[2] + Math.cos(cam.yaw) * cp * cam.dist, false) + 1.8, target[1] + Math.sin(cam.pitch) * cam.dist),
      target[2] + Math.cos(cam.yaw) * cp * cam.dist,
    ];
    const fwd = norm3(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
    const right = norm3(...cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    const fovRad = ((cam.fovDeg || 52) * Math.PI) / 180;
    const tanHalfFov = Math.tan(fovRad * 0.5);
    return {
      pos, target, fwd, right, up,
      center: [target[0], target[1], target[2]],
      fovRad, tanHalfFov, tanHalfH: tanHalfFov * aspect,
      cullFrustum: false,
    };
  }

  function drawFrozenFrustum(vp, fc) {
    // Draw glowing amber frustum cone of the frozen LOD camera
    const d = 26.0;
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
    if (stage === 0) {
      // 1992 Comanche Voxel Space (0 polygons!)
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(progVoxel);
      gl.bindVertexArray(fullVao);
      gl.uniform3fv(uVox.uCamPos, viewCam.pos);
      gl.uniform3fv(uVox.uCamRight, viewCam.right);
      gl.uniform3fv(uVox.uCamUp, viewCam.up);
      gl.uniform3fv(uVox.uCamFwd, viewCam.fwd);
      gl.uniform1f(uVox.uTanHalfFov, viewCam.tanHalfFov);
      gl.uniform1f(uVox.uAspect, viewCam.tanHalfH / Math.max(1e-4, viewCam.tanHalfFov));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      lastTriCount = 0;
      return;
    }

    // 1) Alpine Sky backdrop
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(progSky);
    gl.bindVertexArray(fullVao);
    gl.uniform3fv(uSky.uCamRight, viewCam.right);
    gl.uniform3fv(uSky.uCamUp, viewCam.up);
    gl.uniform3fv(uSky.uCamFwd, viewCam.fwd);
    gl.uniform1f(uSky.uTanHalfFov, viewCam.tanHalfFov);
    gl.uniform1f(uSky.uAspect, viewCam.tanHalfH / Math.max(1e-4, viewCam.tanHalfFov));
    gl.uniform1f(uSky.uCrackFlash, stage === 2 ? 1.0 : 0.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2) Build live LOD triangle geometry for this era!
    let mesh;
    if (stage === 1)      mesh = builder.buildROAM(lodCam, errScale);
    else if (stage === 2) mesh = builder.buildQuadtreeLOD(lodCam, "geomip_cracks", errScale);
    else if (stage === 3) mesh = builder.buildQuadtreeLOD(lodCam, "chunked_skirts", errScale);
    else if (stage === 4) mesh = builder.buildClipmaps(lodCam);
    else if (stage === 5) mesh = builder.buildQuadtreeLOD(lodCam, "cdlod", errScale);
    else if (stage === 6) mesh = builder.buildQuadtreeLOD(lodCam, "bf3", errScale);
    else                  mesh = builder.buildQuadtreeLOD(lodCam, "nanite", errScale);
    lastTriCount = Math.floor(mesh.vertCount / 3);

    // 3) Upload & draw Terrain Triangles
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(progTerrain);
    gl.bindVertexArray(terVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, terVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.data.subarray(0, mesh.vertCount * 10));
    gl.uniformMatrix4fv(uTer.uViewProj, false, vp);
    gl.uniform3fv(uTer.uCamPos, viewCam.pos);

    let visMode = 0;
    if (forceVis !== null) visMode = forceVis;
    else if (stage === 7 && wireframeOn) visMode = 2; // Nanite pastel clusters!
    else if (stage === 6 && wireframeOn) visMode = 3; // BF3 Virtual Texture tile grid!
    else if (wireframeOn && stage !== 2 && stage !== 3) visMode = 1; // Color-coded LOD wireframe!

    gl.uniform1i(uTer.uVisMode, visMode);
    gl.uniform1i(uTer.uRichDetail, stage >= 6 ? 1 : 0);
    gl.uniform1f(uTer.uShowSkirts, showSkirts ? 1.0 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.vertCount);

    if (freezeFrustum && frozenCam) {
      drawFrozenFrustum(vp, frozenCam);
    }
  }

  return {
    id: "terrain",
    maxPixels: 920000,
    defaultCamera: {
      yaw: 0.04,
      pitch: 0.28,
      dist: 17.5,
      lookY: 0.0,
      fovDeg: 52,
      minDist: 7.0,
      maxDist: 38.0,
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

    // Clicking canvas left/right adjusts live screen-space LOD error budget (coarse -> ultra-dense!)
    onCanvasClick(ndcX) {
      errScale = clamp(0.60 + (ndcX * 0.5 + 0.5) * 1.15, 0.55, 1.75);
    },

    getTechBadge(stepIdx) {
      const tris = lastTriCount ? ` · ${(lastTriCount / 1000).toFixed(1)}k tris` : "";
      const labels = [
        "1992 · COMANCHE VOXEL SPACE · 0 POLYS",
        `1996–97 · LINDSTROM / ROAM BINTREE${tris}`,
        `2000 · GEOMIPMAPPING (CRACKS & POP)${tris}`,
        `2002 · CHUNKED LOD + SKIRTS${tris}`,
        `2004–05 · GEOMETRY CLIPMAPS${tris}`,
        `2009–10 · CDLOD MORPH + TESSELLATION${tris}`,
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
        frozenCam = { ...viewCam, pos: [...viewCam.pos], center: [...viewCam.center], fwd: [...viewCam.fwd], right: [...viewCam.right], up: [...viewCam.up], cullFrustum: true };
      }
      const lodCam = (freezeFrustum && frozenCam) ? frozenCam : viewCam;

      const view = makeLookAt(viewCam.pos, viewCam.target, [0, 1, 0]);
      const proj = makePerspective(viewCam.fovRad, aspect, 0.3, 140.0);
      const vp = mulMat4(proj, view);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);

      if (split.enabled) {
        const sx = Math.max(1, Math.min(w - 1, Math.round(split.pos * w)));
        gl.enable(gl.SCISSOR_TEST);
        // Left side: clean shaded (or older broken era)
        const sameStage = step.compareLeft === step.compareRight;
        gl.scissor(0, 0, sx, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        renderStage(step.compareLeft, vp, viewCam, lodCam, sameStage ? 0 : null);
        // Right side: wireframe/cluster view (or newer fixed era!)
        const rightVis = sameStage ? (step.stage === 7 ? 2 : (step.stage === 6 ? 3 : 1)) : (step.compareRight === 7 ? 2 : 0);
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
