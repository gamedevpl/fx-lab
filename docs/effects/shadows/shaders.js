// GLSL ES 3.00 shaders for Evolution of Shadows (1988-2026), split into 5 fast passes:
//   Pass 1 (SHADOW_MAP_FS) — Real orthographic depth map from the sun (88x88 low-res & 320x320 hi-res)
//   Pass 2 (GBUFFER_FS)    — Camera SDF raymarch packing Albedo+Mat and 16-bit Depth+OctNormal
//   Pass 3 (LIGHTING_FS)   — All 8 shadow eras (Blob -> Planar -> Stencil -> Hard Map -> PCF -> PCSS -> RT Area -> Colored Glass & GI)
//   Pass 4 (BLUR_FS)       — Separable Gaussian HDR bloom
//   Pass 5 (FINAL_FS)      — ACES filmic tone mapping

const COMMON_GLSL = `
const float PI = 3.14159265;
const float SM_HALF = 3.15;
const float SM_FAR  = 12.0;
const vec3  SM_TARGET = vec3(0.0, 0.55, 0.0);

const vec3 ARCH_POS = vec3(-1.32, 0.0, -0.78);
const float ARCH_YAW = 0.72;
const vec3 HERO_POS = vec3(0.50, 0.0, -0.68);
const vec3 COL_POS  = vec3(1.76, 0.0, -0.14);
const vec3 STEP_POS = vec3(1.16, 0.0,  0.58);
const vec3 ORB_POS  = vec3(-0.06, 0.44, 0.98);
const float ORB_R   = 0.23;

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

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdCappedCylinder(vec3 p, float h, float r) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

vec2 opU(vec2 a, vec2 b) { return a.x < b.x ? a : b; }

// Exact 16-bit depth packing into RGBA8 RG channels.
vec2 packDepth16(float dist, float maxDist) {
  float d16 = floor(clamp(dist / maxDist, 0.0, 1.0) * 65535.0 + 0.5);
  return vec2(floor(d16 / 256.0), mod(d16, 256.0)) / 255.0;
}

float unpackDepth16(vec2 rg, float maxDist) {
  return (floor(rg.x * 255.0 + 0.5) * 256.0 + floor(rg.y * 255.0 + 0.5)) * (maxDist / 65535.0);
}

// Octahedral unit normal packing into [0,1]^2.
vec2 encodeOctNormal(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z) + 1e-6);
  vec2 e = n.xy;
  if (n.z < 0.0) {
    e = (1.0 - abs(e.yx)) * vec2(e.x >= 0.0 ? 1.0 : -1.0, e.y >= 0.0 ? 1.0 : -1.0);
  }
  return e * 0.5 + 0.5;
}

vec3 decodeOctNormal(vec2 f) {
  f = f * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += (n.x >= 0.0) ? -t : t;
  n.y += (n.y >= 0.0) ? -t : t;
  return normalize(n);
}

// Local coordinates inside the Gothic stained-glass arch frame.
vec3 toArchLocal(vec3 p) {
  vec3 q = p - ARCH_POS;
  q.xz = rot2(-ARCH_YAW) * q.xz;
  return q;
}

// Pointed Gothic arch opening SDF in arch local 2D (x, y): < 0 inside glass pane.
float sdGothicOpening(vec2 xy) {
  float dBot = 0.24 - xy.y;
  float dSides = abs(xy.x) - 0.66;
  float dPointed = length(vec2(abs(xy.x) + 0.26, xy.y - 1.12)) - 0.92;
  float dTop = (xy.y > 1.12) ? dPointed : dSides;
  return max(dBot, dTop);
}

// Slim stone tracery (mullion, transom & rose ring) so sunlight pours cleanly through the glass.
float sdArchTracery(vec3 ap) {
  float dMul = sdBox(ap - vec3(0.0, 0.88, 0.0), vec3(0.028, 0.64, 0.042));
  float dTra = sdBox(ap - vec3(0.0, 1.06, 0.0), vec3(0.68, 0.028, 0.042));
  float rRose = length(ap.xy - vec2(0.0, 1.50));
  float dRose = max(abs(rRose - 0.25) - 0.026, abs(ap.z) - 0.042);
  float dSpoke = sdBox(ap - vec3(0.0, 1.76, 0.0), vec3(0.024, 0.24, 0.038));
  return min(min(dMul, dTra), min(dRose, dSpoke));
}

// Orbiting brass moon position around the astrolabe.
vec3 getMoonPos(float time) {
  float a = time * 0.95 + 0.6;
  return HERO_POS + vec3(cos(a) * 0.62, 1.24 + 0.14 * sin(a * 2.0), sin(a) * 0.62);
}

// Shared opaque geometry SDF (used by shadow maps, G-buffer, and ray-traced shadows).
// Material IDs: 1 = travertine floor/island, 2 = limestone arch/step/column/pedestal,
// 3 = brushed brass astrolabe, 4 = crystal orb (opaque in steps 1-7, transmissive in step 8),
// 5 = stained glass pane (camera only in G-buffer; never blocks shadow maps!).
vec2 mapOpaque(vec3 p, float time, bool includeOrbAsOpaque) {
  // 1. Floating sunlit travertine sanctuary platform.
  float r = length(p.xz);
  float ang = atan(p.z, p.x);
  float rockTaper = (p.y > -0.22) ? 1.0 : clamp(1.0 + (p.y + 0.22) * 0.68, 0.14, 1.0);
  float crag = (0.06 * sin(ang * 7.0 + p.y * 3.0) + 0.035 * cos(ang * 13.0 - p.y * 4.5)) * smoothstep(-0.20, -0.45, p.y);
  float dPlat = max(r - (2.64 * rockTaper + crag), max(p.y, -1.22 - p.y));
  vec2 res = vec2(dPlat, 1.0);

  // 2. Gothic stained-glass arch stone wall + tracery mullions (slender reveal lets full sunlight pass!).
  {
    vec3 ap = toArchLocal(p);
    float dWall = sdBox(ap - vec3(0.0, 1.15, 0.0), vec3(1.04, 1.15, 0.10)) - 0.018;
    float dCap  = sdBox(ap - vec3(0.0, 2.34, 0.0), vec3(1.12, 0.055, 0.16)) - 0.015;
    float dBase = sdBox(ap - vec3(0.0, 0.10, 0.0), vec3(1.12, 0.10, 0.17)) - 0.015;
    float open2D = sdGothicOpening(ap.xy);
    float dCut = max(open2D, abs(ap.z) - 0.22);
    float dArch = min(min(max(dWall, -dCut), dCap), dBase);
    float dTrac = max(sdArchTracery(ap), open2D - 0.03);
    res = opU(res, vec2(min(dArch, dTrac), 2.0));
  }

  // 3. Central stone pedestal + rotating brass armillary astrolabe + orbiting moon.
  {
    vec3 hp = p - HERO_POS;
    float dPedBase = sdBox(hp - vec3(0.0, 0.08, 0.0), vec3(0.35, 0.08, 0.35)) - 0.015;
    float dPedShaft = sdCappedCylinder(hp - vec3(0.0, 0.39, 0.0), 0.28, 0.21);
    float dPedCap = sdBox(hp - vec3(0.0, 0.70, 0.0), vec3(0.28, 0.05, 0.28)) - 0.012;
    res = opU(res, vec2(min(dPedBase, min(dPedShaft, dPedCap)), 2.0));

    vec3 sp = hp - vec3(0.0, 1.32, 0.0);
    vec3 r1 = sp;
    r1.xz = rot2(time * 0.55) * r1.xz;
    r1.xy = rot2(0.48) * r1.xy;
    float dRing1 = sdTorus(r1, vec2(0.45, 0.042));

    vec3 r2 = sp;
    r2.xz = rot2(-time * 0.75 + 1.1) * r2.xz;
    r2.yz = rot2(1.18) * r2.yz;
    float dRing2 = sdTorus(r2, vec2(0.33, 0.035));

    float dCore = length(sp) - 0.148;
    float dMoon = length(p - getMoonPos(time)) - 0.082;
    res = opU(res, vec2(min(min(dRing1, dRing2), min(dCore, dMoon)), 3.0));
  }

  // 4. Right stone step (shows planar shadows failing on 3D height changes).
  {
    vec3 sp = p - STEP_POS;
    sp.xz = rot2(-0.22) * sp.xz;
    float dStep = sdBox(sp - vec3(0.0, 0.15, 0.0), vec3(0.56, 0.15, 0.44)) - 0.016;
    res = opU(res, vec2(dStep, 2.0));
  }

  // 5. Right fluted Doric column (vertical shadow receiver & contact-hardening showcase).
  {
    vec3 cp = p - COL_POS;
    float cAng = atan(cp.z, cp.x);
    float flute = 0.008 * cos(cAng * 12.0);
    float dShaft = sdCappedCylinder(cp - vec3(0.0, 0.86, 0.0), 0.78, 0.205 + flute);
    float dBase = sdCappedCylinder(cp - vec3(0.0, 0.06, 0.0), 0.06, 0.26);
    float dCap  = sdCappedCylinder(cp - vec3(0.0, 1.66, 0.0), 0.055, 0.26);
    res = opU(res, vec2(min(dShaft, min(dBase, dCap)), 2.0));
  }

  // 6. Foreground pedestal & crystal orb (opaque stone caster in 1-7, caustic crystal lens in 8).
  {
    vec3 op = p - vec3(ORB_POS.x, 0.0, ORB_POS.z);
    float dPlinth = sdCappedCylinder(op - vec3(0.0, 0.095, 0.0), 0.095, 0.23);
    res = opU(res, vec2(dPlinth, 2.0));
    if (includeOrbAsOpaque) {
      res = opU(res, vec2(length(p - ORB_POS) - ORB_R, 4.0));
    }
  }

  return res;
}

// Evaluates deep jewel-toned cathedral stained-glass RGB transmission and lead mullion mask.
// Deep monochromatic spectral absorption avoids ACES white-washing!
vec4 evalStainedGlass(vec2 xy) {
  float openD = sdGothicOpening(xy);
  if (openD > 0.0) return vec4(0.0);

  // Lead came lines separating individual colored panes.
  float lead = 0.0;
  lead = max(lead, smoothstep(0.025, 0.010, abs(xy.x)));
  lead = max(lead, smoothstep(0.025, 0.010, abs(xy.y - 1.06)));
  lead = max(lead, smoothstep(0.020, 0.008, abs(xy.y - 0.65)));
  lead = max(lead, smoothstep(0.020, 0.008, abs(abs(xy.x) - 0.34)));

  float rRose = length(xy - vec2(0.0, 1.50));
  lead = max(lead, smoothstep(0.026, 0.010, abs(rRose - 0.25)));
  if (rRose < 0.25) {
    float ra = atan(xy.y - 1.50, xy.x);
    float spoke = abs(sin(ra * 3.0)) * rRose;
    lead = max(lead, smoothstep(0.018, 0.007, spoke));
  }

  // Rich jewel-toned spectral filters: ruby, cathedral cobalt, golden amber, emerald!
  const vec3 RUBY    = vec3(1.00, 0.05, 0.10);
  const vec3 COBALT  = vec3(0.06, 0.26, 1.00);
  const vec3 AMBER   = vec3(1.00, 0.56, 0.03);
  const vec3 EMERALD = vec3(0.04, 0.88, 0.32);
  const vec3 MAGENTA = vec3(0.92, 0.08, 0.52);

  vec3 glass;
  if (rRose < 0.25) {
    glass = (rRose < 0.11) ? RUBY : AMBER;
  } else if (xy.y > 1.06) {
    glass = (xy.x < 0.0) ? COBALT : MAGENTA;
  } else if (xy.y > 0.65) {
    if (xy.x < -0.34)      glass = RUBY;
    else if (xy.x < 0.0)   glass = AMBER;
    else if (xy.x < 0.34)  glass = EMERALD;
    else                   glass = COBALT;
  } else {
    if (xy.x < -0.34)      glass = COBALT;
    else if (xy.x < 0.0)   glass = RUBY;
    else if (xy.x < 0.34)  glass = AMBER;
    else                   glass = EMERALD;
  }

  float rip = 0.86 + 0.24 * noise2(xy * 11.0);
  return vec4(glass * rip * (1.0 - lead * 0.96), 1.0 - lead * 0.96);
}

// Rich golden-hour twilight backdrop (screen-space gradient so camera pitch always frames warm horizon glow).
vec3 evalSky(vec3 rd, vec2 screenUv, vec3 lightDir) {
  float h = clamp(screenUv.y, 0.0, 1.0);
  vec3 cZen = vec3(0.06, 0.11, 0.25);
  vec3 cMid = vec3(0.14, 0.22, 0.40);
  vec3 cHor = vec3(0.38, 0.34, 0.44);
  vec3 cLow = vec3(0.09, 0.13, 0.25);

  vec3 col = (h > 0.36)
    ? mix(cHor, mix(cMid, cZen, smoothstep(0.35, 1.0, (h - 0.36) / 0.64)), smoothstep(0.0, 0.72, (h - 0.36) / 0.64))
    : mix(cLow, cHor, smoothstep(0.0, 1.0, h / 0.36));

  float sDot = max(dot(normalize(rd), lightDir), 0.0);
  col += vec3(0.95, 0.52, 0.24) * pow(sDot, 5.0) * 0.44;
  col += vec3(1.00, 0.84, 0.56) * pow(sDot, 80.0) * 0.90;
  col += vec3(2.00, 1.70, 1.20) * smoothstep(0.996, 0.9992, sDot);
  return col;
}
`;

// ============================================================================
// PASS 1: Real orthographic depth shadow map from the sun's viewpoint
// ============================================================================
export const SHADOW_MAP_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform vec3 uLightDir;
uniform vec3 uLightRight;
uniform vec3 uLightUp;
uniform float uTime;

out vec4 outDepth;

${COMMON_GLSL}

void main() {
  vec2 lp = (vUv * 2.0 - 1.0) * SM_HALF;
  vec3 ro = SM_TARGET + uLightDir * 6.0 + uLightRight * lp.x + uLightUp * lp.y;
  vec3 rd = -uLightDir;

  float t = 0.1;
  float hitT = SM_FAR;
  for (int i = 0; i < 60; i++) {
    float h = mapOpaque(ro + rd * t, uTime, true).x;
    if (h < 0.0028) {
      hitT = t;
      break;
    }
    t += max(0.005, h * 0.82);
    if (t > SM_FAR) break;
  }

  outDepth = vec4(packDepth16(hitT, SM_FAR), 0.0, 1.0);
}
`;

// ============================================================================
// PASS 2: Camera SDF G-buffer (Albedo + MatID, 16-bit Depth + OctNormal)
// ============================================================================
export const GBUFFER_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;

layout(location = 0) out vec4 outAlbedoMat;
layout(location = 1) out vec4 outDepthNorm;

${COMMON_GLSL}

// Includes the stained-glass pane (mat 5) for camera rays so the Gothic window is visible.
vec2 mapCameraScene(vec3 p) {
  vec2 res = mapOpaque(p, uTime, true);
  vec3 ap = toArchLocal(p);
  float openD = sdGothicOpening(ap.xy);
  float dGlass = max(openD, abs(ap.z) - 0.016);
  res = opU(res, vec2(dGlass, 5.0));
  return res;
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.0022;
  return normalize(
    k.xyy * mapCameraScene(p + k.xyy * h).x +
    k.yyx * mapCameraScene(p + k.yyx * h).x +
    k.yxy * mapCameraScene(p + k.yxy * h).x +
    k.xxx * mapCameraScene(p + k.xxx * h).x
  );
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  float hitT = 31.9;
  float hitMat = 0.0;

  vec3 oc = ro - vec3(0.0, 0.55, 0.0);
  float b = dot(oc, rd);
  float disc = b * b - (dot(oc, oc) - 4.15 * 4.15);
  if (disc > 0.0) {
    float t = max(0.05, -b - sqrt(disc));
    float tMax = min(22.0, -b + sqrt(disc));
    for (int i = 0; i < 76; i++) {
      vec2 h = mapCameraScene(ro + rd * t);
      if (h.x < 0.0020) { hitT = t; hitMat = h.y; break; }
      t += h.x * 0.76;
      if (t > tMax) break;
    }
  }

  vec3 albedo = vec3(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);

  if (hitMat > 0.5) {
    vec3 pos = ro + rd * hitT;
    n = calcNormal(pos);

    if (hitMat < 1.5) {
      // Warm golden-sandstone travertine pavers with sundial rings (mid-high value so shadows & stained glass pop!).
      float topMask = smoothstep(0.65, 0.92, n.y) * smoothstep(-0.04, 0.01, pos.y);
      vec2 gv = pos.xz * 1.45;
      vec2 cid = floor(gv), cf = fract(gv);
      float grout = smoothstep(0.018, 0.042, min(cf.x, 1.0 - cf.x)) * smoothstep(0.018, 0.042, min(cf.y, 1.0 - cf.y));
      float r = length(pos.xz);
      float dialRing = smoothstep(0.012, 0.028, abs(r - 1.78)) * smoothstep(0.012, 0.028, abs(r - 2.40));
      float grain = 0.92 + 0.14 * noise2(pos.xz * 7.5) + 0.08 * hash21(cid);
      vec3 topCol = mix(vec3(0.42, 0.36, 0.30), vec3(0.68, 0.62, 0.53) * grain, grout * (0.35 + 0.65 * dialRing));
      vec3 rimCol = vec3(0.42, 0.37, 0.32) * (0.86 + 0.24 * noise2(vec2(atan(pos.z, pos.x) * 8.0, pos.y * 6.0)));
      vec3 cragCol = vec3(0.20, 0.22, 0.28) * (0.80 + 0.34 * noise2(pos.xz * 4.5 + pos.y * 3.0));
      albedo = mix(mix(cragCol, rimCol, smoothstep(-0.40, -0.05, pos.y)), topCol, topMask);
    } else if (hitMat < 2.5) {
      // Carved cream limestone blocks for arch, pedestal, column & step.
      float by = fract(pos.y * 3.6);
      float bx = fract((pos.x + pos.z) * 2.2 + mod(floor(pos.y * 3.6), 2.0) * 0.5);
      float mortar = smoothstep(0.022, 0.055, min(by, 1.0 - by)) * smoothstep(0.022, 0.055, min(bx, 1.0 - bx));
      float tone = 0.90 + 0.16 * hash21(vec2(floor(pos.y * 3.6), floor((pos.x + pos.z) * 2.2)));
      albedo = mix(vec3(0.36, 0.32, 0.28), vec3(0.66, 0.61, 0.53) * tone, mortar);
    } else if (hitMat < 3.5) {
      // Brushed antique brass astrolabe.
      albedo = vec3(0.84, 0.60, 0.22);
    } else if (hitMat < 4.5) {
      // Foreground orb (matte marble in early eras, clear refractive crystal in 2026).
      albedo = vec3(0.62, 0.68, 0.74);
    } else {
      // Gothic stained-glass pane color encoded directly into albedo.
      vec3 ap = toArchLocal(pos);
      vec4 sg = evalStainedGlass(ap.xy);
      albedo = mix(vec3(0.06, 0.06, 0.08), sg.rgb, sg.a);
    }
  }

  outAlbedoMat = vec4(clamp(albedo, 0.0, 1.0), hitMat / 10.0);
  outDepthNorm = vec4(packDepth16(hitT, 32.0), encodeOctNormal(n));
}
`;

// ============================================================================
// PASS 3: All 8 Shadow Eras + Colored Stained-Glass Transmission + GI Bounce
// ============================================================================
export const LIGHTING_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uTexAlbedoMat;
uniform sampler2D uTexDepthNorm;
uniform sampler2D uTexShadowLow;
uniform sampler2D uTexShadowHi;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;

uniform vec3 uLightDir;
uniform vec3 uLightRight;
uniform vec3 uLightUp;
uniform float uLightRadius; // 0.070 (medium sun) .. 0.145 (wide area sun)
uniform float uShowTexelGrid;

uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;

layout(location = 0) out vec4 outHdr;
layout(location = 1) out vec4 outBloom;

${COMMON_GLSL}

const vec2 POISSON_16[16] = vec2[16](
  vec2(-0.9420, -0.3990), vec2( 0.9456, -0.7689), vec2(-0.0942, -0.9294), vec2( 0.3449,  0.2939),
  vec2(-0.9159,  0.4577), vec2(-0.8154, -0.8791), vec2(-0.3828,  0.2768), vec2( 0.9748,  0.7565),
  vec2( 0.4432, -0.9751), vec2( 0.5374, -0.4737), vec2(-0.2650, -0.4189), vec2( 0.7920,  0.1909),
  vec2(-0.2419,  0.9971), vec2(-0.8141,  0.9144), vec2( 0.1998,  0.7864), vec2( 0.1438, -0.1410)
);

// Project world position into the orthographic sun camera (xy = [0,1] uv, z = depth in world units).
vec3 projectToShadowMap(vec3 pos) {
  vec3 rel = pos - SM_TARGET;
  vec2 uv = vec2(dot(rel, uLightRight), dot(rel, uLightUp)) / (2.0 * SM_HALF) + 0.5;
  float depth = 6.0 - dot(rel, uLightDir);
  return vec3(uv, depth);
}

// Step 1 (1988): Circular blob shadows glued onto y = 0 directly beneath objects.
float evalBlobShadow(vec3 pos) {
  if (abs(pos.y) > 0.04) return 1.0;
  float s = 1.0;
  s = min(s, smoothstep(0.24, 0.72, length(pos.xz - HERO_POS.xz)));
  s = min(s, smoothstep(0.18, 0.52, length(pos.xz - COL_POS.xz)));
  s = min(s, smoothstep(0.18, 0.44, length(pos.xz - ORB_POS.xz)));
  vec3 moon = getMoonPos(uTime);
  s = min(s, mix(0.35, 1.0, smoothstep(0.05, 0.25, length(pos.xz - moon.xz))));
  vec3 ap = toArchLocal(pos);
  float dArchBlob = length(vec2(max(0.0, abs(ap.x) - 0.85), ap.z));
  s = min(s, smoothstep(0.14, 0.58, dArchBlob));
  return mix(0.14, 1.0, s);
}

// Unified shadow raymarcher (angularR <= 0 => razor-sharp hard shadow; > 0 => Quilez cone soft shadow).
// Merging both paths into one loop avoids duplicating mapOpaque in Metal/ANGLE JIT -> ~5x faster compile!
float traceShadowRay(vec3 ro, vec3 rd, float angularR, bool includeOrb) {
  float res = 1.0;
  float ph = 1e10;
  float t = 0.028;
  for (int i = 0; i < 56; i++) {
    float h = mapOpaque(ro + rd * t, uTime, includeOrb).x;
    if (h < 0.0018) return 0.0;
    if (angularR > 0.0) {
      float y = h * h / (2.0 * ph);
      float d = sqrt(max(0.0, h * h - y * y));
      res = min(res, d / max(1e-4, angularR * max(0.0, t - y)));
      ph = h;
      t += clamp(h, 0.015, 0.26);
      if (res < 0.004 || t > 6.8) break;
    } else {
      t += max(0.004, h * 0.80);
      if (t > 6.8) break;
    }
  }
  return (angularR > 0.0) ? smoothstep(0.0, 1.0, clamp(res, 0.0, 1.0)) : 1.0;
}

// Step 4 (2004): Real 88x88 nearest-sampled hard shadow map.
float evalHardShadowMap(vec3 pos, vec3 n, out float texelEdge) {
  texelEdge = 0.0;
  vec3 sc = projectToShadowMap(pos + n * 0.032);
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0) return 1.0;
  vec2 cell = fract(sc.xy * 88.0);
  texelEdge = 1.0 - smoothstep(0.04, 0.11, min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y)));
  float dMap = unpackDepth16(texture(uTexShadowLow, sc.xy).rg, SM_FAR);
  return (sc.z - 0.055 <= dMap) ? 1.0 : 0.0;
}

// Step 5 (2008): Uniform-radius 16-tap Poisson PCF on 320x320 shadow map.
float evalPcfShadow(vec3 pos, vec3 n) {
  vec3 sc = projectToShadowMap(pos + n * 0.028);
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0) return 1.0;
  float ang = hash21(floor(gl_FragCoord.xy)) * 6.2831853;
  mat2 r = rot2(ang);
  float radius = (4.2 / 320.0) * (uLightRadius / 0.070);
  float lit = 0.0;
  for (int i = 0; i < 16; i++) {
    vec2 uv = sc.xy + (r * POISSON_16[i]) * radius;
    float dMap = unpackDepth16(texture(uTexShadowHi, uv).rg, SM_FAR);
    lit += (sc.z - 0.042 <= dMap) ? 1.0 : 0.0;
  }
  return lit / 16.0;
}

// Step 6 (2012): PCSS contact-hardening shadow (blocker search -> distance-scaled PCF).
float evalPcssShadow(vec3 pos, vec3 n) {
  vec3 sc = projectToShadowMap(pos + n * 0.025);
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0) return 1.0;
  float ang = hash21(floor(gl_FragCoord.xy)) * 6.2831853;
  mat2 r = rot2(ang);

  float searchR = (11.5 / 320.0) * clamp(uLightRadius / 0.070, 0.5, 2.2);
  float sumBlocker = 0.0;
  float numBlocker = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 uv = sc.xy + (r * POISSON_16[i]) * searchR;
    float dMap = unpackDepth16(texture(uTexShadowHi, uv).rg, SM_FAR);
    if (dMap < sc.z - 0.036) {
      sumBlocker += dMap;
      numBlocker += 1.0;
    }
  }
  if (numBlocker < 0.5) return 1.0;

  float avgBlocker = sumBlocker / numBlocker;
  float distFromBlocker = max(0.0, sc.z - avgBlocker);
  // Contact-hardening: razor-tight at column base, silky wide penumbra far across the courtyard!
  float filterR = clamp(distFromBlocker * uLightRadius * 0.28, 0.45 / 320.0, 15.0 / 320.0);

  float lit = 0.0;
  for (int i = 0; i < 16; i++) {
    vec2 uv = sc.xy + (r * POISSON_16[i]) * filterR;
    float dMap = unpackDepth16(texture(uTexShadowHi, uv).rg, SM_FAR);
    lit += (sc.z - 0.036 <= dMap) ? 1.0 : 0.0;
  }
  return lit / 16.0;
}

// 4-tap SDF ambient occlusion for architectural crevices (Steps 7 & 8).
float evalAO(vec3 pos, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 1; i <= 4; i++) {
    float h = 0.035 + 0.12 * float(i);
    float d = mapOpaque(pos + n * h, uTime, true).x;
    occ += (h - d) * sca;
    sca *= 0.62;
  }
  return clamp(1.0 - occ * 1.55, 0.14, 1.0);
}

// Step 8 (2026): Vivid cathedral stained-glass spectral transmission + contact-hardening penumbra!
vec3 evalStainedGlassTransmission(vec3 pos, vec3 lightDir, float lightAngularR) {
  vec3 ro = toArchLocal(pos);
  vec3 rd = lightDir;
  rd.xz = rot2(-ARCH_YAW) * rd.xz;
  if (abs(rd.z) < 0.04) return vec3(1.0);
  float t = -ro.z / rd.z;
  if (t <= 0.03 || t > 8.0) return vec3(1.0);

  vec2 hitXY = ro.xy + rd.xy * t;
  // Soften projected stained glass proportionally to distance * lightRadius.
  float blur = clamp(t * lightAngularR * 0.34, 0.004, 0.11);
  vec3 sumTint = vec3(0.0);
  float sumInGlass = 0.0;
  const vec2 OFF[5] = vec2[5](vec2(0.0), vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));
  for (int i = 0; i < 5; i++) {
    vec2 p2 = hitXY + OFF[i] * blur;
    float openD = sdGothicOpening(p2);
    if (openD < 0.0) {
      vec4 sg = evalStainedGlass(p2);
      // Saturated stained-glass light pouring onto travertine (luminous cathedral carpet!).
      sumTint += mix(vec3(0.02), sg.rgb * 2.55, sg.a);
      sumInGlass += 1.0;
    } else {
      sumTint += vec3(1.0);
    }
  }
  return (sumInGlass > 0.0) ? (sumTint / 5.0) : vec3(1.0);
}

// Step 8 (2026): Crystal orb translucent shadow + bright focused refractive lens caustic!
vec3 evalCrystalOrbTransmission(vec3 pos, vec3 lightDir, float lightAngularR) {
  vec3 oc = pos - ORB_POS;
  float b = dot(oc, lightDir);
  if (b >= 0.0) return vec3(1.0);
  float tHit = -b;
  vec3 closest = oc + lightDir * tHit;
  float rPerp = length(closest);
  float pen = max(0.016, tHit * lightAngularR * 0.85);

  float inShadow = 1.0 - smoothstep(ORB_R - pen, ORB_R + pen, rPerp);
  float focusR = 0.068 + pen * 0.30;
  float caustic = exp(-(rPerp * rPerp) / (focusR * focusR)) * smoothstep(0.05, 0.35, tHit) * smoothstep(3.2, 0.7, tHit);
  vec3 glassShadow = vec3(0.10, 0.32, 0.48);
  vec3 causticCol = vec3(0.60, 2.35, 2.55) * caustic;
  return mix(vec3(1.0), glassShadow, inShadow) + causticCol * (0.35 + 0.65 * inShadow);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  bool isLeft = (uWipeX <= 0.001) ? false : ((uWipeX >= 0.999) ? true : (vUv.x < uWipeX));
  int st = isLeft ? uStageLeft : uStageRight;

  vec4 am = texture(uTexAlbedoMat, vUv);
  vec4 dn = texture(uTexDepthNorm, vUv);
  float hitMat = am.a * 10.0;
  float hitT = unpackDepth16(dn.rg, 32.0);

  vec3 col = evalSky(rd, vUv, uLightDir);
  vec3 bloom = vec3(0.0);

  if (hitMat > 0.5) {
    vec3 pos = ro + rd * hitT;
    vec3 n = decodeOctNormal(dn.ba);
    vec3 v = -rd;
    vec3 albedo = am.rgb;

    // Gothic stained-glass pane itself (mat 5): deep backlit jewel colors without white-washing.
    if (hitMat > 4.5) {
      vec3 ap = toArchLocal(pos);
      vec4 sg = evalStainedGlass(ap.xy);
      float sunBack = 0.65 + 0.35 * max(dot(-uLightDir, rd), 0.0);
      if (st == 7) {
        col = mix(vec3(0.03, 0.03, 0.04), sg.rgb * (1.25 + 0.55 * sunBack), sg.a);
        bloom += sg.rgb * sg.a * 0.52;
      } else {
        vec3 bg = evalSky(rd, vUv, uLightDir);
        col = mix(vec3(0.05, 0.05, 0.07), mix(bg * 0.65, sg.rgb * 0.42, 0.55), sg.a);
      }
    } else {
      float ndl = max(dot(n, uLightDir), 0.0);
      vec3 sunCol = vec3(1.62, 1.32, 0.90);
      vec3 shadowTint = vec3(1.0);
      float texelEdge = 0.0;
      vec3 rayStart = pos + n * 0.022 + uLightDir * 0.010;

      // Evaluate the active shadow era!
      if (st == 0) {
        float sh = (isLeft && uWipeX > 0.005 && uStageLeft == 0 && uStageRight == 0) ? 1.0 : evalBlobShadow(pos);
        shadowTint = vec3(sh);
      } else if (st == 1) {
        float sh = 1.0;
        if (hitMat < 1.5 && abs(pos.y) < 0.025 && n.y > 0.8) {
          sh = traceShadowRay(pos + vec3(0.0, 0.018, 0.0), uLightDir, 0.0, true);
        }
        shadowTint = vec3(sh);
      } else if (st == 2) {
        float sh = (ndl > 0.002) ? traceShadowRay(rayStart, uLightDir, 0.0, true) : 0.0;
        shadowTint = vec3(sh);
      } else if (st == 3) {
        float sh = (ndl > 0.002) ? evalHardShadowMap(pos, n, texelEdge) : 0.0;
        shadowTint = vec3(sh);
      } else if (st == 4) {
        float sh = (ndl > 0.002) ? evalPcfShadow(pos, n) : 0.0;
        shadowTint = vec3(sh);
      } else if (st == 5) {
        float sh = (ndl > 0.002) ? evalPcssShadow(pos, n) : 0.0;
        shadowTint = vec3(sh);
      } else if (st == 6) {
        float sh = (ndl > 0.002) ? traceShadowRay(rayStart, uLightDir, uLightRadius, true) : 0.0;
        shadowTint = vec3(sh);
      } else {
        float sh = (ndl > 0.002) ? traceShadowRay(rayStart, uLightDir, uLightRadius, false) : 0.0;
        vec3 glassTrans = evalStainedGlassTransmission(rayStart, uLightDir, uLightRadius);
        vec3 orbTrans = (hitMat > 3.5 && hitMat < 4.5) ? vec3(1.0) : evalCrystalOrbTransmission(rayStart, uLightDir, uLightRadius);
        shadowTint = vec3(sh) * glassTrans * orbTrans;
      }

      float metal = (hitMat > 2.5 && hitMat < 3.5) ? 0.85 : 0.0;
      float rough = (hitMat > 2.5 && hitMat < 3.5) ? 0.22 : 0.78;
      float ao = (st >= 6) ? evalAO(pos, n) : 1.0;

      // Crisp shadow contrast: dark neutral ambient in 1988-2012 -> rich blue sky fill + AO in 2018-2026!
      vec3 ambCol;
      if (st <= 2) {
        ambCol = vec3(0.085, 0.090, 0.105);
      } else if (st <= 5) {
        ambCol = mix(vec3(0.08, 0.095, 0.125), vec3(0.14, 0.16, 0.20), n.y * 0.5 + 0.5);
      } else {
        vec3 skyFill = mix(vec3(0.06, 0.09, 0.16), vec3(0.16, 0.27, 0.48), n.y * 0.5 + 0.5);
        ambCol = skyFill * ao;
      }

      vec3 H = normalize(uLightDir + v);
      float specPow = mix(24.0, 128.0, 1.0 - rough);
      float spec = pow(max(dot(n, H), 0.0), specPow) * mix(0.10, 1.75, metal);

      vec3 direct = (albedo * (1.0 - metal * 0.72) * ndl + mix(vec3(1.0), albedo, metal) * spec) * sunCol * shadowTint;
      vec3 indirect = albedo * ambCol * (1.0 - metal * 0.55);

      // Step 8 (2026): Warm stone bounce GI + stained-glass color bounce onto shaded nearby geometry!
      if (st == 7) {
        float floorBounceMask = smoothstep(2.2, 0.0, pos.y) * clamp(0.55 - n.y * 0.55, 0.0, 1.0);
        indirect += albedo * vec3(0.28, 0.20, 0.11) * floorBounceMask * ao * 0.85;

        // Colored GI bounce radiating from the stained-glass light carpet onto pedestal, arch & column.
        vec2 carpetCenter = ARCH_POS.xz + (-uLightDir.xz / max(0.22, uLightDir.y)) * 1.05;
        vec3 toCarpet = vec3(carpetCenter.x, 0.04, carpetCenter.y) - pos;
        float distC = length(toCarpet);
        float faceC = max(0.0, dot(n, toCarpet / max(0.001, distC)) * 0.65 + 0.35);
        vec3 glassBounceTint = mix(vec3(1.00, 0.22, 0.24), vec3(0.18, 0.48, 1.00), smoothstep(-0.4, 0.8, pos.x));
        indirect += albedo * glassBounceTint * (faceC / (0.38 + distC * distC * 1.10)) * ao * 0.42;
      }

      col = indirect + direct;

      // Metallic golden-hour sky reflection on the brass astrolabe.
      if (metal > 0.5) {
        vec3 refl = evalSky(reflect(-v, n), vUv, uLightDir);
        float fres = 0.25 + 0.75 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
        col += refl * albedo * fres * (st >= 6 ? 0.65 : 0.32);
        if (st >= 6) bloom += sunCol * albedo * max(0.0, spec - 0.50) * shadowTint * 0.60;
      }

      // Step 8 (2026): True clear refractive aquamarine crystal lens on the foreground orb!
      if (st == 7 && hitMat > 3.5 && hitMat < 4.5) {
        float cosT = clamp(dot(n, v), 0.0, 1.0);
        float fres = 0.04 + 0.96 * pow(1.0 - cosT, 3.6);
        vec3 envRefl = evalSky(reflect(-v, n), vUv, uLightDir) * 1.35;
        vec3 refrDir = refract(rd, n, 1.0 / 1.50);
        vec3 refrCol = evalSky(refrDir, vUv, uLightDir) * vec3(0.55, 0.92, 1.00);
        if (refrDir.y < -0.02) {
          float tf = -pos.y / refrDir.y;
          vec2 fxz = pos.xz + refrDir.xz * tf;
          vec2 gv = fract(fxz * 1.45);
          float gr = smoothstep(0.02, 0.06, min(gv.x, 1.0 - gv.x)) * smoothstep(0.02, 0.06, min(gv.y, 1.0 - gv.y));
          refrCol = mix(vec3(0.08, 0.22, 0.30), vec3(0.28, 0.78, 0.86), gr) * smoothstep(3.0, 0.6, length(fxz));
        }
        // Internal back-lit cyan caustic glow + razor sun highlight!
        float backGlow = pow(max(dot(v, -uLightDir + n * 0.35), 0.0), 3.0);
        float crystalSpec = pow(max(dot(n, H), 0.0), 280.0) * 5.5;
        col = mix(refrCol * (0.70 + 0.45 * cosT) + vec3(0.06, 0.65, 0.82) * backGlow * 0.95, envRefl, fres) + sunCol * crystalSpec;
        bloom += sunCol * max(0.0, crystalSpec - 0.9) * 0.75 + vec3(0.12, 0.75, 0.92) * backGlow * 0.25;
      }

      // Step 8 bloom on super-bright stained-glass & crystal caustic hotspots on the floor.
      if (st == 7) {
        float peakL = max(col.r, max(col.g, col.b));
        if (peakL > 1.05) bloom += col * (peakL - 1.05) * 0.34;
      }

      // Optional educational Texel Grid overlay on Step 4 (Hard Shadow Map).
      if (st == 3 && uShowTexelGrid > 0.5 && shadowTint.x < 0.5 && hitMat < 2.5) {
        col = mix(col, vec3(0.96, 0.70, 0.24), texelEdge * 0.62);
      }
    }
  }

  outHdr = vec4(max(col, vec3(0.0)), 1.0);
  outBloom = vec4(max(bloom, vec3(0.0)), 1.0);
}
`;

// ============================================================================
// PASS 4 & 5: Separable Gaussian HDR Bloom + ACES Tone Mapping
// ============================================================================
export const BLUR_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 outColor;

void main() {
  const float w[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 acc = texture(uTex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDir * float(i) * 1.7;
    acc += (texture(uTex, vUv + off).rgb + texture(uTex, vUv - off).rgb) * w[i];
  }
  outColor = vec4(acc, 1.0);
}
`;

export const FINAL_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTexHdr;
uniform sampler2D uTexBloom;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;
out vec4 outColor;

vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  bool isLeft = (uWipeX <= 0.001) ? false : ((uWipeX >= 0.999) ? true : (vUv.x < uWipeX));
  int st = isLeft ? uStageLeft : uStageRight;
  vec3 hdr = texture(uTexHdr, vUv).rgb;
  vec3 blm = (st >= 6) ? texture(uTexBloom, vUv).rgb : vec3(0.0);
  outColor = vec4(pow(clamp(acesFilm((hdr + blm * 0.60) * 1.08), 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;
