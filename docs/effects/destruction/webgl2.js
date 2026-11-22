// Automatic WebGL2 Fallback engine for Evolution of Destruction & Fracturing (1998-2023).
// Runs seamlessly on browsers without WebGPU (or when ?renderer=webgl2 is passed in the URL):
//   - 32x48x32 (49,152 voxels) GL_R8UI 3D Texture with exact 3D DDA Voxel Raymarching, Voxel AO & Voxel Sun Shadows
//   - Exact real-time Red Faction Geo-Mod CSG Boolean SDF raymarcher
//   - Hardware-instanced PBR structural blocks, bent DMM steel girders, Voronoi fracture wedges & 1,024 live debris
//   - Shared hardware depth buffer + scissor-split live dual-era comparison

import { FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import {
  DEFAULT_CAMERA, TOWER_BOUNDS, MAX_INSTANCES, MAX_CRATERS, MAX_DUST,
  computeCameraBasis, createAdaptiveBlockMesh, createDestructionController, mulberry32,
} from "./shared.js";

const VOX_DIMS = [32, 48, 32];
const MAX_GL_DEBRIS = 1024;

const ENV_FS = /* glsl */`#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;

in vec2 vUv;
out vec4 fragColor;

uniform mat4 uViewProj;
uniform vec4 uCamPos;    // xyz, tanHalf
uniform vec4 uCamFwd;    // xyz, aspect
uniform vec4 uCamRight;  // xyz, time
uniform vec4 uCamUp;     // xyz, stage
uniform vec4 uFlash;     // xyz, intensity
uniform vec4 uExtra;     // craterCount, stressView, voronoiFlash, 0
uniform vec4 uVoxMin;    // minX, minY, minZ, nx
uniform vec4 uVoxSpan;   // spanX, spanY, spanZ, ny
uniform float uVoxNz;
uniform vec4 uCraters[16];
uniform usampler3D uVoxTex;

const vec3 SUN_DIR = vec3(0.58, 0.72, 0.38);

float hash3(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

vec2 towerCSG(vec3 p) {
  float outerBox = sdBox(p - vec3(0.0, 2.65, 0.0), vec3(1.56, 2.65, 1.56));
  float innerVoid = sdBox(p - vec3(0.0, 2.50, 0.0), vec3(1.08, 2.38, 1.08));
  float midSlab = sdBox(p - vec3(0.0, 2.61, 0.0), vec3(1.58, 0.14, 1.58));
  float roofSlab = sdBox(p - vec3(0.0, 5.22, 0.0), vec3(1.62, 0.14, 1.62));
  vec2 ap = abs(p.xz) - vec2(1.28, 1.28);
  float pillars = sdBox(vec3(ap.x, p.y - 2.62, ap.y), vec3(0.34, 2.62, 0.34));
  float doorCut = sdBox(p - vec3(0.0, 1.08, 1.38), vec3(0.45, 1.08, 0.45));
  float winZ = sdBox(vec3(p.x, p.y - 4.08, abs(p.z) - 1.38), vec3(0.40, 0.68, 0.45));
  float winX = sdBox(vec3(abs(p.x) - 1.38, p.y - 4.08, p.z), vec3(0.45, 0.68, 0.40));

  float d = max(outerBox, -innerVoid);
  d = min(d, midSlab);
  d = min(d, roofSlab);
  d = min(d, pillars);
  d = max(d, -doorCut);
  d = max(d, -winZ);
  d = max(d, -winX);

  vec2 mp = abs(p.xz) - vec2(1.36, 1.36);
  float merlon = sdBox(vec3(mp.x, p.y - 5.50, mp.y), vec3(0.28, 0.20, 0.28));
  d = min(d, merlon);

  float mat = 0.0;
  if (pillars < outerBox + 0.04 || abs(p.y - 2.61) < 0.16) mat = 1.0;
  if (p.y > 5.08) mat = 2.0;

  int nCrat = int(uExtra.x + 0.5);
  for (int i = 0; i < 16; i++) {
    if (i >= nCrat) break;
    vec4 c = uCraters[i];
    vec3 rel = p - c.xyz;
    float rough = (sin(rel.x * 9.5) * cos(rel.y * 10.2) * sin(rel.z * 9.1)) * 0.12 * c.w;
    float cd = length(rel) - (c.w + rough);
    if (-cd > d) {
      d = -cd;
      mat = 5.0;
    }
  }
  return vec2(d, mat);
}

vec3 calcCSGNormal(vec3 p) {
  vec2 e = vec2(0.008, -0.008);
  return normalize(
    e.xyy * towerCSG(p + e.xyy).x +
    e.yyx * towerCSG(p + e.yyx).x +
    e.yxy * towerCSG(p + e.yxy).x +
    e.xxx * towerCSG(p + e.xxx).x
  );
}

uint getVoxel(ivec3 c) {
  ivec3 dims = ivec3(int(uVoxMin.w), int(uVoxSpan.w), int(uVoxNz));
  if (c.x < 0 || c.y < 0 || c.z < 0 || c.x >= dims.x || c.y >= dims.y || c.z >= dims.z) return 0u;
  return texelFetch(uVoxTex, c, 0).r;
}

vec3 voxMatColor(uint m, ivec3 cell) {
  float j = (hash3(vec3(cell)) - 0.5) * 0.06;
  if (m == 1u) return vec3(0.76, 0.34, 0.21) + j;
  if (m == 2u) return vec3(0.68, 0.44, 0.31) + j;
  if (m == 3u) return vec3(0.79, 0.75, 0.67) + j * 0.7;
  if (m == 4u) return vec3(0.24, 0.27, 0.33) + j * 0.5;
  if (m == 5u) return vec3(0.28, 0.68, 0.84);
  if (m == 6u) return vec3(0.29, 0.32, 0.37);
  if (m == 7u) return vec3(0.14, 0.13, 0.12) + j * 0.4;
  if (m == 8u) return vec3(0.42, 0.26, 0.16);
  return vec3(1.0, 0.34, 0.16);
}

float voxShadowRay(vec3 ro, vec3 rd) {
  vec3 dims = vec3(uVoxMin.w, uVoxSpan.w, uVoxNz);
  vec3 gp = (ro - uVoxMin.xyz) / uVoxSpan.xyz * dims;
  ivec3 cell = ivec3(floor(gp));
  ivec3 sd = ivec3(rd.x >= 0.0 ? 1 : -1, rd.y >= 0.0 ? 1 : -1, rd.z >= 0.0 ? 1 : -1);
  vec3 invRd = 1.0 / (rd / uVoxSpan.xyz * dims + vec3(1e-6));
  vec3 stepOff = vec3(rd.x >= 0.0 ? 1.0 : 0.0, rd.y >= 0.0 ? 1.0 : 0.0, rd.z >= 0.0 ? 1.0 : 0.0);
  vec3 tMax = (vec3(cell) + stepOff - gp) * invRd;
  vec3 tDelta = abs(invRd);
  for (int i = 0; i < 40; i++) {
    if (tMax.x < tMax.y) {
      if (tMax.x < tMax.z) { cell.x += sd.x; tMax.x += tDelta.x; }
      else { cell.z += sd.z; tMax.z += tDelta.z; }
    } else {
      if (tMax.y < tMax.z) { cell.y += sd.y; tMax.y += tDelta.y; }
      else { cell.z += sd.z; tMax.z += tDelta.z; }
    }
    if (cell.x < 0 || cell.y < 0 || cell.z < 0 ||
        cell.x >= int(dims.x) || cell.y >= int(dims.y) || cell.z >= int(dims.z)) return 1.0;
    if (getVoxel(cell) != 0u) return 0.24;
  }
  return 1.0;
}

vec3 skyColor(vec3 rd) {
  vec3 sun = normalize(SUN_DIR);
  float h = clamp(rd.y, 0.0, 1.0);
  vec3 col = mix(vec3(0.56, 0.66, 0.78), vec3(0.14, 0.34, 0.66), pow(h, 0.45));
  col = mix(col, vec3(0.06, 0.14, 0.34), smoothstep(0.28, 0.88, h));
  float sDot = max(0.0, dot(rd, sun));
  col += vec3(1.0, 0.74, 0.42) * pow(sDot, 10.0) * 0.45;
  col += vec3(1.0, 0.94, 0.78) * smoothstep(0.996, 0.9994, sDot) * 1.4;
  return col;
}

float worldToDepthGL(vec3 wp) {
  vec4 clip = uViewProj * vec4(wp, 1.0);
  return clamp(0.5 * (clip.z / clip.w) + 0.5, 0.0, 0.9999);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(
    uCamFwd.xyz +
    uCamRight.xyz * (ndc.x * uCamPos.w * uCamFwd.w) +
    uCamUp.xyz * (ndc.y * uCamPos.w)
  );
  vec3 ro = uCamPos.xyz;
  vec3 sun = normalize(SUN_DIR);
  int stage = int(uCamUp.w + 0.5);

  vec3 col = skyColor(rd);
  float bestT = 1e6;
  vec3 hitPos = ro + rd * 80.0;
  bool didHit = false;

  // 1) Sunlit limestone flagstone plaza
  if (rd.y < -0.001) {
    float tg = -ro.y / rd.y;
    if (tg > 0.1 && tg < 85.0) {
      bestT = tg;
      hitPos = ro + rd * tg;
      didHit = true;
      vec2 p = hitPos.xz;
      vec2 tile = floor(p * 0.75);
      vec2 tf = fract(p * 0.75);
      float grout = smoothstep(0.025, 0.055, min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y)));
      float tv = (hash3(vec3(tile.x, 0.0, tile.y)) - 0.5) * 0.06;
      vec3 base = mix(vec3(0.26, 0.24, 0.23), vec3(0.46, 0.43, 0.39) + tv, grout);

      float padBox = max(abs(p.x), abs(p.y));
      if (padBox < 2.25 && padBox > 1.85) base *= 0.82;

      int nCrat = int(uExtra.x + 0.5);
      for (int i = 0; i < 16; i++) {
        if (i >= nCrat) break;
        vec4 c = uCraters[i];
        float gd = length(hitPos.xz - c.xz);
        float scorch = smoothstep(c.w * 1.45, 0.15, gd) * smoothstep(3.4, 0.2, c.y);
        base = mix(base, vec3(0.14, 0.12, 0.11), scorch * 0.65);
      }

      float towerShadow = smoothstep(1.95, 1.35, max(abs(hitPos.x - sun.x * 1.8), abs(hitPos.z - sun.z * 1.8)));
      float shadow = 1.0 - towerShadow * 0.42;
      if (stage == 6) {
        vec3 bmin = uVoxMin.xyz;
        vec3 bmax = uVoxMin.xyz + uVoxSpan.xyz;
        vec3 invS = 1.0 / (sun + vec3(1e-6));
        vec3 t0 = (bmin - (hitPos + vec3(0.0, 0.02, 0.0))) * invS;
        vec3 t1 = (bmax - (hitPos + vec3(0.0, 0.02, 0.0))) * invS;
        float tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
        float tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
        if (tFar > max(0.0, tNear)) {
          shadow = voxShadowRay(hitPos + vec3(0.0, 0.02, 0.0) + sun * (max(0.0, tNear) + 0.01), sun);
        } else {
          shadow = 1.0;
        }
      }
      float footDist = max(0.0, max(abs(p.x) - 1.62, abs(p.y) - 1.62));
      float ao = 0.72 + 0.28 * smoothstep(0.0, 0.85, footDist);
      vec3 lit = base * (vec3(0.30, 0.36, 0.46) * ao + vec3(1.08, 0.96, 0.82) * sun.y * shadow);
      float fDist = length(hitPos - uFlash.xyz);
      vec3 flashLit = vec3(1.0, 0.56, 0.20) * (uFlash.w * 2.8 / (1.0 + fDist * fDist * 0.55));
      float fog = smoothstep(24.0, 78.0, tg);
      col = mix(lit + flashLit, skyColor(vec3(rd.x, 0.05, rd.z)), fog);
    }
  }

  // 2) Stage 1: Geo-Mod CSG Raymarch
  if (stage == 1) {
    vec3 bmin = vec3(-1.72, 0.0, -1.72);
    vec3 bmax = vec3( 1.72, 5.75, 1.72);
    vec3 invRd = 1.0 / (rd + vec3(1e-6));
    vec3 t0 = (bmin - ro) * invRd;
    vec3 t1 = (bmax - ro) * invRd;
    float tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    float tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    if (tFar > max(0.0, tNear) && tNear < bestT) {
      float t = max(0.02, tNear);
      for (int s = 0; s < 68; s++) {
        if (t > min(tFar, bestT)) break;
        vec3 p = ro + rd * t;
        vec2 res = towerCSG(p);
        if (res.x < 0.005) {
          bestT = t;
          hitPos = p;
          didHit = true;
          vec3 n = calcCSGNormal(p);
          vec3 alb = vec3(0.76, 0.35, 0.22);
          if (res.y < 0.5) {
            float row = floor(p.y * 5.2);
            float u = (abs(n.z) > 0.5 ? p.x : p.z) * 2.4 + mod(row, 2.0) * 0.5;
            float bm = step(0.08, fract(p.y * 5.2)) * step(0.06, fract(u));
            alb = mix(vec3(0.62, 0.58, 0.52), vec3(0.77, 0.34, 0.21), bm);
          } else if (res.y < 1.5) {
            alb = vec3(0.80, 0.76, 0.68);
          } else if (res.y < 2.5) {
            alb = vec3(0.24, 0.27, 0.34);
          } else {
            alb = vec3(0.22, 0.20, 0.19) + hash3(floor(p * 14.0)) * 0.14;
          }
          float ndl = max(0.0, dot(n, sun));
          float hemi = 0.5 + 0.5 * n.y;
          vec3 amb = mix(vec3(0.28, 0.25, 0.24), vec3(0.38, 0.48, 0.64), hemi);
          float fDist = length(p - uFlash.xyz);
          vec3 fLit = vec3(1.0, 0.55, 0.2) * (uFlash.w * 2.4 / (1.0 + fDist * fDist * 0.6));
          col = alb * (amb * 0.72 + vec3(1.15, 1.0, 0.85) * ndl) + fLit;
          break;
        }
        t += max(0.014, res.x * 0.88);
      }
    }
  }

  // 3) Stage 6: 32x48x32 3D DDA Voxel Raymarching
  if (stage == 6) {
    vec3 bmin = uVoxMin.xyz;
    vec3 bmax = uVoxMin.xyz + uVoxSpan.xyz;
    vec3 invRd = 1.0 / (rd + vec3(1e-6));
    vec3 t0 = (bmin - ro) * invRd;
    vec3 t1 = (bmax - ro) * invRd;
    float tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    float tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    if (tFar > max(0.0, tNear) && tNear < bestT) {
      float tStart = max(0.001, tNear) + 0.0005;
      vec3 dims = vec3(uVoxMin.w, uVoxSpan.w, uVoxNz);
      vec3 entry = ro + rd * tStart;
      vec3 gp = clamp((entry - bmin) / uVoxSpan.xyz * dims, vec3(0.001), dims - vec3(0.001));
      ivec3 cell = ivec3(floor(gp));
      ivec3 sd = ivec3(rd.x >= 0.0 ? 1 : -1, rd.y >= 0.0 ? 1 : -1, rd.z >= 0.0 ? 1 : -1);
      vec3 invG = 1.0 / (rd / uVoxSpan.xyz * dims + vec3(1e-6));
      vec3 stepOff = vec3(rd.x >= 0.0 ? 1.0 : 0.0, rd.y >= 0.0 ? 1.0 : 0.0, rd.z >= 0.0 ? 1.0 : 0.0);
      vec3 tMax = (vec3(cell) + stepOff - gp) * invG;
      vec3 tDelta = abs(invG);

      ivec3 mask = ivec3(0);
      if (tNear > 0.0) {
        vec3 m0 = min(t0, t1);
        if (m0.x > m0.y && m0.x > m0.z) mask = ivec3(-sd.x, 0, 0);
        else if (m0.y > m0.z) mask = ivec3(0, -sd.y, 0);
        else mask = ivec3(0, 0, -sd.z);
      }

      float tCur = tStart;
      for (int it = 0; it < 120; it++) {
        if (cell.x < 0 || cell.y < 0 || cell.z < 0 ||
            cell.x >= int(dims.x) || cell.y >= int(dims.y) || cell.z >= int(dims.z)) break;
        uint m = getVoxel(cell);
        if (m != 0u) {
          if (tCur < bestT) {
            bestT = tCur;
            hitPos = ro + rd * tCur;
            didHit = true;
            vec3 n = vec3(mask);
            ivec3 nc = cell + mask;
            float occ = 0.0;
            if (mask.x != 0) {
              occ += float(getVoxel(nc + ivec3(0,1,0)) != 0u) + float(getVoxel(nc + ivec3(0,-1,0)) != 0u) +
                     float(getVoxel(nc + ivec3(0,0,1)) != 0u) + float(getVoxel(nc + ivec3(0,0,-1)) != 0u);
            } else if (mask.y != 0) {
              occ += float(getVoxel(nc + ivec3(1,0,0)) != 0u) + float(getVoxel(nc + ivec3(-1,0,0)) != 0u) +
                     float(getVoxel(nc + ivec3(0,0,1)) != 0u) + float(getVoxel(nc + ivec3(0,0,-1)) != 0u);
            } else {
              occ += float(getVoxel(nc + ivec3(1,0,0)) != 0u) + float(getVoxel(nc + ivec3(-1,0,0)) != 0u) +
                     float(getVoxel(nc + ivec3(0,1,0)) != 0u) + float(getVoxel(nc + ivec3(0,-1,0)) != 0u);
            }
            float voxAO = 1.0 - occ * 0.14;
            vec3 fp = fract((hitPos - bmin) / uVoxSpan.xyz * dims);
            float e2 = (mask.x != 0) ? min(min(fp.y, 1.0-fp.y), min(fp.z, 1.0-fp.z))
                     : ((mask.y != 0) ? min(min(fp.x, 1.0-fp.x), min(fp.z, 1.0-fp.z))
                     : min(min(fp.x, 1.0-fp.x), min(fp.y, 1.0-fp.y)));
            float bevel = 0.87 + 0.13 * smoothstep(0.0, 0.14, e2);
            float ndl = max(0.0, dot(n, sun));
            float sh = ndl > 0.01 ? voxShadowRay(hitPos + n * 0.05, sun) : 0.35;
            vec3 alb = voxMatColor(m, cell) * bevel;
            float hemi = 0.5 + 0.5 * n.y;
            vec3 amb = mix(vec3(0.30, 0.27, 0.25), vec3(0.42, 0.54, 0.72), hemi) * voxAO;
            vec3 c = alb * (amb * 0.76 + vec3(1.22, 1.06, 0.88) * ndl * sh);
            if (m == 5u) c = mix(c, skyColor(reflect(rd, n)), 0.42);
            else if (m == 9u) c += vec3(1.2, 0.25, 0.08);
            float fDist = length(hitPos - uFlash.xyz);
            c += vec3(1.0, 0.55, 0.2) * (uFlash.w * 2.5 / (1.0 + fDist * fDist * 0.6));
            col = c;
          }
          break;
        }
        if (tMax.x < tMax.y) {
          if (tMax.x < tMax.z) { tCur = tStart + tMax.x; cell.x += sd.x; tMax.x += tDelta.x; mask = ivec3(-sd.x, 0, 0); }
          else { tCur = tStart + tMax.z; cell.z += sd.z; tMax.z += tDelta.z; mask = ivec3(0, 0, -sd.z); }
        } else {
          if (tMax.y < tMax.z) { tCur = tStart + tMax.y; cell.y += sd.y; tMax.y += tDelta.y; mask = ivec3(0, -sd.y, 0); }
          else { tCur = tStart + tMax.z; cell.z += sd.z; tMax.z += tDelta.z; mask = ivec3(0, 0, -sd.z); }
        }
      }
    }
  }

  vec3 mapped = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  fragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
  gl_FragDepth = didHit ? worldToDepthGL(hitPos) : 0.9998;
}
`;

const BLOCK_VS = /* glsl */`#version 300 es
precision highp float;

layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUv;
layout(location=3) in vec4 iV0; // pos.xyz, matId
layout(location=4) in vec4 iV1; // rot.xyz, shapeType
layout(location=5) in vec4 iV2; // scale.xyz, stress
layout(location=6) in vec4 iV3; // seed, bendAmt, crackGlow, age

uniform mat4 uViewProj;

out vec3 vWPos;
out vec3 vWNrm;
out vec3 vLPos;
out vec3 vScale;
out vec4 vMeta;
out float vShape;

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
  float shape = iV1.w;
  float seed = iV3.x;
  float bendAmt = iV3.y;
  vec3 lp = aPos;
  vec3 ln = aNrm;

  if (shape > 2.5) {
    lp = normalize(aPos) * 0.5;
    ln = normalize(aPos);
  } else if (shape > 1.5) {
    float arch = (1.0 - 4.0 * lp.y * lp.y) * bendAmt * 0.42;
    float archX = (1.0 - 4.0 * lp.x * lp.x) * bendAmt * 0.28;
    lp.z += arch + archX;
  } else if (shape > 0.5) {
    float s1 = fract(seed * 17.31);
    float s2 = fract(seed * 41.73);
    float s3 = fract(seed * 73.19);
    lp.x *= mix(0.28, 1.18, clamp(lp.y + 0.5 + (s1 - 0.5) * 0.5, 0.0, 1.0));
    lp.z *= mix(0.32, 1.15, clamp(lp.x + 0.5 + (s2 - 0.5) * 0.5, 0.0, 1.0));
    lp.y += (lp.x * (s2 - 0.5) + lp.z * (s3 - 0.5)) * 0.58;
  }

  vec3 scaled = lp * iV2.xyz;
  vec3 wp = iV0.xyz + rotXYZ(scaled, iV1.xyz);
  vec3 wn = normalize(rotXYZ(ln, iV1.xyz));

  gl_Position = uViewProj * vec4(wp, 1.0);
  vWPos = wp;
  vWNrm = wn;
  vLPos = scaled;
  vScale = iV2.xyz;
  vMeta = vec4(iV0.w, iV2.w, iV3.z, seed);
  vShape = shape;
}
`;

const BLOCK_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 vWPos;
in vec3 vWNrm;
in vec3 vLPos;
in vec3 vScale;
in vec4 vMeta;
in float vShape;

uniform vec4 uCamPos;
uniform vec4 uCamRight; // xyz, time
uniform vec4 uFlash;
uniform vec4 uExtra;    // craterCount, stressView, voronoiFlash, 0

out vec4 fragColor;

const vec3 SUN_DIR = vec3(0.58, 0.72, 0.38);

float hash3(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}

float voronoiEdge(vec3 p) {
  vec3 n = floor(p), f = fract(p);
  float md1 = 8.0, md2 = 8.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 o = vec3(
          hash3(n + g),
          hash3(n + g + vec3(17.1, 31.7, 11.3)),
          hash3(n + g + vec3(43.2, 7.9, 29.4))
        );
        vec3 r = g + o * 0.82 - f;
        float d = dot(r, r);
        if (d < md1) { md2 = md1; md1 = d; }
        else if (d < md2) { md2 = d; }
      }
    }
  }
  return sqrt(md2) - sqrt(md1);
}

vec3 stressRamp(float s) {
  float t = clamp(s, 0.0, 1.0);
  if (t < 0.45) return mix(vec3(0.14, 0.82, 0.45), vec3(1.0, 0.82, 0.16), t / 0.45);
  return mix(vec3(1.0, 0.82, 0.16), vec3(1.0, 0.14, 0.12), (t - 0.45) / 0.55);
}

void main() {
  vec3 sun = normalize(SUN_DIR);
  vec3 viewDir = normalize(uCamPos.xyz - vWPos);
  int mat = int(vMeta.x + 0.5);
  float stress = vMeta.y;
  float crackGlow = vMeta.z;
  float seed = vMeta.w;

  vec3 rawFace = cross(dFdx(vWPos), dFdy(vWPos));
  float fl = length(rawFace);
  vec3 faceN = fl > 1e-5 ? rawFace / fl : vWNrm;
  if (dot(faceN, vWNrm) < 0.0) faceN = -faceN;
  vec3 n = normalize((vShape > 0.5 && vShape < 2.5) ? faceN : vWNrm);

  vec3 alb = vec3(0.75, 0.35, 0.22);
  float rough = 0.72, metal = 0.0;
  vec3 emissive = vec3(0.0);

  vec3 halfS = max(vScale * 0.5, vec3(0.01));
  float edgeDist = min(min(halfS.x - abs(vLPos.x), halfS.y - abs(vLPos.y)), halfS.z - abs(vLPos.z));
  float microBevel = 0.84 + 0.16 * smoothstep(0.0, 0.025, edgeDist);

  if (mat == 0) {
    float by = (vLPos.y + halfS.y) * 5.2;
    float row = floor(by);
    float bx = (vLPos.x + vLPos.z + halfS.x + halfS.z) * 2.5 + mod(row, 2.0) * 0.5;
    float mortar = step(0.11, fract(by)) * step(0.07, fract(bx));
    float tint = (hash3(vec3(floor(bx), row, floor(seed * 19.0))) - 0.5) * 0.14;
    alb = mix(vec3(0.66, 0.61, 0.54), vec3(0.78, 0.34, 0.21) + tint, mortar) * microBevel;
    rough = 0.78;
  } else if (mat == 1) {
    float grain = (hash3(floor(vLPos * 18.0 + seed * 7.0)) - 0.5) * 0.07;
    float seam = smoothstep(0.02, 0.06, abs(fract((vLPos.y + halfS.y) * 1.6) - 0.5));
    alb = (vec3(0.81, 0.77, 0.69) + grain) * (0.90 + 0.10 * seam) * microBevel;
    rough = 0.74;
  } else if (mat == 2) {
    alb = vec3(0.24, 0.27, 0.34) * microBevel;
    rough = 0.58;
  } else if (mat == 3) {
    float rust = smoothstep(0.55, 0.85, hash3(floor(vLPos * 12.0 + seed * 9.0)));
    alb = mix(vec3(0.32, 0.36, 0.42), vec3(0.46, 0.24, 0.15), rust * 0.35);
    rough = 0.34; metal = 0.78;
  } else if (mat == 4) {
    float fres = pow(1.0 - max(0.0, dot(n, viewDir)), 3.0);
    alb = mix(vec3(0.16, 0.50, 0.68), vec3(0.76, 0.92, 1.0), fres * 0.75);
    rough = 0.12; metal = 0.25;
  } else if (mat == 5) {
    alb = vec3(0.13, 0.12, 0.11); rough = 0.92;
  } else if (mat == 6) {
    alb = vec3(1.0, 0.48, 0.14); emissive = vec3(2.4, 0.92, 0.24); rough = 0.25;
  } else if (mat == 7) {
    alb = vec3(0.68, 0.66, 0.62) + (hash3(floor(vLPos * 28.0 + seed * 13.0)) - 0.5) * 0.16;
    rough = 0.90;
  } else {
    int chk = (int(floor((vLPos.x + vLPos.z) * 4.5)) + int(floor(vLPos.y * 4.5))) & 1;
    alb = chk == 0 ? vec3(0.70, 0.36, 0.23) : vec3(0.56, 0.28, 0.19);
    rough = 0.95;
  }

  if (stress > 0.04) {
    vec3 sCol = stressRamp(stress);
    float mixAmt = uExtra.y > 0.5 ? (0.52 + stress * 0.35) : (smoothstep(0.30, 0.92, stress) * 0.68);
    alb = mix(alb, sCol, mixAmt);
    if (stress > 0.72) {
      float ve = voronoiEdge(vWPos * 3.1);
      float crackLine = smoothstep(0.11, 0.02, ve);
      float pulse = 0.75 + 0.25 * sin(uCamRight.w * 14.0);
      emissive += vec3(1.6, 0.25, 0.08) * crackLine * smoothstep(0.72, 0.96, stress) * pulse;
    }
  }

  if (crackGlow > 0.03) {
    float ve = voronoiEdge(vWPos * 2.6 + vec3(0.4, 0.7, 0.2));
    float web = smoothstep(0.11, 0.015, ve);
    emissive += vec3(1.8, 0.88, 0.22) * web * crackGlow;
    alb = mix(alb, vec3(0.95, 0.78, 0.45), web * crackGlow * 0.45);
  }

  float ndl = max(0.0, dot(n, sun));
  vec3 hVec = normalize(sun + viewDir);
  float specPow = mix(96.0, 14.0, rough);
  float spec = pow(max(0.0, dot(n, hVec)), specPow) * mix(0.28, 0.95, metal) * (1.0 - rough * 0.65);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 amb = mix(vec3(0.32, 0.27, 0.23), vec3(0.42, 0.54, 0.74), hemi);
  float groundAO = 0.72 + 0.28 * smoothstep(0.0, 0.75, vWPos.y);
  vec3 diff = alb * (1.0 - metal * 0.65);
  vec3 specCol = mix(vec3(1.0, 0.96, 0.88), alb, metal);
  float fDist = length(vWPos - uFlash.xyz);
  vec3 flashLit = vec3(1.0, 0.58, 0.22) * (uFlash.w * 3.0 / (1.0 + fDist * fDist * 0.5));

  vec3 col = diff * (amb * 0.72 * groundAO + vec3(1.20, 1.04, 0.86) * ndl) + specCol * spec * 0.85 + flashLit * alb + emissive;
  vec3 mapped = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  fragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;

const DUST_VS = /* glsl */`#version 300 es
precision highp float;

layout(location=0) in vec2 aQuad;
layout(location=1) in vec4 iD0; // pos.xyz, scale
layout(location=2) in vec4 iD1; // ageFrac, kind, seed, 0

uniform mat4 uViewProj;
uniform vec4 uCamRight;
uniform vec4 uCamUp;

out vec2 vUv;
out vec3 vInfo;

void main() {
  vec3 wp = iD0.xyz + uCamRight.xyz * (aQuad.x * iD0.w) + uCamUp.xyz * (aQuad.y * iD0.w);
  gl_Position = uViewProj * vec4(wp, 1.0);
  vUv = aQuad;
  vInfo = iD1.xyz;
}
`;

const DUST_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vInfo;
out vec4 fragColor;

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float age = clamp(vInfo.x, 0.0, 1.0);
  int kind = int(vInfo.y + 0.5);
  if (kind == 2) {
    float ring = smoothstep(0.70, 0.88, r) * smoothstep(1.0, 0.89, r);
    fragColor = vec4(1.0, 0.88, 0.68, ring * (1.0 - age) * (1.0 - age) * 0.72);
    return;
  }
  if (kind == 1) {
    float core = pow(max(0.0, 1.0 - r), 1.8);
    vec3 col = mix(vec3(1.0, 0.38, 0.08), vec3(1.0, 0.96, 0.74), core);
    fragColor = vec4(col, core * (1.0 - age) * 0.85);
    return;
  }
  float puff = pow(max(0.0, 1.0 - r * r), 1.6);
  float light = 0.78 + 0.22 * clamp(vUv.y * 0.5 + 0.5, 0.0, 1.0);
  float fade = smoothstep(0.0, 0.14, age) * (1.0 - age);
  fragColor = vec4(vec3(0.82, 0.74, 0.64) * light, puff * fade * 0.34);
}
`;

// Compact 1,024-particle CPU debris fallback matching the WebGPU compute shader equations
function createFallbackDebrisPool() {
  const rng = mulberry32(202307);
  const pos = new Float32Array(MAX_GL_DEBRIS * 3);
  const vel = new Float32Array(MAX_GL_DEBRIS * 3);
  const rot = new Float32Array(MAX_GL_DEBRIS * 3);
  const scale = new Float32Array(MAX_GL_DEBRIS * 3);
  const mat = new Float32Array(MAX_GL_DEBRIS);
  const shape = new Float32Array(MAX_GL_DEBRIS);
  const life = new Float32Array(MAX_GL_DEBRIS);
  const seed = new Float32Array(MAX_GL_DEBRIS);
  let cursor = 0;

  return {
    reset() { life.fill(0); cursor = 0; },
    emit(ev) {
      if (ev.reset) { this.reset(); return; }
      const cnt = Math.min(Math.round((ev.count || 300) * 0.32), 380);
      const outL = Math.hypot(ev.pos[0], ev.pos[2]) || 1;
      const ox = ev.pos[0] / outL, oz = ev.pos[2] / outL;
      for (let i = 0; i < cnt; i++) {
        const s = cursor;
        cursor = (cursor + 1) % MAX_GL_DEBRIS;
        const th = rng() * Math.PI * 2;
        const cp = rng() * 2 - 1;
        const sp = Math.sqrt(Math.max(0, 1 - cp * cp));
        const dx = sp * Math.cos(th), dy = cp, dz = sp * Math.sin(th);
        const r = ev.radius * Math.pow(rng(), 0.45) * 0.6;
        pos[s * 3 + 0] = ev.pos[0] + dx * r;
        pos[s * 3 + 1] = Math.max(0.14, ev.pos[1] + dy * r);
        pos[s * 3 + 2] = ev.pos[2] + dz * r;

        const isSpark = rng() > (ev.stage === 7 ? 0.74 : 0.85);
        const spd = (2.8 + rng() * 9.0) * ev.power * (isSpark ? 1.55 : 1.0);
        vel[s * 3 + 0] = dx * spd + ox * (1.6 + rng() * 2.2);
        vel[s * 3 + 1] = dy * spd + 2.2 + rng() * 4.0;
        vel[s * 3 + 2] = dz * spd + oz * (1.6 + rng() * 2.2);
        rot[s * 3 + 0] = rng() * 6.28; rot[s * 3 + 1] = rng() * 6.28; rot[s * 3 + 2] = rng() * 6.28;
        seed[s] = rng();
        if (isSpark) {
          mat[s] = 6; shape[s] = 0;
          const sc = 0.055 * (0.7 + rng() * 0.7);
          scale[s * 3 + 0] = sc; scale[s * 3 + 1] = sc; scale[s * 3 + 2] = sc;
          life[s] = 0.55 + rng() * 0.7;
        } else {
          const m = rng();
          mat[s] = ev.stage === 6
            ? (m < 0.46 ? 0 : (m < 0.74 ? 1 : (m < 0.88 ? 5 : 2)))
            : (m < 0.45 ? 0 : (m < 0.74 ? 1 : (m < 0.88 ? 7 : 4)));
          shape[s] = (ev.stage === 5 || ev.stage === 7) && rng() > 0.35 ? 1 : 0;
          const bsc = ev.stage === 6 ? (0.08 + rng() * 0.045) : (0.08 + rng() * 0.09);
          scale[s * 3 + 0] = bsc * 1.15; scale[s * 3 + 1] = bsc * 0.85; scale[s * 3 + 2] = bsc;
          life[s] = 4.2 + rng() * 4.0;
        }
      }
    },
    step(dt) {
      for (let i = 0; i < MAX_GL_DEBRIS; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        if (life[i] <= 0) continue;
        const o = i * 3;
        const isSpark = mat[i] > 5.5 && mat[i] < 6.5;
        vel[o + 1] += (isSpark ? -11.5 : -19.2) * dt;
        if (isSpark) { const d = Math.max(0, 1 - 1.35 * dt); vel[o] *= d; vel[o + 1] *= d; vel[o + 2] *= d; }
        pos[o + 0] += vel[o + 0] * dt;
        pos[o + 1] += vel[o + 1] * dt;
        pos[o + 2] += vel[o + 2] * dt;
        const spd = Math.hypot(vel[o], vel[o + 1], vel[o + 2]);
        if (spd > 0.25) {
          const sp = (1.6 + seed[i] * 4.2) * dt * Math.min(2.2, spd * 0.35);
          rot[o] += sp; rot[o + 1] += sp * 0.77; rot[o + 2] -= sp * 0.91;
        }
        const floorY = scale[o + 1] * 0.5;
        if (pos[o + 1] < floorY) {
          pos[o + 1] = floorY;
          vel[o + 1] = vel[o + 1] < -0.55 ? -vel[o + 1] * (isSpark ? 0.5 : 0.34) : 0;
          vel[o] *= 0.74; vel[o + 2] *= 0.74;
        }
      }
    },
    pack(out, offsetCount, maxTotal) {
      let c = offsetCount;
      for (let i = 0; i < MAX_GL_DEBRIS && c < maxTotal; i++) {
        if (life[i] <= 0) continue;
        const o = c * 16, p = i * 3;
        out[o + 0] = pos[p]; out[o + 1] = pos[p + 1]; out[o + 2] = pos[p + 2]; out[o + 3] = mat[i];
        out[o + 4] = rot[p]; out[o + 5] = rot[p + 1]; out[o + 6] = rot[p + 2]; out[o + 7] = shape[i];
        out[o + 8] = scale[p]; out[o + 9] = scale[p + 1]; out[o + 10] = scale[p + 2]; out[o + 11] = 0;
        out[o + 12] = seed[i]; out[o + 13] = 0; out[o + 14] = 0; out[o + 15] = 0;
        c++;
      }
      return c;
    },
  };
}

export function createDestructionWebGL2(gl) {
  const [pEnv, pBlock, pDust] = linkPrograms(gl, [
    [FULL_VS, ENV_FS],
    [BLOCK_VS, BLOCK_FS],
    [DUST_VS, DUST_FS],
  ]);
  function mapU(p, names) {
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }
  const progs = {
    env: mapU(pEnv, ["uViewProj", "uCamPos", "uCamFwd", "uCamRight", "uCamUp", "uFlash", "uExtra", "uVoxMin", "uVoxSpan", "uVoxNz", "uCraters", "uVoxTex"]),
    block: mapU(pBlock, ["uViewProj", "uCamPos", "uCamRight", "uFlash", "uExtra"]),
    dust: mapU(pDust, ["uViewProj", "uCamRight", "uCamUp"]),
  };

  // 1) Empty VAO for fullscreen triangle
  const emptyVao = gl.createVertexArray();

  // 2) Instanced Block VAO
  const mesh = createAdaptiveBlockMesh();
  const blockVao = gl.createVertexArray();
  gl.bindVertexArray(blockVao);

  function mkAttrBuf(loc, data, size) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return b;
  }
  mkAttrBuf(0, mesh.positions, 3);
  mkAttrBuf(1, mesh.normals, 3);
  mkAttrBuf(2, mesh.uvs, 2);

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  const TOTAL_INST = MAX_INSTANCES + MAX_GL_DEBRIS;
  const instData = new Float32Array(TOTAL_INST * 16);
  const instVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
  gl.bufferData(gl.ARRAY_BUFFER, instData.byteLength, gl.DYNAMIC_DRAW);
  for (let a = 0; a < 4; a++) {
    gl.enableVertexAttribArray(3 + a);
    gl.vertexAttribPointer(3 + a, 4, gl.FLOAT, false, 64, a * 16);
    gl.vertexAttribDivisor(3 + a, 1);
  }
  gl.bindVertexArray(null);

  // 3) Instanced Dust Billboard VAO
  const dustVao = gl.createVertexArray();
  gl.bindVertexArray(dustVao);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const dustData = new Float32Array(MAX_DUST * 8);
  const dustVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, dustVbo);
  gl.bufferData(gl.ARRAY_BUFFER, dustData.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);

  // 4) 32x48x32 R8UI 3D Texture for Teardown Voxels fallback
  const voxTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, voxTex);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, VOX_DIMS[0], VOX_DIMS[1], VOX_DIMS[2], 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(VOX_DIMS[0] * VOX_DIMS[1] * VOX_DIMS[2]));
  gl.bindTexture(gl.TEXTURE_3D, null);

  const ctrl = createDestructionController("webgl2", VOX_DIMS);
  const debrisPools = [createFallbackDebrisPool(), createFallbackDebrisPool()];
  let simTime = 0;
  let lastDt = 0.016;
  let pausedNow = false;
  const craterFlat = new Float32Array(MAX_CRATERS * 4);

  return {
    id: "destruction",
    backend: "webgl2",
    maxPixels: 900000,
    defaultCamera: DEFAULT_CAMERA,

    enterStep(stepIdx) {
      ctrl.enterStep(stepIdx);
      debrisPools[0].reset();
      debrisPools[1].reset();
    },
    onReset() {
      ctrl.onReset();
      debrisPools[0].reset();
      debrisPools[1].reset();
    },
    triggerAction(actionId) {
      ctrl.triggerAction(actionId);
    },
    isActionActive(actionId) {
      return ctrl.isActionActive(actionId);
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      ctrl.onCanvasClick(ndcX, ndcY, w, h, step, cam);
    },
    getTechBadge(stepIdx) {
      return ctrl.getTechBadge(stepIdx);
    },
    resize() {},
    update(dt, paused) {
      pausedNow = paused;
      lastDt = paused ? 0 : Math.min(dt, 0.033);
      if (!paused) simTime += lastDt;
      ctrl.update(dt, paused);
    },
    render(w, h, step, split, cam) {
      const stageR = split.enabled ? (step.compareRight ?? step.stage ?? 7) : (step.stage ?? 0);
      const stageL = split.enabled ? (step.compareLeft ?? 1) : stageR;
      ctrl.setActiveStages(stageL, stageR);

      const basis = computeCameraBasis(cam, w / Math.max(1, h));
      const stressView = ctrl.isStressView();
      const splitX = Math.max(1, Math.min(w - 1, Math.round(split.pos * w)));

      gl.viewport(0, 0, w, h);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      const drawSide = (side, stageIdx, sx, sw) => {
        if (sw <= 0) return;
        const sObj = ctrl.getSim(stageIdx);
        const sim = sObj.sim;

        while (sim.gpuEmitQueue.length > 0) {
          debrisPools[side].emit(sim.gpuEmitQueue.shift());
        }
        if (!pausedNow && lastDt > 0) {
          debrisPools[side].step(lastDt);
        }

        if (sim.stage === 6 && sim.voxelDirty && sim.voxels) {
          gl.bindTexture(gl.TEXTURE_3D, voxTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, VOX_DIMS[0], VOX_DIMS[1], VOX_DIMS[2], gl.RED_INTEGER, gl.UNSIGNED_BYTE, sim.voxels);
          sim.voxelDirty = false;
          sim.voxelCarveQueue.length = 0;
        }

        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, 0, sw, h);

        // Pass A: Environment + CSG / 32x48x32 Voxels
        gl.depthFunc(gl.ALWAYS);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        const pe = progs.env;
        gl.useProgram(pe.p);
        gl.uniformMatrix4fv(pe.u.uViewProj, false, basis.viewProjGL);
        gl.uniform4f(pe.u.uCamPos, basis.eye[0], basis.eye[1], basis.eye[2], basis.tanHalf);
        gl.uniform4f(pe.u.uCamFwd, basis.fwd[0], basis.fwd[1], basis.fwd[2], basis.aspect);
        gl.uniform4f(pe.u.uCamRight, basis.right[0], basis.right[1], basis.right[2], simTime);
        gl.uniform4f(pe.u.uCamUp, basis.up[0], basis.up[1], basis.up[2], sim.stage);
        gl.uniform4f(pe.u.uFlash, sim.flashPos[0], sim.flashPos[1], sim.flashPos[2], sim.flashTime / 0.32);
        gl.uniform4f(pe.u.uExtra, sim.craters.length, stressView ? 1.0 : 0.0, sim.voronoiFlash, 0);
        gl.uniform4f(pe.u.uVoxMin, TOWER_BOUNDS.minX, TOWER_BOUNDS.minY, TOWER_BOUNDS.minZ, VOX_DIMS[0]);
        gl.uniform4f(pe.u.uVoxSpan, TOWER_BOUNDS.maxX - TOWER_BOUNDS.minX, TOWER_BOUNDS.maxY - TOWER_BOUNDS.minY, TOWER_BOUNDS.maxZ - TOWER_BOUNDS.minZ, VOX_DIMS[1]);
        gl.uniform1f(pe.u.uVoxNz, VOX_DIMS[2]);
        craterFlat.fill(0);
        for (let i = 0; i < Math.min(sim.craters.length, MAX_CRATERS); i++) {
          const c = sim.craters[i];
          craterFlat[i * 4 + 0] = c[0]; craterFlat[i * 4 + 1] = c[1]; craterFlat[i * 4 + 2] = c[2]; craterFlat[i * 4 + 3] = c[3];
        }
        gl.uniform4fv(pe.u.uCraters, craterFlat);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, voxTex);
        gl.uniform1i(pe.u.uVoxTex, 0);
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Pass B: Instanced PBR Blocks + 1,024 Debris
        let totalInst = sObj.packInstances(instData, MAX_INSTANCES, stressView);
        totalInst = debrisPools[side].pack(instData, totalInst, TOTAL_INST);
        if (totalInst > 0) {
          gl.depthFunc(gl.LESS);
          gl.depthMask(true);
          const pb = progs.block;
          gl.useProgram(pb.p);
          gl.uniformMatrix4fv(pb.u.uViewProj, false, basis.viewProjGL);
          gl.uniform4f(pb.u.uCamPos, basis.eye[0], basis.eye[1], basis.eye[2], basis.tanHalf);
          gl.uniform4f(pb.u.uCamRight, basis.right[0], basis.right[1], basis.right[2], simTime);
          gl.uniform4f(pb.u.uFlash, sim.flashPos[0], sim.flashPos[1], sim.flashPos[2], sim.flashTime / 0.32);
          gl.uniform4f(pb.u.uExtra, sim.craters.length, stressView ? 1.0 : 0.0, sim.voronoiFlash, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, instData.subarray(0, totalInst * 16));
          gl.bindVertexArray(blockVao);
          gl.drawElementsInstanced(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0, totalInst);
        }

        // Pass C: Alpha-Blended Shockwave Rings, Blast Flash & Sunlit Masonry Dust Plumes
        const dCount = Math.min(sim.dust.length, MAX_DUST);
        if (dCount > 0) {
          for (let i = 0; i < dCount; i++) {
            const d = sim.dust[i];
            const o = i * 8;
            dustData[o + 0] = d.x; dustData[o + 1] = d.y; dustData[o + 2] = d.z; dustData[o + 3] = d.scale;
            dustData[o + 4] = d.age / d.maxAge; dustData[o + 5] = d.kind; dustData[o + 6] = i * 0.13; dustData[o + 7] = 0;
          }
          gl.depthFunc(gl.LESS);
          gl.depthMask(false);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          const pd = progs.dust;
          gl.useProgram(pd.p);
          gl.uniformMatrix4fv(pd.u.uViewProj, false, basis.viewProjGL);
          gl.uniform4f(pd.u.uCamRight, basis.right[0], basis.right[1], basis.right[2], 0);
          gl.uniform4f(pd.u.uCamUp, basis.up[0], basis.up[1], basis.up[2], 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, dustVbo);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, dustData.subarray(0, dCount * 8));
          gl.bindVertexArray(dustVao);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, dCount);
          gl.disable(gl.BLEND);
          gl.depthMask(true);
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
