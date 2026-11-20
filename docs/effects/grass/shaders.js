// GLSL ES 3.00 shaders for Evolution of Grass & Foliage (1992-2026):
// 1. SKY_FS               — 1992 banded VGA sky vs sunlit Ghibli afternoon sky
// 2. TERRAIN_VS/FS        — 1992 pixel-tile grass vs earthy soil, cliff skirt & cloud shadows
// 3. PROP_VS/FS           — Ancient mossy standing runestone (glowing rune) + stepping stones
// 4. ORB_VS/FS            — Rolling carved brass-and-oak meadow orb (Step 8)
// 5. XCARD_VS/FS          — 1996 crossed alpha-cutout billboards + golden Show X-Cards wireframe
// 6. SHELL_VS/FS          — 2001 10-layer stacked translucent shell grass
// 7. BLADE_VS/FS          — 2007-2026 22,000 GPU-instanced 3D curved grass blades (wind, AO, SSS, live trails)
// 8. FLOWER_VS/FS         — 2022-2026 650 swaying 3D wildflowers synced with wind & trails
// 9. POLLEN_VS/FS         — 2022-2026 floating sunlit golden pollen motes
// 10. BLUR_FS + FINAL_FS  — Gentle HDR sun/rune/pollen bloom + ACES filmic tone mapping

const SHARED_GLSL = `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm2(vec2 p) {
  return 0.55 * noise2(p) + 0.30 * noise2(p * 2.07 + 3.1) + 0.15 * noise2(p * 4.19 + 7.4);
}

// Tileable 2D value noise for seamless 36s looping cloud shadows in video & live mode
float tileNoise2(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 i0 = mod(i, per), i1 = mod(i + 1.0, per);
  return mix(
    mix(hash21(i0), hash21(vec2(i1.x, i0.y)), f.x),
    mix(hash21(vec2(i0.x, i1.y)), hash21(i1), f.x),
    f.y
  );
}

// Multi-octave travelling meadow wind waves (sweeping visibly across the rolling hillside!)
// uWindPhase advances continuously (in video: exact integer wraps over 36s for seamless looping!)
vec2 evalMeadowWind(vec2 xz, float windPhase, float gustAmt, out float waveCrest) {
  vec2 dir = vec2(0.84, 0.54);
  vec2 perp = vec2(-0.54, 0.84);
  float proj = dot(xz, dir);
  float side = dot(xz, perp);

  // Broad sweeping wind fronts + secondary cross-curl eddies
  float w1 = sin(proj * 0.92 - windPhase * 6.2831853 * 6.0 + sin(side * 0.55) * 1.1);
  float w2 = sin(proj * 1.85 - windPhase * 6.2831853 * 12.0 + side * 0.72) * 0.42;
  float flutter = sin(proj * 4.1 - windPhase * 6.2831853 * 24.0 + side * 3.1) * 0.14;

  float gustWave = gustAmt * (0.75 + 0.45 * sin(proj * 0.75 - windPhase * 6.2831853 * 12.0));
  float strength = 0.24 + 0.22 * (w1 * 0.5 + 0.5) + 0.12 * w2 + flutter * 0.5 + gustWave * 0.55;
  waveCrest = clamp((w1 * 0.5 + 0.5) * 0.75 + gustWave * 0.65, 0.0, 1.35);

  vec2 curl = perp * (sin(proj * 1.1 - windPhase * 6.2831853 * 6.0 + side * 0.9) * 0.11);
  return dir * strength + curl;
}

// Soft overhead cumulus cloud shadows drifting visibly across the meadow (Steps 7-8)
float evalCloudShadow(vec2 xz, float windPhase) {
  vec2 uv = vec2(xz.x * 0.21 - windPhase * 4.0, xz.y * 0.23 - windPhase * 2.0);
  float n = tileNoise2(uv, 4.0) * 0.68 + tileNoise2(uv * 2.0 + 1.7, 8.0) * 0.32;
  float sh = smoothstep(0.43, 0.63, n);
  return mix(1.0, 0.30, sh);
}

// Soft ambient occlusion & ground shadow from the standing runestone and rolling orb
float evalPropShadow(vec2 xz, vec3 sunDir, vec3 orbPos, float orbActive) {
  // Standing stone at (-1.12, -0.62) casts a directional shadow along -sunDir.xz
  vec2 stoneXZ = vec2(-1.12, -0.62);
  vec2 rel = xz - stoneXZ;
  vec2 sDir = normalize(-sunDir.xz);
  float along = dot(rel, sDir);
  float across = abs(dot(rel, vec2(-sDir.y, sDir.x)));
  float stoneSh = 1.0;
  if (along > -0.22 && along < 2.25) {
    float width = mix(0.42, 0.24, clamp(along / 2.25, 0.0, 1.0));
    float mask = (1.0 - smoothstep(width * 0.55, width * 1.15, across))
               * smoothstep(-0.25, 0.12, along)
               * (1.0 - smoothstep(1.55, 2.25, along));
    stoneSh = mix(1.0, 0.34, mask);
  }
  // Soft contact AO around stone base
  stoneSh *= mix(0.55, 1.0, smoothstep(0.32, 0.78, length(rel)));

  // Rolling orb soft contact shadow on Step 8
  if (orbActive > 0.5) {
    vec2 oRel = xz - orbPos.xz;
    float oDist = length(oRel - sDir * 0.16);
    stoneSh *= mix(0.32, 1.0, smoothstep(0.16, 0.52, oDist));
  }
  return stoneSh;
}
`;

// ============================================================================
// 1. SKY BACKDROP (1992 banded VGA sky vs sunlit Ghibli afternoon sky)
// ============================================================================
export const SKY_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec3 uSunDir;
uniform int uStage;
out vec4 outColor;

${SHARED_GLSL}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);
  float y = clamp(rd.y, -0.4, 1.0);
  float cosS = max(dot(rd, uSunDir), 0.0);

  if (uStage == 0) {
    // 1992 VGA banded cyan-blue backdrop (crisp retro contrast!)
    float q = floor(clamp(y + 0.25, 0.0, 1.0) * 8.0) / 8.0;
    vec3 low = vec3(0.34, 0.66, 0.90);
    vec3 top = vec3(0.06, 0.22, 0.62);
    vec3 col = mix(low, top, pow(q, 0.8));
    if (cosS > 0.995) col = vec3(1.0, 0.94, 0.44);
    outColor = vec4(col, 1.0);
    return;
  }

  // Calibrated linear-HDR sunlit Ghibli summer sky (rich cerulean dome + soft painted horizon cumulus!)
  vec3 zen = vec3(0.018, 0.115, 0.440);
  vec3 mid = vec3(0.068, 0.275, 0.680);
  vec3 hor = vec3(0.280, 0.500, 0.780);
  vec3 low = vec3(0.055, 0.130, 0.255);

  // Remap elevation around horizon so downward-angled diorama camera still sees rich blue Ghibli sky!
  float hSky = clamp((y + 0.14) / 0.42, 0.0, 1.0);
  vec3 sky = mix(hor, mix(mid, zen, smoothstep(0.32, 1.0, hSky)), smoothstep(0.0, 0.52, hSky));
  sky = mix(sky, low, smoothstep(-0.08, -0.36, y));

  // Warm golden sunlit Mie aureole around the afternoon sun
  vec3 sunCol = vec3(1.32, 0.96, 0.54);
  sky += sunCol * (pow(cosS, 14.0) * 0.20 + pow(cosS, 80.0) * 0.45) * smoothstep(-0.18, 0.04, y);
  sky += sunCol * smoothstep(0.9985, 0.9994, cosS) * 3.0;

  // Crisp Ghibli-style warm sunlit horizon cumulus bank peeking behind the meadow hilltop!
  if (y > -0.14 && y < 0.30) {
    vec2 cuv = vec2(atan(rd.x, -rd.z) * 1.85, (y + 0.12) * 5.2);
    float cn = fbm2(cuv * 1.45 + vec2(0.8, 0.2));
    float cn2 = fbm2(cuv * 3.2 - vec2(1.1, 0.5));
    float cShape = cn * 0.72 + cn2 * 0.28;
    float ca = smoothstep(0.49, 0.68, cShape) * smoothstep(-0.12, -0.02, y) * smoothstep(0.24, 0.04, y) * 0.58;
    vec3 cLit = mix(vec3(0.38, 0.50, 0.72), vec3(0.95, 0.93, 0.88), smoothstep(-0.06, 0.14, y));
    sky = mix(sky, cLit, ca);
  }

  outColor = vec4(sky, 1.0);
}
`;

// ============================================================================
// 2. TERRAIN HILLTOP & EARTHY CLIFF RIM
// ============================================================================
export const TERRAIN_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aSkirt;

uniform mat4 uViewProj;
out vec3 vWorldPos;
out vec3 vNorm;
out vec2 vUv;
out float vSkirt;

void main() {
  vWorldPos = aPos;
  vNorm = aNorm;
  vUv = aUv;
  vSkirt = aSkirt;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const TERRAIN_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNorm;
in vec2 vUv;
in float vSkirt;

uniform vec3 uSunDir;
uniform vec3 uOrbPos;
uniform float uWindPhase;
uniform int uStage;
uniform float uSolidLeft;
out vec4 outColor;

${SHARED_GLSL}

void main() {
  vec3 n = normalize(vNorm);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 sunCol = vec3(1.28, 1.06, 0.76);
  vec3 skyAmb = vec3(0.14, 0.24, 0.38);

  // Dark sculpted earthy rock skirt around island rim
  if (vSkirt > 0.5) {
    float rn = fbm2(vec2(vUv.x * 24.0, vUv.y * 5.0));
    vec3 soil = mix(vec3(0.065, 0.048, 0.036), vec3(0.14, 0.105, 0.075), rn);
    // Lush mossy lip right at the top edge of the cliff
    float moss = smoothstep(0.28, 0.0, vUv.y + (rn - 0.5) * 0.25);
    vec3 baseCol = mix(soil, vec3(0.075, 0.175, 0.045), moss);
    vec3 lit = baseCol * (skyAmb * 0.75 + sunCol * ndl * 0.85);
    outColor = vec4(lit, 1.0);
    return;
  }

  // STEP 1 (1992): Flat solid green (split left) vs 16x16 pixelated tiled grass texture (right)
  if (uStage == 0) {
    vec3 flatN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    float fNdl = max(dot(flatN, uSunDir), 0.0);
    float lightQ = floor((0.36 + 0.64 * fNdl) * 4.0) / 4.0;
    if (uSolidLeft > 0.5) {
      outColor = vec4(vec3(0.16, 0.44, 0.14) * lightQ, 1.0);
      return;
    }
    // Crisp repeating 16x16 retro pixel-art grass tile!
    vec2 tile = floor(fract(vWorldPos.xz * 0.65) * 16.0);
    float h = hash21(tile);
    float tuft = step(0.76, hash21(vec2(tile.x, floor(tile.y * 0.5))));
    vec3 pal0 = vec3(0.09, 0.28, 0.08);
    vec3 pal1 = vec3(0.16, 0.44, 0.12);
    vec3 pal2 = vec3(0.27, 0.58, 0.16);
    vec3 pal3 = vec3(0.42, 0.70, 0.22);
    vec3 pixCol = (h < 0.25) ? pal0 : ((h < 0.68) ? pal1 : pal2);
    if (tuft > 0.5 && mod(tile.y, 2.0) < 0.5) pixCol = pal3;
    if (tuft > 0.5 && mod(tile.y, 2.0) >= 0.5) pixCol = pal0;
    outColor = vec4(pixCol * lightQ, 1.0);
    return;
  }

  // Steps 2-8: Rich mossy meadow earth underneath blades/cards/shells
  float soilN = fbm2(vWorldPos.xz * 2.2);
  float macro = fbm2(vWorldPos.xz * 0.55 + vec2(3.1, -1.7));
  vec3 dirt = vec3(0.068, 0.052, 0.032);
  vec3 turf = mix(vec3(0.048, 0.135, 0.032), vec3(0.115, 0.225, 0.042), macro);
  // Step 2 (X-cards) & Step 3 (Shells) need slightly brighter turf visible between sparse cards
  float turfAmt = (uStage <= 2) ? 0.85 : 0.62;
  vec3 albedo = mix(dirt, turf, clamp(soilN * 0.65 + turfAmt * 0.55, 0.0, 1.0));

  float cloudSh = (uStage >= 6) ? evalCloudShadow(vWorldPos.xz, uWindPhase) : 1.0;
  float propSh = evalPropShadow(vWorldPos.xz, uSunDir, uOrbPos, (uStage >= 7) ? 1.0 : 0.0);

  // Subtle ambient darkening under dense 3D grass canopy (Steps 5-8)
  float canopyAO = (uStage >= 4) ? 0.62 : 0.92;
  vec3 col = albedo * (skyAmb * canopyAO + sunCol * ndl * cloudSh * propSh * 0.95);
  outColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 3. MOSSY STANDING RUNESTONE & STEPPING STONES
// ============================================================================
export const PROP_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aMat;

uniform mat4 uViewProj;
out vec3 vWorldPos;
out vec3 vNorm;
out vec2 vUv;
out float vMat;

void main() {
  vWorldPos = aPos;
  vNorm = aNorm;
  vUv = aUv;
  vMat = aMat;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const PROP_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNorm;
in vec2 vUv;
in float vMat;

uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform float uWindPhase;
uniform int uStage;
out vec4 outColor;

${SHARED_GLSL}

void main() {
  vec3 n = normalize(vNorm);
  float ndl = max(dot(n, uSunDir), 0.0);
  float rockN = fbm2(vWorldPos.xz * 4.5 + vWorldPos.y * 3.0);

  vec3 stone = mix(vec3(0.18, 0.20, 0.23), vec3(0.34, 0.35, 0.36), rockN);
  // Soft green hillside moss creeping up the stone base and upward-facing ledges
  float mossMask = smoothstep(0.62, 0.12, vUv.y + (rockN - 0.5) * 0.35) * (1.0 - vMat)
                 + smoothstep(0.68, 0.92, n.y) * smoothstep(0.45, 0.72, rockN) * 0.65;
  vec3 albedo = mix(stone, vec3(0.085, 0.22, 0.055), clamp(mossMask, 0.0, 0.85));

  if (uStage == 0) {
    float q = floor((0.35 + 0.65 * ndl) * 3.0) / 3.0;
    outColor = vec4(albedo * q * 1.15, 1.0);
    return;
  }

  float cloudSh = (uStage >= 6) ? evalCloudShadow(vWorldPos.xz, uWindPhase) : 1.0;
  vec3 sunCol = vec3(1.30, 1.06, 0.74);
  vec3 skyAmb = vec3(0.16, 0.25, 0.38);
  vec3 col = albedo * (skyAmb + sunCol * ndl * cloudSh * 1.05);

  // Carved glowing golden-amber rune emblem centered cleanly on the front face of the monolith!
  if (vMat < 0.5) {
    float faceFront = smoothstep(0.35, 0.72, n.z);
    vec2 rp = vec2((vWorldPos.x - (-1.05)) * 3.4, (vWorldPos.y - 1.12) * 2.5);
    float dDia = abs(abs(rp.x) + abs(rp.y) - 0.54);
    float dInner = abs(length(rp) - 0.18);
    float dStem = max(abs(rp.x), max(0.0, abs(rp.y) - 0.74));
    float rune = (1.0 - smoothstep(0.045, 0.095, min(min(dDia, dInner), dStem))) * faceFront;
    float pulse = 0.85 + 0.15 * sin(uWindPhase * 6.2831853 * 4.0);
    col += vec3(1.85, 1.05, 0.22) * rune * pulse * (uStage >= 5 ? 1.45 : 0.75);
  }

  outColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 4. ROLLING CARVED BRASS-AND-OAK MEADOW ORB (Step 8)
// ============================================================================
export const ORB_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;

uniform mat4 uViewProj;
uniform vec3 uOrbPos;
uniform mat3 uOrbRot;

out vec3 vWorldPos;
out vec3 vNorm;
out vec3 vLocalNorm;

void main() {
  vec3 rPos = uOrbRot * aPos;
  vec3 rNorm = normalize(uOrbRot * aNorm);
  vWorldPos = uOrbPos + rPos;
  vNorm = rNorm;
  vLocalNorm = normalize(aNorm);
  gl_Position = uViewProj * vec4(vWorldPos, 1.0);
}
`;

export const ORB_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNorm;
in vec3 vLocalNorm;

uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform float uWindPhase;
out vec4 outColor;

${SHARED_GLSL}

void main() {
  vec3 n = normalize(vNorm);
  vec3 v = normalize(uCamPos - vWorldPos);
  vec3 h = normalize(uSunDir + v);
  float ndl = max(dot(n, uSunDir), 0.0);
  float ndh = max(dot(n, h), 0.0);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);

  // Carved dark walnut wood + intersecting polished brass meridian bands (so rolling rotation is crystal clear!)
  float eqBand = 1.0 - smoothstep(0.09, 0.14, abs(vLocalNorm.y));
  float mer1 = 1.0 - smoothstep(0.08, 0.13, abs(vLocalNorm.x));
  float mer2 = 1.0 - smoothstep(0.08, 0.13, abs(vLocalNorm.z));
  float brass = max(eqBand, max(mer1, mer2));
  float coreGlow = (1.0 - smoothstep(0.025, 0.055, abs(vLocalNorm.y))) * 0.85;

  float grain = fbm2(vLocalNorm.xz * 7.0 + vLocalNorm.y * 5.0);
  vec3 woodCol = mix(vec3(0.14, 0.08, 0.04), vec3(0.26, 0.15, 0.075), grain);
  vec3 brassCol = vec3(0.78, 0.56, 0.18);
  vec3 albedo = mix(woodCol, brassCol, brass);

  float cloudSh = evalCloudShadow(vWorldPos.xz, uWindPhase);
  vec3 sunCol = vec3(1.35, 1.08, 0.74);
  vec3 skyAmb = vec3(0.16, 0.25, 0.38);
  vec3 meadowBounce = vec3(0.08, 0.18, 0.05) * max(0.0, -n.y * 0.5 + 0.5);

  float spec = pow(ndh, mix(24.0, 72.0, brass)) * mix(0.25, 1.35, brass);
  vec3 col = albedo * (skyAmb + meadowBounce + sunCol * ndl * cloudSh * 1.15)
           + sunCol * spec * cloudSh
           + vec3(0.45, 0.62, 0.85) * fres * (0.25 + 0.45 * brass)
           + vec3(1.85, 1.12, 0.28) * coreGlow;
  outColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 5. STEP 2 (1996): CROSSED ALPHA-CUTOUT X-CARDS + SHOW X-CARDS WIREFRAME
// ============================================================================
export const XCARD_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec3 aNorm;
layout(location = 3) in float aSeed;

uniform mat4 uViewProj;
out vec2 vUv;
out vec3 vNorm;
out float vSeed;

void main() {
  vUv = aUv;
  vNorm = aNorm;
  vSeed = aSeed;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const XCARD_FS = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vNorm;
in float vSeed;

uniform vec3 uSunDir;
uniform float uShowCards;
out vec4 outColor;

void main() {
  // Crisp 16x16 low-res 1996 alpha-cutout grass tuft card (classic N64/PS1 look!)
  vec2 qUv = floor(vUv * 16.0) / 16.0;
  float mask = 0.0;
  float shade = 0.0;
  // 5 sharp flat pixelated blades fanning out from bottom of card
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float cx = 0.14 + fi * 0.18 + (fract(vSeed * 13.7 + fi * 0.37) - 0.5) * 0.07;
    float lean = (fi - 2.0) * 0.11;
    float bh = 0.58 + 0.36 * fract(vSeed * 7.3 + fi * 0.61);
    float dx = abs(qUv.x - (cx + lean * qUv.y * qUv.y));
    float hw = max(0.02, 0.095 * (1.0 - qUv.y / bh));
    if (qUv.y < bh && dx < hw) {
      mask = 1.0;
      shade = max(shade, qUv.y / bh);
    }
  }

  // Educational Show X-Cards toggle: crisp dark-outlined golden wireframe around every flat X-quad!
  if (uShowCards > 0.5) {
    float edge = max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0;
    float diag = min(abs(vUv.x - vUv.y), abs(vUv.x - (1.0 - vUv.y)));
    float isWire = step(0.92, edge) + step(diag, 0.025) * 0.65;
    float isHalo = step(0.87, edge);
    if (isWire > 0.3) {
      outColor = vec4(vec3(1.25, 0.68, 0.08), 1.0);
      return;
    }
    if (isHalo > 0.5 && mask < 0.5) {
      outColor = vec4(vec3(0.05, 0.05, 0.09), 1.0);
      return;
    }
  }

  if (mask < 0.5) discard;

  vec3 n = gl_FrontFacing ? normalize(vNorm) : -normalize(vNorm);
  float ndl = 0.45 + 0.55 * abs(dot(n, uSunDir));
  vec3 bot = vec3(0.08, 0.24, 0.05);
  vec3 top = vec3(0.28, 0.56, 0.12);
  vec3 col = mix(bot, top, shade) * ndl;
  outColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 6. STEP 3 (2001): 10-LAYER STACKED SHELL GRASS (PS2 / Xbox era!)
// ============================================================================
export const SHELL_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in float aLayer;

uniform mat4 uViewProj;
uniform float uWindPhase;
out vec3 vWorldPos;
out vec3 vNorm;
out float vLayer;

void main() {
  // Slight rigid shear drift on upper shells
  vec3 pos = aPos;
  float sway = sin(pos.x * 1.1 - uWindPhase * 6.2831853 * 6.0) * 0.045 * aLayer * aLayer;
  pos.x += sway;
  vWorldPos = pos;
  vNorm = aNorm;
  vLayer = aLayer;
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

export const SHELL_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNorm;
in float vLayer;

uniform vec3 uSunDir;
out vec4 outColor;

${SHARED_GLSL}

void main() {
  // Keep clear of standing runestone & stepping stones
  if (length(vWorldPos.xz - vec2(-1.12, -0.62)) < 0.52) discard;

  // High-frequency cellular tuft dots tapering sharply with layer height -> classic PS2 shell strata!
  vec2 g = vWorldPos.xz * 15.5;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  vec2 jitter = (vec2(hash21(cell), hash21(cell + 17.3)) - 0.5) * 0.45;
  float d = length(f - jitter);
  float bladeH = 0.42 + 0.58 * hash21(cell + 9.1);
  if (vLayer > bladeH) discard;
  float rad = mix(0.46, 0.12, vLayer / bladeH);
  if (d > rad) discard;

  vec3 n = normalize(vNorm);
  float ndl = max(dot(n, uSunDir), 0.0);
  // Layer height self-shadow gradient (dark roots -> bright green tips)
  vec3 rootCol = vec3(0.04, 0.12, 0.025);
  vec3 tipCol  = vec3(0.24, 0.52, 0.11);
  vec3 col = mix(rootCol, tipCol, pow(vLayer, 0.85)) * (0.28 + 0.88 * ndl);
  outColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 7. STEPS 4-8 (2007-2026): 22,000 GPU-INSTANCED 3D CURVED GRASS BLADES!
// ============================================================================
export const BLADE_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 aBlade;     // x: side in [-1, 1], y: t in [0..1]
layout(location = 1) in vec4 aInstPosH;  // xyz: base pos, w: height
layout(location = 2) in vec4 aInstMeta;  // x: yaw, y: width, z: lean, w: colorHash

uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec3 uOrbPos;
uniform float uOrbRadius;
uniform float uWindPhase;
uniform float uGust;
uniform int uStage;
uniform sampler2D uTrailTex;
uniform float uTrailSpan;

out float vH;
out float vSide;
out float vColorHash;
out float vWaveCrest;
out float vFlat;
out vec3 vWorldPos;
out vec3 vNorm;

${SHARED_GLSL}

void main() {
  float side = aBlade.x;
  float t = aBlade.y;
  vec3 base = aInstPosH.xyz;
  float height = aInstPosH.w;
  float yaw = aInstMeta.x;
  float baseW = aInstMeta.y;
  float lean = aInstMeta.z;
  float cHash = aInstMeta.w;

  vec2 fwd = vec2(cos(yaw), sin(yaw));
  vec2 right = vec2(-fwd.y, fwd.x);

  // Subtle distance thickening prevents far sub-pixel blade shimmering at 60 fps!
  float camDist = length(uCamPos - base);
  float aaBoost = 1.0 + clamp((camDist - 4.0) * 0.055, 0.0, 0.48);
  float width = baseW * (1.0 - pow(t, 1.45)) * aaBoost;

  // Natural curved arc along blade height
  vec2 bendXZ = fwd * (lean * height * t * t);
  float yLocal = height * t;
  float waveCrest = 0.0;
  float flatAmt = 0.0;

  // Step 5+ (2012-2026): Dynamic sweeping multi-octave wind waves!
  if (uStage >= 4) {
    vec2 w = evalMeadowWind(base.xz, uWindPhase, uGust, waveCrest);
    float jitter = 0.85 + 0.30 * sin(cHash * 25.0 + uWindPhase * 6.2831853 * 12.0);
    bendXZ += w * (height * t * t * 1.15 * jitter);
  }

  // Step 8 (2026): Crisp 128x128 persistent wake trail + exact analytical sphere-blade parting (ZERO clipping!)
  if (uStage >= 7) {
    vec2 tuv = base.xz / uTrailSpan + 0.5;
    if (tuv.x > 0.005 && tuv.x < 0.995 && tuv.y > 0.005 && tuv.y < 0.995) {
      vec3 tr = texture(uTrailTex, tuv).rgb;
      vec2 push = (tr.rg * 2.0 - 1.0) * 1.95;
      flatAmt = clamp(tr.b, 0.0, 1.0);
      // Damp wind sway when crushed flat into the ground, lay blades cleanly outward along wake
      bendXZ = mix(bendXZ, push * (height * (0.48 * t + 0.72 * t * t)), smoothstep(0.0, 0.65, flatAmt));
      yLocal *= mix(1.0, 0.14, flatAmt * (0.40 + 0.60 * t));
    }
    // Exact analytical collision right around the rolling orb perimeter so ZERO blades poke into the sphere!
    vec2 away = base.xz - uOrbPos.xz;
    float d = length(away);
    float collR = uOrbRadius * 2.55;
    if (d < collR) {
      vec2 dir = (d > 1e-4) ? (away / d) : fwd;
      float prox = 1.0 - smoothstep(uOrbRadius * 0.55, collR, d);
      float pushOut = (uOrbRadius * 1.15 - min(d, uOrbRadius * 1.15)) + prox * height * 1.05;
      bendXZ = mix(bendXZ, dir * (pushOut * (0.45 * t + 0.75 * t * t)), prox);
      yLocal *= mix(1.0, 0.10, prox * smoothstep(0.0, 0.35, t));
      flatAmt = max(flatAmt, prox);
    }
  }

  // Arc-length preservation: strong wind / flattening naturally lowers blade tips instead of stretching!
  float bLen = length(bendXZ);
  float arcDrop = sqrt(max(0.14, 1.0 - min(0.86, (bLen / max(0.08, height)) * 0.54)));
  yLocal *= arcDrop;

  vec3 pos = base + vec3(bendXZ.x + right.x * side * width, yLocal, bendXZ.y + right.y * side * width);

  // Analytical curved tangent & tubular V-crease normal so sunlight glides smoothly across wind waves!
  vec3 tang = normalize(vec3(bendXZ.x * 2.0 + fwd.x * 0.05, max(0.08, yLocal), bendXZ.y * 2.0 + fwd.y * 0.05));
  vec3 nBase = normalize(cross(vec3(right.x, 0.0, right.y), tang));
  if (nBase.y < 0.0) nBase = -nBase;
  vec3 nCreased = normalize(mix(nBase, vec3(0.0, 1.0, 0.0), 0.22) + vec3(right.x, 0.0, right.y) * (side * 0.42));

  vH = t;
  vSide = side;
  vColorHash = cHash;
  vWaveCrest = waveCrest;
  vFlat = flatAmt;
  vWorldPos = pos;
  vNorm = nCreased;

  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

export const BLADE_FS = `#version 300 es
precision highp float;
precision highp int;

in float vH;
in float vSide;
in float vColorHash;
in float vWaveCrest;
in float vFlat;
in vec3 vWorldPos;
in vec3 vNorm;

uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform vec3 uOrbPos;
uniform float uWindPhase;
uniform int uStage;
uniform float uShowWire;
out vec4 outColor;

${SHARED_GLSL}

void main() {
  vec3 n = gl_FrontFacing ? normalize(vNorm) : -normalize(vNorm);
  // Subtle wrap-diffuse normal tilt upwards so lush blades stay luminous from all orbit angles
  vec3 shadeN = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.28));
  float ndl = max(dot(shadeN, uSunDir), 0.0);

  // STEP 4 (2007): Real 3D instanced blades, but basic stiff flat-green Lambert (no AO, no SSS, no wind!)
  if (uStage == 3) {
    vec3 flatGreen = mix(vec3(0.09, 0.28, 0.06), vec3(0.16, 0.44, 0.09), vH);
    vec3 col = flatGreen * (0.28 + 0.78 * ndl);
    if (uShowWire > 0.5) {
      float edge = smoothstep(0.76, 0.96, abs(vSide));
      float seg = 1.0 - smoothstep(0.0, 0.055, abs(fract(vH * 4.0 + 0.5) - 0.5));
      col = mix(col, vec3(1.15, 0.72, 0.14), max(edge * 0.9, seg * 0.65));
    }
    outColor = vec4(col, 1.0);
    return;
  }

  vec3 v = normalize(uCamPos - vWorldPos);
  vec3 hVec = normalize(uSunDir + v);
  float ndh = max(dot(shadeN, hVec), 0.0);
  vec3 sunCol = vec3(1.32, 1.08, 0.74);
  vec3 skyAmb = vec3(0.11, 0.22, 0.36);

  // Deep earthy root Ambient Occlusion (Step 5+ -> instant 3D depth & meadow volume!)
  float rootAO = mix(0.14, 1.0, pow(vH, 1.25));
  float propSh = evalPropShadow(vWorldPos.xz, uSunDir, uOrbPos, (uStage >= 7) ? 1.0 : 0.0);

  // STEP 5 (2012): Travelling wind waves + Root AO + sunlit wave-crest sheen (uniform emerald palette)
  if (uStage == 4) {
    vec3 rootCol = vec3(0.04, 0.14, 0.03);
    vec3 tipCol  = vec3(0.22, 0.48, 0.10);
    vec3 albedo = mix(rootCol, tipCol, smoothstep(0.05, 0.95, vH));
    // Sunlit sheen glides visibly across bending wind wave crests!
    float spec = pow(ndh, 28.0) * (0.18 + 0.28 * vWaveCrest) * pow(vH, 1.4);
    vec3 col = albedo * rootAO * (skyAmb + sunCol * ndl * propSh * 0.95) + sunCol * spec * propSh;
    outColor = vec4(col, 1.0);
    return;
  }

  // STEPS 6-8 (2017-2026): Painterly Ghibli/Tsushima meadow palette + Golden Backlit SSS!
  float macro = fbm2(vWorldPos.xz * 0.52 + vec2(2.4, -1.3));
  vec3 deepRoot   = vec3(0.016, 0.068, 0.018);
  vec3 coolTip    = vec3(0.065, 0.290, 0.068); // rich emerald-viridian hollows
  vec3 warmTip    = vec3(0.290, 0.500, 0.078); // sunlit chartreuse meadow crests
  vec3 goldenTip  = vec3(0.490, 0.520, 0.110); // occasional sun-kissed wheat tips!

  vec3 tipCol = mix(coolTip, warmTip, smoothstep(0.24, 0.74, macro));
  tipCol = mix(tipCol, goldenTip, smoothstep(0.78, 0.98, vColorHash) * 0.58);
  tipCol *= mix(0.84, 1.16, vColorHash);
  vec3 albedo = mix(deepRoot, tipCol, smoothstep(0.06, 0.92, vH));

  float cloudSh = (uStage >= 6) ? evalCloudShadow(vWorldPos.xz, uWindPhase) : 1.0;
  float sunVis = cloudSh * propSh;

  // Translucent Golden Backlit Subsurface Scattering (concentrated at sunlit tips & backlit angles, keeps deep roots rich!)
  float backDot = max(dot(v, -uSunDir), 0.0);
  float sssView = pow(backDot, 2.8) * 0.92 + 0.14;
  float sss = sssView * pow(vH, 1.65) * (0.48 + 0.52 * vWaveCrest) * sunVis;
  vec3 sssCol = vec3(0.56, 0.68, 0.08) * sunCol * sss * 0.68;

  // Crisp anisotropic grazing specular glint along wind waves
  float spec = pow(ndh, 36.0) * (0.18 + 0.34 * vWaveCrest) * pow(vH, 1.5) * sunVis;

  // Crushed/parted trail shading: pressed-down blades sit deeper in shade & reveal a clear lush wake track!
  float trackShade = mix(1.0, 0.56, vFlat * (1.0 - vH * 0.35));
  vec3 col = albedo * rootAO * trackShade * (skyAmb * 1.05 + sunCol * (0.18 + 0.95 * ndl) * sunVis)
           + sssCol * mix(1.0, 0.35, vFlat)
           + sunCol * spec * 0.52;
  outColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 8. STEPS 7-8 (2022-2026): 650 SWAYING 3D WILDFLOWERS
// ============================================================================
export const FLOWER_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aLocalPos;
layout(location = 1) in vec3 aLocalNorm;
layout(location = 2) in float aPart;
layout(location = 3) in vec4 aInstPosH; // xyz: base, w: stalk height
layout(location = 4) in vec4 aInstMeta; // x: yaw, y: headScale, z: species 0..3, w: seed

uniform mat4 uViewProj;
uniform vec3 uOrbPos;
uniform float uOrbRadius;
uniform float uWindPhase;
uniform float uGust;
uniform int uStage;
uniform sampler2D uTrailTex;
uniform float uTrailSpan;

out vec3 vWorldPos;
out vec3 vNorm;
out float vPart;
out float vSpecies;
out float vH;

${SHARED_GLSL}

void main() {
  vec3 base = aInstPosH.xyz;
  float h = aInstPosH.w;
  float yaw = aInstMeta.x;
  float headSc = aInstMeta.y;
  float species = aInstMeta.z;
  float seed = aInstMeta.w;

  float t = clamp(aLocalPos.y, 0.0, 1.0);
  float c = cos(yaw), s = sin(yaw);
  float sc = (aPart > 0.5) ? headSc : 1.0;

  vec3 lp = vec3(aLocalPos.x * sc, aLocalPos.y * h, aLocalPos.z * sc);
  vec3 rotP = vec3(lp.x * c - lp.z * s, lp.y, lp.x * s + lp.z * c);
  vec3 rotN = normalize(vec3(aLocalNorm.x * c - aLocalNorm.z * s, aLocalNorm.y, aLocalNorm.x * s + aLocalNorm.z * c));

  // Identical wind + trail bend so flowers sway and part organically inside the grass!
  float wc;
  vec2 w = evalMeadowWind(base.xz, uWindPhase, uGust, wc);
  float jitter = 0.88 + 0.24 * sin(seed * 20.0 + uWindPhase * 6.2831853 * 12.0);
  vec2 bendXZ = w * (h * t * t * 1.15 * jitter);
  float yLocal = rotP.y;

  if (uStage >= 7) {
    vec2 tuv = base.xz / uTrailSpan + 0.5;
    if (tuv.x > 0.005 && tuv.x < 0.995 && tuv.y > 0.005 && tuv.y < 0.995) {
      vec3 tr = texture(uTrailTex, tuv).rgb;
      vec2 push = (tr.rg * 2.0 - 1.0) * 1.95;
      float flatAmt = clamp(tr.b, 0.0, 1.0);
      bendXZ = mix(bendXZ, push * (h * (0.48 * t + 0.72 * t * t)), smoothstep(0.0, 0.65, flatAmt));
      yLocal *= mix(1.0, 0.18, flatAmt * (0.40 + 0.60 * t));
    }
    vec2 away = base.xz - uOrbPos.xz;
    float d = length(away);
    float collR = uOrbRadius * 2.55;
    if (d < collR) {
      vec2 dir = (d > 1e-4) ? (away / d) : vec2(c, s);
      float prox = 1.0 - smoothstep(uOrbRadius * 0.55, collR, d);
      float pushOut = (uOrbRadius * 1.15 - min(d, uOrbRadius * 1.15)) + prox * h * 1.05;
      bendXZ = mix(bendXZ, dir * (pushOut * (0.45 * t + 0.75 * t * t)), prox);
      yLocal *= mix(1.0, 0.14, prox * smoothstep(0.0, 0.35, t));
    }
  }

  float bLen = length(bendXZ);
  yLocal *= sqrt(max(0.20, 1.0 - min(0.80, (bLen / max(0.08, h)) * 0.50)));

  vec3 worldPos = base + vec3(rotP.x + bendXZ.x, yLocal, rotP.z + bendXZ.y);
  vWorldPos = worldPos;
  vNorm = rotN;
  vPart = aPart;
  vSpecies = species;
  vH = t;

  gl_Position = uViewProj * vec4(worldPos, 1.0);
}
`;

export const FLOWER_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNorm;
in float vPart;
in float vSpecies;
in float vH;

uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform vec3 uOrbPos;
uniform float uWindPhase;
uniform int uStage;
out vec4 outColor;

${SHARED_GLSL}

void main() {
  vec3 n = gl_FrontFacing ? normalize(vNorm) : -normalize(vNorm);
  float ndl = max(dot(n, uSunDir), 0.0);
  float cloudSh = evalCloudShadow(vWorldPos.xz, uWindPhase);
  float propSh = evalPropShadow(vWorldPos.xz, uSunDir, uOrbPos, (uStage >= 7) ? 1.0 : 0.0);
  float sunVis = cloudSh * propSh;

  vec3 sunCol = vec3(1.30, 1.08, 0.76);
  vec3 skyAmb = vec3(0.16, 0.24, 0.36);

  vec3 albedo;
  if (vPart < 0.5) {
    albedo = mix(vec3(0.04, 0.14, 0.03), vec3(0.14, 0.34, 0.07), vH);
  } else if (vPart > 1.5) {
    // Warm golden stamen center (dark core on poppy!)
    albedo = (vSpecies > 2.5) ? vec3(0.06, 0.04, 0.04) : vec3(0.92, 0.62, 0.06);
  } else {
    // 4 vibrant natural meadow wildflower palettes!
    if (vSpecies < 0.5) albedo = vec3(0.96, 0.74, 0.08);       // Sunny buttercup
    else if (vSpecies < 1.5) albedo = vec3(0.94, 0.92, 0.85);  // Meadow daisy white
    else if (vSpecies < 2.5) albedo = vec3(0.28, 0.44, 0.96);  // Cornflower blue
    else albedo = vec3(0.92, 0.17, 0.12);                      // Scarlet poppy accent
  }

  // Gentle translucent petal glow when lit by sun!
  vec3 v = normalize(uCamPos - vWorldPos);
  float sss = (vPart > 0.5 && vPart < 1.5) ? (0.28 + 0.45 * pow(max(dot(v, -uSunDir), 0.0), 2.5)) * sunVis : 0.0;
  vec3 col = albedo * (skyAmb + sunCol * (0.26 + 0.90 * ndl) * sunVis) + albedo * sunCol * sss * 0.45;
  outColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 9. STEPS 7-8 (2022-2026): FLOATING SUNLIT GOLDEN POLLEN MOTES
// ============================================================================
export const POLLEN_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aSeed; // x, yOff, z, phase

uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uWindPhase;
uniform float uGust;
uniform float uHeightPx;

out float vAlpha;

void main() {
  float ph = aSeed.w;
  // Seamless periodic drifting along wind vector inside meadow cylinder
  float drift = fract(ph + uWindPhase * 2.0) * 8.4 - 4.2;
  float x = mod(aSeed.x + drift + 4.4, 8.8) - 4.4;
  float z = mod(aSeed.z + drift * 0.62 + 4.4, 8.8) - 4.4;
  float r = length(vec2(x, z));
  float y = aSeed.y + 0.22 * sin(uWindPhase * 6.2831853 * 6.0 + ph * 25.0) + uGust * 0.25;

  vec3 pos = vec3(x, y, z);
  vec4 clip = uViewProj * vec4(pos, 1.0);
  gl_Position = clip;

  float dist = max(1.5, length(uCamPos - pos));
  gl_PointSize = clamp((uHeightPx * 0.032) / dist, 2.5, 11.0);
  float twinkle = 0.55 + 0.45 * sin(uWindPhase * 6.2831853 * 12.0 + ph * 41.0);
  vAlpha = smoothstep(4.4, 3.0, r) * twinkle;
}
`;

export const POLLEN_FS = `#version 300 es
precision highp float;

in float vAlpha;
out vec4 outColor;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float glow = pow(1.0 - d, 2.2) * vAlpha;
  outColor = vec4(vec3(1.65, 1.38, 0.68) * glow, glow * 0.85);
}
`;

// ============================================================================
// 10. HDR BLOOM THRESHOLD + SEPARABLE BLUR + ACES FILMIC COMPOSITE
// ============================================================================
export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uHdr;
out vec4 outColor;
void main() {
  vec3 c = texture(uHdr, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(0.95, 1.85, lum);
  outColor = vec4(c * w * 0.45, 1.0);
}
`;

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
precision highp int;

in vec2 vUv;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
out vec4 outColor;

void main() {
  vec3 col = texture(uHdr, vUv).rgb;
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;

  // Gentle sunlit HDR bloom on Steps 6-8 (glowing backlit grass tips, golden rune & pollen motes)
  if (st >= 5) {
    col += texture(uBloom, vUv).rgb * 0.55;
  }

  // ACES filmic tone mapping (skip on 1992 VGA Step 1 so retro quantized greens stay crisp!)
  if (st == 0) {
    col = clamp(col, 0.0, 1.0);
  } else {
    col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  }

  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * (st == 0 ? 0.06 : 0.18);
  outColor = vec4(pow(max(col, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}
`;
