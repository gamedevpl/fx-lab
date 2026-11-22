// Automatic WebGL2 Fallback engine for Evolution of Collision Detection & Tunneling (1988-2024).
// Runs seamlessly on browsers without WebGPU (or when ?renderer=webgl2 is passed in the URL):
//   - 512 CPU-simulated live projectiles / 3D spatial-hash bouncing orbs (exact Discrete vs Swept-CCD math!)
//   - Live 3D Spatial Hash occupied grid-cell visualizer (GPU Gems 3 Ch. 32)
//   - Full Doom 1993 directional bug, SAP 1D brackets, Quake Minkowski hull, OBBTree SAT, Speculative/TOI & Spinning Rod!

import { FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import {
  DEFAULT_CAMERA, MAX_INSTANCES, GRID_DIMS,
  computeCameraBasis, createPrimitiveMesh, createCollisionsController, mulberry32,
} from "./shared.js";

const GL_BULLETS = 512;

const ENV_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform mat4 uViewProj;
uniform vec4 uCamPos;
uniform vec4 uCamFwd;
uniform vec4 uCamRight;
uniform vec4 uCamUp;
uniform vec4 uExtra; // 0, wallFlashBad, 0, wallFlashGood

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(
    uCamFwd.xyz +
    uCamRight.xyz * (ndc.x * uCamPos.w * uCamFwd.w) +
    uCamUp.xyz * (ndc.y * uCamPos.w)
  );
  vec3 ro = uCamPos.xyz;
  int stage = int(uCamUp.w + 0.5);

  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.055, 0.075, 0.125), vec3(0.025, 0.038, 0.075), smoothstep(0.45, 0.95, h));
  col += vec3(0.08, 0.18, 0.28) * exp(-abs(rd.y) * 9.0) * 0.45;
  bool didHit = false;
  vec3 hitPos = ro + rd * 80.0;

  if (rd.y < -0.001) {
    float tg = -ro.y / rd.y;
    if (tg > 0.1 && tg < 85.0) {
      hitPos = ro + rd * tg;
      didHit = true;
      vec2 p = hitPos.xz;
      vec2 g1 = abs(fract(p + 0.5) - 0.5);
      float line1 = 1.0 - smoothstep(0.015, 0.032, min(g1.x, g1.y));
      vec2 g4 = abs(fract(p * 4.0 + 0.5) - 0.5);
      float line4 = 1.0 - smoothstep(0.02, 0.05, min(g4.x, g4.y));
      float dc = length(p);
      vec3 base = mix(vec3(0.075, 0.095, 0.145), vec3(0.045, 0.060, 0.095), smoothstep(2.0, 16.0, dc));
      base += vec3(0.06, 0.12, 0.19) * line4 * 0.30;
      base += vec3(0.14, 0.28, 0.42) * line1 * 0.55;

      if (stage == 1) {
        float inLane = smoothstep(2.4, 2.0, abs(p.y));
        float ez = smoothstep(0.4, 0.8, p.x) * smoothstep(4.6, 3.8, p.x) * inLane;
        float wz = smoothstep(-0.4, -0.8, p.x) * smoothstep(-4.6, -3.8, p.x) * inLane;
        base += vec3(0.06, 0.34, 0.20) * ez * 0.42;
        base += vec3(0.42, 0.07, 0.10) * wz * 0.44;
      } else if (stage != 2 && stage != 4) {
        float inLane = smoothstep(4.2, 3.6, abs(p.x));
        float frontZone = smoothstep(0.15, 0.55, p.y) * smoothstep(4.6, 3.6, p.y) * inLane;
        vec3 tint = (stage == 0) ? vec3(0.45, 0.05, 0.09) : vec3(0.04, 0.24, 0.16);
        base += tint * frontZone * (0.34 + uExtra.y * 0.40);
      }

      float spot = exp(-dc * dc * 0.025);
      base *= 0.65 + 0.65 * spot;
      base += vec3(0.12, 0.55, 0.35) * uExtra.w * exp(-dc * dc * 0.18) * 0.45;
      base += vec3(0.65, 0.10, 0.14) * uExtra.y * exp(-dc * dc * 0.18) * 0.45;
      col = mix(base, col, smoothstep(14.0, 52.0, tg));
    }
  }

  vec3 mapped = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  fragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
  if (didHit) {
    vec4 clip = uViewProj * vec4(hitPos, 1.0);
    gl_FragDepth = clamp(0.5 * (clip.z / clip.w) + 0.5, 0.0, 0.9999);
  } else {
    gl_FragDepth = 0.9998;
  }
}
`;

const PRIM_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUv;
layout(location=3) in vec4 iV0; // pos.xyz, matId
layout(location=4) in vec4 iV1; // rot.xyz, shape
layout(location=5) in vec4 iV2; // scale.xyz, alpha
layout(location=6) in vec4 iV3; // glow, seed, 0, 0

uniform mat4 uViewProj;
uniform float uPassMode; // 0=opaque, 1=translucent

out vec3 vWPos;
out vec3 vWNrm;
out vec3 vLPos;
out vec4 vInfo;

vec3 rotXYZ(vec3 v, vec3 r) {
  vec3 p = v;
  float cx = cos(r.x), sx = sin(r.x);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  float cy = cos(r.y), sy = sin(r.y);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  float cz = cos(r.z), sz = sin(r.z);
  p = vec3(p.x * cz - p.y * sz, p.x * sz + p.y * cz, p.z);
  return p;
}

void main() {
  float alpha = iV2.w;
  if ((uPassMode < 0.5 && alpha < 0.98) || (uPassMode > 0.5 && alpha >= 0.98)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float shape = iV1.w;
  vec3 lp = aPos, ln = aNrm;
  if (shape > 0.5 && shape < 1.5) {
    lp = normalize(aPos) * 0.5;
    ln = normalize(aPos);
  } else if (shape > 1.5) {
    lp = normalize(vec3(0.0, aPos.y, aPos.z)) * 0.5;
    lp.x = aPos.x;
    ln = vec3(-1.0, 0.0, 0.0);
  }
  vec3 wp = iV0.xyz + rotXYZ(lp * iV2.xyz, iV1.xyz);
  vec3 wn = normalize(rotXYZ(ln, iV1.xyz));
  gl_Position = uViewProj * vec4(wp, 1.0);
  vWPos = wp; vWNrm = wn; vLPos = aPos;
  vInfo = vec4(iV0.w, alpha, iV3.x, shape);
}
`;

const PRIM_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWPos;
in vec3 vWNrm;
in vec3 vLPos;
in vec4 vInfo;
uniform vec4 uCamPos;
out vec4 fragColor;

const vec3 KEY_LIGHT = vec3(0.42, 0.80, 0.42);

void main() {
  int mat = int(vInfo.x + 0.5);
  float alpha = vInfo.y;
  float glow = vInfo.z;
  float shape = vInfo.w;
  vec3 n = normalize(vWNrm);
  vec3 vDir = normalize(uCamPos.xyz - vWPos);
  vec3 sun = normalize(KEY_LIGHT);

  vec3 alb = vec3(0.22, 0.27, 0.36);
  vec3 em = vec3(0.0);
  float rough = 0.42;
  float edgeMax = max(abs(vLPos.x), max(abs(vLPos.y), abs(vLPos.z)));
  float isFrame = smoothstep(0.42, 0.495, edgeMax);

  if (mat == 0) {
    float panel = smoothstep(0.03, 0.06, abs(fract(vWPos.y * 1.4) - 0.5));
    alb = vec3(0.26, 0.32, 0.42) * (0.88 + 0.12 * panel);
    if (glow > 0.01) em += vec3(0.18, 1.45, 0.72) * glow * 0.9;
    if (glow < -0.01) em += vec3(1.85, 0.16, 0.24) * (-glow) * 1.1;
    rough = 0.28;
  } else if (mat == 1) {
    alb = vec3(0.18, 0.21, 0.29); rough = 0.55;
  } else if (mat == 2) {
    alb = vec3(0.05, 0.72, 0.96); em = vec3(0.04, 0.52, 0.85) * (0.35 + glow * 0.65 + isFrame * 0.75); rough = 0.20;
  } else if (mat == 3) {
    alb = vec3(0.98, 0.48, 0.06); em = vec3(1.32, 0.46, 0.04) * (0.45 + glow * 0.75); rough = 0.22;
  } else if (mat == 4) {
    alb = vec3(0.96, 0.06, 0.14); em = vec3(1.38, 0.04, 0.09) * (0.45 + glow * 0.85); rough = 0.22;
  } else if (mat == 5) {
    alb = vec3(0.06, 0.88, 0.42); em = vec3(0.04, 0.96, 0.34) * (0.40 + glow * 0.75); rough = 0.24;
  } else if (mat == 6) {
    alb = vec3(0.76, 0.92, 1.0); em = vec3(0.55, 0.82, 1.0) * 0.75; rough = 0.20;
  } else if (mat == 7) {
    alb = vec3(0.68, 0.74, 0.84); rough = 0.18;
  } else {
    alb = vec3(1.0, 0.82, 0.28); em = vec3(1.65, 1.18, 0.30) * 0.95; rough = 0.20;
  }

  float ndl = max(0.0, dot(n, sun));
  vec3 hVec = normalize(sun + vDir);
  float spec = pow(max(0.0, dot(n, hVec)), mix(72.0, 14.0, rough)) * 0.55;
  float fres = pow(1.0 - max(0.0, dot(n, vDir)), 2.8);
  vec3 amb = mix(vec3(0.12, 0.16, 0.26), vec3(0.32, 0.42, 0.58), 0.5 + 0.5 * n.y);

  vec3 col = alb * (amb * 0.82 + vec3(1.05, 0.98, 0.92) * ndl) + vec3(0.95, 0.98, 1.0) * spec + em;
  if (alpha < 0.98) col += em * (fres * 0.65 + isFrame * 0.55);

  float outA = alpha;
  if (shape > 1.5) {
    float rr = length(vLPos.yz) * 2.0;
    float ring = smoothstep(0.62, 0.80, rr) * smoothstep(1.02, 0.88, rr);
    if (ring < 0.02) discard;
    outA = alpha * ring;
  }
  vec3 mapped = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  fragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), outA);
}
`;

// Compact 512-bullet CPU fallback matching WebGPU compute discrete/CCD/spatial-hash behavior
function createFallbackSwarm() {
  const rng = mulberry32(200709);
  const pos = new Float32Array(GL_BULLETS * 3);
  const vel = new Float32Array(GL_BULLETS * 3);
  const mat = new Float32Array(GL_BULLETS);
  const st = new Float32Array(GL_BULLETS);
  const life = new Float32Array(GL_BULLETS);
  const grid = new Uint8Array(GRID_DIMS[0] * GRID_DIMS[1] * GRID_DIMS[2]);

  function respawn(i, stage, staggered) {
    const o = i * 3;
    if (stage === 4) {
      const a = rng() * Math.PI * 2, r = 0.85 + Math.pow(rng(), 0.55) * 3.35;
      pos[o] = Math.cos(a) * r; pos[o + 1] = 0.25 + rng() * 3.1; pos[o + 2] = Math.sin(a) * r;
      vel[o] = (rng() - 0.5) * 7.5; vel[o + 1] = (rng() - 0.5) * 4.5; vel[o + 2] = (rng() - 0.5) * 7.5;
      mat[i] = 2; st[i] = 3; life[i] = 1;
    } else {
      pos[o] = (rng() - 0.5) * 6.80;
      pos[o + 1] = 0.28 + rng() * 2.05;
      pos[o + 2] = staggered ? (-4.25 + rng() * 3.85) : -4.25;
      vel[o] = (rng() - 0.5) * 0.45; vel[o + 1] = (rng() - 0.5) * 0.45; vel[o + 2] = 16.5 + rng() * 11.5;
      mat[i] = stage === 7 ? 3 : 2; st[i] = 0; life[i] = 1.0 + rng() * 1.4;
    }
  }

  return {
    reset(stage) { for (let i = 0; i < GL_BULLETS; i++) respawn(i, stage, true); },
    step(dt, stage, wHalf, shockwave) {
      if (stage !== 0 && stage !== 4 && stage !== 6 && stage !== 7) return;
      if (stage === 4) grid.fill(0);
      for (let i = 0; i < GL_BULLETS; i++) {
        const o = i * 3;
        if (stage === 4) {
          if (shockwave) {
            const dl = Math.hypot(pos[o], pos[o + 1] - 1.2, pos[o + 2]) || 1;
            vel[o] += (pos[o] / dl) * 9.5; vel[o + 1] += ((pos[o + 1] - 1.2) / dl) * 9.5 + 3.0; vel[o + 2] += (pos[o + 2] / dl) * 9.5;
          }
          vel[o + 1] -= 5.8 * dt;
          pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt; pos[o + 2] += vel[o + 2] * dt;
          if (pos[o] < -4.35) { pos[o] = -4.35; vel[o] = Math.abs(vel[o]) * 0.92; }
          if (pos[o] >  4.35) { pos[o] =  4.35; vel[o] = -Math.abs(vel[o]) * 0.92; }
          if (pos[o+2] < -4.35) { pos[o+2] = -4.35; vel[o+2] = Math.abs(vel[o+2]) * 0.92; }
          if (pos[o+2] >  4.35) { pos[o+2] =  4.35; vel[o+2] = -Math.abs(vel[o+2]) * 0.92; }
          if (pos[o+1] < 0.14)  { pos[o+1] =  0.14; vel[o+1] = Math.abs(vel[o+1]) * 0.88 + 0.8; }
          if (pos[o+1] > 3.75)  { pos[o+1] =  3.75; vel[o+1] = -Math.abs(vel[o+1]) * 0.90; }
          if (Math.abs(pos[o]) < 0.56 && Math.abs(pos[o+2]) < 0.56 && pos[o+1] < 2.75) {
            if (Math.abs(pos[o]) > Math.abs(pos[o+2])) { pos[o] = pos[o] >= 0 ? 0.56 : -0.56; vel[o] = -vel[o] * 0.95; }
            else { pos[o+2] = pos[o+2] >= 0 ? 0.56 : -0.56; vel[o+2] = -vel[o+2] * 0.95; }
            mat[i] = 3;
          } else {
            mat[i] = Math.hypot(vel[o], vel[o+1], vel[o+2]) > 5.8 ? 5 : 2;
          }
          const cx = Math.max(0, Math.min(15, Math.floor((pos[o] + 4.8) / 9.6 * 16)));
          const cy = Math.max(0, Math.min(7,  Math.floor(pos[o + 1] / 4.8 * 8)));
          const cz = Math.max(0, Math.min(15, Math.floor((pos[o + 2] + 4.8) / 9.6 * 16)));
          const ci = cx + cy * 16 + cz * 128;
          if (grid[ci] < 255) grid[ci]++;
        } else {
          const prevZ = pos[o + 2];
          if (st[i] === 1) {
            vel[o + 1] -= 17.5 * dt;
            pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt; pos[o + 2] += vel[o + 2] * dt;
            if (pos[o + 1] < 0.08) { pos[o + 1] = 0.08; vel[o + 1] = -vel[o + 1] * 0.42; vel[o] *= 0.72; vel[o + 2] *= 0.72; }
            life[i] -= dt * 1.15;
            if (life[i] <= 0.02 || pos[o + 2] < -5.5) respawn(i, stage, false);
          } else {
            pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt; pos[o + 2] += vel[o + 2] * dt;
            const inXY = pos[o + 1] > 0.05 && pos[o + 1] < 2.52 && Math.abs(pos[o]) < 3.82;
            const hitPlane = -(wHalf + 0.07);
            if (stage === 0) {
              if (inXY && Math.abs(pos[o + 2]) <= wHalf + 0.03 && st[i] === 0) {
                pos[o + 2] = hitPlane; vel[o + 2] = -Math.abs(vel[o + 2]) * 0.3; vel[o + 1] = 2.5 + rng() * 3.0; st[i] = 1; mat[i] = 5; life[i] = 0.85;
              } else if (inXY && prevZ < -wHalf && pos[o + 2] > wHalf && st[i] === 0) {
                st[i] = 2; mat[i] = 4;
              }
            } else if (inXY && prevZ <= hitPlane && pos[o + 2] >= hitPlane && st[i] === 0) {
              pos[o + 2] = hitPlane; vel[o] = (rng() - 0.5) * 6.5; vel[o + 1] = 1.6 + rng() * 4.8; vel[o + 2] = -(2.5 + rng() * 5.0);
              st[i] = 1; mat[i] = rng() > 0.45 ? 3 : 5; life[i] = 0.72 + rng() * 0.65;
            }
            if (pos[o + 2] > 4.6 || pos[o + 2] < -5.5) respawn(i, stage, false);
          }
        }
      }
    },
    pack(out, count, maxTotal, stage) {
      if (stage !== 0 && stage !== 4 && stage !== 6 && stage !== 7) return count;
      let c = count;
      for (let i = 0; i < GL_BULLETS && c < maxTotal; i++) {
        const o = c * 16, p = i * 3;
        out[o+0] = pos[p]; out[o+1] = pos[p+1]; out[o+2] = pos[p+2]; out[o+3] = mat[i];
        out[o+4] = 0; out[o+5] = 0; out[o+6] = 0; out[o+7] = 1;
        out[o+8] = 0.16; out[o+9] = 0.16; out[o+10] = 0.16; out[o+11] = 1.0;
        out[o+12] = 0.85; out[o+13] = 0; out[o+14] = 0; out[o+15] = 0;
        c++;
      }
      if (stage === 4) {
        const cs = 9.6 / 16;
        for (let ci = 0; ci < grid.length && c < maxTotal; ci++) {
          if (grid[ci] < 2) continue;
          const cz = (ci / 128) | 0, rem = ci - cz * 128, cy = (rem / 16) | 0, cx = rem - cy * 16;
          const o = c * 16;
          out[o+0] = -4.8 + (cx + 0.5) * cs; out[o+1] = (cy + 0.5) * cs; out[o+2] = -4.8 + (cz + 0.5) * cs; out[o+3] = grid[ci] >= 3 ? 3 : 2;
          out[o+4] = 0; out[o+5] = 0; out[o+6] = 0; out[o+7] = 0;
          out[o+8] = cs * 0.92; out[o+9] = cs * 0.92; out[o+10] = cs * 0.92; out[o+11] = 0.24;
          out[o+12] = 0.85; out[o+13] = 0; out[o+14] = 0; out[o+15] = 0;
          c++;
        }
      }
      return c;
    },
  };
}

export function createCollisionsWebGL2(gl) {
  const [pEnv, pPrim] = linkPrograms(gl, [
    [FULL_VS, ENV_FS],
    [PRIM_VS, PRIM_FS],
  ]);
  const mapU = (p, names) => { const u = {}; for (const n of names) u[n] = gl.getUniformLocation(p, n); return { p, u }; };
  const progs = {
    env: mapU(pEnv, ["uViewProj", "uCamPos", "uCamFwd", "uCamRight", "uCamUp", "uExtra"]),
    prim: mapU(pPrim, ["uViewProj", "uCamPos", "uPassMode"]),
  };

  const emptyVao = gl.createVertexArray();
  const mesh = createPrimitiveMesh();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const mkAttr = (loc, data, size) => {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  mkAttr(0, mesh.positions, 3);
  mkAttr(1, mesh.normals, 3);
  mkAttr(2, mesh.uvs, 2);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  const TOTAL = MAX_INSTANCES + GL_BULLETS + 400;
  const instData = new Float32Array(TOTAL * 16);
  const instVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
  gl.bufferData(gl.ARRAY_BUFFER, instData.byteLength, gl.DYNAMIC_DRAW);
  for (let a = 0; a < 4; a++) {
    gl.enableVertexAttribArray(3 + a);
    gl.vertexAttribPointer(3 + a, 4, gl.FLOAT, false, 64, a * 16);
    gl.vertexAttribDivisor(3 + a, 1);
  }
  gl.bindVertexArray(null);

  const ctrl = createCollisionsController("webgl2");
  const swarms = [createFallbackSwarm(), createFallbackSwarm()];
  let lastDt = 0.016, simTime = 0, pausedNow = false;

  return {
    id: "collisions",
    backend: "webgl2",
    maxPixels: 900000,
    defaultCamera: DEFAULT_CAMERA,

    enterStep(idx) { ctrl.enterStep(idx); },
    onReset() { ctrl.onReset(); },
    triggerAction(id) { ctrl.triggerAction(id); },
    isActionActive(id) { return ctrl.isActionActive(id); },
    onCanvasClick(x, y) { ctrl.onCanvasClick(x, y); },
    getTechBadge(idx) { return ctrl.getTechBadge(idx); },
    resize() {},
    update(dt, paused) {
      pausedNow = paused;
      lastDt = paused ? 0 : Math.min(dt, 0.033);
      if (!paused) simTime += lastDt;
      ctrl.update(dt, paused);
    },
    render(w, h, step, split, cam) {
      const stageR = split.enabled ? (step.compareRight ?? step.stage ?? 7) : (step.stage ?? 0);
      const stageL = split.enabled ? (step.compareLeft ?? 0) : stageR;
      ctrl.setActiveStages(stageL, stageR);

      const basis = computeCameraBasis(cam, w / Math.max(1, h));
      const splitX = Math.max(1, Math.min(w - 1, Math.round(split.pos * w)));
      gl.viewport(0, 0, w, h);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      const drawSide = (side, stageIdx, sx, sw) => {
        if (sw <= 0) return;
        const sObj = ctrl.getSim(stageIdx);
        const sim = sObj.sim;
        const wHalf = (sim.stage === 6 && !sim.thinWall) ? 0.34 : 0.08;
        if (sim.resetGpuPending) { swarms[side].reset(sim.stage); sim.resetGpuPending = false; }
        if (!pausedNow && lastDt > 0) {
          swarms[side].step(lastDt, sim.stage, wHalf, sim.shockwavePending);
          sim.shockwavePending = false;
        }

        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, 0, sw, h);

        // Pass A: Tactical floor
        gl.depthFunc(gl.ALWAYS); gl.depthMask(true); gl.disable(gl.BLEND);
        const pe = progs.env;
        gl.useProgram(pe.p);
        gl.uniformMatrix4fv(pe.u.uViewProj, false, basis.viewProjGL);
        gl.uniform4f(pe.u.uCamPos, basis.eye[0], basis.eye[1], basis.eye[2], basis.tanHalf);
        gl.uniform4f(pe.u.uCamFwd, basis.fwd[0], basis.fwd[1], basis.fwd[2], basis.aspect);
        gl.uniform4f(pe.u.uCamRight, basis.right[0], basis.right[1], basis.right[2], simTime);
        gl.uniform4f(pe.u.uCamUp, basis.up[0], basis.up[1], basis.up[2], sim.stage);
        gl.uniform4f(pe.u.uExtra, 0, sim.wallFlashBad, 0, sim.wallFlashGood);
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        let total = sObj.packInstances(instData, MAX_INSTANCES);
        total = swarms[side].pack(instData, total, TOTAL, sim.stage);
        if (total > 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, instData.subarray(0, total * 16));
          const pp = progs.prim;
          gl.useProgram(pp.p);
          gl.uniformMatrix4fv(pp.u.uViewProj, false, basis.viewProjGL);
          gl.uniform4f(pp.u.uCamPos, basis.eye[0], basis.eye[1], basis.eye[2], basis.tanHalf);
          gl.bindVertexArray(vao);

          // Pass B1: Opaque
          gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
          gl.uniform1f(pp.u.uPassMode, 0.0);
          gl.drawElementsInstanced(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0, total);

          // Pass B2: Translucent hulls, tick ghosts, rings & spatial grid cells
          gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.uniform1f(pp.u.uPassMode, 1.0);
          gl.drawElementsInstanced(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0, total);
          gl.disable(gl.BLEND); gl.depthMask(true);
        }
      };

      if (split.enabled) {
        drawSide(0, stageL, 0, splitX);
        drawSide(1, stageR, splitX, w - splitX);
      } else {
        drawSide(1, stageR, 0, w);
      }
      gl.disable(gl.SCISSOR_TEST);
    },
  };
}
