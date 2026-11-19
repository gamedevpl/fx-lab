// GLSL ES 3.00 shaders for Evolution of Fire:
// Pass 1: SDF stone hearth courtyard with split dynamic firelight GI & 16-bit depth.
// Pass 2: All 8 fire rendering eras + HDR bloom extraction.
// Pass 3: Separable Gaussian bloom blur.
// Pass 4: Unified ACES filmic tone mapping.

export const SCENE_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform float uFireIntensityLeft;
uniform float uFireIntensityRight;
uniform float uWipeX;
uniform vec3 uFireColor;
uniform vec3 uColliderPos;
uniform float uColliderActive;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z
  );
}

float sdCylinder(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Floating medieval hearth courtyard SDF (material ids: 1=plinth, 2=wall, 3=ring stones, 4=logs, 5=embers, 6=collider).
vec2 mapScene(vec3 p) {
  vec2 res = vec2(1e5, 0.0);

  // Stone courtyard plinth + tapered floating crag
  {
    float dTop = sdCylinder(p - vec3(0.0, -0.15, 0.0), 1.66, 0.15) - 0.025;
    float cragY = clamp((-p.y - 0.22) / 1.50, 0.0, 1.0);
    float cragR = 1.60 * pow(1.0 - cragY, 0.72) + 0.06 * sin(atan(p.z, p.x) * 6.0 + p.y * 3.5);
    float dCrag = max(length(p.xz) - max(0.05, cragR), max(p.y + 0.20, -1.68 - p.y));
    float dIsland = min(dTop, dCrag);
    float ph = uTime * 0.185;
    float s1 = length(p - vec3(-1.46, -0.72 + 0.08 * sin(ph * 2.0 + 0.4),  0.72)) - 0.17;
    float s2 = length(p - vec3( 1.52, -0.86 + 0.07 * sin(ph * 3.0 + 2.1), -0.45)) - 0.14;
    dIsland = min(dIsland, min(s1, s2));
    if (dIsland < res.x) res = vec2(dIsland, 1.0);
  }

  // Curved brick backdrop wall (shows off heat haze and firelight GI)
  {
    float r = length(p.xz);
    float ang = atan(p.x, -p.z);
    float dArc = abs(r - 1.34) - 0.15;
    float wallH = 1.92 + 0.08 * smoothstep(-0.2, 0.2, cos(ang * 7.0));
    float dWall = max(max(dArc, max(p.y - wallH, -p.y)), (abs(ang) - 1.08) * r) - 0.015;
    if (dWall < res.x) res = vec2(dWall, 2.0);
  }

  // 10 chiseled hearth ring stones
  {
    float ang = atan(p.z, p.x);
    float sector = 6.2831853 / 10.0;
    float aLocal = mod(ang + sector * 0.5, sector) - sector * 0.5;
    float r = length(p.xz);
    vec3 q = vec3(cos(aLocal) * r - 0.68, p.y - 0.11, sin(aLocal) * r);
    vec3 b = abs(q) - vec3(0.11, 0.095, 0.16);
    float dStone = length(max(b, 0.0)) + min(max(b.x, max(b.y, b.z)), 0.0) - 0.045 + 0.014 * (noise3(p * 8.5) - 0.5);
    if (dStone < res.x) res = vec2(dStone, 3.0);
  }

  // Charred campfire oak logs
  {
    float l1 = sdCapsule(p, vec3(-0.44, 0.07,  0.34), vec3( 0.12, 0.54, -0.10), 0.092);
    float l2 = sdCapsule(p, vec3( 0.42, 0.08,  0.30), vec3(-0.10, 0.52, -0.12), 0.088);
    float l3 = sdCapsule(p, vec3(-0.14, 0.07, -0.44), vec3( 0.10, 0.48,  0.14), 0.088);
    float l4 = sdCapsule(p, vec3( 0.32, 0.06, -0.32), vec3(-0.22, 0.30,  0.22), 0.082);
    float dLogs = min(min(l1, l2), min(l3, l4));
    if (dLogs < res.x) res = vec2(dLogs, 4.0);
  }

  // Glowing coal bed
  {
    float dEmb = length((p - vec3(0.0, 0.04, 0.0)) * vec3(1.0, 2.5, 1.0)) - 0.54;
    if (dEmb < res.x) res = vec2(dEmb, 5.0);
  }

  // Step 8 brushed-iron collider sphere
  if (uColliderActive > 0.5) {
    float dCol = length(p - uColliderPos) - 0.25;
    if (dCol < res.x) res = vec2(dCol, 6.0);
  }

  return res;
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.0028, 0.0);
  return normalize(vec3(
    mapScene(p + e.xyy).x - mapScene(p - e.xyy).x,
    mapScene(p + e.yxy).x - mapScene(p - e.yxy).x,
    mapScene(p + e.yyx).x - mapScene(p - e.yyx).x
  ));
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float sh = 1.0, t = mint;
  for (int i = 0; i < 16; i++) {
    float h = mapScene(ro + rd * t).x;
    sh = min(sh, clamp(k * h / t, 0.0, 1.0));
    t += clamp(h, 0.04, 0.25);
    if (sh < 0.02 || t > maxt) break;
  }
  return sh;
}

vec3 evalSky(vec2 uv) {
  vec3 cTop = vec3(0.08, 0.12, 0.25);
  vec3 cMid = vec3(0.16, 0.24, 0.42);
  vec3 cHor = vec3(0.30, 0.40, 0.58);
  vec3 cLow = vec3(0.12, 0.17, 0.33);
  vec3 col = (uv.y > 0.30)
    ? mix(cHor, mix(cMid, cTop, smoothstep(0.32, 1.0, clamp((uv.y - 0.30) / 0.70, 0.0, 1.0))), smoothstep(0.0, 0.78, clamp((uv.y - 0.30) / 0.70, 0.0, 1.0)))
    : mix(cLow, cHor, smoothstep(0.0, 1.0, clamp(uv.y / 0.30, 0.0, 1.0)));

  vec2 g = uv * vec2(26.0 * uAspect, 26.0);
  vec2 cid = floor(g), f = fract(g) - 0.5;
  float sh = fract(sin(dot(cid, vec2(127.1, 311.7))) * 43758.5453);
  if (sh > 0.962 && uv.y > 0.46) {
    float tw = 0.55 + 0.45 * sin(uTime * 1.45 + sh * 90.0);
    col += vec3(0.95, 0.90, 0.75) * exp(-dot(f, f) * 28.0) * tw * 0.65;
  }
  return col;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  vec3 oc = ro - vec3(0.0, 0.30, 0.0);
  float b = dot(oc, rd);
  float disc = b * b - (dot(oc, oc) - 3.4 * 3.4);
  vec3 col = evalSky(vUv);
  float hitDist = 31.9, hitMat = 0.0;

  if (disc > 0.0) {
    float t = max(0.2, -b - sqrt(disc));
    float tMax = min(22.0, -b + sqrt(disc));
    for (int i = 0; i < 64; i++) {
      vec2 h = mapScene(ro + rd * t);
      if (h.x < 0.0024) {
        hitDist = t;
        hitMat = h.y;
        break;
      }
      t += h.x * 0.88;
      if (t > tMax) break;
    }
  }

  float fireGI = (uWipeX <= 0.001)
    ? uFireIntensityRight
    : ((uWipeX >= 0.999) ? uFireIntensityLeft : (vUv.x < uWipeX ? uFireIntensityLeft : uFireIntensityRight));

  if (hitMat > 0.5) {
    vec3 pos = ro + rd * hitDist;
    vec3 n = calcNormal(pos);
    vec3 v = -rd;
    vec3 albedo = vec3(0.18, 0.21, 0.29);
    vec3 emissive = vec3(0.0);
    float rough = 0.78, metal = 0.0;

    if (hitMat < 1.5) {
      float topMask = smoothstep(0.45, 0.85, n.y) * smoothstep(-0.08, 0.02, pos.y);
      float rad = length(pos.xz), ringIdx = floor(rad * 3.6);
      float angDiv = max(6.0, ringIdx * 5.0), ang = atan(pos.z, pos.x);
      float fx = fract(rad * 3.6);
      float fy = fract((ang / 6.2831853 + 0.5) * angDiv + mod(ringIdx, 2.0) * 0.5);
      float mortar = smoothstep(0.03, 0.08, min(fx, 1.0 - fx)) * smoothstep(0.03, 0.08, min(fy, 1.0 - fy));
      float tileTone = hash31(vec3(ringIdx, floor((ang / 6.2831853 + 0.5) * angDiv), 4.0));
      vec3 flagstone = mix(vec3(0.10, 0.12, 0.18), vec3(0.22, 0.24, 0.32) * (0.75 + 0.45 * tileTone), mortar) * (0.85 + 0.3 * noise3(pos * 14.0));
      vec3 cragStone = vec3(0.11, 0.13, 0.21) * (0.75 + 0.45 * noise3(pos * 6.0));
      albedo = mix(cragStone, flagstone, topMask);
      float puddle = smoothstep(0.50, 0.68, noise3(pos * 2.2 + vec3(2.4, 0.0, 1.1))) * topMask * mortar;
      rough = mix(0.76, 0.10, puddle);
    } else if (hitMat < 2.5) {
      float ang = atan(pos.x, -pos.z), row = floor(pos.y * 5.2);
      float bx = fract(ang * 4.5 + mod(row, 2.0) * 0.5), by = fract(pos.y * 5.2);
      float mortar = smoothstep(0.04, 0.09, min(bx, 1.0 - bx)) * smoothstep(0.06, 0.12, min(by, 1.0 - by));
      float bTone = hash31(vec3(floor(ang * 4.5 + mod(row, 2.0) * 0.5), row, 2.0));
      vec3 brick = mix(vec3(0.13, 0.15, 0.22), vec3(0.25, 0.27, 0.35), bTone) * (0.82 + 0.36 * noise3(pos * 16.0));
      albedo = mix(vec3(0.06, 0.07, 0.12), brick, mortar);
      rough = mix(0.90, 0.48, mortar);
    } else if (hitMat < 3.5) {
      float soot = smoothstep(0.76, 0.54, length(pos.xz));
      albedo = mix(vec3(0.16, 0.18, 0.25), vec3(0.28, 0.29, 0.36), noise3(pos * 11.0)) * mix(1.0, 0.35, soot);
      rough = 0.62;
    } else if (hitMat < 4.5) {
      float bark = noise3(pos * 20.0);
      float nearFire = smoothstep(0.55, 0.10, length(pos.xz));
      albedo = mix(vec3(0.14, 0.09, 0.06), vec3(0.035, 0.03, 0.03), nearFire * 0.90) * (0.7 + 0.5 * bark);
      rough = 0.86;
      float crack = smoothstep(0.62, 0.76, noise3(pos * 24.0 + vec3(0.0, uTime * 0.45, 0.0)));
      emissive = vec3(2.2, 0.45, 0.05) * crack * nearFire * (0.30 + 0.70 * clamp(fireGI, 0.0, 1.2));
    } else if (hitMat < 5.5) {
      float ch = noise3(pos * 18.0 + vec3(0.0, uTime * 0.3, 0.0));
      albedo = vec3(0.04, 0.03, 0.03);
      emissive = mix(vec3(1.1, 0.18, 0.02), vec3(3.0, 0.95, 0.16), smoothstep(0.32, 0.76, ch)) * (0.35 + 0.75 * clamp(fireGI, 0.0, 1.3));
    } else {
      albedo = vec3(0.24, 0.27, 0.34);
      rough = 0.20;
      metal = 0.92;
    }

    vec3 moonDir = normalize(vec3(-0.62, 0.76, 0.45));
    float moonNdl = max(0.0, dot(n, moonDir));
    float moonSh = softShadow(pos + n * 0.02, moonDir, 0.05, 4.0, 6.0);
    vec3 skyAmb = mix(vec3(0.06, 0.08, 0.16), vec3(0.18, 0.24, 0.38), n.y * 0.5 + 0.5);
    vec3 lit = albedo * (skyAmb * 0.95 + vec3(0.42, 0.52, 0.78) * moonNdl * moonSh * 0.82);

    // Dynamic flickering fire point light + specular reflection on wet cobblestones.
    vec3 firePos = vec3(0.07 * sin(uTime * 11.5), 0.78 + 0.09 * cos(uTime * 15.3), 0.07 * cos(uTime * 9.2));
    vec3 fVec = firePos - pos;
    float fDist = length(fVec);
    vec3 fDir = fVec / max(0.01, fDist);
    float fNdl = max(0.0, dot(n, fDir));
    float fAtten = 1.0 / (0.28 + 0.95 * fDist * fDist);
    float fSh = softShadow(pos + n * 0.025, fDir, 0.06, min(fDist - 0.04, 3.6), 5.0);
    float specPow = mix(96.0, 10.0, rough);
    float spec = pow(max(0.0, dot(n, normalize(fDir + v))), specPow) * mix(2.6, 0.10, rough);
    vec3 fRad = uFireColor * fireGI * fAtten * (0.22 + 0.78 * fSh) * 1.85;
    lit += (albedo * (1.0 - metal * 0.75) * fNdl + mix(vec3(1.0, 0.65, 0.28), albedo, metal * 0.4) * spec) * fRad;
    lit += mix(vec3(0.55, 0.68, 0.95), albedo, metal) * pow(max(0.0, dot(n, normalize(moonDir + v))), specPow) * mix(0.9, 0.05, rough) * moonSh;

    col = lit + emissive;
  }

  float dNorm = clamp(hitDist / 32.0, 0.0, 0.9999);
  outColor = vec4(col, 1.0);
  outDepth = vec4(floor(dNorm * 255.0) / 255.0, fract(dNorm * 255.0), hitMat / 10.0, 1.0);
}
`;

export const FIRE_FS = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;

uniform sampler2D uTexScene;
uniform sampler2D uTexDepth;
uniform sampler2D uTexPalIdx;
uniform sampler2D uTexDoom;
uniform sampler2D uTexSprite;
uniform sampler2D uTexFlipA;
uniform sampler2D uTexFlipB;
uniform sampler2D uTexFlipC;
uniform sampler3D uTexFluid3D;

uniform vec3 uClut16[16];
uniform vec3 uDoomPal[37];
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;

uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;
uniform float uClutIndexOnly;
uniform float uQuadWire;
uniform float uSparseGridFlash;

layout(location = 0) out vec4 outHdr;
layout(location = 1) out vec4 outBloom;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z
  );
}

float fbm3(vec3 p) {
  float s = 0.0, a = 0.52;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.08 + vec3(13.1, -7.4, 5.7);
    a *= 0.48;
  }
  return s;
}

// Physical Kelvin blackbody curve (~1100K deep crimson -> ~4100K incandescent core).
vec3 blackbodyHDR(float temp01) {
  float t = clamp(temp01, 0.0, 1.35);
  if (t < 0.08) return vec3(0.0);
  vec3 c1 = vec3(0.85, 0.03, 0.002);
  vec3 c2 = vec3(2.10, 0.26, 0.012);
  vec3 c3 = vec3(3.60, 1.35, 0.12);
  vec3 c4 = vec3(5.80, 4.40, 2.30);
  vec3 col = mix(c1, c2, smoothstep(0.08, 0.38, t));
  col = mix(col, c3, smoothstep(0.38, 0.72, t));
  col = mix(col, c4, smoothstep(0.72, 1.12, t));
  return col * smoothstep(0.08, 0.26, t);
}

bool intersectBillboard(vec3 ro, vec3 rd, vec3 centerW, vec2 halfSize, bool upright, out vec2 uvB, out float tHit) {
  vec3 bFwd = normalize(uCamPos - centerW);
  vec3 bRight = normalize(cross(vec3(0.0, 1.0, 0.0), bFwd));
  vec3 bUp = upright ? vec3(0.0, 1.0, 0.0) : normalize(cross(bFwd, bRight));
  float denom = dot(rd, bFwd);
  if (abs(denom) < 1e-4) return false;
  float t = dot(centerW - ro, bFwd) / denom;
  if (t <= 0.1) return false;
  vec3 hitP = ro + rd * t - centerW;
  float lx = dot(hitP, bRight) / halfSize.x;
  float ly = dot(hitP, bUp) / halfSize.y;
  if (abs(lx) > 1.0 || abs(ly) > 1.0) return false;
  uvB = vec2(lx * 0.5 + 0.5, ly * 0.5 + 0.5);
  tHit = t;
  return true;
}

vec2 intersectBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax) {
  vec3 invD = 1.0 / rd;
  vec3 t0 = (bMin - ro) * invD, t1 = (bMax - ro) * invD;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

void sampleFlipCell(int fIdx, vec2 uv, vec2 flowOff, out vec4 a, out vec4 b, out vec4 c) {
  int fi = ((fIdx % 16) + 16) % 16;
  int col = fi % 4, row = fi / 4;
  vec2 cuv = clamp(uv + flowOff, vec2(0.02), vec2(0.98));
  vec2 atlasUv = (vec2(float(col), float(row)) + cuv) / vec2(4.0, 4.0);
  a = texture(uTexFlipA, atlasUv);
  b = texture(uTexFlipB, atlasUv);
  c = texture(uTexFlipC, atlasUv);
}

// Procedural 3D heat & dense soot volume (Stages 5 & 6).
vec2 evalProceduralVolume(vec3 p, float t) {
  vec3 q = p - vec3(0.0, 0.14, 0.0);
  float h = clamp(q.y / 2.22, 0.0, 1.0);
  if (q.y < -0.04 || q.y > 2.34) return vec2(0.0);

  float ang = t * 0.185, rise = t * 2.35;
  vec3 warpP = q * vec3(2.4, 1.75, 2.4) - vec3(0.0, rise, 0.0) + vec3(cos(ang), 0.0, sin(ang)) * 0.40;
  float n1 = fbm3(warpP);
  float n2 = fbm3(q * vec3(4.8, 3.2, 4.8) - vec3(0.0, rise * 1.75, 0.0) + vec3(n1 * 1.6, -n1 * 1.1, n1 * 1.3));
  float curlDetail = pow(1.0 - abs(n2 * 2.0 - 1.0), 1.35);

  vec2 xz = q.xz - vec2(n1 - 0.5, n2 - 0.5) * (0.18 + 0.62 * h);
  float r = length(xz);

  float flameRad = mix(0.50, 0.06, pow(h, 0.72)) * (0.55 + 0.90 * curlDetail);
  float flameMask = smoothstep(flameRad, flameRad * 0.14, r) * smoothstep(0.0, 0.10, h) * smoothstep(0.68, 0.16, h);
  float temp = clamp(flameMask * (0.45 + 1.15 * curlDetail) * (1.25 - 0.78 * h), 0.0, 1.25);

  float smokeRad = mix(0.38, 0.86, pow(h, 0.62)) * (0.68 + 0.62 * n1);
  float smokeMask = smoothstep(smokeRad, smokeRad * 0.22, r) * smoothstep(0.22, 0.46, h) * smoothstep(0.98, 0.68, h);
  float billow = smoothstep(0.28, 0.74, n1 * 0.58 + curlDetail * 0.52);
  return vec2(temp, clamp(smokeMask * billow * 1.65, 0.0, 1.35));
}

// Live 24x36x24 3D Navier-Stokes fluid texture lookup + high-frequency advection detail (Stage 7).
vec2 evalLiveFluidVolume(vec3 p, float t) {
  vec3 bMin = vec3(-1.15, 0.08, -1.15), bMax = vec3(1.15, 2.48, 1.15);
  vec3 uvw = (p - bMin) / (bMax - bMin);
  if (any(lessThan(uvw, vec3(0.02))) || any(greaterThan(uvw, vec3(0.98)))) return vec2(0.0);

  float boxFeather = smoothstep(0.02, 0.12, min(uvw.x, 1.0 - uvw.x))
                   * smoothstep(0.02, 0.12, min(uvw.z, 1.0 - uvw.z))
                   * smoothstep(0.98, 0.82, uvw.y);
  vec4 s = texture(uTexFluid3D, uvw);
  float hf = fbm3(p * 5.2 - vec3(0.0, t * 2.9, 0.0));
  float ridge = pow(1.0 - abs(hf * 2.0 - 1.0), 1.3);
  return vec2(
    clamp(s.r * (0.62 + 0.75 * ridge) * 1.15 * boxFeather, 0.0, 1.25),
    clamp(s.g * (0.58 + 0.82 * hf) * 1.55 * boxFeather, 0.0, 1.35)
  );
}

vec2 sampleVolField(vec3 p, int stage) {
  return (stage == 7) ? evalLiveFluidVolume(p, uTime) : evalProceduralVolume(p, uTime);
}

vec4 renderVolumetric(vec3 ro, vec3 rd, float sceneDepth, int stage) {
  vec3 bMin = vec3(-1.15, 0.08, -1.15), bMax = vec3(1.15, 2.48, 1.15);
  vec2 hit = intersectBox(ro, rd, bMin, bMax);
  if (hit.x >= hit.y || hit.y < 0.0) return vec4(0.0);

  float tStart = max(0.05, hit.x), tEnd = min(hit.y, sceneDepth);
  if (tStart >= tEnd) return vec4(0.0);

  const int STEPS = 44;
  float dt = (tEnd - tStart) / float(STEPS);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t = tStart + jitter * dt;

  vec3 accum = vec3(0.0);
  float transmittance = 1.0, brickWire = 0.0;
  bool useShadow = (stage >= 6);
  vec3 moonDir = normalize(vec3(-0.62, 0.76, 0.45));
  vec3 coreCenter = vec3(0.0, 0.52, 0.0);

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    vec2 ts = sampleVolField(p, stage);
    float temp = ts.x, smoke = ts.y;

    // Optional occupied-voxel wireframe visualization on Step 7.
    if (stage == 6 && uSparseGridFlash > 0.01 && (temp > 0.09 || smoke > 0.11)) {
      vec3 gCell = fract((p - bMin) / 0.38);
      vec3 edge = min(gCell, 1.0 - gCell);
      float secondE = max(min(edge.x, edge.y), min(max(edge.x, edge.y), edge.z));
      if (secondE < 0.036) brickWire = max(brickWire, smoothstep(0.036, 0.008, secondE) * transmittance);
    }

    float sigma = smoke * 3.45 + temp * 0.75;
    if (sigma > 0.015) {
      vec3 emit = blackbodyHDR(temp) * 2.25;
      vec3 smokeLight;
      if (useShadow && smoke > 0.03) {
        float optCore = 0.0;
        vec3 toCore = normalize(coreCenter - p);
        float dCore = length(coreCenter - p);
        for (int s = 1; s <= 4; s++) {
          optCore += sampleVolField(p + toCore * (float(s) * min(0.24, dCore * 0.24)), stage).y * 0.85;
        }
        float coreShadow = exp(-optCore * 2.6) / (0.35 + 1.15 * dCore * dCore);

        float optMoon = 0.0;
        for (int s = 1; s <= 3; s++) optMoon += sampleVolField(p + moonDir * (float(s) * 0.26), stage).y * 0.95;
        float moonShadow = exp(-optMoon * 3.2);

        smokeLight = (vec3(0.18, 0.24, 0.42) * (0.06 + 0.94 * moonShadow)
                    + vec3(3.10, 0.82, 0.12) * coreShadow * 1.45) * vec3(0.24, 0.23, 0.26);
      } else {
        smokeLight = mix(vec3(0.32, 0.22, 0.16), vec3(0.24, 0.27, 0.35), smoothstep(0.35, 1.85, p.y));
      }

      vec3 stepRad = emit + smokeLight * smoke * 3.1;
      float stepTrans = exp(-sigma * dt);
      accum += transmittance * stepRad * (1.0 - stepTrans) / max(sigma, 0.001);
      transmittance *= stepTrans;
      if (transmittance < 0.015) break;
    }
    t += dt;
  }

  if (brickWire > 0.001 && uSparseGridFlash > 0.01) {
    accum += vec3(1.8, 1.15, 0.25) * brickWire * uSparseGridFlash * 0.95;
  }
  return vec4(accum, 1.0 - transmittance);
}

void evalStage(int stage, bool isLeft, vec2 uv, vec3 ro, vec3 rd, out vec3 colOut, out vec3 bloomOut) {
  vec3 sceneCol = texture(uTexScene, uv).rgb;
  vec4 dp = texture(uTexDepth, uv);
  float sceneDepth = (dp.r + dp.g / 255.0) * 32.0;
  colOut = sceneCol;
  bloomOut = vec3(0.0);

  // Stage 0: 1985 Palette Cycling (CLUT)
  if (stage == 0) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 0.96, 0.0), vec2(0.76, 1.02), true, bUv, bT) && bT < sceneDepth + 0.18) {
      vec2 qUv = (floor(bUv * vec2(64.0, 80.0)) + 0.5) / vec2(64.0, 80.0);
      float packed = texture(uTexPalIdx, qUv).r * 255.0;
      int rawBand = int(mod(packed, 16.0));
      int env = int(floor(packed / 16.0));
      if (rawBand > 0) {
        if (isLeft && uClutIndexOnly > 0.5) {
          float g = (float(rawBand) / 15.0) * 0.72 + 0.08;
          colOut = vec3(g * 0.85, g * 0.92, g);
        } else {
          int shift = int(floor(uTime * 14.0));
          int cycled = 1 + (((rawBand - 1) - shift) % 15 + 15) % 15;
          int finalIdx = clamp(int(round(float(cycled) * (0.45 + 0.55 * float(env) / 15.0))), 1, 15);
          colOut = pow(uClut16[finalIdx], vec3(2.1)) * 1.15;
        }
      }
    }
    return;
  }

  // Stage 1: 1995 PSX Doom 2D Cellular Automaton
  if (stage == 1) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.02, 0.0), vec2(0.90, 1.12), true, bUv, bT) && bT < sceneDepth + 0.22) {
      vec2 qUv = (floor(bUv * vec2(96.0, 112.0)) + 0.5) / vec2(96.0, 112.0);
      int heatIdx = clamp(int(round(texture(uTexDoom, qUv).r * 255.0)), 0, 36);
      if (heatIdx > 2) {
        vec3 doomCol = pow(uDoomPal[heatIdx], vec3(2.1)) * 1.25;
        colOut = mix(sceneCol, doomCol, smoothstep(2.0, 8.0, float(heatIdx)));
      }
    }
    return;
  }

  // Stage 2: 1998 Sprite & Additive Camera-Facing Billboard
  if (stage == 2) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 0.88, 0.0), vec2(0.86, 1.10), false, bUv, bT)) {
      if (bT < sceneDepth) {
        int frame = int(floor(uTime * 11.0)) % 8;
        vec4 sp = texture(uTexSprite, vec2((float(frame) + bUv.x) / 8.0, bUv.y));
        colOut = min(sceneCol + pow(sp.rgb, vec3(2.1)) * 1.05 * sp.a, vec3(1.15, 1.05, 0.65));
      }
      if (uQuadWire > 0.01) {
        float border = min(min(bUv.x, 1.0 - bUv.x), min(bUv.y, 1.0 - bUv.y));
        if (border < 0.014) {
          colOut = mix(colOut, (bT < sceneDepth) ? vec3(0.0, 1.25, 0.92) : vec3(1.60, 0.14, 0.16), uQuadWire * 0.92);
        }
      }
    }
    return;
  }

  // Stage 3: 2004 Soft Particles (Depth Fade) & Heat Haze
  if (stage == 3) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.32, 0.0), vec2(1.02, 1.40), true, bUv, bT) && bT < sceneDepth + 0.6) {
      float mask = smoothstep(0.50, 0.12, abs(bUv.x - 0.5)) * smoothstep(0.0, 0.22, bUv.y) * smoothstep(1.0, 0.42, bUv.y);
      float w1 = sin(bUv.y * 28.0 - uTime * 12.0 + sin(bUv.x * 16.0) * 1.8);
      float w2 = cos(bUv.y * 42.0 - uTime * 17.5 + bUv.x * 22.0);
      sceneCol = texture(uTexScene, clamp(uv + vec2(w1 * 0.0095, w2 * 0.0045) * mask, vec2(0.002), vec2(0.998))).rgb;
    }
    colOut = sceneCol;
    if (intersectBillboard(ro, rd, vec3(0.0, 0.94, 0.0), vec2(0.86, 1.12), true, bUv, bT)) {
      float softFade = smoothstep(-0.18, 0.44, sceneDepth - bT);
      if (softFade > 0.001) {
        vec2 p = bUv * 2.0 - 1.0;
        float n1 = fbm3(vec3(bUv * vec2(3.8, 3.2) - vec2(0.0, uTime * 2.4), uTime * 0.35));
        float n2 = fbm3(vec3(bUv * vec2(7.0, 5.5) - vec2(0.0, uTime * 3.8), uTime * 0.55));
        float distX = abs(p.x + (n1 - 0.5) * 0.65 * bUv.y) / mix(0.64, 0.10, pow(bUv.y, 0.75));
        float shape = smoothstep(1.0, 0.15, distX) * smoothstep(0.0, 0.14, bUv.y) * smoothstep(1.0, 0.18, bUv.y);
        float flame = clamp(shape * (0.55 + 1.1 * n2), 0.0, 1.0);
        vec3 ldrFire = mix(vec3(0.85, 0.12, 0.01), mix(vec3(1.1, 0.45, 0.04), vec3(1.15, 0.95, 0.50), smoothstep(0.45, 0.85, flame)), smoothstep(0.12, 0.55, flame));
        colOut = min(sceneCol + ldrFire * flame * softFade * 1.15, vec3(1.15, 1.0, 0.62));
      }
    }
    return;
  }

  // Stage 4: 2012 6-Way Lit Flipbook + Optical Flow + Kelvin Blackbody HDR
  if (stage == 4) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.42, 0.0), vec2(0.95, 1.25), true, bUv, bT) && bT < sceneDepth + 0.5) {
      float hm = smoothstep(0.48, 0.15, abs(bUv.x - 0.5)) * smoothstep(0.0, 0.25, bUv.y) * smoothstep(1.0, 0.52, bUv.y);
      sceneCol = texture(uTexScene, clamp(uv + vec2(sin(bUv.y * 30.0 - uTime * 13.0) * 0.005, 0.0) * hm, vec2(0.002), vec2(0.998))).rgb;
    }
    colOut = sceneCol;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.24, 0.0), vec2(1.04, 1.24), true, bUv, bT)) {
      float softFade = smoothstep(-0.22, 0.45, sceneDepth - bT);
      float quadFeather = smoothstep(0.0, 0.14, min(bUv.x, 1.0 - bUv.x)) * smoothstep(1.0, 0.78, bUv.y) * smoothstep(0.0, 0.08, bUv.y);
      float mask = softFade * quadFeather;
      if (mask > 0.001) {
        float fCont = mod(uTime * 11.0, 16.0);
        int f0 = int(floor(fCont)), f1 = (f0 + 1) % 16;
        float blend = fract(fCont);
        vec4 a0, b0, c0, a1, b1, c1;
        sampleFlipCell(f0, bUv, vec2(0.0), a0, b0, c0);
        sampleFlipCell(f1, bUv, vec2(0.0), a1, b1, c1);
        vec2 flow0 = (a0.zw - 0.5) * 0.055, flow1 = (a1.zw - 0.5) * 0.055;
        sampleFlipCell(f0, bUv, -flow0 * blend, a0, b0, c0);
        sampleFlipCell(f1, bUv,  flow1 * (1.0 - blend), a1, b1, c1);
        vec4 a = mix(a0, a1, blend), b = mix(b0, b1, blend), c = mix(c0, c1, blend);

        float smoke = clamp(a.g * 1.45 * mask, 0.0, 0.94);
        float moon6 = b.g * 0.45 + b.b * 0.55 + c.r * 0.25;
        float fire6 = b.a * 0.72 + c.b * 0.95;
        vec3 litSmoke = (vec3(0.18, 0.24, 0.42) * (0.12 + 0.88 * moon6) + vec3(2.65, 0.78, 0.14) * fire6) * 0.28;
        vec3 emitHDR = blackbodyHDR(a.r * 1.12) * 0.92 * mask;
        colOut = mix(sceneCol, litSmoke, smoke) + emitHDR;
        bloomOut = max(vec3(0.0), emitHDR - vec3(0.85));
      }
    }
    return;
  }

  // Stages 5, 6, 7: 3D Volumetric Raymarching / Sparse Self-Shadow / Live 3D Fluid
  {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.48, 0.0), vec2(1.0, 1.25), true, bUv, bT) && bT < sceneDepth + 0.5) {
      float hm = smoothstep(0.48, 0.15, abs(bUv.x - 0.5)) * smoothstep(0.0, 0.25, bUv.y) * smoothstep(1.0, 0.55, bUv.y);
      sceneCol = texture(uTexScene, clamp(uv + vec2(sin(bUv.y * 30.0 - uTime * 13.0) * 0.0045, 0.0) * hm, vec2(0.002), vec2(0.998))).rgb;
    }
  }
  vec4 vol = renderVolumetric(ro, rd, sceneDepth, stage);
  colOut = sceneCol * (1.0 - vol.a) + vol.rgb;
  bloomOut = max(vec3(0.0), vol.rgb - vec3(0.85));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  vec3 c, bl;
  if (uWipeX <= 0.001) evalStage(uStageRight, false, vUv, ro, rd, c, bl);
  else if (uWipeX >= 0.999) evalStage(uStageLeft, true, vUv, ro, rd, c, bl);
  else if (vUv.x < uWipeX) evalStage(uStageLeft, true, vUv, ro, rd, c, bl);
  else evalStage(uStageRight, false, vUv, ro, rd, c, bl);

  outHdr = vec4(c, 1.0);
  outBloom = vec4(bl, 1.0);
}
`;

export const BLUR_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 fragColor;

void main() {
  const float w[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 sum = texture(uTex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDir * float(i) * 1.5;
    sum += (texture(uTex, vUv + off).rgb + texture(uTex, vUv - off).rgb) * w[i];
  }
  fragColor = vec4(sum, 1.0);
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
out vec4 fragColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 hdr = texture(uTexHdr, vUv).rgb;
  int st = (uWipeX <= 0.001)
    ? uStageRight
    : ((uWipeX >= 0.999) ? uStageLeft : (vUv.x < uWipeX ? uStageLeft : uStageRight));
  vec3 bloom = (st >= 4) ? texture(uTexBloom, vUv).rgb * 0.34 : vec3(0.0);
  fragColor = vec4(pow(aces((hdr + bloom) * 1.18), vec3(1.0 / 2.15)), 1.0);
}
`;
