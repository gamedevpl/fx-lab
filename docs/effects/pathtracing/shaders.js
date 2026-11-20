// Four GLSL ES 3.00 shaders for Evolution of Path Tracing (1975-2026):
// 1. PT_TRACE_FS  — Analytical Cornell Gallery scene supporting all 8 rendering eras:
//                   0: 1975 Blinn-Phong (no shadows/reflections)
//                   1: 1980 Whitted Ray Tracing (hard shadows, sharp mirror & glass refraction)
//                   2: 1984 Cook Distributed RT (soft area shadows, glossy metal, DoF, motion blur)
//                   3: 1986 Kajiya Path Tracing (1 SPP naive unbiased GI -> heavy noise!)
//                   4: 1998 Multi-SPP Progressive Accumulation (converges when static, resets on move)
//                   5: 2005 Importance Sampling + NEE + Veach MIS (dramatic variance drop at same SPP!)
//                   6: 2020 ReSTIR Multi-Light RIS + SVGF G-buffer output (demodulated for denoiser)
//                   7: 2026 Real-Time Browser Path Tracing (live moving RGB/warm lights + ReSTIR + SVGF)
// 2. ACCUM_FS     — Progressive temporal accumulation (Stage 4) + gentle motion-aware stabilization
// 3. ATROUS_FS    — 3-pass edge-stopping joint-bilateral A-Trous SVGF denoiser (normal/depth/matId)
// 4. FINAL_FS     — Albedo re-modulation + ACES filmic tone mapping + clean split-screen divider

// ============================================================================
// PASS 1: 8-ERA ANALYTICAL CORNELL GALLERY PATH TRACER (MRT: Rad, NormDepth, Albedo)
// ============================================================================
export const PT_TRACE_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec2 uRes;
uniform float uTime;
uniform int uFrame;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uSolidLeft;   // Step 1 split: UNLIT ALBEDO vs BLINN-PHONG
uniform float uRawLeft;     // Step 7 split: RAW 2 SPP vs ReSTIR + SVGF
uniform float uDofBoost;    // Step 3 toggle: wider aperture DoF + faster pendulum motion blur
uniform float uRawNoisy;    // Step 7 toggle: show raw noisy 2 SPP input vs denoised SVGF
uniform int uExtraSpp;      // Video Stage 4 deterministic SPP burst (0 = live 2 spp progressive)
uniform vec3 uLightOrbPos;  // Step 7-8 live moving/clickable glowing emissive orb!
uniform vec3 uLightOrbCol;  // Warm amber/gold -> cyan emissive orb radiance

layout(location = 0) out vec4 outRad;       // RGB = demodulated irradiance (or direct radiance for specular/emissive), A = bypassDenoiser
layout(location = 1) out vec4 outNormDepth; // RGB = world normal, A = linear hit depth (negative -> mirror/glass/emissive bypass)
layout(location = 2) out vec4 outAlbedo;    // RGB = diffuse albedo for SVGF re-modulation, A = matId / 16.0

const float PI = 3.14159265;
const float INF = 1e9;

// Room dimensions: X in [-2.6, 2.6], Y in [0.0, 3.3], Z in [-2.6, 2.6]
const vec3 ROOM_MIN = vec3(-2.6, 0.0, -2.6);
const vec3 ROOM_MAX = vec3( 2.6, 3.3,  2.6);

// Ceiling area softbox bounds
const vec2 LIGHT_HALF = vec2(1.06, 0.94);
const float LIGHT_Y = 3.292;
const vec3 CEIL_EMIT = vec3(11.8, 10.0, 7.8);

// Fast PCG 32-bit hash RNG (zero visual correlation stripes!)
uint rngState;
uint pcgNext() {
  rngState = rngState * 747796405u + 2891336453u;
  uint word = ((rngState >> ((rngState >> 28u) + 4u)) ^ rngState) * 277803737u;
  return (word >> 22u) ^ word;
}
float rand1() {
  return float(pcgNext()) * (1.0 / 4294967296.0);
}
vec2 rand2() {
  return vec2(rand1(), rand1());
}

// Orthonormal tangent basis from unit normal (Duff et al. 2017)
void makeONB(vec3 n, out vec3 t, out vec3 b) {
  float s = (n.z >= 0.0) ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

vec3 sampleUniformHemi(vec3 n, vec2 u) {
  float z = u.x;
  float r = sqrt(max(0.0, 1.0 - z * z));
  float phi = 2.0 * PI * u.y;
  vec3 t, b; makeONB(n, t, b);
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * z);
}

vec3 sampleCosineHemi(vec3 n, vec2 u) {
  float r = sqrt(u.x);
  float phi = 2.0 * PI * u.y;
  float z = sqrt(max(0.0, 1.0 - u.x));
  vec3 t, b; makeONB(n, t, b);
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * z);
}

vec3 sampleGGXHalf(vec3 n, float alpha, vec2 u) {
  float phi = 2.0 * PI * u.x;
  float cosT = sqrt((1.0 - u.y) / max(1e-5, 1.0 + (alpha * alpha - 1.0) * u.y));
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  vec3 t, b; makeONB(n, t, b);
  return normalize(t * (sinT * cos(phi)) + b * (sinT * sin(phi)) + n * cosT);
}

// Analytical primitives
float iSphere(vec3 ro, vec3 rd, vec3 c, float r, out vec3 nOut) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float d2 = b * b - (dot(oc, oc) - r * r);
  if (d2 < 0.0) return INF;
  float sd = sqrt(d2);
  float t = -b - sd;
  if (t < 0.0015) t = -b + sd;
  if (t < 0.0015) return INF;
  nOut = (ro + rd * t - c) / r;
  return t;
}

float iBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax, out vec3 nOut) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bMin - ro) * inv;
  vec3 t1 = (bMax - ro) * inv;
  vec3 tSm = min(t0, t1);
  vec3 tBg = max(t0, t1);
  float tN = max(max(tSm.x, tSm.y), tSm.z);
  float tF = min(min(tBg.x, tBg.y), tBg.z);
  if (tF < max(tN, 0.0015)) return INF;
  float t = (tN > 0.0015) ? tN : tF;
  vec3 p = ro + rd * t;
  vec3 center = 0.5 * (bMin + bMax);
  vec3 halfSz = 0.5 * (bMax - bMin);
  vec3 d = (p - center) / halfSz;
  vec3 ad = abs(d);
  if (ad.x > ad.y && ad.x > ad.z) nOut = vec3(sign(d.x), 0.0, 0.0);
  else if (ad.y > ad.z) nOut = vec3(0.0, sign(d.y), 0.0);
  else nOut = vec3(0.0, 0.0, sign(d.z));
  return t;
}

// Material types: 0 = Diffuse, 1 = Metal/Glossy, 2 = Dielectric Glass, 3 = Emissive
struct Hit {
  float t;
  vec3 pos;
  vec3 norm;
  vec3 albedo;
  vec3 emit;
  float rough;
  int matType;
  int matId;
  bool frontFace;
};

// Swinging bronze pendulum orb position at time t (showcases Cook 1984 motion blur cleanly!)
vec3 pendulumPos(float t, float boost) {
  float freq = boost > 0.5 ? 5.2 : 3.6;
  float ang = sin(t * freq) * 0.72;
  return vec3(sin(ang) * 1.18, 2.38 - cos(ang) * 0.62, -0.35);
}

// Intersect entire Cornell Gallery scene at time rayTime
Hit intersectScene(vec3 ro, vec3 rd, int stage, float rayTime) {
  Hit h;
  h.t = INF;
  h.albedo = vec3(0.0);
  h.emit = vec3(0.0);
  h.rough = 1.0;
  h.matType = 0;
  h.matId = 0;
  h.frontFace = true;

  // 1. Cornell Gallery Room Interior (one-sided inward planes so camera orbiting outside sees right into the diorama!)
  // Floor y = 0 (hit only when travelling downward)
  if (rd.y < -1e-5) {
    float tf = (0.0 - ro.y) / rd.y;
    if (tf > 0.0015 && tf < h.t) {
      vec3 p = ro + rd * tf;
      if (abs(p.x) <= 2.61 && abs(p.z) <= 2.61) {
        h.t = tf; h.pos = p; h.norm = vec3(0.0, 1.0, 0.0);
        // Subtle architectural limestone checkerboard grid (great visual scale & reflection anchor!)
        float chk = mod(floor(p.x * 1.15) + floor(p.z * 1.15), 2.0);
        h.albedo = mix(vec3(0.62, 0.60, 0.56), vec3(0.76, 0.74, 0.70), chk);
        h.emit = vec3(0.0); h.rough = 0.85; h.matType = 0; h.matId = 1;
      }
    }
  }
  // Ceiling y = 3.3 (hit only when travelling upward)
  if (rd.y > 1e-5) {
    float tc = (3.3 - ro.y) / rd.y;
    if (tc > 0.0015 && tc < h.t) {
      vec3 p = ro + rd * tc;
      if (abs(p.x) <= 2.61 && abs(p.z) <= 2.61) {
        h.t = tc; h.pos = p; h.norm = vec3(0.0, -1.0, 0.0);
        bool inLight = (abs(p.x) < LIGHT_HALF.x && abs(p.z + 0.15) < LIGHT_HALF.y);
        if (inLight) {
          h.albedo = vec3(1.0);
          h.emit = CEIL_EMIT;
          h.matType = 3; h.matId = 2;
        } else {
          h.albedo = vec3(0.76, 0.74, 0.71);
          h.emit = vec3(0.0);
          h.matType = 0; h.matId = 3;
        }
        h.rough = 1.0;
      }
    }
  }
  // Left wall (Crimson Red, x = -2.6, inward +X) & Right wall (Emerald Teal, x = +2.6, inward -X)
  if (rd.x < -1e-5) {
    float tl = (-2.6 - ro.x) / rd.x;
    if (tl > 0.0015 && tl < h.t) {
      vec3 p = ro + rd * tl;
      if (p.y >= -0.01 && p.y <= 3.31 && abs(p.z) <= 2.61) {
        h.t = tl; h.pos = p; h.norm = vec3(1.0, 0.0, 0.0);
        h.albedo = vec3(0.78, 0.11, 0.09); // Rich Cornell crimson!
        h.emit = vec3(0.0); h.rough = 1.0; h.matType = 0; h.matId = 4;
      }
    }
  }
  if (rd.x > 1e-5) {
    float tr = (2.6 - ro.x) / rd.x;
    if (tr > 0.0015 && tr < h.t) {
      vec3 p = ro + rd * tr;
      if (p.y >= -0.01 && p.y <= 3.31 && abs(p.z) <= 2.61) {
        h.t = tr; h.pos = p; h.norm = vec3(-1.0, 0.0, 0.0);
        h.albedo = vec3(0.08, 0.62, 0.46); // Rich Cornell teal-emerald!
        h.emit = vec3(0.0); h.rough = 1.0; h.matType = 0; h.matId = 5;
      }
    }
  }
  // Back wall (z = -2.6, inward +Z) & Front enclosing wall behind camera (only hit by rays travelling +Z!)
  if (rd.z < -1e-5) {
    float tb = (-2.6 - ro.z) / rd.z;
    if (tb > 0.0015 && tb < h.t) {
      vec3 p = ro + rd * tb;
      if (p.y >= -0.01 && p.y <= 3.31 && abs(p.x) <= 2.61) {
        h.t = tb; h.pos = p; h.norm = vec3(0.0, 0.0, 1.0);
        h.albedo = vec3(0.76, 0.74, 0.70);
        h.emit = vec3(0.0); h.rough = 1.0; h.matType = 0; h.matId = 6;
      }
    }
  }
  if (rd.z > 1e-5) {
    float tFront = (6.2 - ro.z) / rd.z;
    if (tFront > 0.0015 && tFront < h.t) {
      vec3 p = ro + rd * tFront;
      if (p.y >= -0.01 && p.y <= 3.31 && abs(p.x) <= 3.2) {
        h.t = tFront; h.pos = p; h.norm = vec3(0.0, 0.0, -1.0);
        h.albedo = vec3(0.46, 0.45, 0.44);
        h.emit = vec3(0.0); h.rough = 1.0; h.matType = 0; h.matId = 6;
      }
    }
  }

  // 2. Tall White Gallery Plinth (back-left, catches huge crimson bounce + casts crisp/soft shadows!)
  vec3 nTmp;
  float tBox1 = iBox(ro, rd, vec3(-1.62, 0.0, -1.68), vec3(-0.46, 1.18, -0.58), nTmp);
  if (tBox1 < h.t) {
    h.t = tBox1; h.pos = ro + rd * tBox1; h.norm = nTmp;
    h.albedo = vec3(0.84, 0.82, 0.78);
    h.emit = vec3(0.0); h.rough = 1.0; h.matType = 0; h.matId = 7;
  }

  // 3. Matte Ceramic Hero Sphere perched on the tall back-left plinth (ultimate GI color-bleed showcase!)
  float tMatte = iSphere(ro, rd, vec3(-1.04, 1.72, -1.13), 0.54, nTmp);
  if (tMatte < h.t) {
    h.t = tMatte; h.pos = ro + rd * tMatte; h.norm = nTmp;
    h.albedo = vec3(0.86, 0.85, 0.83);
    h.emit = vec3(0.0); h.rough = 1.0; h.matType = 0; h.matId = 8;
  }

  // 4. Brushed Gold / Mirror Chrome Hero Sphere (mid-right, sharp mirror in Whitted 1980 -> glossy GGX in Cook+!)
  float tMetal = iSphere(ro, rd, vec3(1.12, 0.74, -0.92), 0.74, nTmp);
  if (tMetal < h.t) {
    h.t = tMetal; h.pos = ro + rd * tMetal; h.norm = nTmp;
    h.albedo = (stage == 1) ? vec3(0.92, 0.94, 0.97) : vec3(0.96, 0.74, 0.34); // Chrome in Whitted -> warm gold in Cook+!
    h.emit = vec3(0.0);
    h.rough = (stage <= 1) ? 0.0 : 0.16;
    h.matType = (stage == 0) ? 0 : 1;
    h.matId = 9;
  }

  // 5. Crystal Glass Refractive Sphere (front-center-left, IOR 1.52 -> shows Snell refraction & bright caustic!)
  float tGlass = iSphere(ro, rd, vec3(-0.34, 0.56, 0.68), 0.56, nTmp);
  if (tGlass < h.t) {
    h.t = tGlass; h.pos = ro + rd * tGlass; h.norm = nTmp;
    h.albedo = (stage == 0) ? vec3(0.45, 0.68, 0.82) : vec3(0.95, 0.98, 1.00);
    h.emit = vec3(0.0);
    h.rough = 0.0;
    h.matType = (stage == 0) ? 0 : 2;
    h.matId = 10;
  }

  // 6. Low Accent Plinth on front-right (catches teal wall bounce & dynamic ReSTIR orb light!)
  float tBox2 = iBox(ro, rd, vec3(0.72, 0.0, 0.42), vec3(1.76, 0.52, 1.38), nTmp);
  if (tBox2 < h.t) {
    h.t = tBox2; h.pos = ro + rd * tBox2; h.norm = nTmp;
    h.albedo = vec3(0.84, 0.83, 0.80);
    h.emit = vec3(0.0); h.rough = 1.0; h.matType = 0; h.matId = 11;
  }

  // 7. Step 3 (Cook 1984): Fast-swinging bronze pendulum orb in mid-air -> REAL stochastic motion blur!
  if (stage == 2) {
    vec3 pPos = pendulumPos(rayTime, uDofBoost);
    float tPend = iSphere(ro, rd, pPos, 0.28, nTmp);
    if (tPend < h.t) {
      h.t = tPend; h.pos = ro + rd * tPend; h.norm = nTmp;
      h.albedo = vec3(0.95, 0.52, 0.16);
      h.emit = vec3(0.0); h.rough = 0.22; h.matType = 1; h.matId = 12;
    }
  }

  // 8. Steps 7-8 (2020-2026 ReSTIR & Browser PT): Live moving glowing emissive orb light!
  if (stage >= 6) {
    float tOrb = iSphere(ro, rd, uLightOrbPos, 0.21, nTmp);
    if (tOrb < h.t) {
      h.t = tOrb; h.pos = ro + rd * tOrb; h.norm = nTmp;
      h.albedo = vec3(1.0);
      h.emit = uLightOrbCol * 1.15;
      h.rough = 0.0; h.matType = 3; h.matId = 13;
    }
  }

  // 9. Step 8 bonus: Warm/Cyan recessed architectural neon accent strip on back wall!
  if (stage >= 7) {
    float tStrip = iBox(ro, rd, vec3(-1.55, 2.66, -2.59), vec3(1.55, 2.75, -2.50), nTmp);
    if (tStrip < h.t) {
      h.t = tStrip; h.pos = ro + rd * tStrip; h.norm = nTmp;
      h.albedo = vec3(1.0);
      h.emit = vec3(1.2, 5.2, 9.5);
      h.rough = 0.0; h.matType = 3; h.matId = 14;
    }
  }

  if (h.t < INF) {
    h.frontFace = dot(rd, h.norm) < 0.0;
    if (!h.frontFace) h.norm = -h.norm;
  }
  return h;
}

// Fast visibility shadow test between p0 and target at distance maxT (ignores glass sphere partially for soft caustic tint!)
vec3 traceVisibility(vec3 ro, vec3 rd, float maxT, int stage, float rayTime) {
  Hit sh = intersectScene(ro, rd, stage, rayTime);
  if (sh.t < maxT - 0.015) {
    // Allow subtle refractive caustic transmission through crystal glass sphere on path-traced stages!
    if (sh.matType == 2 && stage >= 3) {
      return vec3(0.68, 0.78, 0.85);
    }
    return vec3(0.0);
  }
  return vec3(1.0);
}

// ============================================================================
// ERA 1 (1975): Local Blinn-Phong Rasterization (zero shadows, zero reflections!)
// ============================================================================
vec3 evalPhong1975(vec3 ro, vec3 rd, bool unlit) {
  Hit h = intersectScene(ro, rd, 0, uTime);
  if (h.t >= INF) return vec3(0.02);
  if (h.matType == 3) return vec3(1.0, 0.96, 0.86);
  if (unlit) return h.albedo * 0.78;
  vec3 lPos = vec3(0.0, 3.05, -0.15);
  vec3 L = lPos - h.pos;
  float dist2 = dot(L, L);
  L *= inversesqrt(dist2);
  vec3 V = -rd;
  vec3 H = normalize(L + V);
  float ndl = max(dot(h.norm, L), 0.0);
  float spec = pow(max(dot(h.norm, H), 0.0), (h.matId == 9 || h.matId == 10) ? 48.0 : 12.0) * ((h.matId == 9 || h.matId == 10) ? 0.65 : 0.08);
  float att = 4.6 / (1.5 + dist2 * 0.42);
  return h.albedo * (0.20 + ndl * att * vec3(1.0, 0.95, 0.86)) + vec3(spec * att);
}

// ============================================================================
// ERA 2 (1980): Classic Whitted Ray Tracing (hard shadows, sharp mirror & glass!)
// ============================================================================
vec3 evalWhitted1980(vec3 ro, vec3 rd) {
  vec3 accum = vec3(0.0);
  vec3 throughput = vec3(1.0);
  vec3 curO = ro, curD = rd;

  for (int b = 0; b < 5; b++) {
    Hit h = intersectScene(curO, curD, 1, uTime);
    if (h.t >= INF) break;
    if (h.matType == 3) {
      accum += throughput * min(h.emit, vec3(2.5));
      break;
    }

    vec3 lPos = vec3(0.0, 3.24, -0.15);
    vec3 toL = lPos - h.pos;
    float dL = length(toL);
    vec3 L = toL / dL;
    vec3 vis = traceVisibility(h.pos + h.norm * 0.003, L, dL, 1, uTime);
    float ndl = max(dot(h.norm, L), 0.0);
    float att = 7.2 / (1.8 + dL * dL * 0.55);

    if (h.matType == 0) {
      vec3 H = normalize(L - curD);
      float spec = pow(max(dot(h.norm, H), 0.0), 24.0) * 0.12;
      // Classic Whitted: razor-sharp dark shadow + flat constant grey ambient (ZERO GI color bleed!)
      accum += throughput * (h.albedo * (0.055 + vis * ndl * att * vec3(1.05, 0.97, 0.86)) + vis * spec * att);
      break;
    } else if (h.matType == 1) {
      // Sharp chrome mirror + tiny direct Phong highlight
      vec3 H = normalize(L - curD);
      accum += throughput * vis * pow(max(dot(h.norm, H), 0.0), 96.0) * att * 0.9;
      throughput *= h.albedo * 0.90;
      curO = h.pos + h.norm * 0.003;
      curD = reflect(curD, h.norm);
    } else if (h.matType == 2) {
      // Classic Snell glass sphere with Schlick Fresnel reflection glint!
      float eta = h.frontFace ? (1.0 / 1.52) : 1.52;
      float cosI = min(dot(-curD, h.norm), 1.0);
      float sinT2 = eta * eta * (1.0 - cosI * cosI);
      float f0 = 0.04;
      float fres = f0 + (1.0 - f0) * pow(1.0 - cosI, 5.0);
      vec3 H = normalize(L - curD);
      accum += throughput * vis * pow(max(dot(h.norm, H), 0.0), 140.0) * att * 1.4;
      if (sinT2 > 1.0 || (b == 0 && fres > 0.55)) {
        curD = reflect(curD, h.norm);
        curO = h.pos + h.norm * 0.003;
      } else {
        curD = refract(curD, h.norm, eta);
        curO = h.pos - h.norm * 0.003;
        throughput *= vec3(0.96, 0.99, 1.0);
      }
    }
  }
  return accum;
}

// ============================================================================
// ERA 3 (1984): Cook Distributed Ray Tracing (soft area shadows, glossy, DoF, motion blur!)
// ============================================================================
vec3 evalCookSample(vec3 ro, vec3 rd, float rayTime) {
  vec3 accum = vec3(0.0);
  vec3 throughput = vec3(1.0);
  vec3 curO = ro, curD = rd;

  for (int b = 0; b < 4; b++) {
    Hit h = intersectScene(curO, curD, 2, rayTime);
    if (h.t >= INF) break;
    if (h.matType == 3) {
      accum += throughput * min(h.emit, vec3(2.8));
      break;
    }

    // Stochastic point on the ceiling area softbox -> genuine soft penumbra shadows!
    vec2 uL = rand2() * 2.0 - 1.0;
    vec3 lPos = vec3(uL.x * LIGHT_HALF.x, LIGHT_Y - 0.01, -0.15 + uL.y * LIGHT_HALF.y);
    vec3 toL = lPos - h.pos;
    float dL = length(toL);
    vec3 L = toL / dL;
    vec3 vis = traceVisibility(h.pos + h.norm * 0.003, L, dL, 2, rayTime);
    float ndl = max(dot(h.norm, L), 0.0);
    float cosLight = max(L.y, 0.0);
    float att = 8.8 * cosLight / (1.5 + dL * dL * 0.55);

    if (h.matType == 0) {
      accum += throughput * h.albedo * (0.08 + vis * ndl * att * vec3(1.06, 0.96, 0.84));
      break;
    } else if (h.matType == 1) {
      // Distributed glossy reflection (cone-perturbed reflection ray!)
      vec3 H = normalize(L - curD);
      accum += throughput * vis * h.albedo * pow(max(dot(h.norm, H), 0.0), 36.0) * att * 0.65;
      vec3 refD = reflect(curD, h.norm);
      vec3 halfVec = sampleGGXHalf(h.norm, h.rough, rand2());
      vec3 nextD = reflect(curD, halfVec);
      if (dot(nextD, h.norm) <= 0.0) nextD = refD;
      throughput *= h.albedo * 0.90;
      curO = h.pos + h.norm * 0.003;
      curD = normalize(nextD);
    } else if (h.matType == 2) {
      float eta = h.frontFace ? (1.0 / 1.52) : 1.52;
      float cosI = min(dot(-curD, h.norm), 1.0);
      float sinT2 = eta * eta * (1.0 - cosI * cosI);
      float fres = 0.04 + 0.96 * pow(1.0 - cosI, 5.0);
      vec3 H = normalize(L - curD);
      accum += throughput * vis * pow(max(dot(h.norm, H), 0.0), 120.0) * att * 1.1;
      if (sinT2 > 1.0 || (b == 0 && fres > 0.55)) {
        curD = reflect(curD, h.norm);
        curO = h.pos + h.norm * 0.003;
      } else {
        curD = refract(curD, h.norm, eta);
        curO = h.pos - h.norm * 0.003;
        throughput *= vec3(0.96, 0.99, 1.0);
      }
    }
  }
  return accum;
}

// ============================================================================
// ERAS 4-8 (1986-2026): Genuine Unbiased Monte Carlo Path Tracing!
// - naiveMode (Stages 3-4): pure Kajiya hemisphere bounce (hits lights by pure chance -> iconic 1 SPP noise!)
// - neeMisMode (Stages 5-7): Cosine/GGX importance + Next Event Estimation + Veach MIS + ReSTIR multi-light!
// ============================================================================
float powerHeuristic(float pdfA, float pdfB) {
  float a2 = pdfA * pdfA;
  return a2 / max(1e-6, a2 + pdfB * pdfB);
}

// Area PDF of hitting the ceiling softbox from p along unit dir d at distance t (d points UPWARD -> cosL = +d.y!)
float ceilLightPdf(vec3 d, float dist) {
  float area = (2.0 * LIGHT_HALF.x) * (2.0 * LIGHT_HALF.y);
  float cosL = max(d.y, 0.0);
  if (cosL < 1e-4) return 0.0;
  return (dist * dist) / (area * cosL);
}

// Explicit direct light estimation (NEE + MIS, plus ReSTIR RIS candidate selection across multi-lights on Stages 6-7!)
vec3 sampleDirectNEE(vec3 p, vec3 n, vec3 V, vec3 albedo, float rough, int matType, int stage) {
  vec3 direct = vec3(0.0);

  // Light 1: Ceiling Area Softbox (outward normal is -Y, ray leaves light along -L1 -> cosL1 = +L1.y!)
  vec2 u1 = rand2() * 2.0 - 1.0;
  vec3 lPos1 = vec3(u1.x * LIGHT_HALF.x, LIGHT_Y - 0.005, -0.15 + u1.y * LIGHT_HALF.y);
  vec3 toL1 = lPos1 - p;
  float d1 = length(toL1);
  vec3 L1 = toL1 / d1;
  float ndl1 = max(dot(n, L1), 0.0);
  float cosL1 = max(L1.y, 0.0);
  float pdfL1 = ceilLightPdf(L1, d1);
  vec3 contrib1 = vec3(0.0);
  if (ndl1 > 0.0 && cosL1 > 0.0 && pdfL1 > 0.0) {
    float pdfBsdf = (matType == 0) ? (ndl1 / PI) : 0.45;
    float misW = powerHeuristic(pdfL1, pdfBsdf);
    vec3 brdf = (matType == 0) ? (albedo / PI) : (albedo * pow(max(dot(n, normalize(L1 + V)), 0.0), 42.0) * 1.4);
    // Slightly soften overhead light on Stage 7 so the glowing orb & cyan neon pop dramatically!
    float ceilScale = (stage >= 7) ? 0.68 : ((stage == 6) ? 0.78 : 1.0);
    contrib1 = (CEIL_EMIT * ceilScale) * brdf * (ndl1 * misW / pdfL1);
  }

  // Light 2 (Stages 6-7): Live moving glowing emissive orb!
  vec3 contrib2 = vec3(0.0);
  vec3 L2 = vec3(0.0, 1.0, 0.0);
  float d2 = 1.0;
  if (stage >= 6) {
    // Sample visible disk on orb sphere (radius 0.21)
    vec3 toC = uLightOrbPos - p;
    float distC = length(toC);
    if (distC > 0.24) {
      vec3 dirC = toC / distC;
      vec3 tB, bB; makeONB(dirC, tB, bB);
      vec2 du = rand2();
      float rr = 0.21 * sqrt(du.x);
      float phi = 2.0 * PI * du.y;
      vec3 lPos2 = uLightOrbPos + (tB * cos(phi) + bB * sin(phi)) * rr - dirC * 0.16;
      vec3 toL2 = lPos2 - p;
      d2 = length(toL2);
      L2 = toL2 / d2;
      float ndl2 = max(dot(n, L2), 0.0);
      if (ndl2 > 0.0) {
        float solidAng = PI * (0.21 * 0.21) / (d2 * d2);
        vec3 brdf = (matType == 0) ? (albedo / PI) : (albedo * pow(max(dot(n, normalize(L2 + V)), 0.0), 48.0) * 1.6);
        contrib2 = uLightOrbCol * brdf * (ndl2 * solidAng * 2.1);
      }
    }
  }

  // Light 3 (Stage 7): Back-wall cyan architectural neon strip!
  vec3 contrib3 = vec3(0.0);
  vec3 L3 = vec3(0.0, 0.0, -1.0);
  float d3 = 1.0;
  if (stage >= 7) {
    vec3 lPos3 = vec3((rand1() * 2.0 - 1.0) * 1.52, 2.705, -2.49);
    vec3 toL3 = lPos3 - p;
    d3 = length(toL3);
    L3 = toL3 / d3;
    float ndl3 = max(dot(n, L3), 0.0);
    float cosL3 = max(-L3.z, 0.0);
    if (ndl3 > 0.0 && cosL3 > 0.0) {
      float area3 = 3.10 * 0.09;
      float pdf3 = (d3 * d3) / max(1e-4, area3 * cosL3);
      vec3 brdf = (matType == 0) ? (albedo / PI) : (albedo * 0.25);
      contrib3 = vec3(1.2, 5.2, 9.5) * brdf * (ndl3 / pdf3);
    }
  }

  // ReSTIR RIS (Resampled Importance Sampling) on Stages 6-7: pick strongest candidate proportionally to target luminance!
  if (stage >= 6) {
    float w1 = dot(contrib1, vec3(0.2126, 0.7152, 0.0722));
    float w2 = dot(contrib2, vec3(0.2126, 0.7152, 0.0722));
    float w3 = dot(contrib3, vec3(0.2126, 0.7152, 0.0722));
    float wSum = w1 + w2 + w3;
    if (wSum > 1e-5) {
      float pick = rand1() * wSum;
      if (pick < w1) {
        vec3 vis = traceVisibility(p + n * 0.003, L1, d1, stage, uTime);
        direct = vis * contrib1 * (wSum / max(1e-5, w1));
      } else if (pick < w1 + w2) {
        vec3 vis = traceVisibility(p + n * 0.003, L2, d2, stage, uTime);
        direct = vis * contrib2 * (wSum / max(1e-5, w2));
      } else {
        vec3 vis = traceVisibility(p + n * 0.003, L3, d3, stage, uTime);
        direct = vis * contrib3 * (wSum / max(1e-5, w3));
      }
    }
  } else {
    // Stage 5: classic NEE + MIS against ceiling area light
    if (dot(contrib1, vec3(1.0)) > 1e-5) {
      vec3 vis = traceVisibility(p + n * 0.003, L1, d1, stage, uTime);
      direct = vis * contrib1;
    }
  }
  return direct;
}

vec3 tracePathSample(
  vec3 ro, vec3 rd, int stage, bool useNEE, bool demodFirstDiffuse,
  out vec3 gNorm, out float gDepth, out vec3 gAlbedo, out int gMatId, out bool gBypass
) {
  vec3 accum = vec3(0.0);
  vec3 throughput = vec3(1.0);
  vec3 curO = ro, curD = rd;
  bool lastWasSpecular = true;
  float lastBsdfPdf = 1.0;

  gNorm = vec3(0.0, 1.0, 0.0);
  gDepth = -1.0;
  gAlbedo = vec3(1.0);
  gMatId = 0;
  gBypass = true;

  for (int b = 0; b < 4; b++) {
    Hit h = intersectScene(curO, curD, stage, uTime);
    if (h.t >= INF) break;

    if (b == 0) {
      gNorm = h.norm;
      gMatId = h.matId;
      if (h.matType == 0 && demodFirstDiffuse) {
        // Demodulate first diffuse albedo so SVGF denoises smooth irradiance with razor-sharp albedo edges!
        gAlbedo = max(h.albedo, vec3(0.04));
        gDepth = h.t;
        gBypass = false;
      } else {
        gAlbedo = vec3(1.0);
        gDepth = -h.t; // Negative depth signals SVGF to keep mirror/glass/emissive razor-sharp!
        gBypass = true;
      }
    }

    // Hit an emissive light source
    if (h.matType == 3) {
      if (!useNEE || lastWasSpecular || b == 0) {
        accum += throughput * h.emit;
      } else {
        // MIS weight for BSDF hit on ceiling softbox (prevents double-counting with NEE!)
        if (h.matId == 2) {
          float pdfL = ceilLightPdf(curD, h.t);
          float w = powerHeuristic(lastBsdfPdf, pdfL);
          accum += throughput * h.emit * w;
        }
      }
      break;
    }

    vec3 effAlbedo = (b == 0 && h.matType == 0 && demodFirstDiffuse) ? vec3(1.0) : h.albedo;

    if (h.matType == 0) {
      // Explicit Next Event Estimation (+ MIS + ReSTIR on Stages 5-7)
      if (useNEE) {
        accum += throughput * sampleDirectNEE(h.pos, h.norm, -curD, effAlbedo, h.rough, 0, stage);
      }
      // Indirect bounce sampling: naive Kajiya (Stages 3-4) has ZERO NEE (hits lights only by chance -> authentic Monte Carlo noise!)
      // Use cosine-weighted hemisphere so naive 1 SPP reveals the noisy Cornell room & red/teal bounce instead of 90% black pixels.
      vec3 nextD = sampleCosineHemi(h.norm, rand2());
      throughput *= effAlbedo;
      lastBsdfPdf = max(dot(h.norm, nextD), 0.001) / PI;
      curO = h.pos + h.norm * 0.003;
      curD = nextD;
      lastWasSpecular = false;
    } else if (h.matType == 1) {
      // Glossy GGX gold metal!
      if (useNEE) {
        accum += throughput * sampleDirectNEE(h.pos, h.norm, -curD, h.albedo, h.rough, 1, stage) * 0.35;
      }
      float rEff = (stage >= 6) ? 0.095 : max(0.04, h.rough);
      vec3 hv = sampleGGXHalf(h.norm, rEff, rand2());
      vec3 nextD = reflect(curD, hv);
      if (dot(nextD, h.norm) <= 0.0) nextD = reflect(curD, h.norm);
      throughput *= h.albedo * 0.92;
      curO = h.pos + h.norm * 0.003;
      curD = normalize(nextD);
      lastWasSpecular = true;
    } else if (h.matType == 2) {
      // Crystal refractive glass sphere (IOR 1.52): deterministic Fresnel split on real-time stages eliminates salt-and-pepper coin-flip noise!
      float eta = h.frontFace ? (1.0 / 1.52) : 1.52;
      float cosI = min(dot(-curD, h.norm), 1.0);
      float sinT2 = eta * eta * (1.0 - cosI * cosI);
      float fres = 0.04 + 0.96 * pow(1.0 - cosI, 5.0);
      bool doReflect = (stage >= 5) ? (sinT2 > 1.0 || (b == 0 && fres > 0.52)) : (sinT2 > 1.0 || rand1() < fres);
      if (stage >= 5 && b == 0 && !doReflect) {
        // Add clean grazing Fresnel rim & overhead glint analytically so glass looks crystal-clear at 2 SPP!
        vec3 reflDir = reflect(curD, h.norm);
        Hit rh = intersectScene(h.pos + h.norm * 0.003, reflDir, stage, uTime);
        if (rh.t < INF) {
          vec3 rCol = (rh.matType == 3) ? min(rh.emit, vec3(3.5)) : rh.albedo * 0.65;
          accum += throughput * rCol * fres;
        }
        throughput *= (1.0 - fres);
      }
      if (doReflect) {
        curD = reflect(curD, h.norm);
        curO = h.pos + h.norm * 0.003;
      } else {
        curD = refract(curD, h.norm, eta);
        curO = h.pos - h.norm * 0.003;
        throughput *= vec3(0.96, 0.99, 1.0);
      }
      lastWasSpecular = true;
    }

    // Clamp extreme single-path fireflies softly only on real-time denoised stages (keep authentic fireflies on Kajiya 1986!)
    if (stage >= 6) {
      accum = min(accum, vec3(9.5));
      // Early diffuse termination at bounce 2 on real-time 1 SPP stages (keeps full 4-bounce depth for glass & metal!)
      if (!lastWasSpecular && b >= 1) break;
    }
  }
  return accum;
}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  bool solidLeft = useLeft && (uSolidLeft > 0.5);

  // Unique per-pixel, per-frame PCG RNG seed
  uvec2 px = uvec2(gl_FragCoord.xy);
  rngState = px.x * 1973u + px.y * 9277u + uint(uFrame) * 26699u + 911u;
  pcgNext();

  vec2 jitter = (st >= 2) ? (rand2() - 0.5) : vec2(0.0);
  vec2 uvJ = (gl_FragCoord.xy + jitter) / uRes;
  vec2 ndc = uvJ * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  vec3 gNorm = vec3(0.0, 1.0, 0.0);
  float gDepth = -1.0;
  vec3 gAlbedo = vec3(1.0);
  int gMatId = 0;
  bool gBypass = true;
  vec3 rad = vec3(0.0);

  bool isRawFlag = false;
  if (st == 0) {
    rad = evalPhong1975(uCamPos, rd, solidLeft);
  } else if (st == 1) {
    rad = evalWhitted1980(uCamPos, rd);
  } else if (st == 2) {
    // Cook 1984 Distributed RT: 8 stochastic samples -> soft shadows + glossy gold + optical DoF + motion blur!
    float focusDist = length(vec3(-0.34, 0.56, 0.68) - uCamPos);
    float aperture = (uDofBoost > 0.5) ? 0.21 : 0.115;
    float shutter = (uDofBoost > 0.5) ? 0.30 : 0.19;
    vec3 sum = vec3(0.0);
    for (int s = 0; s < 8; s++) {
      vec2 du = rand2();
      float rA = aperture * sqrt(du.x);
      float phi = 2.0 * PI * du.y;
      vec3 lensOff = (uCamRight * cos(phi) + uCamUp * sin(phi)) * rA;
      vec3 focusPt = uCamPos + rd * focusDist;
      vec3 rO = uCamPos + lensOff;
      vec3 rD = normalize(focusPt - rO);
      float rT = uTime + (rand1() - 0.5) * shutter;
      sum += evalCookSample(rO, rD, rT);
    }
    rad = sum / 8.0;
  } else if (st == 3) {
    // Kajiya 1986: 1 unbiased Monte Carlo path per pixel (or 2 SPP when split-comparing directly against 2 SPP NEE+MIS!)
    int nK = (useLeft && uStageRight == 5) ? 2 : 1;
    vec3 sum = vec3(0.0);
    for (int s = 0; s < 2; s++) {
      if (s >= nK) break;
      sum += tracePathSample(uCamPos, rd, 3, false, false, gNorm, gDepth, gAlbedo, gMatId, gBypass);
    }
    rad = sum / float(nK);
  } else if (st == 4) {
    // 1998 Multi-SPP Accumulation: live mode traces 2 SPP/frame & accumulates in ACCUM_FS; video can burst uExtraSpp!
    int nSpp = (uExtraSpp > 0) ? uExtraSpp : 2;
    vec3 sum = vec3(0.0);
    for (int s = 0; s < 48; s++) {
      if (s >= nSpp) break;
      vec2 jj = (rand2() - 0.5) / uRes;
      vec2 n2 = (vUv + jj) * 2.0 - 1.0;
      vec3 r2 = normalize(uCamFwd + n2.x * uAspect * uTanHalfFov * uCamRight + n2.y * uTanHalfFov * uCamUp);
      sum += tracePathSample(uCamPos, r2, 4, false, false, gNorm, gDepth, gAlbedo, gMatId, gBypass);
    }
    rad = sum / float(nSpp);
  } else if (st == 5) {
    // 2005 Importance Sampling + NEE + MIS (2 SPP raw, NO denoiser — compare directly against Naive Kajiya 2 SPP!)
    vec3 sum = vec3(0.0);
    for (int s = 0; s < 2; s++) {
      sum += tracePathSample(uCamPos, rd, 5, true, false, gNorm, gDepth, gAlbedo, gMatId, gBypass);
    }
    rad = sum * 0.5;
  } else {
    // 2020 ReSTIR + SVGF (Stage 6) & 2026 Real-Time Browser Path Tracing (Stage 7):
    // Genuine 1 SPP ReSTIR + NEE + MIS -> 4-pass edge-stopping A-Trous SVGF denoiser at locked 60 FPS!
    bool rawSide = (st == 6) && ((uRawNoisy > 0.5) || (useLeft && uRawLeft > 0.5));
    bool demod = !rawSide;
    rad = tracePathSample(uCamPos, rd, st, true, demod, gNorm, gDepth, gAlbedo, gMatId, gBypass);
    if (rawSide) {
      isRawFlag = true;
      gBypass = true;
      gDepth = 0.0; // Zero depth strictly disables BOTH diffuse SVGF and specular micro-denoise on RAW side!
      gAlbedo = vec3(1.0);
    }
  }

  outRad = vec4(max(rad, vec3(0.0)), isRawFlag ? 2.0 : (gBypass ? 1.0 : 0.0));
  outNormDepth = vec4(gNorm, gDepth);
  outAlbedo = vec4(gAlbedo, float(gMatId) / 16.0);
}
`;

// ============================================================================
// PASS 2: TEMPORAL ACCUMULATION (Progressive convergence on Stage 4 + optional stabilization)
// ============================================================================
export const ACCUM_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uCurRad;
uniform sampler2D uPrevAccum;
uniform float uBlendAlpha; // 1.0 = no history (reset), 1/N = progressive average!
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
out vec4 outColor;

void main() {
  vec4 cur = texture(uCurRad, vUv);
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;

  // Only accumulate temporally on Stage 4 (progressive) or gentle stabilization on Stages 6-7 when camera is still
  if (st == 4 && uBlendAlpha < 0.999) {
    vec4 prev = texture(uPrevAccum, vUv);
    outColor = vec4(mix(prev.rgb, cur.rgb, uBlendAlpha), cur.a);
    return;
  }
  if (st >= 6 && cur.a < 1.5 && uBlendAlpha < 0.999) {
    vec4 prev = texture(uPrevAccum, vUv);
    // Clamped lightweight temporal EMA on denoised 1 SPP stages (strictly skipped on RAW 1 SPP pixels where cur.a >= 1.5!)
    if (cur.a < 0.5) {
      float a = max(uBlendAlpha, 0.20);
      outColor = vec4(mix(prev.rgb, cur.rgb, a), cur.a);
      return;
    }
    float aSpec = max(uBlendAlpha, 0.26);
    outColor = vec4(mix(prev.rgb, cur.rgb, aSpec), cur.a);
    return;
  }
  outColor = cur;
}
`;

// ============================================================================
// PASS 3: FAST 3x3 EDGE-STOPPING JOINT-BILATERAL A-TROUS WAVELET SVGF DENOISER
// (4 passes at step 1, 2, 4, 8 -> 36 taps total for 30px diameter at locked 60 FPS!)
// ============================================================================
export const ATROUS_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uNormDepth;
uniform sampler2D uAlbedo;
uniform vec2 uTexel;
uniform float uStepSize;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
out vec4 outColor;

void main() {
  vec4 c0 = texture(uSrc, vUv);
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;

  // Denoise Stages 6-7 diffuse irradiance across all 4 passes, plus tight 2-pass specular cleanup on gold (9) & glass (10)
  vec4 nd0 = texture(uNormDepth, vUv);
  float m0 = texture(uAlbedo, vUv).a;
  bool isSpecRefine = (abs(m0 - (9.0 / 16.0)) < 0.025 || abs(m0 - (10.0 / 16.0)) < 0.025) && (uStepSize <= 2.5) && (nd0.a < -0.01);
  if (st < 6 || (!isSpecRefine && (c0.a > 0.5 || nd0.a <= 0.0))) {
    outColor = c0;
    return;
  }

  vec3 n0 = normalize(nd0.rgb);
  float d0 = abs(nd0.a);
  float l0 = dot(c0.rgb, vec3(0.2126, 0.7152, 0.0722));
  float lSigma = isSpecRefine ? (0.55 + l0 * 0.40) : (1.75 + l0 * 0.65);

  vec3 sum = c0.rgb;
  float wSum = 1.0;

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec2 uv = vUv + vec2(float(dx), float(dy)) * uTexel * uStepSize;
      // Never blur across the active split-screen divider!
      if (uSplitX > 0.005 && uSplitX < 0.995 && ((uv.x < uSplitX) != useLeft)) continue;

      vec4 c1 = texture(uSrc, uv);
      vec4 nd1 = texture(uNormDepth, uv);
      float m1 = texture(uAlbedo, uv).a;
      if (abs(m0 - m1) > 0.025) continue; // Strict object/wall separation -> razor-sharp silhouettes!
      if (!isSpecRefine && (c1.a > 0.5 || nd1.a <= 0.0)) continue;

      float wN = pow(max(0.0, dot(n0, normalize(nd1.rgb))), isSpecRefine ? 20.0 : 64.0);
      float wD = exp(-abs(d0 - abs(nd1.a)) / (0.06 * d0 + 0.008));
      float l1 = dot(c1.rgb, vec3(0.2126, 0.7152, 0.0722));
      float wL = exp(-abs(l0 - l1) / lSigma);
      float kw = (dx == 0 || dy == 0) ? 0.58 : 0.32;
      float w = kw * wN * wD * wL;
      sum += c1.rgb * w;
      wSum += w;
    }
  }

  outColor = vec4(sum / max(wSum, 1e-4), c0.a);
}
`;

// ============================================================================
// PASS 4: ALBEDO RE-MODULATION + ACES FILMIC TONE MAPPING
// ============================================================================
export const FINAL_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uRad;
uniform sampler2D uAlbedo;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
out vec4 outColor;

void main() {
  vec4 r = texture(uRad, vUv);
  vec3 alb = texture(uAlbedo, vUv).rgb;
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;

  // Re-multiply denoised diffuse irradiance by sharp primary albedo on Stages 6-7!
  vec3 col = (st >= 6 && r.a < 0.5) ? (r.rgb * alb) : r.rgb;

  // Subtle exposure lift & ACES filmic tone mapping (skip ACES on flat 1975 Blinn-Phong so it stays crisp/classic!)
  if (st == 0) {
    col = clamp(col, 0.0, 1.0);
  } else {
    col *= 1.08;
    col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  }

  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * (st == 0 ? 0.06 : 0.16);
  outColor = vec4(pow(max(col, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}
`;
