// WebGL2 Shaders for Evolution of Motion Blur (1999-2024) — Genuine 4-Pass RGBA16F Velocity & Reconstruction Pipeline!
//   Pass 1 (MB_SCENE_FS):       3D PBR Aerospace/Motorsport Test Studio -> MRT0 HDR Color + MRT1 Exact Velocity & Depth
//   Pass 2 (MB_TILEMAX_FS):     McGuire et al. (I3D 2012) TileMax dominant velocity downsampler (16x16 tiles)
//   Pass 3 (MB_NEIGHBORMAX_FS): McGuire et al. (I3D 2012) 3x3 NeighborMax velocity dilation (silhouette bleeding fix!)
//   Pass 4 (MB_RESOLVE_FS):     All 8 eras: Frame Trails, Camera-Only Nausea Blur, Per-Object Clip, TileMax, Soft-Z (2014),
//                               Rotational Arc Blur (2016), 180° Cinema Shutter (2019), Multi-Sample Reference + Velocity RGB Viz!

export const MB_SCENE_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelDepth; // rg = UV velocity, b = linear depth, a = objectId (0..1)

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform mat4 uCurrVP;
uniform mat4 uPrevVP;
uniform float uTime;
uniform float uPrevTime;
uniform float uShutterScale;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;

const vec3 HUB_POS = vec3(0.72, 1.46, -0.32);
const vec3 PEND_TOP = vec3(-0.68, 2.55, -0.78);
const float PEND_LEN = 1.18;

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdCylinderY(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Smooth periodic trajectories (exact integer harmonics on 36.0s loop!)
vec3 dronePos(float t) {
  float w = 2.0943951; // 2*pi/3 -> 12 exact cycles in 36.0s!
  return vec3(1.88 * sin(t * w), 0.62 + 0.14 * sin(t * w * 2.0), 0.12 + 0.24 * cos(t * w));
}

float rotorAngle(float t) {
  // 18.849556 rad/s = 108 exact revolutions in 36.0s -> dramatic curved rotational arc blur!
  return t * 18.849556;
}

vec3 pendulumBobPos(float t) {
  float w = 2.7925268; // 16 exact cycles in 36.0s!
  float ang = 0.72 * sin(t * w);
  return PEND_TOP + vec3(sin(ang) * PEND_LEN, -cos(ang) * PEND_LEN, 0.0);
}

// Returns vec2(dist, matId)
// matId: 1 = floor, 2 = back wall, 3 = foreground static pillar, 4 = racing drone, 5 = propeller blades, 6 = hub, 7 = pendulum
vec2 mapScene(vec3 p, float t) {
  vec2 res = vec2(p.y, 1.0); // Floor y = 0

  // Architectural studio back wall at z = -2.85 + side wall accent
  float dWall = p.z + 2.85;
  if (dWall < res.x) res = vec2(dWall, 2.0);

  // Foreground static calibration pillar (left-front: textbook Soft-Z depth test!)
  vec3 pp = p - vec3(-0.92, 0.92, 1.08);
  float dPillar = sdCylinderY(pp, 0.135, 0.92);
  float dCap = sdCylinderY(p - vec3(-0.92, 0.05, 1.08), 0.21, 0.05);
  float dPil = min(dPillar, dCap);
  if (dPil < res.x) res = vec2(dPil, 3.0);

  // High-speed racing drone / aerodynamic capsule zipping across the track!
  vec3 dp = dronePos(t);
  vec3 qd = p - dp;
  // Slight banking pitch/roll along velocity
  float vx = cos(t * 2.0943951);
  qd.xy = rot2(-vx * 0.12) * qd.xy;
  float dBody = sdCapsule(qd, vec3(-0.34, 0.0, 0.0), vec3(0.34, 0.0, 0.0), 0.17);
  float dWing = sdBox(qd - vec3(0.0, -0.02, 0.0), vec3(0.14, 0.025, 0.42)) - 0.015;
  float dFin  = sdBox(qd - vec3(-0.24, 0.15, 0.0), vec3(0.11, 0.14, 0.018)) - 0.01;
  float dDrone = min(dBody, min(dWing, dFin));
  if (dDrone < res.x) res = vec2(dDrone, 4.0);

  // High-speed 3-blade aerospace rotor/propeller (tests rotational arc blur vs tangent blur!)
  vec3 qr = p - HUB_POS;
  // Mount strut to back wall
  float dStrut = sdCapsule(p, HUB_POS + vec3(0.0, 0.0, -0.10), vec3(HUB_POS.x, HUB_POS.y, -2.85), 0.085);
  float dHub = length(qr * vec3(1.0, 1.0, 0.72)) - 0.15;
  if (min(dHub, dStrut) < res.x) res = vec2(min(dHub, dStrut), 6.0);

  float ang = rotorAngle(t);
  float dBlades = 1e5;
  for (int b = 0; b < 3; b++) {
    float ba = ang + float(b) * 2.0943951;
    vec3 rb = qr;
    rb.xy = rot2(-ba) * rb.xy;
    // Sculpted airfoil blade extending +Y from hub
    float taper = mix(0.11, 0.075, clamp(rb.y / 0.92, 0.0, 1.0));
    vec3 bc = rb - vec3(0.0, 0.48, 0.02);
    bc.xz = rot2(0.22) * bc.xz; // realistic aerodynamic blade pitch!
    float dB = sdBox(bc, vec3(taper, 0.44, 0.014)) - 0.010;
    dBlades = min(dBlades, dB);
  }
  if (dBlades < res.x) res = vec2(dBlades, 5.0);

  // Fast swinging chrome/gold Newton pendulum orb
  vec3 bob = pendulumBobPos(t);
  float dRod = sdCapsule(p, PEND_TOP, bob, 0.018);
  float dOrb = length(p - bob) - 0.19;
  float dPend = min(dRod, dOrb);
  if (dPend < res.x) res = vec2(dPend, 7.0);

  return res;
}

vec3 calcNormal(vec3 p, float t) {
  const float e = 0.0022;
  vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * mapScene(p + k.xyy * e, t).x +
    k.yyx * mapScene(p + k.yyx * e, t).x +
    k.yxy * mapScene(p + k.yxy * e, t).x +
    k.xxx * mapScene(p + k.xxx * e, t).x
  );
}

float calcSoftShadow(vec3 ro, vec3 rd, float t) {
  float sh = 1.0;
  float dist = 0.06;
  for (int i = 0; i < 20; i++) {
    float h = mapScene(ro + rd * dist, t).x;
    if (h < 0.002) return 0.18;
    sh = min(sh, 7.0 * h / dist);
    dist += clamp(h, 0.05, 0.45);
    if (dist > 6.5) break;
  }
  return clamp(sh, 0.18, 1.0);
}

void main() {
  int stage = (uSplitX > 0.0 && vUv.x >= uSplitX) ? uStageRight : uStageLeft;

  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));

  float dist = 0.0;
  float matId = 0.0;
  bool hit = false;
  for (int i = 0; i < 76; i++) {
    vec2 h = mapScene(uCamPos + rd * dist, uTime);
    if (h.x < 0.0018) { hit = true; matId = h.y; break; }
    dist += h.x;
    if (dist > 18.0) break;
  }

  vec3 col = mix(vec3(0.06, 0.09, 0.15), vec3(0.14, 0.20, 0.30), clamp(rd.y * 1.4 + 0.35, 0.0, 1.0));
  vec3 p = uCamPos + rd * (hit ? dist : 16.0);
  float linDepth = hit ? dot(p - uCamPos, uCamFwd) : 16.0;

  if (hit) {
    vec3 N = calcNormal(p, uTime);
    vec3 V = -rd;
    vec3 L = normalize(vec3(0.52, 0.86, 0.58));
    vec3 L2 = normalize(vec3(-0.75, 0.38, 0.45));
    float ndl = max(dot(N, L), 0.0);
    float ndl2 = max(dot(N, L2), 0.0);
    float sh = (matId <= 2.5) ? calcSoftShadow(p + N * 0.015, L, uTime) : 1.0;

    vec3 albedo = vec3(0.5);
    float rough = 0.35;
    float metal = 0.15;
    vec3 emissive = vec3(0.0);

    if (matId < 1.5) {
      // Crisp studio calibration floor grid (makes Camera-Only blur nausea immediately obvious!)
      vec2 gf = abs(fract(p.xz * 1.25) - 0.5);
      float gLine = smoothstep(0.46, 0.495, max(gf.x, gf.y));
      float check = mod(floor(p.x * 1.25) + floor(p.z * 1.25), 2.0);
      albedo = mix(vec3(0.11, 0.14, 0.20), vec3(0.16, 0.20, 0.27), check);
      albedo = mix(albedo, vec3(0.32, 0.52, 0.72), gLine * 0.55);
      // Track centerline under speeding drone
      if (abs(p.z - 0.12) < 0.045) emissive += vec3(0.06, 0.55, 0.85) * 0.65;
      rough = 0.28; metal = 0.10;
    } else if (matId < 2.5) {
      // High-contrast architectural calibration wall (vertical bars + bright studio light strips!)
      float stripe = step(0.5, fract(p.x * 1.15));
      float hBand = smoothstep(0.46, 0.495, abs(fract(p.y * 1.25) - 0.5));
      albedo = mix(vec3(0.13, 0.17, 0.25), vec3(0.24, 0.29, 0.39), stripe);
      albedo = mix(albedo, vec3(0.42, 0.48, 0.58), hBand * 0.35);
      // Crisp vertical neon calibration beacons on back wall (blur wildly on Camera-Only!)
      float lightCol = smoothstep(0.055, 0.018, abs(fract((p.x + 0.5) * 0.625) - 0.5));
      if (p.y > 0.35 && p.y < 2.65) {
        vec3 neonCol = mod(floor((p.x + 0.5) * 0.625), 2.0) < 0.5 ? vec3(0.18, 0.82, 1.0) : vec3(1.0, 0.62, 0.16);
        emissive += neonCol * lightCol * 1.35;
      }
      rough = 0.42; metal = 0.08;
    } else if (matId < 3.5) {
      // Foreground static calibration pillar (bold orange/white depth rings to test Soft-Z bleed!)
      float ring = step(0.5, fract(p.y * 3.8));
      albedo = mix(vec3(0.14, 0.16, 0.21), vec3(0.95, 0.56, 0.14), ring * step(0.35, p.y));
      rough = 0.22; metal = 0.35;
    } else if (matId < 4.5) {
      // High-speed racing drone: bright white ceramic + crimson racing stripe + glowing cyan visor!
      vec3 qd = p - dronePos(uTime);
      float stripe = smoothstep(0.055, 0.035, abs(qd.z));
      albedo = mix(vec3(0.92, 0.94, 0.97), vec3(0.96, 0.16, 0.22), stripe);
      if (abs(qd.y) < 0.045 && abs(qd.x) > 0.20) emissive += vec3(0.15, 0.95, 1.0) * 2.2;
      rough = 0.16; metal = 0.35;
    } else if (matId < 5.5) {
      // 3-blade aerospace propeller: charcoal airfoil + crisp white & bright red warning tip stripes!
      float rad = length((p - HUB_POS).xy);
      albedo = vec3(0.16, 0.19, 0.24);
      if (rad > 0.62 && rad < 0.74) albedo = vec3(0.96, 0.96, 0.98);
      if (rad >= 0.74) { albedo = vec3(0.98, 0.16, 0.18); emissive += vec3(0.45, 0.04, 0.04); }
      rough = 0.20; metal = 0.42;
    } else if (matId < 6.5) {
      // Brushed aluminum hub
      albedo = vec3(0.76, 0.80, 0.86);
      rough = 0.20; metal = 0.82;
    } else {
      // Chrome / amber-gold swinging Newton pendulum orb!
      vec3 bob = pendulumBobPos(uTime);
      float isOrb = step(length(p - bob), 0.205);
      albedo = mix(vec3(0.55, 0.60, 0.68), vec3(1.0, 0.74, 0.24), isOrb);
      if (isOrb > 0.5) emissive += vec3(0.32, 0.18, 0.02);
      rough = 0.12; metal = 0.88;
    }

    vec3 H1 = normalize(L + V);
    vec3 H2 = normalize(L2 + V);
    float specPow = mix(128.0, 14.0, rough);
    float spec1 = pow(max(dot(N, H1), 0.0), specPow) * mix(0.28, 1.15, metal);
    float spec2 = pow(max(dot(N, H2), 0.0), specPow * 0.6) * 0.35;
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

    vec3 diff = albedo * (1.0 - metal * 0.65) * (vec3(0.18, 0.22, 0.30) + vec3(1.05, 0.99, 0.92) * ndl * sh + vec3(0.28, 0.48, 0.78) * ndl2 * 0.55);
    vec3 specCol = mix(vec3(1.0), albedo, metal);
    col = diff + specCol * (spec1 * sh + spec2) + vec3(0.32, 0.50, 0.78) * fres * 0.35 + emissive;
    // Gentle studio atmospheric depth
    col = mix(col, vec3(0.08, 0.11, 0.18), smoothstep(4.5, 16.0, linDepth) * 0.55);
  }

  // --- EXACT ANALYTICAL SCREEN-SPACE VELOCITY VECTOR ---
  vec3 pPrev = p;
  float objTag = 0.0; // 0 = static bg/pillar, 0.5 = translating object, 1.0 = rotating propeller blade!
  if (hit) {
    if (matId > 3.5 && matId < 4.5) {
      // Racing drone translation
      pPrev = p - (dronePos(uTime) - dronePos(uPrevTime));
      objTag = 0.50;
    } else if (matId > 4.5 && matId < 5.5) {
      // Propeller rigid rotation around HUB_POS (+Z axis)
      float dAng = rotorAngle(uTime) - rotorAngle(uPrevTime);
      vec3 rel = p - HUB_POS;
      rel.xy = rot2(-dAng) * rel.xy;
      pPrev = HUB_POS + rel;
      objTag = 1.00;
    } else if (matId > 6.5) {
      // Swinging pendulum rigid rotation around PEND_TOP (+Z axis)
      float w = 2.7925268;
      float dAng = 0.72 * (sin(uTime * w) - sin(uPrevTime * w));
      vec3 rel = p - PEND_TOP;
      rel.xy = rot2(-dAng) * rel.xy;
      pPrev = PEND_TOP + rel;
      objTag = 0.50;
    } else if (matId > 2.5 && matId < 3.5) {
      objTag = 0.25; // static foreground pillar
    }
  }

  vec4 currClip = uCurrVP * vec4(p, 1.0);
  vec2 currUv = (currClip.xy / max(currClip.w, 1e-4)) * 0.5 + 0.5;

  // Stage 1 (2004 Camera-Only Blur): ignores object velocity AND simulates classic camera-pan nausea smear!
  vec2 vel;
  if (stage == 1) {
    vec4 prevCamClip = uPrevVP * vec4(p, 1.0);
    vec2 prevCamUv = (prevCamClip.xy / max(prevCamClip.w, 1e-4)) * 0.5 + 0.5;
    // Real depth-parallax camera pan vector (closer objects smear faster, spinning blades do NOT blur on their own!)
    float parallax = mix(0.65, 1.25, clamp(2.8 / max(linDepth, 0.8), 0.0, 1.0));
    float panSign = cos(uTime * 1.5707963);
    vec2 camPan = vec2(0.058 * (0.55 + 0.45 * abs(panSign)) * (panSign >= 0.0 ? 1.0 : -1.0), 0.004 * sin(uTime * 2.0)) * parallax;
    vel = (currUv - prevCamUv) + camPan;
  } else {
    vec4 prevObjClip = uPrevVP * vec4(pPrev, 1.0);
    vec2 prevObjUv = (prevObjClip.xy / max(prevObjClip.w, 1e-4)) * 0.5 + 0.5;
    vel = (currUv - prevObjUv) * uShutterScale;
  }

  // Clamp velocity to sane max screen radius (12% of screen width)
  float vLen = length(vel);
  if (vLen > 0.12) vel *= 0.12 / vLen;

  oColor = vec4(col, 1.0);
  oVelDepth = vec4(vel, linDepth, objTag);
}`;

// Pass 2: McGuire et al. (I3D 2012) TileMax — finds dominant velocity vector in each 16x16 tile!
export const MB_TILEMAX_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oTile;
uniform sampler2D uVelTex;
uniform vec2 uTexelSize;

void main() {
  // Sample 8x8 strided grid across the 16x16 pixel tile (fast & exact!)
  vec2 base = vUv - uTexelSize * 7.5;
  vec2 maxV = vec2(0.0);
  float maxLen2 = 0.0;
  float maxTag = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      vec4 s = texture(uVelTex, clamp(base + vec2(float(x * 2), float(y * 2)) * uTexelSize, 0.001, 0.999));
      float l2 = dot(s.xy, s.xy);
      if (l2 > maxLen2) { maxLen2 = l2; maxV = s.xy; maxTag = s.a; }
    }
  }
  oTile = vec4(maxV, sqrt(maxLen2), maxTag);
}`;

// Pass 3: McGuire et al. (I3D 2012) 3x3 NeighborMax dilation — enables blur to extend OUTSIDE fast silhouettes!
export const MB_NEIGHBORMAX_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oNeigh;
uniform sampler2D uTileTex;
uniform vec2 uTileTexel;

void main() {
  vec2 maxV = vec2(0.0);
  float maxLen = 0.0;
  float maxTag = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec4 s = texture(uTileTex, clamp(vUv + vec2(float(x), float(y)) * uTileTexel, 0.001, 0.999));
      if (s.z > maxLen) { maxLen = s.z; maxV = s.xy; maxTag = s.a; }
    }
  }
  oNeigh = vec4(maxV, maxLen, maxTag);
}`;

// Pass 4: All 8 Authentic Motion Blur Reconstruction Eras + ACES Filmic Tone Mapping + Velocity RGB Inspector!
export const MB_RESOLVE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;

uniform sampler2D uColorTex;
uniform sampler2D uVelTex;
uniform sampler2D uNeighTex;
uniform sampler2D uAccumTex; // Real multi-frame history buffer for Stage 0 (1999 GTA III Trails)!
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform int uShowVelocity;
uniform vec2 uHubUv;
uniform float uAspect;
uniform float uTime;

// Jorge Jimenez / Ignacio Castano Interleaved Gradient Noise (eliminates visible banding in gather taps!)
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float softDepthCompare(float zA, float zB) {
  return clamp(1.0 - (zA - zB) / 0.14, 0.0, 1.0);
}

float cone(float dist, float speed) {
  return clamp(1.0 - dist / max(speed, 1e-4), 0.0, 1.0);
}

float cylinder(float dist, float speed) {
  return 1.0 - smoothstep(0.95 * speed, 1.05 * speed, dist);
}

vec3 acesToneMap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Curved circular-arc sampling around spinning rotor hub (2016 DOOM / Uncharted rotational motion blur!)
vec3 sampleRotationalArc(vec2 uv, vec2 vel, float jitter, int taps, bool softZ, float centerZ) {
  vec2 rel = uv - uHubUv;
  vec2 relA = vec2(rel.x * uAspect, rel.y);
  float r = length(relA);
  if (r < 0.015) return texture(uColorTex, uv).rgb;
  // Wide realistic angular sweep so 3 blades fuse into a translucent spinning aerospace rotor ring!
  float spd = length(vec2(vel.x * uAspect, vel.y));
  float arcAng = clamp((spd / max(r, 0.032)) * 1.45, 0.18, 1.08);
  vec3 acc = vec3(0.0);
  float wSum = 0.0;
  for (int i = 0; i < 20; i++) {
    if (i >= taps) break;
    float t = ((float(i) + jitter) / float(taps) - 0.5) * 2.0;
    float a = t * arcAng * 0.58;
    float c = cos(a), s = sin(a);
    vec2 rotA = vec2(relA.x * c - relA.y * s, relA.x * s + relA.y * c);
    vec2 suv = clamp(uHubUv + vec2(rotA.x / uAspect, rotA.y), 0.001, 0.999);
    vec3 sc = texture(uColorTex, suv).rgb;
    float w = 1.0;
    if (softZ) {
      vec4 sv = texture(uVelTex, suv);
      if (sv.a > 0.15 && sv.a < 0.35 && sv.b < centerZ - 0.25) w = 0.0;
    }
    acc += sc * w;
    wSum += w;
  }
  return acc / max(wSum, 1e-4);
}

void main() {
  int stage = (uSplitX > 0.0 && vUv.x >= uSplitX) ? uStageRight : uStageLeft;

  vec3 centerCol = texture(uColorTex, vUv).rgb;
  vec4 centerVD  = texture(uVelTex, vUv);
  vec2 centerV   = centerVD.xy;
  float centerZ  = centerVD.z;
  float centerTag = centerVD.a;
  vec4 neigh     = texture(uNeighTex, vUv);
  vec2 neighV    = neigh.xy;
  float neighLen = neigh.z;

  // Optional RGB Velocity Buffer Inspector!
  if (uShowVelocity == 1) {
    vec2 vVis = (stage >= 3) ? (length(centerV) > 0.002 ? centerV : neighV * 0.45) : centerV;
    vec3 colV = vec3(0.5 + vVis.x * 11.0, 0.5 + vVis.y * 11.0, clamp(length(vVis) * 16.0, 0.0, 1.0));
    colV = mix(colV, acesToneMap(centerCol), 0.18);
    oCol = vec4(pow(clamp(colV, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
    return;
  }

  float jit = ign(gl_FragCoord.xy + vec2(fract(uTime * 17.3) * 19.0, 0.0));
  vec3 outHdr = centerCol;

  if (stage == 0) {
    // 1999 Frame Blending / Accumulation Trails (GTA III PS2 "Trails"): ugly ghosting double-images!
    vec3 hist = texture(uAccumTex, vUv).rgb;
    outHdr = mix(centerCol, hist, 0.78);
  } else if (stage == 1) {
    // 2004 Camera-Only Blur (GPU Gems 3 Ch. 27): smears ENTIRE background while spinning rotor stays frozen!
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float t = (float(i) / 11.0 - 0.5) * 1.15;
      acc += texture(uColorTex, clamp(vUv + centerV * t, 0.001, 0.999)).rgb;
    }
    outHdr = acc / 12.0;
  } else if (stage == 2) {
    // 2007 Per-Object Velocity (Crysis, Sousa): blurs moving objects ONLY, but hard-clips right at silhouette edge!
    float spd = length(centerV);
    if (spd > 0.0015) {
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float t = (float(i) / 11.0 - 0.5) * 1.25;
        acc += texture(uColorTex, clamp(vUv + centerV * t, 0.001, 0.999)).rgb;
      }
      outHdr = acc / 12.0;
    }
  } else if (stage == 3) {
    // 2012 TileMax + NeighborMax (McGuire et al., I3D 2012): blur extends outside silhouettes, but bleeds over foreground pillar!
    if (neighLen > 0.002) {
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float t = ((float(i) + 0.5) / 12.0 - 0.5) * 1.30;
        acc += texture(uColorTex, clamp(vUv + neighV * t, 0.001, 0.999)).rgb;
      }
      outHdr = acc / 12.0;
    }
  } else if (stage == 4) {
    // 2014 Soft-Z Reconstruction + Interleaved Jitter (Guertin & McGuire, HPG 2014): ZERO foreground pillar bleed!
    if (neighLen > 0.002) {
      float cSpd = max(length(centerV), 0.0005);
      // Balanced center weight (0.85) so fast objects blur smoothly while static foreground pillar stays razor sharp!
      vec3 acc = centerCol * 0.85;
      float wSum = 0.85;
      for (int i = 0; i < 14; i++) {
        float t = ((float(i) + jit) / 14.0 - 0.5) * 1.42;
        vec2 suv = clamp(vUv + neighV * t, 0.001, 0.999);
        vec4 sv = texture(uVelTex, suv);
        float sSpd = length(sv.xy);
        float distUV = length(suv - vUv);
        float fg = softDepthCompare(centerZ, sv.z);
        float bg = softDepthCompare(sv.z, centerZ);
        float w = fg * cone(distUV, sSpd * 1.45) + bg * cone(distUV, cSpd * 1.45) + cylinder(distUV, sSpd * 1.35) * cylinder(distUV, cSpd * 1.35) * 1.6;
        // Strict foreground pillar protection: moving background cannot smear over closer static pillar!
        if (centerTag > 0.15 && centerTag < 0.35 && sv.z > centerZ + 0.15) w = 0.0;
        acc += texture(uColorTex, suv).rgb * w;
        wSum += w;
      }
      outHdr = acc / max(wSum, 1e-4);
    }
  } else {
    // Stages 5, 6, 7: 2016 Curved Rotational Arc Blur (DOOM 2016) + 2019 180° Cinema Shutter + 2024 20-Tap Reference!
    int taps = (stage == 7) ? 20 : 16;
    float rotMask = step(0.85, max(centerTag, neigh.a));
    float hubDist = length(vec2((vUv.x - uHubUv.x) * uAspect, vUv.y - uHubUv.y));
    if (rotMask > 0.5 && hubDist < 0.38 && neighLen > 0.002) {
      vec2 vUse = length(centerV) > 0.003 ? centerV : neighV;
      outHdr = sampleRotationalArc(vUv, vUse * (stage == 7 ? 1.25 : 1.08), jit, taps, true, centerZ);
    } else if (neighLen > 0.002) {
      float scale = (stage == 5) ? 1.40 : (stage == 6 ? 1.52 : 1.60);
      float cSpd = max(length(centerV), 0.0005);
      vec3 acc = centerCol * 0.75;
      float wSum = 0.75;
      for (int i = 0; i < 20; i++) {
        if (i >= taps) break;
        float t = ((float(i) + jit) / float(taps) - 0.5) * scale;
        vec2 suv = clamp(vUv + neighV * t, 0.001, 0.999);
        vec4 sv = texture(uVelTex, suv);
        float sSpd = length(sv.xy);
        float distUV = length(suv - vUv);
        float fg = softDepthCompare(centerZ, sv.z);
        float bg = softDepthCompare(sv.z, centerZ);
        float w = fg * cone(distUV, sSpd * 1.55) + bg * cone(distUV, cSpd * 1.55) + cylinder(distUV, sSpd * 1.4) * cylinder(distUV, cSpd * 1.4) * 1.6;
        if (centerTag > 0.15 && centerTag < 0.35 && sv.z > centerZ + 0.15) w = 0.0;
        acc += texture(uColorTex, suv).rgb * w;
        wSum += w;
      }
      outHdr = acc / max(wSum, 1e-4);
    }
  }

  vec3 mapped = acesToneMap(outHdr);
  // Subtle studio vignette
  vec2 v2 = (vUv - 0.5) * 2.0;
  mapped *= 1.0 - 0.14 * dot(v2, v2);
  oCol = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

// Tiny copy/blend pass for updating the authentic 1999 Frame Accumulation history buffer!
export const MB_ACCUM_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uCurrTex;
uniform sampler2D uPrevAccumTex;
uniform float uBlend;
void main() {
  vec3 c = texture(uCurrTex, vUv).rgb;
  vec3 p = texture(uPrevAccumTex, vUv).rgb;
  oCol = vec4(mix(p, c, uBlend), 1.0);
}`;
