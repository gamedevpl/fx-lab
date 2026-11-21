// Evolution of Surface Detail (1978-2026) — Interactive WebGL2 Surface & Silhouette Lab:
//   0: 1978 Bump Mapping (Jim Blinn, SIGGRAPH 1978 — split vs pre-1978 Flat Texture!)
//   1: 1998 Normal Mapping (Cohen & Cignoni 1998; Evolva / Giants 2000; popularized by Doom 3 2004)
//   2: 2001 Parallax / Offset Mapping (Kaneko 2001 / Welsh 2004)
//   3: 2005 Relief Mapping (Policarpo et al., I3D 2005 — linear march + binary search)
//   4: 2006 Parallax Occlusion Mapping / POM (Tatarchuk, GDC 2006 — adaptive march + self-shadows, flat silhouette)
//   5: 2009 Programmable DX11 Tessellation (Direct3D 11 / Unigine Heaven 2009; real 3D displaced silhouette + wireframe!)
//   6: 2018-20 Mesh Shaders & Meshlets (NVIDIA Turing 2018 -> DX12 Ultimate March 2020 — spatial meshlet clusters!)
//   7: 2022-26 Virtualized Micropolygon Geometry (UE5 Nanite — demo 2020, UE 5.0 2022 — dense micro-displacement + clusters!)
// Note: WebGL2 has no native hardware tessellation or mesh shaders; Stages 5-7 emulate real displacement
// and spatial meshlets via pre-subdivided vertex-displaced GPU meshes.

import {
  clamp, cameraBasisFromOrbit, makeLookAt, makePerspective,
  FULL_VS, linkPrograms,
} from "../../src/gl-utils.js";
import { buildSurfaceMeshes } from "./mesh.js";
import { BG_FS, MESH_VS, MESH_FS } from "./shaders.js";

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

export function createSurfaceEffect(gl) {
  const [progBg, progMesh] = linkPrograms(gl, [
    [FULL_VS, BG_FS],
    [MESH_VS, MESH_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uBg = uLoc(progBg, [
    "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect",
    "uLightPos", "uCamPos", "uShowSilGuide",
  ]);
  const uMesh = uLoc(progMesh, [
    "uViewProj", "uStage", "uFlatMode", "uCamPos", "uLightPos", "uDebugMode", "uTime",
  ]);

  const vaoEmpty = gl.createVertexArray();
  const meshes = buildSurfaceMeshes(gl); // [0=LowPoly, 1=Tessellated, 2=Meshlets, 3=Micropolygons]

  let simTime = 0;
  let debugWire = false;      // Stage 5 Wireframe toggle
  let debugClusters = false;  // Stages 6-7 Meshlet / Nanite Cluster Debug toggle
  let edgeZoom = false;       // Steps 1-5 Silhouette Edge Close-Up toggle!
  let edgeZoomAmt = 0.0;
  let customLightAngle = null; // [azim, y] from clicking canvas

  function currentLightPos() {
    if (customLightAngle) {
      const [az, ly] = customLightAngle;
      return [Math.sin(az) * 2.35, ly, Math.cos(az) * 2.35];
    }
    const ang = 0.72 + Math.sin(simTime * 0.65) * 0.68;
    return [Math.sin(ang) * 2.35, 0.72 + Math.sin(simTime * 1.1) * 0.42, Math.cos(ang) * 2.35];
  }

  function meshForStage(st, flatMode) {
    if (flatMode || st < 5) return meshes[0];
    if (st === 5) return meshes[1];
    if (st === 6) return meshes[2];
    return meshes[3];
  }

  return {
    id: "surface",
    maxPixels: 920000,
    defaultCamera: {
      yaw: 0.22,
      pitch: 0.16,
      dist: 4.35,
      lookY: 0.14,
      fovDeg: 42,
      minDist: 2.1,
      maxDist: 7.2,
      minPitch: -0.22,
      maxPitch: 0.68,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 5) debugWire = false;
      if (stepIdx !== 6 && stepIdx !== 7) debugClusters = false;
      if (stepIdx >= 5) edgeZoom = false;
    },
    onReset() {
      debugWire = false;
      debugClusters = false;
      edgeZoom = false;
      edgeZoomAmt = 0.0;
      customLightAngle = null;
    },
    triggerAction(actionId) {
      if (actionId === "edgeZoom") edgeZoom = !edgeZoom;
      else if (actionId === "wireframe") debugWire = !debugWire;
      else if (actionId === "clusters") debugClusters = !debugClusters;
    },
    isActionActive(actionId) {
      if (actionId === "edgeZoom") return edgeZoom;
      if (actionId === "wireframe") return debugWire;
      if (actionId === "clusters") return debugClusters;
      return false;
    },
    onCanvasClick(ndcX, ndcY, _w, _h, _step, cam) {
      // Aim the warm grazing forge torch toward where the user clicked around the column!
      const az = cam.yaw + ndcX * 1.35;
      const ly = clamp(ndcY * 1.45 + 0.35, -0.75, 1.85);
      customLightAngle = [az, ly];
    },
    getTechBadge(stepIdx) {
      const tris = [
        "1978 · BLINN BUMP MAP",
        "1998 · NORMAL MAPPING",
        "2001 · KANEKO PARALLAX",
        "2005 · POLICARPO RELIEF",
        edgeZoom ? "2006 · POM (FLAT EDGE!)" : "2006 · TATARCHUK POM",
        debugWire ? `2009 · DX11 TESS (${Math.round(meshes[1].triCount / 1000)}K WIRE)` : "2009 · DX11 TESSELLATION",
        debugClusters ? "2018–20 · MESHLET PACKETS" : "2018–20 · TURING / DX12 MESHLETS",
        debugClusters ? "2022–26 · NANITE CLUSTER VIEW" : "2022–26 · MICROPOLYGON (UE5)",
      ];
      return tris[stepIdx] || "WEBGL2";
    },
    resize() {},
    update(dt, paused) {
      const targetZoom = edgeZoom ? 1.0 : 0.0;
      edgeZoomAmt += (targetZoom - edgeZoomAmt) * Math.min(1.0, dt * 6.5);
      if (!paused) simTime += dt;
    },
    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);
      const effDist = cam.dist - edgeZoomAmt * 1.25;
      const effLookY = cam.lookY + edgeZoomAmt * 0.25;
      const effPitch = cam.pitch - edgeZoomAmt * 0.08;
      const basis = cameraBasisFromOrbit(cam.yaw, effPitch, effDist, effLookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const view = makeLookAt(basis.pos, basis.target, [0, 1, 0]);
      const proj = makePerspective((cam.fovDeg * Math.PI) / 180, aspect, 0.1, 40.0);
      const viewProj = mulMat4(proj, view);
      const lightPos = currentLightPos();

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      // 1. Background Twilight Sky + Torch Glow
      gl.bindVertexArray(vaoEmpty);
      gl.useProgram(progBg);
      gl.uniform3fv(uBg.uCamRight, basis.right);
      gl.uniform3fv(uBg.uCamUp, basis.up);
      gl.uniform3fv(uBg.uCamFwd, basis.fwd);
      gl.uniform1f(uBg.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uBg.uAspect, aspect);
      gl.uniform3fv(uBg.uLightPos, lightPos);
      gl.uniform3fv(uBg.uCamPos, basis.pos);
      gl.uniform1f(uBg.uShowSilGuide, edgeZoomAmt);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 2. Render Stone Column + Cobblestone Plinth (Scissor-split cleanly compares low-poly flat POM vs 3D displaced geometry!)
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);

      const drawHalf = (x0, sw, st, flatMode, dbgMode) => {
        if (sw <= 0) return;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(x0, 0, sw, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const m = meshForStage(st, flatMode);
        gl.useProgram(progMesh);
        gl.uniformMatrix4fv(uMesh.uViewProj, false, viewProj);
        gl.uniform1i(uMesh.uStage, st);
        gl.uniform1f(uMesh.uFlatMode, flatMode ? 1.0 : 0.0);
        gl.uniform3fv(uMesh.uCamPos, basis.pos);
        gl.uniform3fv(uMesh.uLightPos, lightPos);
        gl.uniform1f(uMesh.uDebugMode, dbgMode);
        gl.uniform1f(uMesh.uTime, simTime);
        gl.bindVertexArray(m.vao);
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
      };

      const activeDbg = (st) => {
        if (st === 5 && debugWire) return 1.0;
        if ((st === 6 || st === 7) && debugClusters) return 2.0;
        return 0.0;
      };

      if (split.enabled) {
        const sx = Math.round(clamp(split.pos, 0.01, 0.99) * w);
        const flatLeft = !!step.flatSplit;
        drawHalf(0, sx, step.compareLeft, flatLeft, activeDbg(step.compareLeft));
        drawHalf(sx, w - sx, step.compareRight, false, activeDbg(step.compareRight));
      } else {
        drawHalf(0, w, step.stage, false, activeDbg(step.stage));
      }

      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DEPTH_TEST);
    },
  };
}
