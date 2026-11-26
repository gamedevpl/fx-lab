// FX Lab #30: Evolution of Dithering & 1-Bit Stippling (1973–2026) — GLSL ES 3.00 Shaders
// Pass 1 (DITHER_SCENE_FS): Analytical raytraced ringed gas giant, turbulent Jovian cloud bands &
//   Great Storm vortex, tilted Cassini rings with mutual shadows, backlit eclipsing moon & Milky Way.
//   Outputs 4 MRT buffers: continuous color, calibrated luma/masks, co-rotating 3D surface coords,
//   and authentic 1988-94 screen-door stippled retro color.
// Pass 2 (DITHER_POST_FS): All 8 historical dithering eras, dual-octave variance-preserving
//   surface-anchored blue-noise stippling, analog CRT composite blur, PS1 RGB555 hardware dither,
//   draggable 4x pixel magnifier loupe, and live amber split-screen divider.

export const DITHER_SCENE_FS = `#version 300 es
precision highp float;

in vec2 vUv;

layout(location = 0) out vec4 oCol;      // Full continuous-tone linear/sRGB RGB + alpha
layout(location = 1) out vec4 oLuma;     // r: calibrated 1-bit luma, g: ring alpha, b: objId, a: rim/edge
layout(location = 2) out vec4 oSurf;     // rg: co-rotating equal-area 3D surface UV, b: footprint, a: surfKind
layout(location = 3) out vec4 oStipple;  // Stage 4: authentic 1988-94 screen-door stipple & limited color

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform float uLoopPeriod; // > 0 enables exact seamless periodic loop at t = 0 == t = uLoopPeriod
uniform vec2 uRenderRes;

const float PI = 3.14159265359;
const float PLANET_R = 1.38;
const float RING_IN  = 1.76;
const float RING_OUT = 3.18;
const float MOON_R   = 0.245;

// 3D smooth value noise & fBm for seamless swirling Jovian cloud bands (zero UV seams!)
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i + vec3(0, 0, 0));
  float n100 = hash31(i + vec3(1, 0, 0));
  float n010 = hash31(i + vec3(0, 1, 0));
  float n110 = hash31(i + vec3(1, 1, 0));
  float n001 = hash31(i + vec3(0, 0, 1));
  float n101 = hash31(i + vec3(1, 0, 1));
  float n011 = hash31(i + vec3(0, 1, 1));
  float n111 = hash31(i + vec3(1, 1, 1));
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}

float fbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * noise3(p);
    p = p * 2.04 + vec3(17.1, 31.7, 11.3);
    a *= 0.5;
  }
  return s;
}

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Equal-area cube-face projection for unit sphere vectors: distortion < 1.15x everywhere, ZERO pole pinch!
// Keeps returned uv tightly within [-1, +1] so RGBA16F preserves full 11-bit mantissa precision on every face!
vec2 sphereCubeUv(vec3 d, out float faceId) {
  vec3 a = abs(d);
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) {
    uv = vec2(d.z * sign(d.x), d.y) / max(a.x, 1e-5);
    faceId = d.x >= 0.0 ? 0.0 : 1.0;
  } else if (a.y >= a.x && a.y >= a.z) {
    uv = vec2(d.x, d.z * sign(d.y)) / max(a.y, 1e-5);
    faceId = d.y >= 0.0 ? 2.0 : 3.0;
  } else {
    uv = vec2(d.x * sign(d.z), d.y) / max(a.z, 1e-5);
    faceId = d.z >= 0.0 ? 4.0 : 5.0;
  }
  return atan(uv) * (4.0 / PI);
}

// 4x4 Bayer for authentic Stage-4 Mega Drive / VGA screen-door stipple & color dithering
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(floor(p), 4.0));
  const float m[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[q.y * 4 + q.x] + 0.5) / 16.0;
}

// Quantize color to classic 1988-94 9-bit Sega Mega Drive / EGA-VGA ramp (8 levels/channel = 512 colors)
// using 4x4 ordered Bayer dithering so CRT horizontal blend creates smooth extra shades!
vec3 quantizeRetro9Bit(vec3 col, vec2 px) {
  float b = bayer4(px) - 0.5;
  // 3 bits per channel (levels 0..7) matches Sega Genesis / Mega Drive CRAM (RGB333 = 512 colors)!
  vec3 c = clamp(col + b * (1.0 / 6.5), 0.0, 1.0);
  return floor(c * 7.0 + 0.5) / 7.0;
}

// Exact analytical ray-sphere intersection: returns (tNear, tFar) or (-1, -1)
vec2 intersectSphere(vec3 ro, vec3 rd, vec3 center, float r) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Planet axial tilt basis (diagonal dramatic tilt echoing iconic gas-giant silhouette & tilted ring!)
mat3 planetBasis() {
  // Tilt the north pole ~24 deg right & slightly toward viewer so rings sweep dramatically bottom-left -> top-right!
  vec3 up = normalize(vec3(-0.42, 0.87, 0.26));
  vec3 right = normalize(cross(up, vec3(0.0, 0.0, 1.0)));
  vec3 fwd = cross(right, up);
  return mat3(right, up, fwd);
}

// Procedural ring optical density & radial bands (Cassini gap + gossamer streaks + fine ringlets)
void evalRing(vec3 pLocal, float tSpin, out float alpha, out vec3 albedo) {
  float r = length(pLocal.xz);
  float u = clamp((r - RING_IN) / (RING_OUT - RING_IN), 0.0, 1.0);
  float edge = smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.88, u);

  // Classic multi-band structure + Cassini division + Encke gap
  float bands = 0.54
    + 0.24 * sin(u * 38.0)
    + 0.14 * sin(u * 92.0 + 1.1)
    + 0.10 * cos(u * 185.0);
  float cassini = 1.0 - 0.88 * exp(-pow((u - 0.56) / 0.042, 2.0));
  float encke   = 1.0 - 0.72 * exp(-pow((u - 0.82) / 0.018, 2.0));

  // Subtle icy-dust azimuthal spokes orbiting gently with Keplerian shear
  float ang = atan(pLocal.z, pLocal.x);
  float spokePhase = uLoopPeriod > 0.5
    ? (uTime / uLoopPeriod) * (2.0 * PI * 2.0)
    : tSpin * 0.45;
  float spoke = 0.88 + 0.12 * sin(ang * 5.0 - spokePhase + u * 6.0);

  alpha = clamp(edge * bands * cassini * encke * spoke * 0.86, 0.0, 0.92);

  // Rich icy cream, warm gold, and dusty rose-amber bands for color eras (Stages 4 & 5)
  vec3 icyCream = vec3(0.95, 0.89, 0.78);
  vec3 warmGold = vec3(0.84, 0.65, 0.46);
  vec3 coolDust = vec3(0.62, 0.68, 0.78);
  albedo = mix(warmGold, icyCream, smoothstep(0.32, 0.78, bands));
  albedo = mix(albedo, coolDust, smoothstep(0.68, 0.95, u) * 0.45);
}

// Procedural Jovian swirling cloud bands + iconic Great Storm anticyclone on unit sphere pRot
void evalGasGiant(vec3 pRot, float tFlow, out vec3 albedo, out float bandContrast) {
  // Latitude in [-1, 1]
  float lat = pRot.y;

  // Multi-scale turbulent domain warp along zonal jets (east-west jet streams shear clouds!)
  // In film loop mode (uLoopPeriod > 0), trace a smooth circular path in noise space so t=0 == t=period bit-for-bit!
  vec3 q = pRot * 2.25;
  float shear = sin(lat * 11.0) * 0.35;
  vec3 flowOff = uLoopPeriod > 0.5
    ? vec3(cos((tFlow / uLoopPeriod) * 2.0 * PI) * 0.42 + shear, 0.0, sin((tFlow / uLoopPeriod) * 2.0 * PI) * 0.42)
    : vec3(tFlow * 0.12 + shear, 0.0, -tFlow * 0.09);
  float w1 = fbm3(q + flowOff);
  float w2 = fbm3(q * 2.15 + vec3(w1 * 1.45, lat * 2.1, -w1 * 1.15));

  // Great Red/Cream Storm anticyclone centered near southern tropical belt (lat ~ -0.22)
  // Compute angular offset from storm eye on the rotating globe
  float lon = atan(pRot.x, pRot.z);
  float dLon = mod(lon - 0.38 + PI, 2.0 * PI) - PI;
  float dLat = lat + 0.18;
  vec2 stVec = vec2(dLon * 0.62, dLat * 1.48);
  float stDist = length(stVec);
  float stMask = smoothstep(0.46, 0.05, stDist);
  float stSwirlAngle = stMask * 4.4 * (1.0 - stDist * 1.25);
  vec2 stRot = rot2(stSwirlAngle) * stVec;
  float stormPhase = uLoopPeriod > 0.5 ? sin((tFlow / uLoopPeriod) * 2.0 * PI) * 0.35 : tFlow * 0.18;
  float stSpiral = fbm3(vec3(stRot * 8.5, stormPhase));

  // Turbulent zonal latitudes (distinct cream zones, rust belts, deep ochre eddies)
  float warpedLat = lat + (w1 - 0.5) * 0.24 + (w2 - 0.5) * 0.11 + stMask * sin(stSwirlAngle) * 0.06;
  float b1 = sin(warpedLat * 18.5 + 0.4);
  float b2 = sin(warpedLat * 39.0 - 1.1 + w2 * 2.2);
  float zone = clamp(0.52 + 0.32 * b1 + 0.16 * b2 + (w2 - 0.5) * 0.28, 0.0, 1.0);

  // Dark polar vortex hoods near north & south poles
  float polar = smoothstep(0.68, 0.98, abs(lat));
  zone = mix(zone, zone * 0.42 + 0.08, polar);

  // Blend swirling Great Storm eye right into the cloud deck
  float stormEye = smoothstep(0.32, 0.06, stDist) * (0.45 + 0.55 * stSpiral);
  float stormCollar = smoothstep(0.44, 0.26, stDist) * smoothstep(0.14, 0.26, stDist);
  zone = mix(zone, 0.94, stormCollar * 0.55);
  zone = mix(zone, 0.28 + 0.52 * stSpiral, stormEye * 0.82);

  // Rich color palette for color stages (Stages 4 & 5: warm cream, terracotta, sienna, cobalt polar mist)
  vec3 cDeepBelt  = vec3(0.34, 0.17, 0.12);
  vec3 cRustMid   = vec3(0.74, 0.41, 0.24);
  vec3 cOchre     = vec3(0.88, 0.68, 0.46);
  vec3 cCreamZone = vec3(0.97, 0.93, 0.84);
  vec3 cPolar     = vec3(0.30, 0.38, 0.52);

  vec3 col = mix(cDeepBelt, cRustMid, smoothstep(0.12, 0.42, zone));
  col = mix(col, cOchre, smoothstep(0.38, 0.68, zone));
  col = mix(col, cCreamZone, smoothstep(0.64, 0.92, zone));
  col = mix(col, cPolar, polar * 0.68);
  // Warm crimson-terracotta glow inside the Great Storm eye
  col = mix(col, vec3(0.86, 0.30, 0.18), stormEye * 0.72);

  albedo = col;
  bandContrast = zone;
}

// Background diagonal Milky Way ribbon & crisp starfield (gives near-black dither noise-floor & PS1 banding test!)
void evalSpaceBackground(vec3 rd, out vec3 col, out float luma) {
  // Delicate diagonal Milky Way dust ribbon sloping lower-left -> upper-right behind the gas giant!
  vec3 mwNormal = normalize(vec3(0.48, -0.80, 0.36));
  float dPlane = dot(rd, mwNormal) + 0.02;
  float mwWide = exp(-pow(dPlane * 4.4, 2.0));
  float mwCore = exp(-pow(dPlane * 10.5, 2.0));
  float mwCloud = fbm3(rd * 4.6 + vec3(2.3, 1.1, 4.7));
  float mwRift  = smoothstep(0.42, 0.70, fbm3(rd * 8.8 + vec3(5.1, 2.4, 0.8)));
  float dust = (mwWide * 0.42 + mwCore * 0.48) * smoothstep(0.24, 0.84, mwCloud) * (1.0 - 0.56 * mwRift);

  // Smooth deep-indigo & warm-ivory cosmic gradient (exposes PS1 RGB555 banding & Atkinson black clip without overpowering rings!)
  vec3 baseVoid = vec3(0.008, 0.013, 0.028);
  vec3 mwColor  = mix(vec3(0.14, 0.22, 0.40), vec3(0.42, 0.37, 0.32), mwCloud) * dust;
  col = baseVoid + mwColor;
  luma = clamp(dust * 0.28, 0.0, 0.52);

  // Crisp multi-scale pinpoint stars locked on celestial sphere
  vec3 sc = rd * 132.0;
  vec3 si = floor(sc);
  vec3 sf = fract(sc) - 0.5;
  float sh = hash31(si);
  if (sh > 0.982) {
    vec3 jitter = vec3(hash31(si + 7.1), hash31(si + 13.7), hash31(si + 29.3)) - 0.5;
    float d = length(sf - jitter * 0.55);
    float star = smoothstep(0.22, 0.03, d) * smoothstep(0.982, 0.998, sh);
    vec3 starTint = mix(vec3(0.80, 0.90, 1.0), vec3(1.0, 0.92, 0.74), hash31(si + 41.2));
    col += starTint * star * 1.15;
    luma = max(luma, star * 0.96);
  }
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));

  // Strong dramatic upper-left key sun for stark crescent shadow & smooth terminator!
  vec3 sunDir = normalize(vec3(-0.70, 0.54, 0.46));

  mat3 pMat = planetBasis();
  mat3 pInv = transpose(pMat);

  // Small eclipsing moon orbiting cleanly in the upper hemisphere — visible above the HUD & clear of the 4x loupe!
  float moonAng = uLoopPeriod > 0.5
    ? (0.28 + (uTime / uLoopPeriod) * (2.0 * PI))
    : (0.04 + uTime * 0.16);
  vec3 moonLocal = vec3(sin(moonAng) * 2.18, 0.68 + sin(moonAng * 2.0) * 0.08, cos(moonAng) * 2.18);
  vec3 moonPos = pMat * moonLocal;

  // Ray intersections: Planet, Moon, and Tilted Ring plane (y_local = 0)
  vec2 hitPlanet = intersectSphere(ro, rd, vec3(0.0), PLANET_R);
  vec2 hitMoon   = intersectSphere(ro, rd, moonPos, MOON_R);

  float tPlanet = hitPlanet.x > 0.0 ? hitPlanet.x : 1e9;
  float tMoon   = hitMoon.x   > 0.0 ? hitMoon.x   : 1e9;

  // Ring plane intersection in planet-local coordinates
  vec3 roLoc = pInv * ro;
  vec3 rdLoc = pInv * rd;
  float tRing = 1e9;
  float ringAlpha = 0.0;
  vec3 ringAlb = vec3(0.0);
  vec3 ringHitLoc = vec3(0.0);
  if (abs(rdLoc.y) > 1e-4) {
    float tr = -roLoc.y / rdLoc.y;
    if (tr > 0.05) {
      vec3 pR = roLoc + rdLoc * tr;
      float rr = length(pR.xz);
      if (rr >= RING_IN && rr <= RING_OUT) {
        evalRing(pR, uTime, ringAlpha, ringAlb);
        if (ringAlpha > 0.015) {
          tRing = tr;
          ringHitLoc = pR;
        }
      }
    }
  }

  // Evaluate background space & diagonal Milky Way
  vec3 spaceCol;
  float spaceLuma;
  evalSpaceBackground(rd, spaceCol, spaceLuma);

  // Lush smooth atmospheric halo glow around the sunlit planetary limb (super clear PS1 RGB555 banding test!)
  float closestT = max(0.0, -dot(ro, rd));
  vec3 closestP = ro + rd * closestT;
  float limbDist = length(closestP) - PLANET_R;
  float haloMask = exp(-max(limbDist, 0.0) * 4.4) * step(0.0, limbDist);
  float haloSun = smoothstep(-0.32, 0.72, dot(normalize(closestP), sunDir));
  vec3 haloCol = vec3(0.38, 0.62, 0.96) * haloMask * (0.14 + 0.62 * haloSun);
  spaceCol += haloCol;
  spaceLuma = clamp(spaceLuma + haloMask * (0.06 + 0.30 * haloSun), 0.0, 1.0);

  // Start with sky/space as base solid hit
  float tSolid = 1e9;
  vec3 solidCol = spaceCol;
  float solidLuma = spaceLuma;
  float objId = 0.0;
  float edgeMask = 0.0;
  float faceId = 0.0;
  vec2 surfUv = sphereCubeUv(rd, faceId);
  float pixelRad = (2.0 * uTanHalfFov) / max(uRenderRes.y, 1.0);
  float surfFoot = (4.0 / PI) * pixelRad;
  float surfKind = faceId;

  // Shade Gas Giant if hit
  if (tPlanet < tSolid) {
    tSolid = tPlanet;
    vec3 wp = ro + rd * tPlanet;
    vec3 n = normalize(wp);
    vec3 nLoc = pInv * n;

    // Spin the planet steadily around its tilted local Y axis!
    float spin = uLoopPeriod > 0.5
      ? (uTime / uLoopPeriod) * (2.0 * PI)
      : uTime * 0.16;
    vec3 pRot = nLoc;
    pRot.xz = rot2(spin) * nLoc.xz;

    vec3 alb;
    float bandC;
    evalGasGiant(pRot, uTime, alb, bandC);

    // Direct sun lighting + soft Rayleigh twilight terminator wrap
    float ndl = dot(n, sunDir);
    float diff = smoothstep(-0.14, 0.96, ndl);
    float diffSoft = pow(max(ndl, 0.0), 0.76);
    float shade = mix(diff * 0.45, diffSoft, 0.75);

    // Ring shadow cast onto the planet surface!
    vec3 sunLoc = pInv * sunDir;
    float ringShad = 1.0;
    if (abs(sunLoc.y) > 1e-4) {
      float ts = -nLoc.y * PLANET_R / sunLoc.y;
      if (ts > 0.01) {
        vec3 sp = nLoc * PLANET_R + sunLoc * ts;
        float sr = length(sp.xz);
        if (sr >= RING_IN && sr <= RING_OUT) {
          float sa; vec3 sAlb;
          evalRing(sp, uTime, sa, sAlb);
          ringShad = 1.0 - sa * 0.78;
        }
      }
    }

    // Moon eclipse shadow cast onto the gas giant clouds!
    float moonShad = 1.0;
    vec2 mOcc = intersectSphere(wp + n * 0.01, sunDir, moonPos, MOON_R);
    if (mOcc.x > 0.0) {
      float mEdge = length(cross(sunDir, wp - moonPos)) / MOON_R;
      moonShad = smoothstep(0.68, 1.06, mEdge);
    }

    // Fresnel atmospheric rim scatter on the sunlit crescent
    float ndv = max(dot(n, -rd), 0.0);
    float fres = pow(1.0 - ndv, 3.2);
    vec3 twilight = vec3(0.86, 0.44, 0.24) * exp(-pow((ndl + 0.02) / 0.18, 2.0)) * 0.36;
    vec3 atmoRim = vec3(0.55, 0.78, 1.0) * fres * (0.06 + 0.62 * smoothstep(-0.22, 0.65, ndl));
    vec3 ambCol = vec3(0.020, 0.028, 0.050) * (0.4 + 0.6 * bandC);

    float lit = shade * ringShad * moonShad;
    solidCol = ambCol + alb * lit * 1.18 + twilight * ringShad * moonShad + atmoRim;

    // Calibrated perceptual luminance with rich 1-bit tonal dynamic range across bands & terminator
    float bandLuma = mix(0.42, 1.04, bandC);
    solidLuma = clamp(0.010 + bandLuma * lit * 0.96 + fres * 0.30 * smoothstep(-0.18, 0.55, ndl), 0.0, 1.0);

    objId = 0.66;
    edgeMask = smoothstep(0.28, 0.06, ndv);
    // Co-rotating equal-area cube UV tightly in [-1, +1] for full RGBA16F precision on ALL 6 cube faces!
    float pFace = 0.0;
    surfUv = sphereCubeUv(pRot, pFace);
    surfFoot = (4.0 / PI) * (tPlanet * pixelRad / PLANET_R) / max(ndv, 0.46);
    surfKind = 10.0 + pFace;
  }

  // Shade Orbiting Eclipsing Moon if closer than planet
  if (tMoon < tSolid) {
    tSolid = tMoon;
    vec3 wp = ro + rd * tMoon;
    vec3 n = normalize(wp - moonPos);
    float ndv = max(dot(n, -rd), 0.0);
    float ndl = dot(n, sunDir);

    // Subtle cratered lunar albedo + dramatic dark backlit silhouette with crisp sunlit crescent rim!
    vec3 mLoc = n;
    mLoc.xz = rot2(-moonAng) * n.xz;
    float crater = fbm3(mLoc * 5.2);
    float mDiff = smoothstep(0.18, 0.96, ndl);
    float rim = pow(1.0 - ndv, 3.0) * smoothstep(-0.10, 0.78, ndl);

    vec3 moonAlb = mix(vec3(0.24, 0.24, 0.26), vec3(0.68, 0.66, 0.62), crater);
    solidCol = moonAlb * (mDiff * 0.78 + 0.015) + vec3(0.95, 0.90, 0.80) * rim * 0.68;
    // Stark dark silhouette core with crisp thin sunlit crescent (echoes @seigneurrrr's dark moon transit!)
    solidLuma = clamp(mDiff * (0.20 + 0.54 * crater) + rim * 0.64, 0.0, 1.0);

    objId = 1.0;
    edgeMask = smoothstep(0.36, 0.08, ndv);
    float mFace = 0.0;
    surfUv = sphereCubeUv(mLoc, mFace);
    surfFoot = (4.0 / PI) * (tMoon * pixelRad / MOON_R) / max(ndv, 0.48);
    surfKind = 20.0 + mFace;
  }

  // Shade Tilted Planetary Ring (can pass BEHIND or IN FRONT of the planet & moon!)
  vec3 finalCol = solidCol;
  float finalLuma = solidLuma;
  float outRingAlpha = 0.0;
  vec3 stippleCol = quantizeRetro9Bit(solidCol, gl_FragCoord.xy);

  if (tRing < tSolid && ringAlpha > 0.015) {
    // Check if the planet casts its giant shadow across this section of the ring!
    vec3 ringWp = ro + rd * tRing;
    vec2 pOcc = intersectSphere(ringWp, sunDir, vec3(0.0), PLANET_R);
    float ringLit = 1.0;
    if (pOcc.x > 0.0) {
      // Soft penumbra edge on planet's shadow across the ring!
      float distAxis = length(cross(sunDir, ringWp));
      ringLit = mix(0.05, 1.0, smoothstep(PLANET_R * 0.94, PLANET_R * 1.04, distAxis));
    }
    // Slight forward-scatter brightening on sun-facing ring particles
    float phase = 0.78 + 0.28 * max(dot(-rd, sunDir), 0.0);
    vec3 rCol = ringAlb * ringLit * phase;
    float rLuma = clamp(dot(rCol, vec3(0.299, 0.587, 0.114)) * 1.12, 0.0, 1.0);

    // Continuous composite for Stages 0,1,2,3,5,6,7
    finalCol = mix(solidCol, rCol, ringAlpha);
    finalLuma = mix(solidLuma, rLuma, ringAlpha);
    outRingAlpha = ringAlpha;

    // Authentic 1988-94 Screen-Door Checkerboard / Ordered Stipple Transparency for Stage 4!
    // ZERO alpha blending: each pixel shows EITHER opaque ring OR opaque planet/space behind it!
    float doorThresh = bayer4(gl_FragCoord.xy);
    vec3 rawChoice = (ringAlpha > doorThresh) ? rCol : solidCol;
    stippleCol = quantizeRetro9Bit(rawChoice, gl_FragCoord.xy);

    // Update surface coords where ring dominates (normalized to [-1, +1] for full RGBA16F precision!)
    if (ringAlpha > 0.34) {
      vec3 rSpin = ringHitLoc;
      float rAng = uLoopPeriod > 0.5 ? (uTime / uLoopPeriod) * (2.0 * PI) : uTime * 0.08;
      rSpin.xz = rot2(rAng) * ringHitLoc.xz;
      surfUv = rSpin.xz / RING_OUT;
      float rGraz = max(abs(rdLoc.y), 0.30);
      surfFoot = (tRing * pixelRad / RING_OUT) / rGraz;
      surfKind = 30.0;
      objId = 0.33;
    }
  } else {
    // Even without ring in front, apply screen-door stipple to subtle atmospheric halo for Stage 4!
    if (tSolid > 1e8 && haloMask > 0.04) {
      float doorH = bayer4(gl_FragCoord.xy);
      float hCov = clamp(haloMask * (0.25 + 0.65 * haloSun), 0.0, 1.0);
      vec3 hPick = (hCov > doorH) ? vec3(0.32, 0.52, 0.84) : vec3(0.010, 0.016, 0.032);
      stippleCol = quantizeRetro9Bit(hPick, gl_FragCoord.xy);
    }
  }

  // Gentle sRGB-like gamma curve on continuous color for lush display
  vec3 dispCol = pow(clamp(finalCol, 0.0, 1.0), vec3(0.92));
  // Subtle S-contrast lift on calibrated 1-bit luma so stipple highlights & shadows feel sculptural
  float dispLuma = clamp(pow(clamp(finalLuma, 0.0, 1.0), 0.90), 0.0, 1.0);

  oCol = vec4(dispCol, 1.0);
  oLuma = vec4(dispLuma, outRingAlpha, objId, edgeMask);
  oSurf = vec4(surfUv, surfFoot, surfKind);
  oStipple = vec4(pow(clamp(stippleCol, 0.0, 1.0), vec3(0.92)), 1.0);
}
`;

export const DITHER_POST_FS = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 oCol;

uniform sampler2D uCol;       // Continuous-tone scene RGB (dither grid res)
uniform sampler2D uLuma;      // r: luma, g: ringAlpha, b: objId, a: edgeMask
uniform sampler2D uSurf;      // rg: co-rotating 3D surface UV, b: footprint, a: surfKind
uniform sampler2D uStipple;   // Stage 4 screen-door stipple + retro 9-bit palette
uniform sampler2D uErrDiff;   // r: live Floyd-Steinberg 1-bit, g: live Bill Atkinson 1-bit
uniform sampler2D uBlueNoise; // 64x64 Ulichney Void-and-Cluster Blue Noise (REPEAT, NEAREST)

uniform vec2 uRes;            // Output viewport px
uniform vec2 uGridRes;        // Virtual dither buffer px
uniform float uSplitX;        // < 0 when split OFF
uniform int uStageLeft;
uniform int uStageRight;
uniform int uStageActive;

// Interactive era controls
uniform int uPaletteIdx;      // 0: Cream/Obsidian, 1: Mac B&W, 2: Green CRT, 3: Amber P3, 4: Obra Dinn
uniform float uBayer4On;      // Stage 1: 0 = 8x8 Bayer, 1 = 4x4 Bayer
uniform float uCrtBlendOn;    // Stage 4: Analog CRT composite horizontal blur ON/OFF
uniform float uPs1DitherOn;   // Stage 5: PS1 4x4 hardware dither ON/OFF
uniform float uSphereLockOn;  // Stage 6: Obra Dinn world-direction lock ON/OFF

// Camera basis (for Stage 6 Obra Dinn spherical direction projection!)
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;

// Interactive draggable 4x Pixel Magnifier Loupe
uniform vec2 uLoupeTarget;
uniform float uLoupeOn;
uniform vec3 uLoupeBox; // (cxUv, cyUv, sizeFracOfMinDim); z <= 0 uses default top-right FX Lab placement
uniform float uDrawDivider; // 1.0 in FX Lab; 0.0 when film HUD draws its own stylized amber wipe divider

const float PI = 3.14159265359;

// 1-bit display palettes: (dark ink, bright phosphor/cream)
void get1BitPalette(int idx, out vec3 cDark, out vec3 cLight) {
  if (idx == 1) {
    // 1984 Apple Macintosh crisp CRT paper-white
    cDark  = vec3(0.055, 0.068, 0.088);
    cLight = vec3(0.935, 0.955, 0.975);
  } else if (idx == 2) {
    // IBM 5151 P39 Phosphor Green CRT
    cDark  = vec3(0.024, 0.068, 0.036);
    cLight = vec3(0.360, 0.980, 0.540);
  } else if (idx == 3) {
    // Classic Amber Terminal (P3 phosphor)
    cDark  = vec3(0.075, 0.042, 0.018);
    cLight = vec3(1.000, 0.720, 0.270);
  } else if (idx == 4) {
    // Return of the Obra Dinn antique Macintosh parchment & olive-charcoal
    cDark  = vec3(0.115, 0.140, 0.122);
    cLight = vec3(0.905, 0.890, 0.800);
  } else {
    // Default: High-contrast Obsidian Black & Warm Cream (@seigneurrrr editorial palette!)
    cDark  = vec3(0.032, 0.032, 0.038);
    cLight = vec3(0.955, 0.922, 0.842);
  }
}

// Exact recursive Bayer 4x4 matrix in [0, 1)
float bayer4(ivec2 p) {
  int x = p.x & 3;
  int y = p.y & 3;
  const float m[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[y * 4 + x] + 0.5) / 16.0;
}

// Exact recursive Bayer 8x8 matrix (Bryce Bayer, 1973) in [0, 1)
float bayer8(ivec2 p) {
  int x = p.x & 7;
  int y = p.y & 7;
  int xc = x ^ y;
  int r = (((xc & 1) << 5) | ((y & 1) << 4)
        | (((xc >> 1) & 1) << 3) | (((y >> 1) & 1) << 2)
        | (((xc >> 2) & 1) << 1) | ((y >> 2) & 1));
  return (float(r) + 0.5) / 64.0;
}

// Exact PlayStation 1 GPU 4x4 signed hardware dither matrix (values in [-4..+3] added to 8-bit RGB before 5-bit truncation)
float ps1DitherOffset(ivec2 p) {
  int x = p.x & 3;
  int y = p.y & 3;
  const float m[16] = float[16](
    -4.0,  0.0, -3.0,  1.0,
     2.0, -2.0,  3.0, -1.0,
    -3.0,  1.0, -4.0,  0.0,
     3.0, -1.0,  2.0, -2.0
  );
  return m[y * 4 + x];
}

// Equal-area spherical direction UV for Stage 6 (Obra Dinn world-locked dither)
vec2 rayCubeUv(vec3 d) {
  vec3 a = abs(d);
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) uv = vec2(d.z * sign(d.x), d.y) / max(a.x, 1e-5);
  else if (a.y >= a.x && a.y >= a.z) uv = vec2(d.x, d.z * sign(d.y)) / max(a.y, 1e-5);
  else uv = vec2(d.x * sign(d.z), d.y) / max(a.z, 1e-5);
  return atan(uv);
}

// Exact closed-form CDF of weighted sum Z = (1-f)*U0 + f*U1 of two Uniform(0,1) thresholds.
// Guarantees mathematically Uniform(0,1) output at EVERY octave blend fraction f in [0,1] -> zero midtone pop!
float blendUniformThresholds(float u0, float u1, float f) {
  float a = 1.0 - f;
  float b = f;
  float m = min(a, b);
  float M = max(a, b);
  float z = a * u0 + b * u1;
  if (m < 1e-3) return z;
  if (z <= m) return (z * z) / (2.0 * a * b);
  if (z >= M) {
    float r = 1.0 - z;
    return 1.0 - (r * r) / (2.0 * a * b);
  }
  return (z - 0.5 * m) / M;
}

float sampleBlueNoisePx(vec2 coord) {
  vec2 uv = (floor(coord) + 0.5) / 64.0;
  return texture(uBlueNoise, uv).r;
}

// Stage 4: Analog CRT composite horizontal phosphor blend melts screen-door checkerboard into translucent silk!
vec3 sampleCrtComposite(vec2 qUv, vec2 texel) {
  // Asymmetric NTSC-style horizontal chroma/luma smear across 5 neighboring virtual pixels
  vec3 cM2 = texture(uStipple, clamp(qUv - vec2(texel.x * 2.0, 0.0), vec2(0.001), vec2(0.999))).rgb;
  vec3 cM1 = texture(uStipple, clamp(qUv - vec2(texel.x * 1.0, 0.0), vec2(0.001), vec2(0.999))).rgb;
  vec3 c0  = texture(uStipple, qUv).rgb;
  vec3 cP1 = texture(uStipple, clamp(qUv + vec2(texel.x * 1.0, 0.0), vec2(0.001), vec2(0.999))).rgb;
  vec3 cP2 = texture(uStipple, clamp(qUv + vec2(texel.x * 2.0, 0.0), vec2(0.001), vec2(0.999))).rgb;
  vec3 blur = cM2 * 0.10 + cM1 * 0.25 + c0 * 0.30 + cP1 * 0.25 + cP2 * 0.10;
  // Subtle vertical phosphor scanline beam profile + gentle warm CRT halation
  float scan = 0.89 + 0.11 * cos(vUv.y * uGridRes.y * 2.0 * PI);
  return clamp(blur * scan * 1.07, 0.0, 1.0);
}

vec3 evalStageAt(vec2 uv, int stage, bool isLeftSide, bool sameStageSplit) {
  vec2 texel = 1.0 / max(uGridRes, vec2(1.0));
  vec2 gridCoord = floor(uv * uGridRes);
  ivec2 px = ivec2(gridCoord);
  vec2 qUv = (gridCoord + 0.5) / uGridRes;

  vec3 cDark, cLight;
  get1BitPalette(uPaletteIdx, cDark, cLight);

  vec4 lumaData = texture(uLuma, qUv);
  float luma = lumaData.r;

  // STAGE 0: Pre-1973 1-Bit Hard Threshold (no halftones, stark 2-tone cutoff)
  if (stage == 0) {
    float bit = step(0.46, luma);
    return mix(cDark, cLight, bit);
  }

  // STAGE 1: 1973 Bryce Bayer Ordered Dithering (8x8 or 4x4 matrix)
  if (stage == 1) {
    float thresh = (uBayer4On > 0.5) ? bayer4(px) : bayer8(px);
    float bit = step(thresh, luma);
    return mix(cDark, cLight, bit);
  }

  // STAGE 2: 1976 Live CPU Floyd-Steinberg Error Diffusion
  if (stage == 2) {
    float bit = texture(uErrDiff, qUv).r;
    return mix(cDark, cLight, bit);
  }

  // STAGE 3: 1984 Live CPU Bill Atkinson (Apple Macintosh 6/8 Error Diffusion)
  if (stage == 3) {
    float bit = texture(uErrDiff, qUv).g;
    // Slight classic Macintosh phosphor default tint only if user is on default cream? No, honor selected palette!
    return mix(cDark, cLight, bit);
  }

  // STAGE 4: 1988-94 Mega Drive / VGA Screen-Door Stipple Alpha & Limited Color
  // In same-stage split: Left = Sharp Pixel Stipple (LCD), Right = Analog CRT Composite Blend!
  if (stage == 4) {
    bool useCrt = sameStageSplit ? !isLeftSide : (uCrtBlendOn > 0.5);
    if (useCrt) return sampleCrtComposite(qUv, texel);
    return texture(uStipple, qUv).rgb;
  }

  // STAGE 5: 1994-99 PlayStation 1 15-Bit RGB555 Banding vs Hardware 4x4 Bayer Dither
  // In same-stage split: Left = Raw RGB555 Banding (no dither), Right = PS1 4x4 Hardware Dither!
  if (stage == 5) {
    vec3 col = texture(uCol, qUv).rgb;
    bool usePs1Dither = sameStageSplit ? !isLeftSide : (uPs1DitherOn > 0.5);
    // Exact PlayStation 1 GPU hardware pipeline: 24-bit Gouraud RGB -> add signed [-4..+3] 4x4 dither -> truncate to 5-bit RGB555 (0..31)!
    float dOff = usePs1Dither ? ps1DitherOffset(px) : 0.0;
    vec3 rgb8 = clamp(col * 255.0 + vec3(dOff), 0.0, 255.0);
    vec3 q = floor(rgb8 / 8.0) / 31.0;
    return q;
  }

  // STAGE 6: 1993-2018 Ulichney Void-and-Cluster Blue Noise + Lucas Pope Obra Dinn Sphere-Lock
  // In same-stage split: Left = Screen-Space Blue Noise (swims on orbit!), Right = 2018 Sphere-Locked!
  if (stage == 6) {
    bool useLock = sameStageSplit ? !isLeftSide : (uSphereLockOn > 0.5);
    float thresh;
    if (useLock) {
      // Reconstruct world ray direction for this virtual pixel and sample blue noise in angular sphere space!
      vec2 ndc = qUv * 2.0 - 1.0;
      vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));
      float pxPerRad = uGridRes.y / (2.0 * uTanHalfFov);
      vec2 spCoord = rayCubeUv(rd) * pxPerRad * 0.96;
      thresh = sampleBlueNoisePx(spCoord);
    } else {
      thresh = sampleBlueNoisePx(gridCoord);
    }
    float bit = step(thresh, luma);
    return mix(cDark, cLight, bit);
  }

  // STAGE 7: 2024-26 Surface-Anchored 3D Blue-Noise Stippling (Dual-Octave Variance-Preserving CDF!)
  // Stipple dots lock directly to the rotating gas giant clouds, rings, orbiting moon & starry sky
  // while keeping crisp, zoom-stable 1-bit density at any distance with full 32-bit float precision!
  vec4 surf = texture(uSurf, qUv);
  vec2 sUv = surf.rg;
  float foot = max(surf.b, 1e-4);
  float surfId = surf.a;

  // Continuous log2 scale matching 1 blue-noise texel to ~1.0 virtual pixel on screen
  float idealTexelsPerUnit = 1.0 / foot;
  float lod = log2(max(idealTexelsPerUnit, 1.0));
  float lod0 = floor(lod);
  float frac = fract(lod);

  float scale0 = exp2(lod0);
  float scale1 = scale0 * 2.0;

  // Apply per-object/per-face decorrelation offset in full 32-bit float (never in RGBA16F!)
  vec2 faceOff = vec2(mod(surfId * 17.0, 64.0), mod(surfId * 31.0, 64.0));
  float bn0 = sampleBlueNoisePx(sUv * scale0 + faceOff);
  float bn1 = sampleBlueNoisePx(sUv * scale1 + faceOff + vec2(23.0, 41.0));
  float thresh = blendUniformThresholds(bn0, bn1, smoothstep(0.08, 0.92, frac));

  float bit = step(thresh, luma);
  return mix(cDark, cLight, bit);
}

vec3 evalFinalAt(vec2 uv) {
  bool splitOn = uSplitX > 0.0;
  bool isLeft = splitOn && uv.x < uSplitX;
  int st = isLeft ? uStageLeft : uStageRight;
  bool sameStage = splitOn && (uStageLeft == uStageRight);
  return evalStageAt(uv, st, isLeft, sameStage);
}

void main() {
  vec2 uv = vUv;
  vec3 col = evalFinalAt(uv);

  // Crisp amber split divider (optional — film HUD can draw its own glowing divider + diamond)
  if (uDrawDivider > 0.5 && uSplitX > 0.0 && abs(uv.x - uSplitX) < 1.5 / uRes.x) {
    col = vec3(0.93, 0.65, 0.37);
  }

  // Interactive 4x Pixel Magnifier Loupe (proves pure 1-bit dots / Bayer grid / PS1 banding up close!)
  if (uLoupeOn > 0.5) {
    float aspect = uRes.x / max(1.0, uRes.y);
    vec2 px = uv * uRes;
    vec2 tgtPx = uLoupeTarget * uRes;
    float boxSizePx = uLoupeBox.z > 0.0
      ? min(uRes.x, uRes.y) * uLoupeBox.z
      : min(uRes.x, uRes.y) * 0.30;
    vec2 boxCen = uLoupeBox.z > 0.0
      ? uLoupeBox.xy * uRes
      : (aspect > 1.0
        ? vec2(uRes.x - boxSizePx * 0.60 - 24.0, uRes.y - boxSizePx * 0.60 - 74.0)
        : vec2(uRes.x - boxSizePx * 0.56 - 20.0, uRes.y * 0.64));
    vec2 boxHalf = vec2(boxSizePx * 0.5);
    vec2 retHalf = boxHalf * 0.25;

    // Reticle square on target region
    vec2 dRet = abs(px - tgtPx) - retHalf;
    float retEdge = max(dRet.x, dRet.y);
    if (abs(retEdge) < 2.1 && dRet.x < 2.8 && dRet.y < 2.8) {
      col = vec3(1.0, 0.84, 0.28);
    }

    // Subtle connector tether line
    vec2 seg = boxCen - tgtPx;
    float segLen = length(seg);
    if (segLen > 1.0) {
      vec2 dir = seg / segLen;
      float proj = clamp(dot(px - tgtPx, dir), length(retHalf) * 0.95, segLen - boxSizePx * 0.55);
      if (length((px - tgtPx) - dir * proj) < 1.25) {
        col = mix(col, vec3(1.0, 0.84, 0.28), 0.72);
      }
    }

    // 4x Zoom Box
    vec2 dBox = abs(px - boxCen) - boxHalf;
    float boxEdge = max(dBox.x, dBox.y);
    if (boxEdge < 0.0) {
      vec2 local = (px - boxCen) / boxHalf;
      vec2 sUv = clamp((tgtPx + local * retHalf) / uRes, vec2(0.001), vec2(0.999));
      col = evalFinalAt(sUv);
      if (uSplitX > 0.0) {
        float splitPx = uSplitX * uRes.x;
        float splitInBox = boxCen.x + ((splitPx - tgtPx.x) / retHalf.x) * boxHalf.x;
        if (abs(px.x - splitInBox) < 2.0) col = vec3(0.95, 0.72, 0.29);
      }
      if (min(abs(px.x - boxCen.x), abs(px.y - boxCen.y)) < 0.85 && length(px - boxCen) < 11.0) {
        col = mix(col, vec3(1.0, 0.86, 0.30), 0.62);
      }
    } else if (boxEdge < 3.2) {
      col = vec3(1.0, 0.84, 0.28);
    } else if (boxEdge < 5.0) {
      col = vec3(0.06, 0.07, 0.11);
    }
  }

  oCol = vec4(col, 1.0);
}
`;
