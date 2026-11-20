// Five GLSL ES 3.00 shaders for Evolution of Glass & Caustics:
// 1. CAUSTIC_PHOTON_VS / FS — Real-time GPU photon splatting (9,216..55,296 refracted sunlight photons)
// 2. GLASS_MAIN_FS          — 8-era optical ray tracer (alpha -> Fresnel -> Snell -> Beer -> Dispersion -> TIR + Caustics)
// 3. BLUR_FS                — Separable HDR bloom blur
// 4. FINAL_FS               — ACES filmic tone mapping & subtle vignette

import { GLASS_COMMON_GLSL } from "./optics.js";

// ============================================================================
// PASS 1: REAL-TIME GPU PHOTON CAUSTIC MAP (512x512 additive point splats)
// ============================================================================
export const CAUSTIC_PHOTON_VS = `#version 300 es
precision highp float;
precision highp int;

uniform vec3 uSunDir;
uniform vec3 uSunRight;
uniform vec3 uSunUp;
uniform float uSpin;
uniform float uPrismYaw;
uniform int uBands;          // 1 = monochrome caustics (Step 7), 6 = full spectral rainbow (Step 8)
uniform float uDispStrength; // Cauchy dispersion spread
uniform float uFrost;        // Frosted microfacet softens caustic focus!
uniform float uEnergyScale;  // Scales splat brightness (handles RGBA16F vs RGBA8 cleanly)

out vec3 vColor;

${GLASS_COMMON_GLSL}

void main() {
  const int GRID = 128;
  int perBand = GRID * GRID;
  int bandIdx = gl_VertexID / perBand;
  int cell = gl_VertexID - bandIdx * perBand;
  int ix = cell % GRID;
  int iy = cell / GRID;

  // Clean stratified light-plane grid (no random clumping -> silky continuous caustic ribbons!)
  // Small deterministic band stagger keeps all 6 spectral bands aligned cleanly without moire.
  vec2 subOff = vec2(fract(float(bandIdx) * 0.37) - 0.5, fract(float(bandIdx) * 0.61) - 0.5) * 0.35;
  vec2 jitter = vec2(
    hash21(vec2(float(ix) + float(bandIdx) * 19.3, float(iy) * 3.7)),
    hash21(vec2(float(iy) + float(bandIdx) * 7.1, float(ix) * 5.3))
  ) - 0.5;
  vec2 uv = (vec2(float(ix), float(iy)) + 0.5 + subOff) / float(GRID);
  vec2 plane = (uv * 2.0 - 1.0) * vec2(2.15, 1.65);

  vec3 clusterCenter = vec3(0.22, 0.76, -0.08);
  vec3 ro = clusterCenter + uSunDir * 6.0 + uSunRight * plane.x + uSunUp * plane.y;
  vec3 rd = -uSunDir;

  // Wavelength in [0..1] (0 = Red 650nm, 1 = Violet 435nm)
  // Wide optical flint-crystal Cauchy spread separates R/O/Y/G/C/V into unmistakable rainbow bands!
  float wNorm = (uBands > 1) ? (float(bandIdx) + 0.5) / float(uBands) : 0.45;
  float ior = (uBands > 1) ? mix(1.36, 1.74 + 0.05 * uDispStrength, wNorm) : 1.525;

  // Trace sunlight photon into glass entry surface
  vec2 hit = traceGlassEntry(ro, rd, uSpin, uPrismYaw);
  if (hit.x < 0.0) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }

  vec3 pIn = ro + rd * hit.x;
  vec3 nIn = calcGlassNormal(pIn, uSpin, uPrismYaw);
  if (dot(rd, nIn) > 0.0) nIn = -nIn;

  // Entry Fresnel transmittance & Snell refraction
  float cosIn = max(0.0, dot(-rd, nIn));
  float f0 = pow((1.0 - ior) / (1.0 + ior), 2.0);
  float fIn = f0 + (1.0 - f0) * pow(1.0 - cosIn, 5.0);
  vec3 rdIn = refract(rd, nIn, 1.0 / ior);
  if (length(rdIn) < 0.1) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }

  // March through solid glass to exit face (allow 1 internal TIR bounce so prisms work at every sun angle!)
  float distInside = 0.0;
  vec3 pCur = pIn;
  vec3 dCur = normalize(rdIn);
  vec3 dOut = vec3(0.0);
  float fOut = 0.0;
  bool exited = false;

  for (int b = 0; b < 2; b++) {
    float seg = traceGlassExit(pCur, dCur, hit.y, uSpin, uPrismYaw);
    distInside += seg;
    pCur = pCur + dCur * seg;
    vec3 nOut = calcGlassNormal(pCur, uSpin, uPrismYaw);
    if (dot(dCur, nOut) < 0.0) nOut = -nOut; // ensure nOut points outward
    vec3 refr = refract(dCur, -nOut, ior);
    if (length(refr) > 0.1) {
      float cosO = max(0.0, dot(-dCur, -nOut));
      fOut = f0 + (1.0 - f0) * pow(1.0 - cosO, 5.0);
      dOut = normalize(refr);
      exited = true;
      break;
    }
    // Total Internal Reflection bounce inside the crystal!
    dCur = reflect(dCur, -nOut);
    pCur += dCur * 0.008;
  }

  // Intersect refracted photon with the y = 0 marble pedestal plane
  if (!exited || dOut.y >= -0.04) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }

  float tFloor = -pCur.y / dOut.y;
  vec3 pFloor = pCur + dOut * tFloor;
  if (tFloor < 0.0 || length(pFloor.xz) > PED_R + 0.12) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }

  // Beer-Lambert glass absorption along real path length inside crystal (keep prism ultra-clear for vivid rainbows!)
  vec3 sigma = (hit.y < 1.5) ? vec3(0.24, 0.07, 0.09) : vec3(0.03, 0.02, 0.02);
  vec3 absorb = exp(-sigma * distInside * 0.75);
  float trans = (1.0 - fIn) * (1.0 - fOut);

  vec3 bandCol = (uBands > 1) ? spectralBandColor(wNorm) : vec3(1.12, 1.00, 0.84);
  // Subtle frost diffusion scatters photon footprint wider & softer
  float blurSpread = (hit.y < 1.5) ? uFrost * 0.18 : uFrost * 0.12;
  vec2 floorJit = (jitter * 2.0) * blurSpread;
  vec2 ndc = (pFloor.xz + floorJit) / CAUSTIC_EXT;

  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = mix(6.2, 13.5, uFrost);
  // Boost prism rainbow energy slightly so the Newton fan matches the orb's blazing focal star!
  float objBoost = (hit.y < 1.5) ? 0.88 : 1.75;
  float invBands = (uBands > 1) ? (1.95 / float(uBands)) : 1.0;
  float areaComp = mix(1.0, 0.24, uFrost);
  vColor = bandCol * absorb * trans * objBoost * invBands * areaComp * uEnergyScale;
}
`;

export const CAUSTIC_PHOTON_FS = `#version 300 es
precision highp float;

in vec3 vColor;
out vec4 outColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float w = exp(-r2 * 2.8);
  outColor = vec4(vColor * w, 1.0);
}
`;

// ============================================================================
// PASS 2: 8-ERA GLASS & CAUSTICS RAY TRACER (MRT: HDR + Bloom extract)
// ============================================================================
export const GLASS_MAIN_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uSpin;
uniform float uPrismYaw;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;       // <= 0 or >= 1 disables split
uniform float uOpaqueLeft;   // Step 1 split compares OPAQUE MESH vs 1995 ALPHA
uniform float uDispStrength; // 0 = natural crown/flint, 1 = diamond high dispersion
uniform float uFrost;        // 0 = polished crystal, 1 = frosted sea-glass microfacets
uniform float uCausticDecode;// Multiplier if caustic FBO fell back to RGBA8
uniform sampler2D uTexCaustic;

layout(location = 0) out vec4 outHdr;
layout(location = 1) out vec4 outBloom;

${GLASS_COMMON_GLSL}

// ---------------------------------------------------------------------------
// Analytical opaque world: inlaid marble checkerboard pedestal, brass collar,
// and two fluted dark-marble observatory columns behind the glass!
// ---------------------------------------------------------------------------
struct OpaqueHit {
  float t;
  vec3 pos;
  vec3 norm;
  int mat; // 0 = sky, 1 = marble tile top, 2 = brass rim/collar, 3 = basalt plinth, 4 = dark column
};

// Analytical finite vertical cylinder intersection (centerXZ, radius, yMin..yMax)
float iCylY(vec3 ro, vec3 rd, vec2 c, float r, float yMin, float yMax, out vec3 nOut) {
  vec2 oc = ro.xz - c;
  float a = dot(rd.xz, rd.xz);
  float b = dot(oc, rd.xz);
  float cc = dot(oc, oc) - r * r;
  float h = b * b - a * cc;
  float bestT = 1e5;
  nOut = vec3(0.0, 1.0, 0.0);

  if (h >= 0.0 && a > 1e-6) {
    float s = sqrt(h);
    float t1 = (-b - s) / a;
    if (t1 > 0.001) {
      float y = ro.y + rd.y * t1;
      if (y >= yMin && y <= yMax) {
        bestT = t1;
        nOut = normalize(vec3(ro.x + rd.x * t1 - c.x, 0.0, ro.z + rd.z * t1 - c.y));
      }
    }
  }
  // Top cap at yMax
  if (abs(rd.y) > 1e-5) {
    float tCap = (yMax - ro.y) / rd.y;
    if (tCap > 0.001 && tCap < bestT) {
      vec2 p = ro.xz + rd.xz * tCap - c;
      if (dot(p, p) <= r * r) {
        bestT = tCap;
        nOut = vec3(0.0, 1.0, 0.0);
      }
    }
  }
  return bestT;
}

OpaqueHit traceOpaque(vec3 ro, vec3 rd) {
  OpaqueHit res;
  res.t = 1e5;
  res.mat = 0;
  res.norm = vec3(0.0, 1.0, 0.0);
  res.pos = ro;

  // 1. Marble pedestal tabletop (y = 0, radius PED_R) + outer brass bezel ring (PED_R..PED_R+0.19)
  if (abs(rd.y) > 1e-5) {
    float t0 = -ro.y / rd.y;
    if (t0 > 0.001 && t0 < res.t) {
      vec3 p = ro + rd * t0;
      float r2 = dot(p.xz, p.xz);
      if (r2 <= (PED_R + 0.19) * (PED_R + 0.19)) {
        res.t = t0;
        res.pos = p;
        res.norm = vec3(0.0, 1.0, 0.0);
        res.mat = (r2 <= PED_R * PED_R) ? 1 : 2;
      }
    }
  }

  // 2. Stepped basalt pedestal cylinder beneath tabletop (y = -0.56..0.0)
  vec3 nTmp;
  float tPed = iCylY(ro, rd, vec2(0.0), PED_R + 0.18, -0.56, 0.0, nTmp);
  if (tPed < res.t) {
    res.t = tPed;
    res.pos = ro + rd * tPed;
    res.norm = nTmp;
    res.mat = (res.pos.y > -0.09) ? 2 : 3;
  }

  // 3. Slim brass collar seating the fluted crystal orb cleanly onto the marble
  float tCollar = iCylY(ro, rd, ORB_CENTER.xz, 0.42, 0.0, 0.065, nTmp);
  if (tCollar < res.t) {
    res.t = tCollar;
    res.pos = ro + rd * tCollar;
    res.norm = nTmp;
    res.mat = 2;
  }

  // 4. Two background observatory marble-and-brass columns (so refraction visibly bends vertical pillars!)
  vec2 colA = vec2(-1.42, -1.78);
  vec2 colB = vec2( 1.28, -1.78);
  float tA = iCylY(ro, rd, colA, 0.21, 0.0, 2.35, nTmp);
  if (tA < res.t) {
    res.t = tA;
    res.pos = ro + rd * tA;
    res.norm = nTmp;
    res.mat = (abs(res.pos.y - 0.12) < 0.06 || abs(res.pos.y - 2.25) < 0.07) ? 2 : 4;
  }
  float tB = iCylY(ro, rd, colB, 0.21, 0.0, 2.35, nTmp);
  if (tB < res.t) {
    res.t = tB;
    res.pos = ro + rd * tB;
    res.norm = nTmp;
    res.mat = (abs(res.pos.y - 0.12) < 0.06 || abs(res.pos.y - 2.25) < 0.07) ? 2 : 4;
  }

  return res;
}

// Fast analytical shadow factor from glass objects onto the marble tabletop
float evalGlassShadow(vec3 p, vec3 sunDir) {
  float sh = 1.0;
  // Soft spherical shadow under the fluted orb
  vec2 bO = iSphere(p + vec3(0.0, 0.01, 0.0), sunDir, ORB_CENTER, ORB_R);
  if (bO.x > 0.0 && bO.y > bO.x) {
    float thick = clamp((bO.y - bO.x) / (2.0 * ORB_R), 0.0, 1.0);
    sh = min(sh, 1.0 - 0.78 * smoothstep(0.05, 0.58, thick));
  }
  // Soft shadow under the triangular prism
  vec2 bP = iSphere(p + vec3(0.0, 0.01, 0.0), sunDir, PRISM_CENTER, 0.66);
  if (bP.x > 0.0 && bP.y > bP.x) {
    vec2 h = traceGlassEntry(p + vec3(0.0, 0.015, 0.0), sunDir, uSpin, uPrismYaw);
    if (h.x > 0.0 && h.y > 1.5) sh = min(sh, 0.24);
  }
  return sh;
}

// Shade any opaque world point (used for direct camera hits AND through refracted/reflected glass rays!)
vec3 shadeOpaque(OpaqueHit hit, vec3 rd, int stage) {
  if (hit.mat == 0) return evalStudioSky(rd, uSunDir);

  vec3 p = hit.pos;
  vec3 n = hit.norm;
  vec3 v = -rd;
  vec3 albedo = vec3(0.7);
  float rough = 0.35;
  float metal = 0.0;

  if (hit.mat == 1) {
    // High-contrast inlaid travertine cream & charcoal slate marble checkerboard with brass grout!
    vec2 tileCoord = p.xz / 0.56;
    vec2 cid = floor(tileCoord);
    vec2 cf = abs(fract(tileCoord) - 0.5);
    float grout = smoothstep(0.475, 0.495, max(cf.x, cf.y));
    float chk = mod(cid.x + cid.y, 2.0);
    float vein = fbm2(p.xz * 3.8 + vec2(chk * 5.2, 1.7));
    vec3 cream = mix(vec3(0.84, 0.79, 0.71), vec3(0.68, 0.62, 0.54), smoothstep(0.48, 0.76, vein));
    vec3 slate = mix(vec3(0.11, 0.14, 0.19), vec3(0.20, 0.24, 0.30), smoothstep(0.42, 0.74, vein));
    albedo = mix(mix(slate, cream, chk), vec3(0.68, 0.52, 0.24), grout);
    // Subtle decorative brass inlay circle around the pedestal edge
    float ringD = abs(length(p.xz) - (PED_R - 0.14));
    float ringMask = 1.0 - smoothstep(0.016, 0.026, ringD);
    albedo = mix(albedo, vec3(0.76, 0.58, 0.26), ringMask);
    rough = mix(0.24, 0.18, ringMask);
    metal = max(grout * 0.7, ringMask * 0.85);
  } else if (hit.mat == 2) {
    // Antique brushed brass rim & collar
    albedo = vec3(0.84, 0.64, 0.28);
    rough = 0.22;
    metal = 0.90;
  } else if (hit.mat == 3) {
    // Dark carved basalt pedestal side
    float flt = 0.85 + 0.15 * sin(atan(p.z, p.x) * 24.0);
    albedo = vec3(0.14, 0.16, 0.20) * flt;
    rough = 0.55;
  } else {
    // Fluted dark-emerald/charcoal marble background observatory columns with warm gold band!
    float ang = atan(n.z, n.x);
    float flute = 0.86 + 0.14 * cos(ang * 12.0);
    float band = smoothstep(0.04, 0.01, abs(p.y - 1.15));
    albedo = mix(vec3(0.16, 0.22, 0.28) * flute, vec3(0.88, 0.68, 0.30), band);
    rough = mix(0.32, 0.20, band);
    metal = band * 0.85;
  }

  // Contact AO right underneath the orb & prism bases
  float ao = 1.0;
  if (hit.mat == 1) {
    float dO = length(p.xz - ORB_CENTER.xz);
    float dP = length(p.xz - PRISM_CENTER.xz);
    ao *= smoothstep(0.25, 0.88, dO) * 0.52 + 0.48;
    ao *= smoothstep(0.20, 0.72, dP) * 0.50 + 0.50;
  }

  float sh = (hit.mat == 1) ? evalGlassShadow(p, uSunDir) : 1.0;
  // On Step 1-2 glass shadow is softer; on Step 7-8 deeper refractive shadow makes blazing caustics pop!
  if (stage <= 1) sh = mix(0.72, 1.0, sh);
  else if (stage >= 6) sh = mix(0.14, 1.0, smoothstep(0.20, 0.95, sh));

  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 sunCol = vec3(1.55, 1.38, 1.14);
  vec3 skyAmb = mix(vec3(0.10, 0.13, 0.18), vec3(0.24, 0.30, 0.40), n.y * 0.5 + 0.5);

  vec3 H = normalize(uSunDir + v);
  float specPow = mix(96.0, 16.0, rough);
  float spec = pow(max(dot(n, H), 0.0), specPow) * mix(0.22, 1.35, metal);

  vec3 diff = albedo * (1.0 - metal * 0.82);
  vec3 col = diff * (skyAmb * ao + sunCol * ndl * sh) + mix(vec3(1.0), albedo, metal) * sunCol * spec * sh;

  // Subtle polished reflection on brass and marble floor
  if (metal > 0.3 || hit.mat == 1) {
    vec3 envR = evalStudioSky(reflect(rd, n), uSunDir);
    float f = mix(0.04, 0.82, metal) + (1.0 - mix(0.04, 0.82, metal)) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    col += envR * f * mix(0.14, 0.55, metal) * ao;
  }

  // STEPS 7-8 (2021-2026): Add real GPU-splatted Photon Caustics directly onto the marble pedestal!
  if (hit.mat == 1 && stage >= 6) {
    vec2 cUv = p.xz / CAUSTIC_EXT * 0.5 + 0.5;
    // Smooth 9-tap 3x3 gather over the 512x512 photon splat map -> silky continuous light ribbons!
    vec2 t1 = vec2(1.4 / 512.0);
    vec3 caust = texture(uTexCaustic, cUv).rgb * 0.25
      + (texture(uTexCaustic, cUv + vec2( t1.x, 0.0)).rgb
       + texture(uTexCaustic, cUv + vec2(-t1.x, 0.0)).rgb
       + texture(uTexCaustic, cUv + vec2(0.0,  t1.y)).rgb
       + texture(uTexCaustic, cUv + vec2(0.0, -t1.y)).rgb) * 0.125
      + (texture(uTexCaustic, cUv + vec2( t1.x,  t1.y)).rgb
       + texture(uTexCaustic, cUv + vec2(-t1.x,  t1.y)).rgb
       + texture(uTexCaustic, cUv + vec2( t1.x, -t1.y)).rgb
       + texture(uTexCaustic, cUv + vec2(-t1.x, -t1.y)).rgb) * 0.0625;
    caust *= uCausticDecode;
    // Preserve vivid spectral chroma under ACES (soft shoulder prevents bright rainbow cusps from clipping to white!)
    vec3 tileBoost = mix(vec3(0.74), albedo * 1.05, 0.38);
    vec3 cScaled = caust * (stage >= 7 ? 1.55 : 1.45);
    cScaled = cScaled / (vec3(1.0) + max(vec3(0.0), cScaled - 0.85) * 0.42);
    col += cScaled * tileBoost * 1.18;
  }

  return col;
}

// Microfacet normal perturbation for frosted sea-glass (Step 7 Frost Glass toggle)
vec3 frostNormal(vec3 p, vec3 n, float amt) {
  if (amt < 0.01) return n;
  vec2 q = p.xz * 38.0 + vec2(p.y * 41.0, p.z * 27.0);
  vec3 j = vec3(noise2(q) - 0.5, noise2(q + 17.3) - 0.5, noise2(q + 43.1) - 0.5);
  return normalize(n + j * (0.28 * amt));
}

// Trace a single wavelength ray through thick glass (with optional multi-bounce TIR for Step 8!)
vec3 traceGlassWavelength(vec3 pIn, vec3 rd, vec3 nIn, float glassId, float ior, int maxBounces, float frostAmt, int stage) {
  vec3 rdIn = refract(rd, nIn, 1.0 / ior);
  if (length(rdIn) < 0.1) return evalStudioSky(reflect(rd, nIn), uSunDir);

  vec3 sigma = (glassId < 1.5) ? vec3(0.55, 0.14, 0.18) : vec3(0.14, 0.09, 0.06);
  vec3 throughput = vec3(1.0);
  vec3 accum = vec3(0.0);
  vec3 pCur = pIn;
  vec3 dCur = normalize(rdIn);
  float f0 = pow((1.0 - ior) / (1.0 + ior), 2.0);

  for (int b = 0; b < 4; b++) {
    if (b >= maxBounces) break;
    float seg = traceGlassExit(pCur, dCur, glassId, uSpin, uPrismYaw);
    pCur = pCur + dCur * seg;
    // Beer-Lambert exponential volume absorption along the real interior chord!
    throughput *= exp(-sigma * seg * 0.82);

    vec3 nOut = calcGlassNormal(pCur, uSpin, uPrismYaw);
    if (dot(dCur, nOut) < 0.0) nOut = -nOut;
    if (frostAmt > 0.01) nOut = frostNormal(pCur, nOut, frostAmt);

    vec3 dOut = refract(dCur, -nOut, ior);
    if (length(dOut) > 0.1) {
      float cosO = max(0.0, dot(-dCur, -nOut));
      float fOut = f0 + (1.0 - f0) * pow(1.0 - cosO, 5.0);
      OpaqueHit bg = traceOpaque(pCur + nOut * 0.004, normalize(dOut));
      vec3 exitCol = shadeOpaque(bg, normalize(dOut), stage);
      if (b == maxBounces - 1 || maxBounces == 1) {
        accum += throughput * exitCol;
        break;
      }
      accum += throughput * (1.0 - fOut) * exitCol;
      throughput *= fOut;
    }
    // Total Internal Reflection (or partial internal reflection) keeps bouncing inside the crystal!
    dCur = reflect(dCur, -nOut);
    pCur += dCur * 0.008;
    if (b == maxBounces - 1) {
      // Fallback subtle sparkling internal sky reflection if all bounces stayed trapped
      accum += throughput * evalStudioSky(dCur, uSunDir) * 0.85;
    }
  }
  return accum;
}

// Subtle volumetric sunlit dust-beam emerging from the prism/orb caustic zone (Step 8 polish!)
vec3 evalPrismDustBeam(vec3 ro, vec3 rd, float maxT) {
  vec3 glow = vec3(0.0);
  float tStart = max(0.5, maxT * 0.15);
  float tEnd = min(maxT, 11.5);
  float stepT = (tEnd - tStart) / 6.0;
  for (int i = 0; i < 6; i++) {
    float t = tStart + (float(i) + 0.5) * stepT;
    vec3 p = ro + rd * t;
    if (p.y > 0.02 && p.y < 1.05 && length(p.xz) < PED_R) {
      // Project point back along sunlight direction onto the caustic floor map!
      vec2 projXZ = p.xz - uSunDir.xz * (p.y / max(0.25, uSunDir.y));
      vec2 cUv = projXZ / CAUSTIC_EXT * 0.5 + 0.5;
      if (cUv.x > 0.02 && cUv.x < 0.98 && cUv.y > 0.02 && cUv.y < 0.98) {
        vec3 cVal = texture(uTexCaustic, cUv).rgb * uCausticDecode;
        float hFade = smoothstep(1.02, 0.08, p.y);
        glow += cVal * hFade * stepT * 0.055;
      }
    }
  }
  return glow;
}

vec3 shadePixel(vec3 ro, vec3 rd, int stage, bool opaqueLeft) {
  OpaqueHit op = traceOpaque(ro, rd);
  vec2 gHit = traceGlassEntry(ro, rd, uSpin, uPrismYaw);

  // If camera hits opaque geometry BEFORE glass (or misses glass), shade opaque scene
  if (gHit.x < 0.0 || gHit.x > op.t) {
    vec3 col = shadeOpaque(op, rd, stage);
    if (stage >= 7) col += evalPrismDustBeam(ro, rd, min(op.t, 12.0));
    return col;
  }

  vec3 pIn = ro + rd * gHit.x;
  vec3 nIn = calcGlassNormal(pIn, uSpin, uPrismYaw);
  if (dot(rd, nIn) > 0.0) nIn = -nIn;
  float glassId = gHit.y;

  // Background straight behind the glass (for Steps 1-3 where rays do NOT refract!)
  vec3 bgStraight = shadeOpaque(op, rd, stage);

  // -------------------------------------------------------------------------
  // STEP 1 (1995): Flat Alpha Transparency (or solid Opaque Mesh on Split Left)
  // -------------------------------------------------------------------------
  if (stage == 0) {
    float ndl = max(dot(nIn, uSunDir), 0.0);
    vec3 flatTint = mix(vec3(0.46, 0.62, 0.68), vec3(0.60, 0.72, 0.78), glassId - 1.0);
    vec3 lit = flatTint * (0.28 + 0.78 * ndl);
    if (opaqueLeft) return lit;
    return mix(bgStraight, lit, 0.38);
  }

  // -------------------------------------------------------------------------
  // STEP 2 (1999): Constant Env-Map Chrome Reflection + Blinn-Phong Specular
  // -------------------------------------------------------------------------
  if (stage == 1) {
    vec3 reflDir = reflect(rd, nIn);
    vec3 env = evalStudioSky(reflDir, uSunDir);
    vec3 H = normalize(uSunDir - rd);
    float spec = pow(max(dot(nIn, H), 0.0), 84.0) * 1.45;
    vec3 col = mix(bgStraight, vec3(0.54, 0.74, 0.80), 0.22);
    col = mix(col, env, 0.34) + vec3(1.0, 0.96, 0.90) * spec;
    return col;
  }

  // -------------------------------------------------------------------------
  // STEP 3 (2003): Schlick Fresnel Reflection (F0 = 0.04, unbent background)
  // -------------------------------------------------------------------------
  float cosTheta = max(0.0, dot(-rd, nIn));
  float fresnel = 0.04 + 0.96 * pow(1.0 - cosTheta, 5.0);
  vec3 reflDir = reflect(rd, nIn);
  vec3 envRefl = evalStudioSky(reflDir, uSunDir);
  vec3 H = normalize(uSunDir - rd);
  float sunGlint = pow(max(dot(nIn, H), 0.0), 180.0) * 2.4;

  if (stage == 2) {
    vec3 body = bgStraight * vec3(0.92, 0.98, 0.99);
    return mix(body, envRefl, fresnel) + vec3(1.0, 0.95, 0.86) * sunGlint * (0.35 + 0.65 * fresnel);
  }

  // -------------------------------------------------------------------------
  // STEP 4 (2007): Single-Surface Snell Refraction (thin shell, bends background!)
  // -------------------------------------------------------------------------
  if (stage == 3) {
    vec3 refrDir = normalize(refract(rd, nIn, 1.0 / 1.52));
    OpaqueHit hRefr = traceOpaque(pIn + refrDir * 0.01, refrDir);
    vec3 refrCol = shadeOpaque(hRefr, refrDir, stage);
    return mix(refrCol, envRefl, fresnel) + vec3(1.0, 0.95, 0.86) * sunGlint;
  }

  // -------------------------------------------------------------------------
  // STEP 5 (2012): Thick Double Refraction (Entry + Exit) & Beer-Lambert Tint
  // -------------------------------------------------------------------------
  if (stage == 4) {
    vec3 refrCol = traceGlassWavelength(pIn, rd, nIn, glassId, 1.525, 2, 0.0, stage);
    return mix(refrCol, envRefl, fresnel) + vec3(1.0, 0.95, 0.86) * sunGlint;
  }

  // -------------------------------------------------------------------------
  // STEPS 6-8 (2016-2026): Cauchy Spectral Dispersion + Photon Caustics + TIR!
  // -------------------------------------------------------------------------
  float frostAmt = (stage == 6) ? uFrost : 0.0;
  vec3 nUse = frostNormal(pIn, nIn, frostAmt);
  float cosF = max(0.0, dot(-rd, nUse));
  float fUse = 0.04 + 0.96 * pow(1.0 - cosF, 5.0);
  vec3 envUse = evalStudioSky(reflect(rd, nUse), uSunDir);

  if (frostAmt > 0.01) {
    // True multi-tap GGX frosted sea-glass cone blur: 4 jittered microfacet rays + soft sheen!
    vec3 tA = normalize(cross(nIn, abs(nIn.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 tB = cross(nIn, tA);
    vec3 accRefr = vec3(0.0);
    vec3 accEnv = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      float ang = float(k) * 1.5708 + hash21(gl_FragCoord.xy + float(k) * 13.7) * 6.2831;
      float rad = (0.16 + 0.14 * hash21(gl_FragCoord.yx + float(k) * 7.3)) * frostAmt;
      vec3 nk = normalize(nIn + (tA * cos(ang) + tB * sin(ang)) * rad);
      accRefr += traceGlassWavelength(pIn, rd, nk, glassId, 1.525, 2, 0.0, stage);
      accEnv += evalStudioSky(reflect(rd, nk), uSunDir);
    }
    vec3 refrBlur = mix(accRefr * 0.25, vec3(0.68, 0.84, 0.88), 0.28 * frostAmt);
    vec3 envBlur = accEnv * 0.25;
    float fRough = 0.08 + 0.55 * pow(1.0 - cosTheta, 3.2);
    float glintSoft = pow(max(dot(nIn, H), 0.0), 18.0) * 0.65;
    return mix(refrBlur, envBlur, fRough) + vec3(1.0, 0.96, 0.90) * glintSoft;
  }

  int maxBounces = (stage >= 7) ? 4 : 2;
  float spread = mix(0.055, 0.115, uDispStrength);
  float iorR = 1.525 - spread;
  float iorG = 1.525;
  float iorB = 1.525 + spread * 1.15;

  // 3 primary spectral wavelengths (plus 2 intermediate orange/cyan taps on Step 8 for silky smooth rainbows!)
  vec3 cR = traceGlassWavelength(pIn, rd, nUse, glassId, iorR, maxBounces, frostAmt, stage);
  vec3 cG = traceGlassWavelength(pIn, rd, nUse, glassId, iorG, maxBounces, frostAmt, stage);
  vec3 cB = traceGlassWavelength(pIn, rd, nUse, glassId, iorB, maxBounces, frostAmt, stage);
  vec3 refrCol;
  if (stage >= 7) {
    vec3 cY = traceGlassWavelength(pIn, rd, nUse, glassId, mix(iorR, iorG, 0.5), maxBounces, frostAmt, stage);
    vec3 cC = traceGlassWavelength(pIn, rd, nUse, glassId, mix(iorG, iorB, 0.5), maxBounces, frostAmt, stage);
    refrCol = vec3(
      cR.r * 0.58 + cY.r * 0.42,
      cY.g * 0.28 + cG.g * 0.44 + cC.g * 0.28,
      cC.b * 0.42 + cB.b * 0.58
    );
  } else {
    refrCol = vec3(cR.r, cG.g, cB.b);
  }

  float glintPow = mix(220.0, 28.0, frostAmt);
  float glintAmp = mix(2.8, 0.55, frostAmt);
  float glint = pow(max(dot(nUse, H), 0.0), glintPow) * glintAmp;

  vec3 col = mix(refrCol, envUse, fUse) + vec3(1.0, 0.96, 0.88) * glint;
  if (stage >= 7) col += evalPrismDustBeam(ro, rd, gHit.x);
  return col;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  bool opLeft = useLeft && (uOpaqueLeft > 0.5);

  vec3 hdr = shadePixel(uCamPos, rd, st, opLeft);
  outHdr = vec4(max(hdr, vec3(0.0)), 1.0);

  // Extract bright optical glints, studio skylights & intense caustics for HDR bloom
  float lum = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
  float bloomW = smoothstep(0.95, 2.20, lum);
  outBloom = vec4(hdr * bloomW * 0.75, 1.0);
}
`;

// ============================================================================
// PASS 3 & 4: SEPARABLE HDR BLOOM + ACES FILMIC TONE MAPPING
// ============================================================================
export const BLUR_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;
out vec4 outColor;

void main() {
  vec3 acc = texture(uSrc, vUv).rgb * 0.227027;
  acc += (texture(uSrc, vUv + uDir * 1.384615).rgb + texture(uSrc, vUv - uDir * 1.384615).rgb) * 0.316216;
  acc += (texture(uSrc, vUv + uDir * 3.230769).rgb + texture(uSrc, vUv - uDir * 3.230769).rgb) * 0.070270;
  outColor = vec4(acc, 1.0);
}
`;

export const FINAL_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
out vec4 outColor;

void main() {
  vec3 col = texture(uHdr, vUv).rgb + texture(uBloom, vUv).rgb * 0.58;
  // ACES filmic tone curve
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  // Subtle observatory vignette
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.22;
  outColor = vec4(pow(max(col, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}
`;
