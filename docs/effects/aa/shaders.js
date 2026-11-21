// Six GLSL ES 3.00 shaders for Evolution of Anti-Aliasing & Temporal Upscaling (1990-2026):
// 1. SCENE_FS      — Analytical "AA Torture-Test Courtyard" (shallow diagonal eaves, subpixel tension wires,
//                    fluted chrome sphere, metallic louvers, perspective checkerboard, swinging crimson/chrome
//                    pendulum & spinning rotor). Supports 1x Aliased, 4x4 SSAA (Haeberli & Akeley 1990),
//                    true 4x RGSS MSAA (4x coverage + 1x shading -> leaves specular aliasing!), Halton jitter,
//                    Specular AA (Toksvig 2005 / Kaplanyan 2016), and exact analytical per-pixel Motion Vectors!
// 2. FXAA_FS       — Authentic Timothy Lottes (NVIDIA 2011) luminance-based FXAA edge filter
// 3. SMAA_EDGE_FS  — Jorge Jimenez et al. (Eurographics 2012) color/luma edge detection
// 4. SMAA_BLEND_FS — Morphological L/Z/U edge-pattern length search & directional blend (sharp textures, subpixel wires still break!)
// 5. TAA_FS        — Temporal resolve supporting:
//                    - Early TAA (Halo: Reach 2010 / Crysis 2 2011 / UE4 2013): naive history blend -> dramatic motion ghosting!
//                    - Karis SIGGRAPH 2014 TAA: Motion Vectors + 5-tap Catmull-Rom + YCoCg AABB Clipping (Lottes 2011 / Malan 2012 / Karis 2014)
//                    - Temporal Upscaling (FSR 2 / TSR style): 50% per axis (25% pixels) reconstructed to 100% + RCAS contrast sharpen!
// 6. FINAL_FS      — ACES tone-map + crisp pixel-accurate 4x Magnifier Loupe with crosshair targeting wires, pendulum & chrome!

// ============================================================================
// 1. ANALYTICAL AA TORTURE-TEST SCENE + EXACT PER-PIXEL MOTION VECTORS
// ============================================================================
export const SCENE_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec3 uPrevCamPos;
uniform vec3 uPrevCamRight;
uniform vec3 uPrevCamUp;
uniform vec3 uPrevCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec2 uRes;
uniform vec2 uJitterPx;     // Halton(2,3) subpixel jitter in current-buffer pixels ([-0.5..0.5])
uniform float uTime;
uniform float uPrevTime;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uNoAaLeft;    // Step 1 split: NO AA (1x) vs 1990 SSAA (4x4)
uniform float uSpecAaOn;    // Step 7 toggle: Toksvig/Kaplanyan Specular AA on/off
uniform int uRenderScale;   // 1 = full-res, 2 = 50% per axis (25% pixels) for Stage 7 Upscaling!
uniform int uSideMask;      // 0 = both halves, 1 = left only, 2 = right only

layout(location = 0) out vec4 outColor;    // Linear HDR radiance
layout(location = 1) out vec4 outVelocity; // RG = screen UV motion vector (curUv - prevUv), B = linear depth, A = movingObjMask

const float INF = 1e9;
const float PI = 3.14159265;
const vec3 SUN_DIR = normalize(vec3(0.56, 0.72, 0.42));

// Swinging crimson-and-chrome pendulum orb (sweeps briskly across thin overhead wires & checkerboard!)
vec3 pendulumCenter(float t) {
  float ang = sin(t * 2.55) * 0.78;
  return vec3(sin(ang) * 1.48, 2.28 - cos(ang) * 0.92, 0.36);
}

// Spinning metallic weather-vane / rotor blade on right pedestal
float rotorAngle(float t) {
  return t * 3.1;
}

float iSphere(vec3 ro, vec3 rd, vec3 c, float r, out vec3 nOut) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float d2 = b * b - (dot(oc, oc) - r * r);
  if (d2 < 0.0) return INF;
  float sd = sqrt(d2);
  float t = -b - sd;
  if (t < 0.002) return INF;
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
  if (tF < max(tN, 0.002)) return INF;
  float t = (tN > 0.002) ? tN : tF;
  vec3 p = ro + rd * t;
  vec3 c = 0.5 * (bMin + bMax);
  vec3 h = 0.5 * (bMax - bMin);
  vec3 d = (p - c) / h;
  vec3 ad = abs(d);
  if (ad.x > ad.y && ad.x > ad.z) nOut = vec3(sign(d.x), 0.0, 0.0);
  else if (ad.y > ad.z) nOut = vec3(0.0, sign(d.y), 0.0);
  else nOut = vec3(0.0, 0.0, sign(d.z));
  return t;
}

// Exact ray vs finite capsule/wire segment (ultra-thin subpixel wires torture-test SMAA/FXAA!)
float iCapsule(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float r, out vec3 nOut) {
  vec3 ba = pb - pa;
  vec3 oa = ro - pa;
  float baba = dot(ba, ba);
  float bard = dot(ba, rd);
  float baoa = dot(ba, oa);
  float rdoa = dot(rd, oa);
  float oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float b = baba * rdoa - baoa * bard;
  float c = baba * oaoa - baoa * baoa - r * r * baba;
  float h = b * b - a * c;
  if (h < 0.0) return INF;
  float t = (-b - sqrt(h)) / max(a, 1e-6);
  if (t < 0.002) return INF;
  float y = baoa + t * bard;
  if (y < 0.0 || y > baba) return INF;
  vec3 p = ro + rd * t;
  nOut = normalize((p - pa) - ba * (y / baba));
  return t;
}

// Rotated thin angled slat / roof eave (shallow 12-deg slope = textbook stair-stepping edge!)
float iRotBox(vec3 ro, vec3 rd, vec3 center, float angZ, vec3 halfSz, out vec3 nOut) {
  float c = cos(angZ), s = sin(angZ);
  mat2 rot = mat2(c, -s, s, c);
  mat2 invR = mat2(c, s, -s, c);
  vec3 lro = ro - center;
  vec3 lrd = rd;
  lro.xy = invR * lro.xy;
  lrd.xy = invR * lrd.xy;
  vec3 ln;
  float t = iBox(lro, lrd, -halfSz, halfSz, ln);
  if (t < INF) {
    nOut = vec3(rot * ln.xy, ln.z);
  }
  return t;
}

struct Hit {
  float t;
  vec3 pos;
  vec3 norm;
  int matId;  // 0=sky, 1=checker floor, 2=stone architecture, 3=fluted chrome, 4=louvers, 5=thin wires, 6=pendulum, 7=rotor, 8=stripe sign
  vec3 prevPos; // World position at uPrevTime for EXACT analytical Motion Vectors!
  float moving;
};

Hit traceScene(vec3 ro, vec3 rd, float tCur, float tPrev) {
  Hit h;
  h.t = INF;
  h.matId = 0;
  h.norm = vec3(0.0, 1.0, 0.0);
  h.pos = ro + rd * 40.0;
  h.prevPos = h.pos;
  h.moving = 0.0;
  vec3 nTmp;

  // 1. Perspective stone checkerboard courtyard floor (y = 0)
  if (rd.y < -1e-5) {
    float tf = (0.0 - ro.y) / rd.y;
    if (tf > 0.002 && tf < 45.0 && tf < h.t) {
      h.t = tf; h.pos = ro + rd * tf; h.norm = vec3(0.0, 1.0, 0.0);
      h.matId = 1; h.prevPos = h.pos;
    }
  }

  // 2. Crisp shallow-angled architectural roof canopy (11.5 deg slope -> classic razor-edge stair-stepping!)
  float tRoof = iRotBox(ro, rd, vec3(-0.35, 2.74, -1.65), 0.20, vec3(2.55, 0.09, 1.05), nTmp);
  if (tRoof < h.t) {
    h.t = tRoof; h.pos = ro + rd * tRoof; h.norm = nTmp; h.matId = 2; h.prevPos = h.pos;
  }

  // Two crisp architectural signal-tower pillars framing the scene
  float tP1 = iBox(ro, rd, vec3(-2.35, 0.0, -2.10), vec3(-1.92, 2.55, -1.62), nTmp);
  if (tP1 < h.t) { h.t = tP1; h.pos = ro + rd * tP1; h.norm = nTmp; h.matId = 2; h.prevPos = h.pos; }
  float tP2 = iBox(ro, rd, vec3( 1.92, 0.0, -2.10), vec3( 2.35, 3.08, -1.62), nTmp);
  if (tP2 < h.t) { h.t = tP2; h.pos = ro + rd * tP2; h.norm = nTmp; h.matId = 2; h.prevPos = h.pos; }

  // Back high-contrast fine-striped calibration sign (instantly exposes FXAA texture blur vs SMAA/SSAA!)
  float tSign = iBox(ro, rd, vec3(-1.82, 1.56, -2.15), vec3(-0.62, 2.28, -2.02), nTmp);
  if (tSign < h.t) { h.t = tSign; h.pos = ro + rd * tSign; h.norm = nTmp; h.matId = 8; h.prevPos = h.pos; }

  // 3. Fluted Specular-Torture Chrome Sphere on left plinth (high-freq micro-ridges -> severe specular aliasing in 1x & MSAA!)
  float tPlinthL = iBox(ro, rd, vec3(-1.72, 0.0, -0.58), vec3(-0.68, 0.56, 0.42), nTmp);
  if (tPlinthL < h.t) { h.t = tPlinthL; h.pos = ro + rd * tPlinthL; h.norm = nTmp; h.matId = 2; h.prevPos = h.pos; }
  float tChrome = iSphere(ro, rd, vec3(-1.20, 1.12, -0.08), 0.56, nTmp);
  if (tChrome < h.t) {
    h.t = tChrome; h.pos = ro + rd * tChrome; h.norm = nTmp; h.matId = 3; h.prevPos = h.pos;
  }

  // 4. Dense Horizontal Metallic Louver Grate on right (classic Moire + specular shimmer torture test!)
  float tLouver = iBox(ro, rd, vec3(0.76, 0.0, -1.42), vec3(1.86, 1.76, -1.10), nTmp);
  if (tLouver < h.t) {
    h.t = tLouver; h.pos = ro + rd * tLouver; h.norm = nTmp; h.matId = 4; h.prevPos = h.pos;
  }

  // 5. Ultra-thin Tensioned Steel Overhead Wires (subpixel diameter -> break into dashed dots in 1x/MSAA/FXAA/SMAA, solid in TAA!)
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float yL = 1.62 + fi * 0.25;
    float yR = 2.02 + fi * 0.24;
    float zW = -1.72 + fi * 0.14;
    float rW = (i == 0 || i == 2) ? 0.0085 : 0.0125;
    float tW = iCapsule(ro, rd, vec3(-2.15, yL, zW), vec3(2.15, yR, zW), rW, nTmp);
    if (tW < h.t) {
      h.t = tW; h.pos = ro + rd * tW; h.norm = nTmp; h.matId = 5; h.prevPos = h.pos;
    }
  }
  // Cross-bracing diagonal guy wires (classic thin diagonal cables!)
  float tD1 = iCapsule(ro, rd, vec3(-1.95, 2.38, -1.78), vec3(0.45, 0.55, -1.45), 0.011, nTmp);
  if (tD1 < h.t) { h.t = tD1; h.pos = ro + rd * tD1; h.norm = nTmp; h.matId = 5; h.prevPos = h.pos; }
  float tD2 = iCapsule(ro, rd, vec3( 1.95, 2.86, -1.78), vec3(-0.35, 0.65, -1.45), 0.011, nTmp);
  if (tD2 < h.t) { h.t = tD2; h.pos = ro + rd * tD2; h.norm = nTmp; h.matId = 5; h.prevPos = h.pos; }

  // 6. Moving Crimson & Chrome Pendulum Orb + Thin Cable (sweeps right across cables & stripes -> EXPOSES EARLY TAA GHOSTING!)
  vec3 pCur = pendulumCenter(tCur);
  vec3 pPrev = pendulumCenter(tPrev);
  vec3 pivot = vec3(0.0, 2.66, 0.36);
  float tCord = iCapsule(ro, rd, pivot, pCur, 0.013, nTmp);
  if (tCord < h.t) {
    h.t = tCord; h.pos = ro + rd * tCord; h.norm = nTmp; h.matId = 5;
    float f = clamp(dot(h.pos - pivot, pCur - pivot) / max(1e-4, dot(pCur - pivot, pCur - pivot)), 0.0, 1.0);
    h.prevPos = mix(pivot, pPrev, f);
    h.moving = 1.0;
  }
  float tPend = iSphere(ro, rd, pCur, 0.32, nTmp);
  if (tPend < h.t) {
    h.t = tPend; h.pos = ro + rd * tPend; h.norm = nTmp; h.matId = 6;
    h.prevPos = (h.pos - pCur) + pPrev;
    h.moving = 1.0;
  }

  // 7. Spinning Crisp Orange/Dark Metal Rotor Blade on front-right post (secondary fast thin-edge motion test!)
  vec3 rHub = vec3(1.22, 0.86, 0.62);
  float aC = rotorAngle(tCur), aP = rotorAngle(tPrev);
  float tR1 = iRotBox(ro, rd, rHub, aC, vec3(0.56, 0.042, 0.03), nTmp);
  if (tR1 < h.t) {
    h.t = tR1; h.pos = ro + rd * tR1; h.norm = nTmp; h.matId = 7;
    vec3 rel = h.pos - rHub;
    float da = aP - aC;
    float cd = cos(da), sd = sin(da);
    h.prevPos = rHub + vec3(cd * rel.x - sd * rel.y, sd * rel.x + cd * rel.y, rel.z);
    h.moving = 1.0;
  }
  float tR2 = iRotBox(ro, rd, rHub, aC + 1.5708, vec3(0.56, 0.042, 0.03), nTmp);
  if (tR2 < h.t) {
    h.t = tR2; h.pos = ro + rd * tR2; h.norm = nTmp; h.matId = 7;
    vec3 rel = h.pos - rHub;
    float da = aP - aC;
    float cd = cos(da), sd = sin(da);
    h.prevPos = rHub + vec3(cd * rel.x - sd * rel.y, sd * rel.x + cd * rel.y, rel.z);
    h.moving = 1.0;
  }

  return h;
}

float quickShadow(vec3 p, float tCur) {
  vec3 nTmp;
  vec3 ro = p + vec3(0.0, 0.008, 0.0);
  if (iSphere(ro, SUN_DIR, vec3(-1.20, 1.12, -0.08), 0.56, nTmp) < INF) return 0.25;
  if (iSphere(ro, SUN_DIR, pendulumCenter(tCur), 0.32, nTmp) < INF) return 0.25;
  if (iBox(ro, SUN_DIR, vec3(-1.72, 0.0, -0.58), vec3(-0.68, 0.56, 0.42), nTmp) < INF) return 0.25;
  if (iBox(ro, SUN_DIR, vec3(0.76, 0.0, -1.42), vec3(1.86, 1.76, -1.10), nTmp) < INF) return 0.25;
  if (iRotBox(ro, SUN_DIR, vec3(-0.35, 2.74, -1.65), 0.20, vec3(2.55, 0.09, 1.05), nTmp) < INF) return 0.30;
  return 1.0;
}

vec3 evalSky(vec3 rd) {
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 low = vec3(0.48, 0.64, 0.84);
  vec3 mid = vec3(0.13, 0.32, 0.66);
  vec3 top = vec3(0.04, 0.10, 0.30);
  vec3 col = mix(low, mid, smoothstep(0.47, 0.67, h));
  col = mix(col, top, smoothstep(0.67, 0.96, h));
  float sd = max(dot(rd, SUN_DIR), 0.0);
  col += vec3(1.0, 0.88, 0.64) * pow(sd, 48.0) * 0.72;
  col += vec3(0.35, 0.45, 0.65) * pow(sd, 6.0) * 0.16;
  return col;
}

// GGX Microfacet specular with optional Toksvig (2005) / Kaplanyan (2016) Normal-Variance Specular AA!
float evalGGX(vec3 N, vec3 V, vec3 L, float baseRough, float normalVar, bool useSpecAA) {
  float a2 = baseRough * baseRough;
  if (useSpecAA) {
    // Kaplanyan & Hill (2016) / Toksvig (2005): filter subpixel normal variance into roughness^2!
    a2 = clamp(a2 + normalVar * 1.65, 0.002, 0.85);
  }
  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  float denom = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * denom * denom + 1e-5);
  return min(D * 0.30, useSpecAA ? 1.85 : 14.0);
}

vec3 shadeHit(Hit h, vec3 rd, float tCur, bool useSpecAA) {
  if (h.matId == 0) return evalSky(rd);

  vec3 N = normalize(h.norm);
  vec3 V = -rd;
  float sh = quickShadow(h.pos + N * 0.015, tCur);
  vec3 alb = vec3(0.72);
  float rough = 0.45;
  float metal = 0.0;
  float normalVar = 0.0;

  if (h.matId == 1) {
    // Crisp sunlit stone checkerboard courtyard + dark grout lines
    vec2 g = h.pos.xz * 1.65;
    float distFade = useSpecAA ? smoothstep(26.0, 5.0, h.t) : 1.0;
    float chk = mod(floor(g.x) + floor(g.y), 2.0);
    vec2 f = abs(fract(g) - 0.5);
    float grout = smoothstep(0.46, 0.495, max(f.x, f.y));
    vec3 cA = vec3(0.76, 0.73, 0.68);
    vec3 cB = vec3(0.11, 0.15, 0.24);
    alb = mix(mix(cA, cB, chk), vec3(0.05, 0.07, 0.11), grout * 0.75);
    alb = mix(vec3(0.36, 0.40, 0.48), alb, 0.18 + 0.82 * distFade);
    rough = 0.40;
    normalVar = clamp(h.t * 0.015, 0.0, 0.28);
  } else if (h.matId == 2) {
    // Architectural travertine pillars & dark charcoal-slate roof canopy (high contrast vs sky!)
    alb = vec3(0.62, 0.64, 0.69);
    if (h.pos.y > 2.52) alb = vec3(0.08, 0.11, 0.18);
    rough = 0.55;
  } else if (h.matId == 3) {
    // Fluted Gunmetal-Chrome Sphere: blazing micro-glints against rich dark titanium -> MASSIVE Specular AA contrast!
    vec3 rel = normalize(h.pos - vec3(-1.20, 1.12, -0.08));
    float az = atan(rel.x, rel.z);
    float el = asin(clamp(rel.y, -1.0, 1.0));
    float rib1 = sin(az * 48.0 + el * 18.0);
    float rib2 = cos(el * 56.0);
    vec3 t1 = normalize(cross(vec3(0.0, 1.0, 0.01), N));
    vec3 t2 = cross(N, t1);
    N = normalize(N + t1 * rib1 * 0.52 + t2 * rib2 * 0.42);
    alb = vec3(0.42, 0.48, 0.58);
    rough = 0.035;
    metal = 0.96;
    normalVar = 0.16 + 0.42 * pow(1.0 - max(dot(normalize(h.norm), V), 0.0), 1.4);
  } else if (h.matId == 4) {
    // Dense horizontal dark metallic louver blinds (razor-sharp high-freq specular & Moire shimmer!)
    float sl = fract(h.pos.y * 16.5);
    float tilt = (sl - 0.5) * 1.5;
    N = normalize(N + vec3(0.0, tilt, 0.0));
    alb = mix(vec3(0.08, 0.10, 0.16), vec3(0.64, 0.68, 0.76), step(0.44, sl));
    rough = 0.045;
    metal = 0.88;
    normalVar = 0.28;
  } else if (h.matId == 5) {
    // Jet-dark steel tension wires (razor contrast against cobalt sky!)
    alb = vec3(0.03, 0.04, 0.07);
    rough = 0.22;
    metal = 0.75;
    normalVar = 0.20;
  } else if (h.matId == 6) {
    // Moving Deep-Crimson & Gold Pendulum Orb (unmistakable ghosting contrast!)
    vec3 rel = normalize(h.pos - pendulumCenter(tCur));
    float stripe = step(0.16, abs(rel.y));
    alb = mix(vec3(0.98, 0.82, 0.16), vec3(0.84, 0.06, 0.11), stripe);
    rough = 0.14;
    metal = 0.25;
    normalVar = 0.04;
  } else if (h.matId == 7) {
    // Fast-spinning vivid safety-orange rotor blade
    alb = vec3(0.98, 0.32, 0.04);
    rough = 0.24;
    metal = 0.20;
  } else if (h.matId == 8) {
    // High-contrast black/white fine vertical & diagonal resolution chart sign
    vec2 su = (h.pos.xy - vec2(-1.82, 1.56)) / vec2(1.20, 0.72);
    float border = step(0.06, su.x) * step(su.x, 0.94) * step(0.09, su.y) * step(su.y, 0.91);
    float bars = step(0.5, fract(su.x * 18.0));
    float diag = step(0.5, fract((su.x * 11.0 + su.y * 7.0)));
    float pat = (su.y > 0.5) ? bars : diag;
    alb = mix(vec3(0.04, 0.06, 0.10), mix(vec3(0.05, 0.06, 0.10), vec3(0.94, 0.94, 0.92), pat), border);
    rough = 0.45;
  }

  float ndl = max(dot(N, SUN_DIR), 0.0);
  float skyAmb = 0.5 + 0.5 * N.y;
  vec3 diff = alb * (1.0 - metal * 0.84) * (vec3(0.12, 0.19, 0.34) * skyAmb + vec3(1.12, 1.04, 0.92) * ndl * sh);

  vec3 reflDir = reflect(-V, N);
  vec3 env = evalSky(reflDir);
  if (useSpecAA && metal > 0.5) {
    env = mix(env, vec3(0.24, 0.36, 0.56), clamp(normalVar * 0.85, 0.0, 0.65));
  }
  float f0 = mix(0.04, 0.88, metal);
  float fres = f0 + (1.0 - f0) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  float spec = evalGGX(N, V, SUN_DIR, rough, normalVar, useSpecAA) * sh;
  vec3 specCol = mix(vec3(1.0), alb, metal) * (spec * vec3(1.22, 1.12, 0.96) + env * fres * (1.0 - rough * 0.75) * 0.82);

  vec3 col = diff + specCol;
  float fog = 1.0 - exp(-h.t * h.t * 0.0014);
  col = mix(col, evalSky(rd), fog);
  return col;
}

vec3 rayForUv(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);
}

// Project previous world position into previous screen UV (0..1) for EXACT analytical Motion Vectors!
vec2 projectPrevUv(vec3 prevWorldPos) {
  vec3 d = prevWorldPos - uPrevCamPos;
  float z = dot(d, uPrevCamFwd);
  if (z < 0.01) return vUv;
  float x = dot(d, uPrevCamRight) / (z * uAspect * uTanHalfFov);
  float y = dot(d, uPrevCamUp) / (z * uTanHalfFov);
  return vec2(x, y) * 0.5 + 0.5;
}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  bool noAaLeft = useLeft && (uNoAaLeft > 0.5);

  // Jitter only applies to Temporal stages (4=Early TAA, 5=Karis TAA, 6=Specular AA+TAA, 7=Temporal Upscaling)!
  bool useJitter = (st >= 4);
  vec2 effRes = (uRenderScale == 2) ? floor(uRes * 0.5) : uRes;
  vec2 baseUv = useJitter ? (vUv + uJitterPx / max(effRes, vec2(1.0))) : vUv;
  vec2 pxSize = 1.0 / max(effRes, vec2(1.0));

  bool useSpecAA = (st == 6 && uSpecAaOn > 0.5) || (st == 7);

  vec3 col = vec3(0.0);
  Hit centerHit = traceScene(uCamPos, rayForUv(baseUv), uTime, uPrevTime);

  if (st == 0 && !noAaLeft) {
    // ERA 1 (1990): Haeberli & Akeley Accumulation Buffer 4x4 SSAA (16 full shade evaluations/pixel!)
    for (int sy = 0; sy < 4; sy++) {
      for (int sx = 0; sx < 4; sx++) {
        vec2 off = (vec2(float(sx) + 0.5, float(sy) + 0.5) / 4.0 - 0.5) * pxSize;
        vec3 rS = rayForUv(vUv + off);
        Hit hS = traceScene(uCamPos, rS, uTime, uPrevTime);
        col += shadeHit(hS, rS, uTime, false);
      }
    }
    col *= (1.0 / 16.0);
  } else if (st == 1) {
    // ERA 2 (1993): Hardware 4x RGSS MSAA (RealityEngine 1993 -> PC GPUs):
    // 4 subpixel geometry/coverage samples, YET interior surface shading runs ONCE per pixel!
    // Result: crisp silhouette edges, while high-freq specular & checkerboard shading still alias!
    const vec2 rgss[4] = vec2[4](
      vec2(-0.375, -0.125), vec2( 0.125, -0.375),
      vec2( 0.375,  0.125), vec2(-0.125,  0.375)
    );
    vec3 centerShade = shadeHit(centerHit, rayForUv(vUv), uTime, false);
    for (int k = 0; k < 4; k++) {
      vec3 rS = rayForUv(vUv + rgss[k] * pxSize);
      Hit hS = traceScene(uCamPos, rS, uTime, uPrevTime);
      // True MSAA behavior: reuse center pixel's single shader evaluation whenever sample hits same object!
      if (hS.matId == centerHit.matId && abs(hS.t - centerHit.t) < 0.25) {
        col += centerShade;
      } else {
        col += shadeHit(hS, rS, uTime, false);
      }
    }
    col *= 0.25;
  } else {
    // Single primary sample per pixel (Aliased 1x, FXAA input, SMAA input, Early TAA, Karis TAA, Specular AA, 50% Upscale input)
    col = shadeHit(centerHit, rayForUv(baseUv), uTime, useSpecAA);
  }

  // Exact analytical screen-space motion vector (unjittered curUv - prevUv)
  vec2 prevUv = (centerHit.matId == 0)
    ? projectPrevUv(uCamPos + rayForUv(vUv) * 100.0)
    : projectPrevUv(centerHit.prevPos);
  vec2 vel = vUv - prevUv;

  outColor = vec4(max(col, vec3(0.0)), 1.0);
  outVelocity = vec4(vel, centerHit.t < INF ? centerHit.t : 99.0, centerHit.moving);
}
`;

// ============================================================================
// 2. AUTHENTIC FXAA 3.11 (Timothy Lottes, NVIDIA 2011)
// ============================================================================
export const FXAA_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
out vec4 outColor;

float fxLuma(vec3 c) {
  return dot(sqrt(max(c, vec3(0.0))), vec3(0.299, 0.587, 0.114));
}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  vec3 cM = texture(uSrc, vUv).rgb;
  if (st != 2) { outColor = vec4(cM, 1.0); return; }

  vec3 cN  = texture(uSrc, vUv + vec2( 0.0,  uTexel.y)).rgb;
  vec3 cS  = texture(uSrc, vUv + vec2( 0.0, -uTexel.y)).rgb;
  vec3 cE  = texture(uSrc, vUv + vec2( uTexel.x,  0.0)).rgb;
  vec3 cW  = texture(uSrc, vUv + vec2(-uTexel.x,  0.0)).rgb;
  vec3 cNW = texture(uSrc, vUv + vec2(-uTexel.x,  uTexel.y)).rgb;
  vec3 cNE = texture(uSrc, vUv + vec2( uTexel.x,  uTexel.y)).rgb;
  vec3 cSW = texture(uSrc, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
  vec3 cSE = texture(uSrc, vUv + vec2( uTexel.x, -uTexel.y)).rgb;

  float lM = fxLuma(cM), lN = fxLuma(cN), lS = fxLuma(cS), lE = fxLuma(cE), lW = fxLuma(cW);
  float lNW = fxLuma(cNW), lNE = fxLuma(cNE), lSW = fxLuma(cSW), lSE = fxLuma(cSE);

  float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  float lRange = lMax - lMin;
  if (lRange < max(0.0312, lMax * 0.125)) { outColor = vec4(cM, 1.0); return; }

  // Subpixel blur blend factor (responsible for FXAA's iconic soft/blurry texture look!)
  float lAvg = (2.0 * (lN + lS + lE + lW) + lNW + lNE + lSW + lSE) / 12.0;
  float subpix = clamp(abs(lAvg - lM) / lRange, 0.0, 1.0);
  subpix = smoothstep(0.0, 1.0, subpix);
  subpix = subpix * subpix * 0.85;

  float edgeH = abs(lNW - 2.0 * lW + lSW) + 2.0 * abs(lN - 2.0 * lM + lS) + abs(lNE - 2.0 * lE + lSE);
  float edgeV = abs(lNW - 2.0 * lN + lNE) + 2.0 * abs(lW - 2.0 * lM + lE) + abs(lSW - 2.0 * lS + lSE);
  bool isHorz = edgeH >= edgeV;

  float l1 = isHorz ? lS : lW;
  float l2 = isHorz ? lN : lE;
  float g1 = abs(l1 - lM), g2 = abs(l2 - lM);
  float stepLen = isHorz ? uTexel.y : uTexel.x;
  if (g1 >= g2) stepLen = -stepLen;

  vec2 uvB = vUv;
  if (isHorz) uvB.y += stepLen * 0.5;
  else uvB.x += stepLen * 0.5;
  vec2 stepDir = isHorz ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);

  float lEndRef = 0.5 * (lM + (g1 >= g2 ? l1 : l2));
  float gScaled = max(g1, g2) * 0.25;

  vec2 uv1 = uvB - stepDir, uv2 = uvB + stepDir;
  float d1 = fxLuma(texture(uSrc, uv1).rgb) - lEndRef;
  float d2 = fxLuma(texture(uSrc, uv2).rgb) - lEndRef;
  bool done1 = abs(d1) >= gScaled, done2 = abs(d2) >= gScaled;
  for (int i = 0; i < 6; i++) {
    if (!done1) { uv1 -= stepDir; d1 = fxLuma(texture(uSrc, uv1).rgb) - lEndRef; done1 = abs(d1) >= gScaled; }
    if (!done2) { uv2 += stepDir; d2 = fxLuma(texture(uSrc, uv2).rgb) - lEndRef; done2 = abs(d2) >= gScaled; }
    if (done1 && done2) break;
  }

  float dist1 = isHorz ? (vUv.x - uv1.x) : (vUv.y - uv1.y);
  float dist2 = isHorz ? (uv2.x - vUv.x) : (uv2.y - vUv.y);
  float distMin = min(dist1, dist2);
  float span = max(dist1 + dist2, 1e-5);
  float edgeOff = max(0.0, 0.5 - distMin / span);
  float finalOff = max(edgeOff, subpix);

  vec2 finalUv = vUv;
  if (isHorz) finalUv.y += finalOff * stepLen;
  else finalUv.x += finalOff * stepLen;
  if (uSplitX > 0.005 && uSplitX < 0.995 && ((finalUv.x < uSplitX) != useLeft)) finalUv = vUv;
  outColor = vec4(texture(uSrc, finalUv).rgb, 1.0);
}
`;

// ============================================================================
// 3. SMAA 1x (Jorge Jimenez et al., Eurographics 2012) — Edge + Morphological Pattern Blend
// ============================================================================
export const SMAA_EDGE_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 outEdge; // R = left edge, G = top edge

float maxDiff(vec3 a, vec3 b) {
  vec3 d = abs(sqrt(max(a, vec3(0.0))) - sqrt(max(b, vec3(0.0))));
  return max(max(d.r, d.g), d.b);
}

void main() {
  vec3 c  = texture(uSrc, vUv).rgb;
  vec3 cL = texture(uSrc, vUv - vec2(uTexel.x, 0.0)).rgb;
  vec3 cT = texture(uSrc, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 cR = texture(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 cB = texture(uSrc, vUv - vec2(0.0, uTexel.y)).rgb;
  float dL = maxDiff(c, cL);
  float dT = maxDiff(c, cT);
  float dR = maxDiff(c, cR);
  float dB = maxDiff(c, cB);
  // Local contrast adaptation (Jimenez 2012): skips noisy/low-contrast interior texture detail -> stays sharper than FXAA!
  float maxD = max(max(dL, dT), max(dR, dB));
  float eL = step(max(0.09, maxD * 0.50), dL);
  float eT = step(max(0.09, maxD * 0.50), dT);
  outEdge = vec4(eL, eT, 0.0, 1.0);
}
`;

export const SMAA_BLEND_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uEdges;
uniform vec2 uTexel;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
out vec4 outColor;

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  vec3 c0 = texture(uSrc, vUv).rgb;
  if (st != 3) { outColor = vec4(c0, 1.0); return; }

  vec2 e = texture(uEdges, vUv).rg;
  vec2 eR = texture(uEdges, vUv + vec2(uTexel.x, 0.0)).rg;
  vec2 eB = texture(uEdges, vUv - vec2(0.0, uTexel.y)).rg;

  vec3 res = c0;
  float wTotal = 0.0;
  vec3 accum = vec3(0.0);

  // Horizontal edge pattern search (top edge e.g > 0.5)
  if (e.g > 0.5) {
    int lLen = 0, rLen = 0;
    for (int i = 1; i <= 10; i++) {
      if (texture(uEdges, vUv - vec2(float(i) * uTexel.x, 0.0)).g > 0.5) lLen++; else break;
    }
    for (int i = 1; i <= 10; i++) {
      if (texture(uEdges, vUv + vec2(float(i) * uTexel.x, 0.0)).g > 0.5) rLen++; else break;
    }
    float total = float(lLen + rLen + 1);
    if (total >= 2.0) {
      // Check crossing edges at ends (L/Z-shape detection)
      float crossL = texture(uEdges, vUv - vec2(float(lLen) * uTexel.x, 0.0)).r;
      float crossR = texture(uEdges, vUv + vec2(float(rLen + 1) * uTexel.x, 0.0)).r;
      float pos = (float(lLen) + 0.5) / total;
      float area = 0.0;
      if (crossL > 0.5 && crossR < 0.5) area = max(0.0, 0.5 - pos) * 0.9;
      else if (crossR > 0.5 && crossL < 0.5) area = max(0.0, pos - 0.5) * 0.9;
      else if (crossL > 0.5 && crossR > 0.5) area = abs(pos - 0.5) * 0.75;
      if (area > 0.01) {
        accum += mix(c0, texture(uSrc, vUv + vec2(0.0, uTexel.y)).rgb, area) * area;
        wTotal += area;
      }
    }
  }

  // Vertical edge pattern search (left edge e.r > 0.5)
  if (e.r > 0.5) {
    int dLen = 0, uLen = 0;
    for (int i = 1; i <= 10; i++) {
      if (texture(uEdges, vUv - vec2(0.0, float(i) * uTexel.y)).r > 0.5) dLen++; else break;
    }
    for (int i = 1; i <= 10; i++) {
      if (texture(uEdges, vUv + vec2(0.0, float(i) * uTexel.y)).r > 0.5) uLen++; else break;
    }
    float total = float(dLen + uLen + 1);
    if (total >= 2.0) {
      float crossD = texture(uEdges, vUv - vec2(0.0, float(dLen) * uTexel.y)).g;
      float crossU = texture(uEdges, vUv + vec2(0.0, float(uLen + 1) * uTexel.y)).g;
      float pos = (float(dLen) + 0.5) / total;
      float area = 0.0;
      if (crossD > 0.5 && crossU < 0.5) area = max(0.0, 0.5 - pos) * 0.9;
      else if (crossU > 0.5 && crossD < 0.5) area = max(0.0, pos - 0.5) * 0.9;
      else if (crossD > 0.5 && crossU > 0.5) area = abs(pos - 0.5) * 0.75;
      if (area > 0.01) {
        vec2 suv = vUv - vec2(uTexel.x, 0.0);
        if (!(uSplitX > 0.005 && uSplitX < 0.995 && ((suv.x < uSplitX) != useLeft))) {
          accum += mix(c0, texture(uSrc, suv).rgb, area) * area;
          wTotal += area;
        }
      }
    }
  }

  // Also blend from opposite side if neighbor has edge
  if (wTotal < 0.01 && (eR.r > 0.5 || eB.g > 0.5)) {
    vec3 nb = (eR.r > 0.5) ? texture(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb : texture(uSrc, vUv - vec2(0.0, uTexel.y)).rgb;
    res = mix(c0, nb, 0.16);
  } else if (wTotal > 0.01) {
    res = accum / wTotal;
  }
  outColor = vec4(res, 1.0);
}
`;

// ============================================================================
// 4. TEMPORAL RESOLVE: Early TAA (2010-13) / Karis YCoCg Clip (2014) / Upscaling (50% Axis = 25% px)
// ============================================================================
export const TAA_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uCurFull;     // Full-res current (already FXAA/SMAA resolved for Stages 0-6)
uniform sampler2D uCurHalf;     // 50%-axis (25% pixels!) jittered input for Stage 7 Temporal Upscaling!
uniform sampler2D uVelFull;     // Full-res analytical motion vectors
uniform sampler2D uVelHalf;     // 50%-axis motion vectors for Stage 7
uniform sampler2D uHistory;     // Previous resolved full-res history buffer
uniform vec2 uFullTexel;
uniform vec2 uHalfTexel;
uniform vec2 uFullRes;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uHistoryValid;    // 0.0 on first frame / reset -> 1.0 during temporal accumulation
uniform float uShowRawHalf;     // Stage 7 toggle: display raw nearest-neighbor 50%-axis (25% pixels) input!
out vec4 outColor;

vec3 rgbToYCoCg(vec3 c) {
  return vec3(
     0.25 * c.r + 0.50 * c.g + 0.25 * c.b,
     0.50 * c.r              - 0.50 * c.b,
    -0.25 * c.r + 0.50 * c.g - 0.25 * c.b
  );
}
vec3 yCoCgToRgb(vec3 y) {
  float tmp = y.x - y.z;
  return vec3(tmp + y.y, y.x + y.z, tmp - y.y);
}

// Reinhard luma tone-weight (Karis SIGGRAPH 2014: suppresses temporal fireflies!)
vec3 tonemapKaris(vec3 c) {
  float l = max(c.r, max(c.g, c.b));
  return c / (1.0 + l);
}
vec3 invTonemapKaris(vec3 c) {
  float l = min(max(c.r, max(c.g, c.b)), 0.99);
  return c / max(1.0 - l, 0.01);
}

// 5-tap Catmull-Rom bicubic history lookup (stays razor-sharp unlike blurry bilinear!)
vec3 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 res) {
  vec2 pos = uv * res;
  vec2 center = floor(pos - 0.5) + 0.5;
  vec2 f = pos - center;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;

  vec2 w0 = f2 - 0.5 * (f3 + f);
  vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
  vec2 w3 = 0.5 * (f3 - f2);
  vec2 w2 = 1.0 - w0 - w1 - w3;

  vec2 w12 = w1 + w2;
  vec2 tc0 = (center - 1.0) / res;
  vec2 tc3 = (center + 2.0) / res;
  vec2 tc12 = (center + w2 / max(w12, vec2(1e-4))) / res;

  vec3 resCol = vec3(0.0);
  resCol += texture(tex, vec2(tc12.x, tc0.y)).rgb  * (w12.x * w0.y);
  resCol += texture(tex, vec2(tc0.x,  tc12.y)).rgb * (w0.x  * w12.y);
  resCol += texture(tex, vec2(tc12.x, tc12.y)).rgb * (w12.x * w12.y);
  resCol += texture(tex, vec2(tc3.x,  tc12.y)).rgb * (w3.x  * w12.y);
  resCol += texture(tex, vec2(tc12.x, tc3.y)).rgb  * (w12.x * w3.y);
  float wSum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(resCol / max(wSum, 1e-4), vec3(0.0));
}

// Karis SIGGRAPH 2014 exact ray-AABB clip toward neighborhood center in YCoCg space!
vec3 clipAABB(vec3 aabbMin, vec3 aabbMax, vec3 center, vec3 hist) {
  vec3 ext = max(0.5 * (aabbMax - aabbMin), vec3(1e-4));
  vec3 off = hist - center;
  vec3 unit = abs(off / ext);
  float maxU = max(unit.x, max(unit.y, unit.z));
  if (maxU > 1.0) return center + off / maxU;
  return hist;
}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;

  // Spatial stages 0..3 bypass temporal accumulation completely!
  if (st < 4) {
    outColor = texture(uCurFull, vUv);
    return;
  }

  // Stage 7 Toggle: show raw pixelated 50%-axis (25% pixels) nearest-neighbor input directly!
  if (st == 7 && uShowRawHalf > 0.5) {
    vec2 halfPx = floor(vUv * floor(uFullRes * 0.5)) + 0.5;
    vec2 snapUv = halfPx / floor(uFullRes * 0.5);
    outColor = texture(uCurHalf, snapUv);
    return;
  }

  bool isUpscale = (st == 7);
  vec3 cur = isUpscale ? texture(uCurHalf, vUv).rgb : texture(uCurFull, vUv).rgb;
  if (uHistoryValid < 0.5) {
    outColor = vec4(cur, 1.0);
    return;
  }

  if (st == 4) {
    // ERA 5 (2010-2013): Early TAA (Halo: Reach 2010 / Crysis 2 2011 / UE4 2013):
    // Static-camera history blend WITHOUT velocity reprojection or YCoCg clipping!
    // Fixes subpixel wires & shimmer cleanly, BUT leaves unmistakable GHOSTING behind moving pendulum & rotor!
    vec3 hist = texture(uHistory, vUv).rgb;
    vec3 blended = mix(hist, cur, 0.13);
    outColor = vec4(blended, 1.0);
    return;
  }

  // Stages 5 (Karis 2014 TAA), 6 (Specular AA + TAA), 7 (FSR 2 / TSR Temporal Upscaling 50% axis = 25% pixels):
  // 1. Closest-depth velocity dilation (3x3) so moving object silhouettes get crisp motion vectors!
  vec2 vTex = isUpscale ? uHalfTexel : uFullTexel;
  vec4 bestV = isUpscale ? texture(uVelHalf, vUv) : texture(uVelFull, vUv);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec2 suv = vUv + vec2(float(dx), float(dy)) * vTex;
      vec4 sv = isUpscale ? texture(uVelHalf, suv) : texture(uVelFull, suv);
      if (sv.b < bestV.b) bestV = sv;
    }
  }
  vec2 prevUv = vUv - bestV.rg;
  bool offScreen = (prevUv.x < 0.002 || prevUv.x > 0.998 || prevUv.y < 0.002 || prevUv.y > 0.998);
  bool crossedSplit = (uSplitX > 0.005 && uSplitX < 0.995) && ((prevUv.x < uSplitX) != useLeft);

  if (offScreen || crossedSplit) {
    outColor = vec4(cur, 1.0);
    return;
  }

  // 2. 3x3 Neighborhood YCoCg Variance AABB (Lottes 2011 / Malan 2012 / Karis SIGGRAPH 2014)
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 cMin = vec3(1e9), cMax = vec3(-1e9);
  vec2 nTex = isUpscale ? uHalfTexel : uFullTexel;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 suv = clamp(vUv + vec2(float(dx), float(dy)) * nTex, vec2(0.002), vec2(0.998));
      vec3 s = isUpscale ? texture(uCurHalf, suv).rgb : texture(uCurFull, suv).rgb;
      vec3 sy = rgbToYCoCg(tonemapKaris(s));
      m1 += sy;
      m2 += sy * sy;
      cMin = min(cMin, sy);
      cMax = max(cMax, sy);
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));
  // Slightly tighter gamma on moving objects reduces ghosting (while leaving subtle realistic residual at high-contrast edges!)
  float gamma = mix(isUpscale ? 1.35 : 1.15, 0.85, bestV.a);
  vec3 boxMin = max(cMin, mu - gamma * sigma);
  vec3 boxMax = min(cMax, mu + gamma * sigma);

  // 3. Sharp 5-tap Catmull-Rom history lookup + Karis YCoCg AABB ray-clip!
  vec3 histRgb = sampleCatmullRom(uHistory, prevUv, uFullRes);
  vec3 histY = rgbToYCoCg(tonemapKaris(histRgb));
  vec3 clippedY = clipAABB(boxMin, boxMax, mu, histY);
  vec3 curY = rgbToYCoCg(tonemapKaris(cur));

  float alpha = isUpscale ? mix(0.11, 0.24, bestV.a) : mix(0.10, 0.22, bestV.a);
  vec3 outRgb = invTonemapKaris(yCoCgToRgb(mix(clippedY, curY, alpha)));

  outColor = vec4(max(outRgb, vec3(0.0)), 1.0);
}
`;

// ============================================================================
// 5. FINAL ACES TONE-MAP + RCAS SHARPEN (Stage 7) + PIXEL-ACCURATE 4x LOUPE!
// ============================================================================
export const FINAL_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform vec2 uTexel;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uLoupeOn;     // 1.0 = draw crisp 4x pixel-magnifier inset + target crosshair!
uniform vec2 uLoupeTarget;  // Normalized UV of magnified spot (clickable in FX Lab!)
uniform vec2 uLoupeCenter;  // Normalized UV center of the inset box on screen
uniform vec2 uLoupeHalf;    // Normalized half-size of the inset box
uniform float uShowRawHalf;
out vec4 outColor;

vec3 toneMap(vec3 col) {
  col *= 0.94;
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  return pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
}

// Lightweight AMD FSR-style Robust Contrast-Adaptive Sharpening (RCAS) for Stage 7 Temporal Upscaling
vec3 sampleDisplay(vec2 uv, bool useLeft) {
  int st = useLeft ? uStageLeft : uStageRight;
  vec3 c = texture(uSrc, uv).rgb;
  if (st == 7 && uShowRawHalf < 0.5) {
    vec3 n = texture(uSrc, uv + vec2(0.0, uTexel.y)).rgb;
    vec3 s = texture(uSrc, uv - vec2(0.0, uTexel.y)).rgb;
    vec3 e = texture(uSrc, uv + vec2(uTexel.x, 0.0)).rgb;
    vec3 w = texture(uSrc, uv - vec2(uTexel.x, 0.0)).rgb;
    vec3 blur = 0.25 * (n + s + e + w);
    c = max(c + (c - blur) * 0.42, vec3(0.0));
  }
  return toneMap(c);
}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  vec3 col = sampleDisplay(vUv, useLeft);

  if (uLoupeOn > 0.5) {
    // 1. Draw crisp amber target reticle around uLoupeTarget
    vec2 tHalf = uLoupeHalf * 0.25; // Exact 4x magnified footprint on the scene!
    vec2 td = abs(vUv - uLoupeTarget);
    vec2 pxBorder = vec2(2.0) / uRes;
    bool inTargetBorder = (td.x <= tHalf.x + pxBorder.x && td.y <= tHalf.y + pxBorder.y) &&
                          (td.x >= tHalf.x - pxBorder.x || td.y >= tHalf.y - pxBorder.y);
    if (inTargetBorder) {
      col = mix(col, vec3(0.96, 0.72, 0.28), 0.95);
    }

    // 2. Draw pixel-accurate NEAREST 4x Magnifier Loupe inset box!
    vec2 ld = abs(vUv - uLoupeCenter);
    vec2 framePx = vec2(3.0) / uRes;
    if (ld.x <= uLoupeHalf.x + framePx.x && ld.y <= uLoupeHalf.y + framePx.y) {
      if (ld.x >= uLoupeHalf.x || ld.y >= uLoupeHalf.y) {
        col = vec3(0.96, 0.72, 0.28); // Crisp amber loupe frame
      } else {
        // Snap lookup strictly to exact source texel centers -> shows genuine individual pixels at 4x zoom!
        vec2 rel = (vUv - uLoupeCenter) * 0.25;
        vec2 sampleUv = clamp(uLoupeTarget + rel, vec2(0.002), vec2(0.998));
        vec2 snappedUv = (floor(sampleUv * uRes) + 0.5) / uRes;
        bool sampleLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (snappedUv.x < uSplitX));
        col = sampleDisplay(snappedUv, sampleLeft);
        // Subtle 1px amber split line inside the loupe if the split divider crosses the magnified target!
        if (uSplitX > 0.005 && uSplitX < 0.995 && abs(sampleUv.x - uSplitX) < (0.85 / uRes.x)) {
          col = vec3(0.96, 0.72, 0.28);
        }
      }
    }
  }

  outColor = vec4(col, 1.0);
}
`;
