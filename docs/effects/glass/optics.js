// Shared optical scene parameters and GLSL geometry/environment library for Evolution of Glass & Caustics.

export const DEFAULT_SUN_AZ = -2.15; // Upper-left-back sun -> 0.98-unit Newton rainbow right in front!
export const DEFAULT_SUN_EL = 0.56;  // ~32 deg elevation -> optimal Newton dispersion & star-cusp caustics

export const CAUSTIC_RES = 512;      // 512x512 floor photon accumulation map ([-3.1, 3.1]^2)
export const PHOTON_GRID = 128;      // 128x128 = 16,384 rays per spectral band (98,304 photons across 6 bands!)
export const CAUSTIC_EXTENT = 3.1;

// Shared GLSL geometry (analytical marble pedestal & brass observatory columns + smooth glass SDFs)
// and procedural HDR studio skylight environment (crisp window highlights make Fresnel & TIR pop).
export const GLASS_COMMON_GLSL = `
const vec3 ORB_CENTER   = vec3(-0.48, 0.86, -0.34);
const float ORB_R       = 0.84;
const vec3 PRISM_CENTER = vec3(0.86, 0.64, 0.08);
const float PRISM_HALF_H = 0.62;
const float PRISM_R     = 0.48;
const float PED_R       = 2.65;
const float CAUSTIC_EXT = 3.10;

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

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
  return 0.54 * noise2(p) + 0.30 * noise2(p * 2.07 + 3.1) + 0.16 * noise2(p * 4.19 + 7.7);
}

// ---------------------------------------------------------------------------
// Glass SDF: 8-flute Venetian crystal orb + beveled upright triangular prism
// ---------------------------------------------------------------------------
float sdOrb(vec3 p, float spin) {
  vec3 q = p - ORB_CENTER;
  float r = length(q);
  float rXZ = length(q.xz);
  // 8 gentle vertical/spiral crystal ribs -> creates an unmistakable star-rosette caustic!
  float ang = atan(q.z, q.x) + spin;
  float mask = smoothstep(0.08, 0.56, rXZ / ORB_R);
  float flute = 0.044 * sin(8.0 * ang + q.y * 1.15) * mask;
  return (r - ORB_R + flute) * 0.68;
}

float sdPrism(vec3 p, float prismYaw) {
  vec3 q = p - PRISM_CENTER;
  q.xz = rot2(prismYaw) * q.xz;
  // Exact equilateral triangular prism SDF (base radius PRISM_R, beveled by 0.032)
  const float k = 1.7320508; // sqrt(3)
  vec2 d2 = vec2(abs(q.x), q.z);
  float tri = max(d2.x * 0.8660254 + d2.y * 0.5, -d2.y) - (PRISM_R * 0.54);
  float dy = abs(q.y) - (PRISM_HALF_H - 0.032);
  vec2 w = vec2(tri, dy);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - 0.032;
}

// Returns vec2(dist, id): id = 1.0 for fluted orb, 2.0 for triangular optical prism
vec2 mapGlass(vec3 p, float spin, float prismYaw) {
  float dO = sdOrb(p, spin);
  float dP = sdPrism(p, prismYaw);
  return (dO < dP) ? vec2(dO, 1.0) : vec2(dP, 2.0);
}

vec3 calcGlassNormal(vec3 p, float spin, float prismYaw) {
  vec2 e = vec2(0.0022, -0.0022);
  return normalize(
    e.xyy * mapGlass(p + e.xyy, spin, prismYaw).x +
    e.yyx * mapGlass(p + e.yyx, spin, prismYaw).x +
    e.yxy * mapGlass(p + e.yxy, spin, prismYaw).x +
    e.xxx * mapGlass(p + e.xxx, spin, prismYaw).x
  );
}

// Fast bounding-sphere intersection for ray early-out
vec2 iSphere(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) return vec2(1e5, -1e5);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Trace into either the orb or prism from outside (returns vec2(tHit, glassId), tHit < 0 if miss)
vec2 traceGlassEntry(vec3 ro, vec3 rd, float spin, float prismYaw) {
  vec2 bO = iSphere(ro, rd, ORB_CENTER, ORB_R + 0.09);
  vec2 bP = iSphere(ro, rd, PRISM_CENTER, 0.92);
  float tMin = min(bO.x, bP.x);
  float tMax = max(bO.y, bP.y);
  if (tMax < 0.0 || tMin > 30.0) return vec2(-1.0, 0.0);

  float t = max(0.002, tMin);
  float tEnd = min(tMax + 0.05, 22.0);
  for (int i = 0; i < 42; i++) {
    vec2 h = mapGlass(ro + rd * t, spin, prismYaw);
    if (h.x < 0.0012) return vec2(t, h.y);
    t += max(h.x, 0.002);
    if (t > tEnd) break;
  }
  return vec2(-1.0, 0.0);
}

// Trace from inside a single glass object (id 1 or 2) to its back exit boundary
float traceGlassExit(vec3 ro, vec3 rd, float glassId, float spin, float prismYaw) {
  float t = 0.025;
  for (int i = 0; i < 38; i++) {
    vec3 p = ro + rd * t;
    float d = (glassId < 1.5) ? sdOrb(p, spin) : sdPrism(p, prismYaw);
    if (d > -0.0012) return t;
    t += max(-d, 0.003);
    if (t > 2.6) break;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Procedural HDR Observatory Studio Sky (dark twilight + crisp bright skylights!)
// Sharp bright window panels in HDR give glass photographic Fresnel reflections.
// ---------------------------------------------------------------------------
vec3 evalStudioSky(vec3 rd, vec3 sunDir) {
  float h = clamp(rd.y, -0.25, 1.0);
  vec3 zen = vec3(0.045, 0.078, 0.138);
  vec3 mid = vec3(0.095, 0.145, 0.215);
  vec3 hor = vec3(0.240, 0.215, 0.205);
  vec3 low = vec3(0.030, 0.042, 0.062);

  vec3 col = (h > 0.0)
    ? mix(hor, mix(mid, zen, smoothstep(0.18, 0.85, h)), smoothstep(0.0, 0.48, h))
    : mix(hor * 0.65, low, smoothstep(0.0, -0.25, h));

  // Warm sun disc + golden atmospheric halo
  float sDot = max(dot(rd, sunDir), 0.0);
  col += vec3(1.10, 0.72, 0.36) * pow(sDot, 8.0) * 0.42;
  col += vec3(3.20, 2.55, 1.75) * pow(sDot, 96.0) * 1.45;
  col += vec3(6.50, 5.80, 4.60) * smoothstep(0.9975, 0.9994, sDot);

  // Two crisp overhead observatory skylight softbox panels (makes curved glass read instantly!)
  vec3 win1 = normalize(vec3(0.55, 0.72, 0.42));
  vec3 win2 = normalize(vec3(-0.78, 0.56, 0.26));
  float p1 = smoothstep(0.86, 0.92, dot(rd, win1)) * smoothstep(0.18, 0.35, rd.y);
  float p2 = smoothstep(0.88, 0.94, dot(rd, win2)) * smoothstep(0.12, 0.28, rd.y);
  col += vec3(1.85, 2.05, 2.35) * p1 * 1.15;
  col += vec3(2.10, 1.72, 1.28) * p2 * 0.95;
  return col;
}

// 6-band spectral RGB tint (w in [0..1]: Red -> Orange -> Yellow -> Green -> Cyan -> Violet)
vec3 spectralBandColor(float wNorm) {
  // High-chroma prism spectrum weights summing cleanly to warm sunlit white where bands overlap!
  vec3 c0 = vec3(1.85, 0.06, 0.02); // 650 nm Deep Red
  vec3 c1 = vec3(1.65, 0.68, 0.02); // 605 nm Vivid Orange
  vec3 c2 = vec3(1.18, 1.38, 0.04); // 570 nm Golden Yellow
  vec3 c3 = vec3(0.06, 1.52, 0.48); // 525 nm Emerald Green
  vec3 c4 = vec3(0.04, 0.92, 1.72); // 480 nm Electric Cyan-Blue
  vec3 c5 = vec3(0.68, 0.10, 1.95); // 435 nm Pure Violet
  float x = clamp(wNorm, 0.0, 1.0) * 5.0;
  if (x < 1.0) return mix(c0, c1, x);
  if (x < 2.0) return mix(c1, c2, x - 1.0);
  if (x < 3.0) return mix(c2, c3, x - 2.0);
  if (x < 4.0) return mix(c3, c4, x - 3.0);
  return mix(c4, c5, x - 4.0);
}
`;
