// WebGL2 Shaders for Evolution of Character Animation (1989-2020):
// Real GPU Rigid 1-Bone, Quake-style Per-Vertex Morphing, Linear Blend Skinning (LBS),
// exact Kavan (2007) Dual Quaternion Skinning (DQS), 1989 Rotoscoped 2D Sprite, Arena, and Skeleton/Trajectory overlay.

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform int uRetro;
void main() {
  vec3 top = uRetro == 1 ? vec3(0.06, 0.05, 0.14) : vec3(0.11, 0.17, 0.28);
  vec3 mid = uRetro == 1 ? vec3(0.18, 0.11, 0.22) : vec3(0.24, 0.34, 0.48);
  vec3 bot = uRetro == 1 ? vec3(0.10, 0.08, 0.14) : vec3(0.14, 0.17, 0.22);
  float y = vUv.y;
  vec3 col = y > 0.42 ? mix(mid, top, smoothstep(0.42, 1.0, y)) : mix(bot, mid, smoothstep(0.0, 0.42, y));
  // Subtle warm studio rim glow behind arena
  float glow = exp(-length((vUv - vec2(0.52, 0.54)) * vec2(1.4, 2.2)) * 2.4);
  col += (uRetro == 1 ? vec3(0.32, 0.18, 0.10) : vec3(0.24, 0.20, 0.14)) * glow;
  oCol = vec4(col, 1.0);
}`;

export const CHAR_VS = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec2 aBones;
layout(location = 4) in vec2 aWeights;
layout(location = 5) in float aMatId;

uniform mat4 uViewProj;
uniform mat4 uBones[13];
uniform mat4 uBonesB[13];   // Second keyframe pose for Stage 2 (1996 Quake MDL per-vertex morph!)
uniform vec4 uDqReal[13];
uniform vec4 uDqDual[13];
uniform int uDeformMode;    // 0=Rigid 1-Bone, 1=Quake Vertex Morph, 2=LBS, 3=Dual Quaternion (Kavan 2007)
uniform float uMorphT;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out float vMatId;
out float vPinch;           // Visualizing LBS volume loss subtle highlight on pinched sleeve!

vec3 qRot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  int b0 = int(aBones.x + 0.5);
  int b1 = int(aBones.y + 0.5);
  float w0 = aWeights.x;
  float w1 = aWeights.y;

  vec3 posW = aPos;
  vec3 nrmW = aNorm;
  float pinch = 0.0;

  if (uDeformMode == 0) {
    // 1992-98 Rigid single-bone attachment (hard creases / joint breaks!)
    int b = (w0 >= w1) ? b0 : b1;
    mat4 M = uBones[b];
    posW = (M * vec4(aPos, 1.0)).xyz;
    nrmW = normalize(mat3(M) * aNorm);
  } else if (uDeformMode == 1) {
    // 1996 Quake MDL Per-Vertex Linear Interpolation between two keyframe meshes:
    // Chords cut across circular limb arcs -> limbs shrink & wobble mid-frame!
    int b = (w0 >= w1) ? b0 : b1;
    vec3 pA = (uBones[b]  * vec4(aPos, 1.0)).xyz;
    vec3 pB = (uBonesB[b] * vec4(aPos, 1.0)).xyz;
    vec3 nA = mat3(uBones[b])  * aNorm;
    vec3 nB = mat3(uBonesB[b]) * aNorm;
    posW = mix(pA, pB, uMorphT);
    nrmW = normalize(mix(nA, nB, uMorphT) + vec3(1e-5));
  } else if (uDeformMode == 2) {
    // Linear Blend Skinning (LBS): weighted matrix sum -> genuine 180° candy-wrapper collapse!
    mat4 M = uBones[b0] * w0 + uBones[b1] * w1;
    posW = (M * vec4(aPos, 1.0)).xyz;
    vec3 rawN = mat3(M) * aNorm;
    pinch = clamp(1.0 - length(rawN), 0.0, 1.0);
    nrmW = normalize(rawN + vec3(1e-5));
  } else {
    // Exact Unit Dual Quaternion Skinning (Kavan et al., I3D 2007): zero volume collapse!
    vec4 qr0 = uDqReal[b0], qd0 = uDqDual[b0];
    vec4 qr1 = uDqReal[b1], qd1 = uDqDual[b1];
    if (dot(qr0, qr1) < 0.0) { qr1 = -qr1; qd1 = -qd1; }
    vec4 qr = qr0 * w0 + qr1 * w1;
    vec4 qd = qd0 * w0 + qd1 * w1;
    float len = max(length(qr), 1e-5);
    qr /= len;
    qd /= len;
    // Extract exact translation t = 2 * (qd * conj(qr))
    vec3 t = 2.0 * (qr.w * qd.xyz - qd.w * qr.xyz + cross(qr.xyz, qd.xyz));
    posW = qRot(qr, aPos) + t;
    nrmW = normalize(qRot(qr, aNorm));
  }

  vWorldPos = posW;
  vNormal = nrmW;
  vUv = aUv;
  vMatId = aMatId;
  vPinch = pinch;
  gl_Position = uViewProj * vec4(posW, 1.0);
}`;

export const CHAR_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in float vMatId;
in float vPinch;

uniform vec3 uCamPos;
uniform int uFlatShade; // 1 for 1992-93 faceted Virtua Fighter / Alone in the Dark look!

out vec4 oCol;

void main() {
  vec3 N = uFlatShade == 1
    ? normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)))
    : normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 L = normalize(vec3(0.55, 0.85, 0.45));
  vec3 L2 = normalize(vec3(-0.7, 0.35, -0.5));

  int m = int(vMatId + 0.5);
  vec3 base = vec3(0.86, 0.84, 0.80); // 0: sculpted porcelain head/hands
  float rough = 0.42;
  if (m == 1) { base = vec3(0.18, 0.24, 0.34); rough = 0.55; }      // 1: athletic slate pants
  else if (m == 2) { base = vec3(0.92, 0.42, 0.22); rough = 0.44; } // 2: vivid tangerine jacket
  else if (m == 3) {
    // High-contrast striped/checkered twist sleeve so 180° LBS candy-wrapper vs DQS pops unmistakably!
    float chk = mod(floor(vUv.x * 8.0) + floor(vUv.y * 10.0), 2.0);
    base = mix(vec3(0.96, 0.92, 0.84), vec3(0.92, 0.36, 0.20), chk);
    // Subtle crimson warning tint right on severely pinched LBS vertices!
    base = mix(base, vec3(1.0, 0.16, 0.24), smoothstep(0.32, 0.78, vPinch) * 0.55);
    rough = 0.38;
  } else if (m == 4) {
    // Glowing cyan visor
    base = vec3(0.28, 0.90, 1.0); rough = 0.14;
  } else if (m == 5) {
    // Crisp white/amber athletic boots (highlights Foot IK contact on stone steps!)
    base = vec3(0.94, 0.72, 0.22); rough = 0.35;
  }

  float ndl = max(dot(N, L), 0.0);
  float fill = max(dot(N, L2), 0.0) * 0.32;
  float hemi = 0.26 + 0.20 * N.y;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), mix(64.0, 12.0, rough)) * (0.45 - 0.3 * rough);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.30;

  vec3 col = base * (hemi + ndl * 0.88 + fill * vec3(0.65, 0.82, 1.0)) + vec3(1.0, 0.96, 0.90) * spec + vec3(0.55, 0.78, 1.0) * rim;
  if (m == 4) col += vec3(0.18, 0.65, 0.85) * 0.65;

  // Clean ACES-like filmic rolloff + gamma
  col = col / (col + 0.65) * 1.28;
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  oCol = vec4(col, 1.0);
}`;

export const ARENA_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vNorm;
out vec2 vUv;
void main() {
  vPos = aPos;
  vNorm = aNorm;
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const ARENA_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNorm;
in vec2 vUv;
uniform vec3 uPelvisPos;
uniform vec3 uFootL;
uniform vec3 uFootR;
uniform float uShowFootRings;
uniform float uTime;
out vec4 oCol;

void main() {
  vec3 N = normalize(vNorm);
  vec3 L = normalize(vec3(0.55, 0.85, 0.45));
  float ndl = max(dot(N, L), 0.0);

  // Architectural warm stone tiles with crisp riser highlights on stairs
  vec2 g = abs(fract(vUv * 2.0 - 0.5) - 0.5) / max(fwidth(vUv * 2.0), vec2(0.002));
  float gridLine = 1.0 - smoothstep(0.0, 1.3, min(g.x, g.y));
  float isStepTop = smoothstep(0.02, 0.06, vPos.y);
  vec3 stone = mix(vec3(0.24, 0.27, 0.34), vec3(0.36, 0.38, 0.43), isStepTop);
  if (abs(N.y) < 0.7) stone = vec3(0.20, 0.23, 0.30); // darker vertical stair risers
  stone = mix(stone, vec3(0.52, 0.58, 0.68), gridLine * 0.24);

  // Soft contact shadow directly under pelvis + both feet
  float dP = length(vPos.xz - uPelvisPos.xz);
  float shP = smoothstep(0.18, 0.85, dP) * 0.45 + 0.55;
  float shL = smoothstep(0.08, 0.26, length(vPos.xz - uFootL.xz)) * 0.35 + 0.65;
  float shR = smoothstep(0.08, 0.26, length(vPos.xz - uFootR.xz)) * 0.35 + 0.65;
  float sh = min(shP, min(shL, shR));

  vec3 col = stone * (0.28 + 0.72 * ndl) * sh;

  // Glowing emerald Foot-IK contact target rings directly on the stone steps!
  if (uShowFootRings > 0.5) {
    float rL = abs(length(vPos.xz - uFootL.xz) - 0.145);
    float rR = abs(length(vPos.xz - uFootR.xz) - 0.145);
    float ring = (1.0 - smoothstep(0.008, 0.026, rL)) * smoothstep(0.26, 0.04, abs(vPos.y - uFootL.y))
               + (1.0 - smoothstep(0.008, 0.026, rR)) * smoothstep(0.26, 0.04, abs(vPos.y - uFootR.y));
    col += vec3(0.22, 0.96, 0.58) * clamp(ring, 0.0, 1.0) * 0.85;
  }

  // Soft radial fade at arena rim
  float edge = 1.0 - smoothstep(2.05, 2.72, max(abs(vPos.x), abs(vPos.z)));
  col = mix(vec3(0.14, 0.17, 0.22), col, edge);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  oCol = vec4(col, 1.0);
}`;

// 1989 Prince of Persia Rotoscoped 2D Pixel-Art Sprite Billboard (8 quantized VHS-traced run frames @ 12 fps!)
export const ROTO_VS = /* glsl */`#version 300 es
precision highp float;
uniform mat4 uViewProj;
uniform vec3 uPos;
uniform vec3 uCamRight;
out vec2 vUv;
void main() {
  vec2 c = vec2((gl_VertexID & 1) == 1 ? 1.0 : -1.0, (gl_VertexID & 2) == 2 ? 1.0 : 0.0);
  vUv = vec2(c.x * 0.5 + 0.5, c.y);
  vec3 p = uPos + uCamRight * (c.x * 0.65) + vec3(0.0, c.y * 1.82, 0.0);
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

export const ROTO_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime;
out vec4 oCol;

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  // Crisp 1989 32x48 pixel grid + authentic 12 fps frame-stepped rotoscope animation!
  vec2 grid = vec2(32.0, 48.0);
  vec2 p = (floor(vUv * grid) + 0.5) / grid;
  float frame = floor(uTime * 11.0);
  float ph = frame * 0.785398; // 8 discrete VHS-traced stride frames!
  float s = sin(ph), c = cos(ph);

  // Proportional rotoscoped Prince runner silhouette (white tunic, crimson sash, dark trousers)
  vec2 hip = vec2(0.50, 0.44 + abs(s) * 0.03);
  vec2 sh  = hip + vec2(0.04, 0.25);
  vec2 hd  = sh + vec2(0.03, 0.11);

  vec2 kL = hip + vec2( s * 0.14 + 0.04, -0.17 + max(0.0, c) * 0.06);
  vec2 fL = kL  + vec2( s * 0.10 - max(0.0, -c) * 0.11, -0.20 + max(0.0, c) * 0.05);
  vec2 kR = hip + vec2(-s * 0.14 + 0.04, -0.17 + max(0.0, -c) * 0.06);
  vec2 fR = kR  + vec2(-s * 0.10 - max(0.0,  c) * 0.11, -0.20 + max(0.0, -c) * 0.05);

  vec2 eL = sh + vec2(-s * 0.13, -0.11);
  vec2 hL = eL + vec2(-s * 0.08 + 0.08, -0.04 + max(0.0, -s) * 0.08);
  vec2 eR = sh + vec2( s * 0.13, -0.11);
  vec2 hR = eR + vec2( s * 0.08 + 0.08, -0.04 + max(0.0,  s) * 0.08);

  float dHead = length(p - hd) - 0.058;
  float dTorso = sdSeg(p, hip, sh) - 0.058;
  float dLegs = min(min(sdSeg(p, hip, kL), sdSeg(p, kL, fL)), min(sdSeg(p, hip, kR), sdSeg(p, kR, fR))) - 0.034;
  float dArms = min(min(sdSeg(p, sh, eL), sdSeg(p, eL, hL)), min(sdSeg(p, sh, eR), sdSeg(p, eR, hR))) - 0.028;
  float d = min(min(dHead, dTorso), min(dLegs, dArms));

  if (d > 0.018) discard;
  vec3 col = vec3(0.08, 0.06, 0.12); // crisp 1px dark rotoscope outline
  if (d <= 0.0) {
    if (dHead <= 0.0) col = p.y > hd.y + 0.015 ? vec3(0.32, 0.18, 0.10) : vec3(0.95, 0.76, 0.58);
    else if (dTorso <= 0.0) col = abs(p.y - (hip.y + 0.04)) < 0.028 ? vec3(0.88, 0.16, 0.22) : vec3(0.96, 0.94, 0.88);
    else if (dArms <= 0.0) col = vec3(0.92, 0.88, 0.80);
    else col = vec3(0.32, 0.36, 0.56); // blue trousers
  }
  oCol = vec4(col, 1.0);
}`;

// Overlay line/point shader for Skeleton X-Ray Bones & Motion Matching Future Trajectory!
export const LINE_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aCol;
uniform mat4 uViewProj;
uniform float uPointSize;
out vec3 vCol;
void main() {
  vCol = aCol;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  gl_PointSize = uPointSize;
}`;

export const LINE_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vCol;
out vec4 oCol;
void main() {
  oCol = vec4(vCol, 1.0);
}`;
