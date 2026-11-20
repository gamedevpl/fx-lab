// Four GLSL ES 3.00 shaders for Evolution of Clouds & Sky:
// 1. CLOUDS_MAIN_FS — All 8 eras (1992 pixel sprites -> 1997 plane -> 2002 billboards -> 2007 Rayleigh/Mie
//                     -> 2012 3D Perlin-Worley -> 2016 Beer/HG -> 2020 Multi-Scatter Powder -> 2026 God-Rays)
// 2. GODRAYS_FS     — Radial crepuscular sunbeam shafts through cumulus gaps (Step 8)
// 3. BLUR_FS        — Separable HDR bloom blur
// 4. FINAL_FS       — ACES filmic composite with split-screen masking of god-rays

import { CLOUDS_COMMON_GLSL } from "./atmosphere.js";

// ============================================================================
// PASS 1: 8-ERA SKY, CLOUDS & ALPINE HORIZON (MRT: outHdr + outOccBloom)
// ============================================================================
export const CLOUDS_MAIN_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

in vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec3 uSunDir;
uniform float uTime;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uSolidLeft;   // Step 1 split compares SOLID SKY vs 1992 PIXEL
uniform float uShowCards;   // Step 3 toggle: outlines 2002 billboard quad borders!
uniform float uStorm;       // Step 7 toggle: deepens cloud coverage & towering storm anvil!
uniform sampler3D uCloudTex3D;

layout(location = 0) out vec4 outHdr;
layout(location = 1) out vec4 outOccBloom; // RGB = HDR bloom + god-ray source, A = sun-beam emitter mask

${CLOUDS_COMMON_GLSL}

// ---------------------------------------------------------------------------
// 3D Volumetric Cloud Field (Steps 5-8): GPU-baked 64^3 Perlin-Worley 3D texture!
// Sculpted photographic cumulus puffs (like Flight Simulator / RDR2 — never smooth blobs!)
// ---------------------------------------------------------------------------
const float CLOUD_BOT = 1.75;
const float CLOUD_TOP = 5.35;

// Natural broken-cumulus weather coverage: lush, sculptural cumulus billows with clear sapphire sky gaps!
float sampleCloudCoverage(vec2 xz, float stormAmt) {
  vec2 drift = xz + vec2(uTime * 0.16, uTime * 0.04);
  float wBase = fbm2(drift * 0.135 + vec2(2.6, 4.9));
  float wBillow = noise2(drift * 0.27 - vec2(1.4, 2.3));
  float midBand = exp(-pow((xz.y + 12.0) * 0.10, 2.0)) * 0.20;
  float cov = mix(wBase, wBillow, 0.36) * 0.94 + midBand + 0.08 + stormAmt * 0.22;
  return clamp(cov, 0.0, 0.90 + stormAmt * 0.09);
}

// Full 3D cloud density at world point p (bold, crisp cauliflower cumulus towers sculpted by 64^3 3D Worley!)
float sampleCloudDensity(vec3 p, float stormAmt, bool hiDetail) {
  float h = (p.y - CLOUD_BOT) / (CLOUD_TOP - CLOUD_BOT);
  if (h <= 0.0 || h >= 1.0) return 0.0;

  float cov = sampleCloudCoverage(p.xz, stormAmt);
  if (cov < 0.40) return 0.0;

  float hProf = smoothstep(0.0, 0.13, h) * smoothstep(1.0, 0.44 - stormAmt * 0.18, h);
  if (hProf < 0.002) return 0.0;

  vec3 windOff = vec3(uTime * 0.022, 0.0, uTime * 0.007);
  vec3 sp = p * 0.155 + windOff + vec3(h * 0.07, 0.0, 0.0);
  vec4 nBase = texture(uCloudTex3D, sp);

  float baseShape = nBase.r * 0.56 + nBase.g * 0.30 + nBase.b * 0.14;
  float thresh = mix(0.66, 0.34, clamp((cov - 0.40) / 0.52, 0.0, 1.0)) + h * 0.16;
  float d = smoothstep(thresh, thresh + 0.15, baseShape) * hProf;

  if (hiDetail && d > 0.002) {
    vec3 dp = p * 0.42 + windOff * 2.2;
    vec4 nDet = texture(uCloudTex3D, dp);
    float wDet = nDet.g * 0.60 + nDet.b * 0.40;
    d = max(0.0, d - (1.0 - wDet) * 0.32 * (1.0 - d * 0.38));
  }
  return d * (3.15 + stormAmt * 0.95);
}

// Fast 6-tap light-march shadow transmittance toward the sun (Steps 6-8)
float marchCloudLight(vec3 p, vec3 sunDir, float stormAmt) {
  float od = 0.0;
  float stepLen = 0.28;
  for (int i = 0; i < 6; i++) {
    vec3 lp = p + sunDir * (stepLen * (float(i) + 0.55));
    if (lp.y > CLOUD_TOP) break;
    od += sampleCloudDensity(lp, stormAmt, i < 2) * stepLen;
    stepLen *= 1.30;
  }
  return od;
}

// ---------------------------------------------------------------------------
// STEP 1 (1992): Flat 2D Pixelated Cloud Sprites scrolling across quantized sky
// ---------------------------------------------------------------------------
vec3 render1992PixelClouds(vec3 rd, vec3 sunDir, vec3 skyCol) {
  if (rd.y < 0.02) return skyCol;
  // Quantize screen/sky angle onto a crisp low-res 2D pixel grid (SNES/VGA era!)
  vec2 skyUV = vec2(atan(rd.x, -rd.z) * 1.55, rd.y * 2.8);
  vec2 qUV = floor(skyUV * vec2(44.0, 34.0)) / vec2(44.0, 34.0);

  // Two flat 2D parallax cloud sprite layers (zero 3D perspective foreshortening!)
  vec2 p1 = vec2(qUV.x + uTime * 0.06, qUV.y);
  float c1 = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float cx = fract(p1.x * 0.28 + fi * 0.27) * 3.6 - 1.8;
    float cy = 0.55 + 0.28 * sin(fi * 2.1 + 0.6);
    vec2 d = (vec2(cx, qUV.y - cy)) * vec2(1.0, 2.3);
    float puff = min(length(d), min(length(d - vec2(0.24, -0.04)), length(d + vec2(0.26, 0.03))));
    c1 = max(c1, step(puff, 0.26));
  }
  // Classic 2-tone pixel cloud shading (bright white top, flat periwinkle bottom)
  if (c1 > 0.5) {
    float topBand = step(0.62, fract(qUV.y * 3.2 + 0.2));
    return mix(vec3(0.76, 0.85, 0.96), vec3(0.98, 0.99, 1.00), topBand);
  }
  return skyCol;
}

// ---------------------------------------------------------------------------
// STEP 2 (1997): Single Flat Scrolling Cloud Plane mapped overhead at y = 2.6
// ---------------------------------------------------------------------------
vec3 render1997ScrollingPlane(vec3 ro, vec3 rd, vec3 sunDir, vec3 skyCol) {
  if (rd.y <= 0.015) return skyCol;
  float t = (2.75 - ro.y) / rd.y;
  if (t <= 0.0 || t > 140.0) return skyCol;
  vec2 p = ro.xz + rd.xz * t;
  vec2 uv = p * 0.105 + vec2(uTime * 0.05, uTime * 0.02);

  // Classic N64/PS1 tiled FBM sheet (high-contrast patches stretch dramatically toward horizon!)
  float n = fbm2(uv) * 0.72 + noise2(uv * 3.1 - vec2(uTime * 0.02)) * 0.28;
  float alpha = smoothstep(0.48, 0.64, n) * smoothstep(0.015, 0.11, rd.y);
  float lit = clamp(0.55 + 0.65 * (fbm2(uv + sunDir.xz * 0.09) - n) * 2.8, 0.35, 1.0);
  vec3 cloudCol = mix(vec3(0.45, 0.54, 0.68), vec3(0.98, 0.98, 0.99), lit);
  float distFade = exp(-t * 0.014);
  return mix(skyCol, cloudCol, alpha * distFade * 0.94);
}

// ---------------------------------------------------------------------------
// STEP 3 (2002): 3D Camera-Facing Billboard Cloud Puffs (with Show Cards toggle!)
// ---------------------------------------------------------------------------
vec3 render2002Billboards(vec3 ro, vec3 rd, vec3 sunDir, vec3 skyCol, float showCards) {
  vec3 col = skyCol;
  // 10 deterministic 3D cloud-puff cards arranged back-to-front in the mid sky
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float depth = 15.5 - fi * 0.72;
    float px = (hash21(vec2(fi, 1.7)) - 0.5) * 12.0 + sin(uTime * 0.15 + fi) * 0.22;
    float py = 2.4 + hash21(vec2(fi, 4.3)) * 2.4;
    vec3 center = vec3(px, py, -depth);
    float halfSz = 1.75 + hash21(vec2(fi, 9.1)) * 0.95;

    // Intersect ray with camera-facing quad centered at center (plane normal = -uCamFwd)
    float denom = dot(rd, -uCamFwd);
    if (abs(denom) < 1e-4) continue;
    float t = dot(center - ro, -uCamFwd) / denom;
    if (t <= 0.5) continue;
    vec3 hp = ro + rd * t - center;
    vec2 q = vec2(dot(hp, uCamRight), dot(hp, uCamUp)) / halfSz;
    if (abs(q.x) > 1.0 || abs(q.y) > 1.0) continue;

    // Classic early-2000s round alpha puff sprite (crisp enough to read clearly, flat vs 3D volume!)
    float r = length(q * vec2(0.88, 1.12));
    float puffNoise = fbm2(q * 2.6 + vec2(fi * 3.1, 1.2));
    float a = smoothstep(0.92, 0.44, r + (puffNoise - 0.5) * 0.34) * 0.92;
    float shade = clamp(0.42 + q.y * 0.52 + dot(normalize(vec3(q, 0.5)), sunDir) * 0.22, 0.22, 1.0);
    vec3 cardCol = mix(vec3(0.44, 0.50, 0.62), vec3(0.98, 0.95, 0.90), shade);
    col = mix(col, cardCol, a);

    // Educational Show Cards overlay: crisp amber wireframe border around every flat billboard quad!
    if (showCards > 0.5) {
      float edge = max(abs(q.x), abs(q.y));
      float border = smoothstep(0.952, 0.985, edge);
      float diag = 1.0 - smoothstep(0.008, 0.018, abs(q.x - q.y));
      col = mix(col, vec3(0.98, 0.72, 0.24), max(border * 0.96, diag * 0.30));
    }
  }
  return col;
}

// ---------------------------------------------------------------------------
// STEPS 5-8 (2012-2026): Real 3D Perlin-Worley Volumetric Cloud Raymarcher
// ---------------------------------------------------------------------------
void marchVolumetricClouds(
  vec3 ro, vec3 rd, vec3 sunDir, vec3 skyCol, float stormAmt, int stage,
  out vec3 finalCol, out float cloudTransOut
) {
  cloudTransOut = 1.0;
  finalCol = skyCol;
  if (rd.y <= 0.008) return;

  // Ray-slab intersection with horizontal cloud deck [CLOUD_BOT, CLOUD_TOP]
  float tBot = (CLOUD_BOT - ro.y) / rd.y;
  float tTop = (CLOUD_TOP - ro.y) / rd.y;
  float t0 = max(0.2, min(tBot, tTop));
  float t1 = min(44.0, max(tBot, tTop));
  if (t1 <= t0) return;

  const int STEPS = 56;
  float dt = (t1 - t0) / float(STEPS);
  // Blue-noise-like interleaved gradient jitter kills slice banding completely!
  float t = t0 + dt * ign(gl_FragCoord.xy);

  float cosT = dot(rd, sunDir);
  vec3 sunCol = evalSunColor(sunDir.y);
  float day = smoothstep(-0.02, 0.45, sunDir.y);

  // Phase functions:
  // Step 5 (2012): isotropic basic diffuse
  // Step 6 (2016): forward-peaked Henyey-Greenstein silver lining!
  // Steps 7-8 (2020-2026): dual-lobe HG (strong forward silver rim + soft back scatter)
  float phaseFwd = hgPhase(cosT, 0.76);
  float phaseBack = hgPhase(cosT, -0.24);
  float phase = (stage <= 4) ? 0.34 : mix(phaseBack, phaseFwd, 0.74) * 2.35;

  // Sky ambient colors illuminating cloud bottoms & crests
  vec3 skyTopAmb = mix(vec3(0.20, 0.26, 0.44), vec3(0.36, 0.56, 0.88), day);
  vec3 skyBotAmb = mix(vec3(0.14, 0.11, 0.16), vec3(0.16, 0.22, 0.32), day);

  vec3 accumLight = vec3(0.0);
  float trans = 1.0;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float dens = sampleCloudDensity(p, stormAmt, true);
    if (dens > 0.002) {
      float h = clamp((p.y - CLOUD_BOT) / (CLOUD_TOP - CLOUD_BOT), 0.0, 1.0);
      vec3 scatterLight = vec3(0.0);

      if (stage == 4) {
        // STEP 5 (2012): 3D Perlin-Worley volume with simple height-gradient diffuse (chalky, zero self-shadows!)
        float basicLit = mix(0.28, 0.92, pow(h, 0.85));
        scatterLight = vec3(0.84, 0.86, 0.90) * basicLit + mix(skyBotAmb, skyTopAmb, h) * 0.22;
      } else {
        float lightOD = marchCloudLight(p, sunDir, stormAmt);
        float beer = exp(-lightOD * 1.85);

        if (stage == 5) {
          // STEP 6 (2016): Beer-Lambert single scattering + blazing HG silver lining!
          // (Deep stark slate-black cloud bellies contrast dramatically with glowing sunlit rims!)
          vec3 direct = sunCol * beer * (0.35 + phase * 1.45);
          vec3 amb = mix(vec3(0.05, 0.07, 0.13), skyTopAmb * 0.65, h);
          scatterLight = direct + amb;
        } else {
          // STEPS 7-8 (2020-2026): Multi-Scattering Octave Sum + Beer-Powder + warm painterly bounce!
          float powder = 1.0 - exp(-lightOD * 2.4);
          float ms0 = beer * mix(1.0, powder * 1.65, 0.42);
          float ms1 = exp(-lightOD * 0.45) * 0.46;
          float ms2 = exp(-lightOD * 0.16) * 0.22;
          float p0 = mix(phaseBack, phaseFwd, 0.76) * 2.30;
          float p1 = mix(0.30, hgPhase(cosT, 0.35) * 1.4, 0.55);
          float p2 = 0.26;

          vec3 direct = sunCol * (ms0 * (0.40 + p0) + ms1 * p1 * vec3(1.08, 0.92, 0.78) + ms2 * p2 * vec3(1.16, 0.80, 0.62));
          float depthAO = mix(0.38, 1.0, smoothstep(0.0, 0.62, h));
          // Storm Front deepens underside shadows dramatically!
          float stormDark = mix(1.0, 0.48, stormAmt);
          vec3 amb = mix(skyBotAmb * 1.15 * stormDark, skyTopAmb * 1.15, h) * depthAO;
          scatterLight = direct + amb;
        }
      }

      // Energy-conserving analytical integration across step dt (Frostbite / Sebastian Hillaire formula!)
      float stepTrans = exp(-dens * dt * 1.42);
      vec3 stepInteg = (scatterLight - scatterLight * stepTrans);
      accumLight += trans * stepInteg;
      trans *= stepTrans;
      if (trans < 0.015) {
        trans = 0.0;
        break;
      }
    }
    t += dt;
  }

  // Gentle aerial perspective keeps mid-sky clouds crisp while softening very distant horizon clouds
  float distFog = exp(-max(0.0, t0 - 8.0) * 0.025);
  vec3 cloudFinal = mix(skyCol, accumLight + skyCol * trans, distFog);

  // Step 8 bonus: delicate high-altitude golden cirrus wisps high in the cobalt zenith!
  if (stage >= 7 && rd.y > 0.14 && trans > 0.05) {
    float tCir = (9.5 - ro.y) / rd.y;
    vec2 cPos = ro.xz + rd.xz * tCir;
    vec2 cUv = cPos * 0.048 + vec2(uTime * 0.015, -uTime * 0.008);
    float wisp = fbm2(vec2(cUv.x * 2.6 + fbm2(cUv * 1.9), cUv.y * 0.8));
    float cirA = smoothstep(0.58, 0.84, wisp) * smoothstep(0.14, 0.30, rd.y) * 0.38 * trans;
    vec3 cirCol = mix(skyTopAmb * 1.1, sunCol * 1.25, 0.72);
    cloudFinal = mix(cloudFinal, cirCol, cirA);
  }

  finalCol = cloudFinal;
  cloudTransOut = mix(1.0, trans, distFog);
}

// ---------------------------------------------------------------------------
// Alpine Horizon Peak & Distant Ridges (anchors cinematic scale + cloud shadows!)
// ---------------------------------------------------------------------------
bool traceAlpineTerrain(vec3 ro, vec3 rd, out float tHit, out vec3 pHit) {
  tHit = -1.0;
  pHit = ro;
  if (rd.y > 0.22) return false;
  float t = 1.6;
  for (int i = 0; i < 42; i++) {
    vec3 p = ro + rd * t;
    float h = mountainHeight(p.xz);
    float diff = p.y - h;
    if (diff < 0.025) {
      // One bisection refinement step for crisp silhouette ridges!
      t -= diff * 0.5;
      pHit = ro + rd * t;
      tHit = t;
      return true;
    }
    t += max(0.08, diff * 0.58);
    if (t > 24.0) break;
  }
  return false;
}

vec3 calcTerrainNormal(vec3 p) {
  vec2 e = vec2(0.06, 0.0);
  return normalize(vec3(
    mountainHeight(p.xz - e.xy) - mountainHeight(p.xz + e.xy),
    2.0 * e.x,
    mountainHeight(p.xz - e.yx) - mountainHeight(p.xz + e.yx)
  ));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  bool solidLeft = useLeft && (uSolidLeft > 0.5);
  float stormAmt = (st == 6) ? uStorm : 0.0;

  // 1. Evaluate base sky dome (Retro for Steps 1-3 vs Physical Rayleigh+Mie for Steps 4-8!)
  vec3 sunDisk = vec3(0.0);
  vec3 skyCol = (st <= 2) ? evalRetroSky(rd, uSunDir, st) : evalPhysicalSky(rd, uSunDir, sunDisk);

  // 2. Render clouds according to current graphics era
  vec3 col = skyCol;
  float cloudTrans = 1.0;
  if (st == 0) {
    col = solidLeft ? skyCol : render1992PixelClouds(rd, uSunDir, skyCol);
  } else if (st == 1) {
    col = render1997ScrollingPlane(uCamPos, rd, uSunDir, skyCol);
  } else if (st == 2) {
    col = render2002Billboards(uCamPos, rd, uSunDir, skyCol, uShowCards);
  } else if (st == 3) {
    // Step 4 (2007): Physical Rayleigh + Mie Sky paired with crisp 2002 billboards so sky leap is unmistakable!
    col = render2002Billboards(uCamPos, rd, uSunDir, skyCol, 0.0);
  } else {
    marchVolumetricClouds(uCamPos, rd, uSunDir, skyCol, stormAmt, st, col, cloudTrans);
  }

  // 3. Intersect foreground alpine mountain peak & distant misty valley ridges
  float tTerr;
  vec3 pTerr;
  bool hitTerr = traceAlpineTerrain(uCamPos, rd, tTerr, pTerr);
  if (hitTerr) {
    vec3 n = calcTerrainNormal(pTerr);
    float ndl = max(dot(n, uSunDir), 0.0);
    vec3 sunCol = (st <= 2) ? vec3(1.15, 1.10, 0.95) : evalSunColor(uSunDir.y);

    // Drifting volumetric cloud shadows projected across the alpine ridges on Steps 6-8!
    float cloudSh = 1.0;
    if (st >= 5 && uSunDir.y > 0.03) {
      float tProj = (2.4 - pTerr.y) / uSunDir.y;
      vec2 shXZ = pTerr.xz + uSunDir.xz * tProj;
      float cCov = sampleCloudCoverage(shXZ, stormAmt);
      cloudSh = mix(1.0, 0.24, smoothstep(0.42, 0.72, cCov));
    }

    // Dark slate alpine rock with snowy high crests & warm sunlit ridges
    float rockNoise = fbm2(pTerr.xz * 2.4);
    float snowMask = smoothstep(0.48, 0.74, n.y) * smoothstep(-0.1, 0.70, pTerr.y + rockNoise * 0.30);
    vec3 rockCol = mix(vec3(0.045, 0.060, 0.095), vec3(0.11, 0.13, 0.18), rockNoise);
    vec3 albedo = mix(rockCol, vec3(0.72, 0.78, 0.86), snowMask * 0.72);

    vec3 amb = (st <= 2)
      ? vec3(0.14, 0.20, 0.32)
      : mix(vec3(0.05, 0.08, 0.16), vec3(0.16, 0.18, 0.28), smoothstep(-0.02, 0.35, uSunDir.y));
    vec3 terrCol = albedo * (amb + sunCol * ndl * cloudSh * 1.25);

    // Warm golden sanctuary beacon lantern glowing on the left crag summit!
    float dBeacon = length(pTerr - vec3(-3.15, 0.78, -7.15));
    terrCol += vec3(3.8, 1.85, 0.45) * exp(-dBeacon * 4.5) * 1.6;

    // Restrained atmospheric aerial perspective keeps foreground peaks crisp & dark!
    float fogT = 1.0 - exp(-max(0.0, tTerr - 4.5) * (st <= 2 ? 0.042 : 0.052));
    vec3 fogCol = (st <= 2) ? vec3(0.42, 0.56, 0.72) : skyCol;
    col = mix(terrCol, fogCol, fogT * 0.62);
    cloudTrans = 0.0; // Opaque mountains cleanly block crepuscular god-rays!
  }

  outHdr = vec4(max(col, vec3(0.0)), 1.0);

  // Tightly localized crepuscular god-ray emitter around the sun & sunlit cumulus gaps:
  // Only emits on volumetric Step 8 pixels so Split-Screen never bleeds glare from 1992 flat sky!
  float cosS = max(dot(rd, uSunDir), 0.0);
  float sunCone = pow(cosS, 12.0) * 0.95 + pow(cosS, 64.0) * 1.15;
  vec3 sunCol = evalSunColor(uSunDir.y);
  float gapMask = (st >= 7) ? smoothstep(0.22, 0.92, cloudTrans) : 0.0;
  vec3 rayEmit = clamp(sunCol * gapMask * sunCone * smoothstep(-0.04, 0.04, rd.y), vec3(0.0), vec3(1.6));
  outOccBloom = vec4(rayEmit, 1.0);
}
`;

// ============================================================================
// PASS 2: CREPUSCULAR VOLUMETRIC GOD-RAYS (Radial Screen-Space Scatter, 1/2-res)
// ============================================================================
export const GODRAYS_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uOccTex;
uniform vec2 uSunUv;      // Projected sun UV in [0..1]
uniform float uSunVis;    // Fades gracefully if sun moves far off-screen
out vec4 outColor;

float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

void main() {
  if (uSunVis < 0.01) {
    outColor = vec4(0.0);
    return;
  }
  const int SAMPLES = 40;
  vec2 delta = (vUv - uSunUv) * (0.94 / float(SAMPLES));
  vec2 uv = vUv - delta * ign(gl_FragCoord.xy);
  float decay = 0.955;
  float weight = 1.0;
  vec3 accum = vec3(0.0);

  for (int i = 0; i < SAMPLES; i++) {
    uv -= delta;
    vec2 cl = clamp(uv, vec2(0.002), vec2(0.998));
    vec3 s = texture(uOccTex, cl).rgb;
    accum += s * weight;
    weight *= decay;
  }

  float distSun = length((vUv - uSunUv) * vec2(1.0, 0.85));
  float radialFade = exp(-distSun * 1.35);
  outColor = vec4(accum * (0.015 * uSunVis * radialFade), 1.0);
}
`;

// ============================================================================
// PASS 3: SEPARABLE GAUSSIAN SMOOTH (softens god-rays & HDR glow!)
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

// ============================================================================
// PASS 4: ACES FILMIC COMPOSITE (cleanly masks god-rays to Step 8 side of split!)
// ============================================================================
export const FINAL_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uHdr;
uniform sampler2D uGodRays;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
out vec4 outColor;

void main() {
  vec3 col = texture(uHdr, vUv).rgb;
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;

  // Apply crepuscular volumetric god-rays strictly on Step 8 (cleanly sliced at the split divider!)
  if (st >= 7) {
    col += texture(uGodRays, vUv).rgb * 0.92;
  }

  // ACES filmic tone mapping (skip on 1992 VGA Step 1 so retro quantized bands stay punchy!)
  if (st == 0) {
    col = clamp(col, 0.0, 1.0);
  } else {
    col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  }

  // Subtle cinematic vignette
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * (st == 0 ? 0.06 : 0.22);
  outColor = vec4(pow(max(col, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}
`;
