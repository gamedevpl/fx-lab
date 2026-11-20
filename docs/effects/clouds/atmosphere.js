// Shared atmospheric parameters, GPU 64^3 Perlin-Worley 3D noise baker,
// Rayleigh + Mie physical sky, and alpine horizon terrain for Evolution of Clouds & Sky.

export const VOL_RES = 64; // 64x64x64 tileable RGBA8 WebGL2 TEXTURE_3D (baked once on GPU in < 3 ms!)

// Default dramatic golden-hour sun peeking through sculpted cumulus gaps!
export const DEFAULT_SUN_AZ = -0.18; // Slightly left of center -> golden god-rays stream diagonally over peaks!
export const DEFAULT_SUN_EL = 0.22;  // ~12.5 deg elevation -> rich sapphire zenith + golden-apricot horizon!

// GPU shader that bakes one Z-slice (uSlice in [0..63]) of a tileable 64x64x64 RGBA8 cloud noise volume:
// R = 4-octave organic turbulent Perlin FBM (sweeping horizontal strata & ridges — ZERO round Worley dots!)
// G = Multi-octave billowy Worley (freq 6 + 12 + 24) for natural cauliflower sub-structure
// B = High-frequency wispy Worley-Perlin erosion (freq 12 + 24) for razor-crisp edges
// A = Smooth 3D domain-warp field (twists clouds organically with atmospheric wind shear!)
export const NOISE_BAKE_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform float uZ; // (slice + 0.5) / 64.0
out vec4 outColor;

vec3 hash33(vec3 p) {
  p = vec3(
    dot(p, vec3(127.1, 311.7,  74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(p) * 43758.5453123);
}

// Tileable 3D gradient noise with integer period
float tileNoise(vec3 p, float period) {
  vec3 gp = p * period;
  vec3 i = floor(gp);
  vec3 f = fract(gp);
  vec3 u = f * f * (3.0 - 2.0 * f);

  float res = 0.0;
  for (int dz = 0; dz <= 1; dz++) {
    for (int dy = 0; dy <= 1; dy++) {
      for (int dx = 0; dx <= 1; dx++) {
        vec3 off = vec3(float(dx), float(dy), float(dz));
        vec3 cell = mod(i + off, period);
        vec3 g = hash33(cell) * 2.0 - 1.0;
        vec3 d = f - off;
        float w = mix(1.0 - u.x, u.x, off.x) * mix(1.0 - u.y, u.y, off.y) * mix(1.0 - u.z, u.z, off.z);
        res += w * dot(g, d);
      }
    }
  }
  return res * 0.5 + 0.5;
}

// Tileable 3D inverted Worley cellular billows
float tileWorley(vec3 p, float period) {
  vec3 gp = p * period;
  vec3 id = floor(gp);
  vec3 f = fract(gp);
  float minD = 1.0;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec3 off = vec3(float(dx), float(dy), float(dz));
        vec3 cell = mod(id + off, period);
        vec3 pt = off + hash33(cell) - f;
        minD = min(minD, dot(pt, pt));
      }
    }
  }
  return clamp(1.0 - sqrt(minD), 0.0, 1.0);
}

void main() {
  vec3 p = vec3(vUv, uZ);

  // Domain-warped organic 4-octave Perlin FBM (sweeping natural cloud shapes, ZERO polka-dot balls!)
  float wx = tileNoise(p + vec3(0.17, 0.31, 0.53), 4.0) - 0.5;
  float wy = tileNoise(p + vec3(0.71, 0.13, 0.29), 4.0) - 0.5;
  float wz = tileNoise(p + vec3(0.43, 0.67, 0.11), 4.0) - 0.5;
  vec3 pw = fract(p + vec3(wx, wy, wz) * 0.12);

  float perlinFbm =
    tileNoise(pw,  3.0) * 0.46 +
    tileNoise(pw,  6.0) * 0.28 +
    tileNoise(pw, 12.0) * 0.16 +
    tileNoise(pw, 24.0) * 0.10;

  // Multi-octave Worley billows (all high enough frequency that no single cell ever reads as a round ball!)
  float w6  = tileWorley(pw,  6.0);
  float w12 = tileWorley(p,  12.0);
  float w20 = tileWorley(p,  20.0);
  float worleyBillow = w6 * 0.50 + w12 * 0.32 + w20 * 0.18;

  // Fine high-frequency fibrous wisps
  float wisps = w12 * 0.45 + w20 * 0.35 + tileNoise(p, 24.0) * 0.20;

  // Smooth 3D warp signal
  float warpField = tileNoise(p, 4.0) * 0.65 + tileNoise(p, 8.0) * 0.35;

  outColor = vec4(clamp(perlinFbm, 0.0, 1.0), clamp(worleyBillow, 0.0, 1.0), clamp(wisps, 0.0, 1.0), clamp(warpField, 0.0, 1.0));
}
`;

// Shared GLSL atmospheric scattering (Rayleigh + Mie), sun palette, and alpine horizon ridge
export const CLOUDS_COMMON_GLSL = `
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
  return 0.54 * noise2(p) + 0.28 * noise2(p * 2.07 + 3.1) + 0.12 * noise2(p * 4.21 + 7.7) + 0.06 * noise2(p * 8.33 + 1.4);
}

// Interleaved gradient noise (Jorge Jimenez) -> eliminates raymarch step banding at 60 fps!
float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

// Henyey-Greenstein phase function (models crisp forward silver-lining glow around sun!)
float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(0.001, 1.0 + g2 - 2.0 * g * cosTheta), 1.5));
}

// Physical sun color temperature reacting smoothly to solar elevation (noon white -> golden amber -> deep sunset crimson)
vec3 evalSunColor(float sunEl) {
  float day = smoothstep(-0.02, 0.42, sunEl);
  float gold = smoothstep(-0.04, 0.18, sunEl);
  vec3 dusk = vec3(1.65, 0.42, 0.14);
  vec3 warm = vec3(1.95, 1.24, 0.68);
  vec3 noon = vec3(1.75, 1.66, 1.50);
  return mix(mix(dusk, warm, gold), noon, day);
}

// Physical Nishita-inspired Rayleigh + Mie atmospheric sky dome (Steps 4-8)
vec3 evalPhysicalSky(vec3 rd, vec3 sunDir, out vec3 sunDiskOut) {
  float sunEl = sunDir.y;
  float y = max(rd.y, 0.0);
  float cosT = dot(rd, sunDir);

  // Day/sunset blend factors driven purely by sun elevation
  float day = smoothstep(0.02, 0.50, sunEl);
  float sunset = smoothstep(-0.04, 0.24, sunEl) * (1.0 - smoothstep(0.16, 0.58, sunEl));

  // Deep saturated Rayleigh sapphire zenith -> rich golden-apricot sunset horizon!
  vec3 zenDay   = vec3(0.032, 0.145, 0.560);
  vec3 zenGold  = vec3(0.025, 0.088, 0.310);
  vec3 zenDusk  = vec3(0.012, 0.028, 0.115);
  vec3 zenith   = mix(mix(zenDusk, zenGold, smoothstep(-0.05, 0.14, sunEl)), zenDay, day);

  vec3 midDay   = vec3(0.12, 0.36, 0.76);
  vec3 midGold  = vec3(0.18, 0.28, 0.54);
  vec3 midDusk  = vec3(0.14, 0.12, 0.26);
  vec3 midSky   = mix(mix(midDusk, midGold, smoothstep(-0.05, 0.14, sunEl)), midDay, day);

  vec3 horDay   = vec3(0.50, 0.70, 0.88);
  vec3 horGold  = vec3(1.18, 0.52, 0.20);
  vec3 horDusk  = vec3(0.56, 0.18, 0.16);
  vec3 horizon  = mix(mix(horDusk, horGold, smoothstep(-0.05, 0.12, sunEl)), horDay, day);

  vec3 sky = mix(horizon, mix(midSky, zenith, smoothstep(0.12, 0.65, y)), smoothstep(0.0, 0.32, y));

  // Focused sunset warmth concentrated along the solar azimuth belt
  vec2 rdH = normalize(vec2(rd.x, rd.z) + vec2(1e-5));
  vec2 sunH = normalize(vec2(sunDir.x, sunDir.z) + vec2(1e-5));
  float azAlign = pow(max(0.0, dot(rdH, sunH)), 3.2);
  float belt = exp(-y * 10.5) * azAlign * (0.20 + 0.95 * sunset);
  sky += vec3(1.25, 0.40, 0.10) * belt;

  // Crisp localized Mie forward-scattering solar aureole (tight, keeps cobalt zenith & cloud contrast rich!)
  vec3 sunCol = evalSunColor(sunEl);
  float mieGlow = pow(max(cosT, 0.0), 14.0) * (0.22 + 0.32 * sunset) + pow(max(cosT, 0.0), 72.0) * 0.62;
  sky += sunCol * mieGlow * smoothstep(-0.08, 0.03, rd.y);

  // Crisp solar disc
  float sunDisc = smoothstep(0.9985, 0.9994, cosT) * smoothstep(-0.02, 0.02, rd.y);
  sunDiskOut = sunCol * sunDisc * 8.5;
  sky += sunDiskOut;

  // Below-horizon valley continuation
  if (rd.y < 0.0) {
    vec3 valleyMist = mix(horizon * 0.48, vec3(0.05, 0.07, 0.12), clamp(-rd.y * 5.0, 0.0, 1.0));
    sky = mix(sky, valleyMist, smoothstep(0.0, -0.05, rd.y));
  }
  return sky;
}

// Retro painted sky (Steps 1-3: pre-Rayleigh era!)
vec3 evalRetroSky(vec3 rd, vec3 sunDir, int stage) {
  float h = clamp(rd.y, 0.0, 1.0);
  if (stage == 0) {
    // 1992 VGA/SNES quantized 10-band cyan-to-cobalt gradient!
    float q = floor(h * 10.0) / 10.0;
    vec3 low = vec3(0.46, 0.78, 0.96);
    vec3 top = vec3(0.08, 0.25, 0.74);
    vec3 col = mix(low, top, pow(q, 0.72));
    float sDot = dot(rd, sunDir);
    if (sDot > 0.9965) col = vec3(1.0, 0.96, 0.48);
    return col;
  }
  // 1997-2002 painted skybox gradient (rich classic blue, lacks physical golden Rayleigh/Mie atmosphere!)
  vec3 hor = vec3(0.50, 0.70, 0.88);
  vec3 mid = vec3(0.18, 0.42, 0.76);
  vec3 zen = vec3(0.07, 0.18, 0.50);
  vec3 col = mix(hor, mix(mid, zen, smoothstep(0.22, 0.85, h)), smoothstep(0.0, 0.50, h));
  float sDot = max(dot(rd, sunDir), 0.0);
  col += vec3(1.0, 0.94, 0.76) * pow(sDot, 56.0) * 0.40;
  col += vec3(1.5, 1.4, 1.1) * smoothstep(0.9985, 0.9994, sDot);
  return col;
}

// Crisp serrated alpine mountain range (Dolomites / Teton style jagged silhouettes, zero flat-topped cones!)
float ridged2(vec2 p) {
  float a = 1.0 - abs(noise2(p) * 2.0 - 1.0);
  float b = 1.0 - abs(noise2(p * 2.13 + 4.7) * 2.0 - 1.0);
  float c = 1.0 - abs(noise2(p * 4.41 + 9.2) * 2.0 - 1.0);
  float d = 1.0 - abs(noise2(p * 8.70 + 2.1) * 2.0 - 1.0);
  return a * a * 0.52 + b * b * 0.26 + c * c * 0.14 + d * d * 0.08;
}

float mountainHeight(vec2 xz) {
  float d = length(xz);
  // Two intersecting jagged mountain ridges creating a dramatic V-shaped alpine pass in the center
  float r1 = ridged2(xz * 0.13 + vec2(1.15, -0.42)) * 2.95;
  float r2 = ridged2(xz * 0.28 + vec2(-2.4, 3.1)) * 0.95;
  float passDip = exp(-pow((xz.x + 0.35) * 0.24, 2.0)) * 0.72;
  float sideLift = smoothstep(1.2, 7.5, abs(xz.x + 0.35)) * 1.15;
  float valley = smoothstep(3.2, 9.5, d);
  return -2.10 + (r1 + r2 + sideLift - passDip) * valley;
}
`;
