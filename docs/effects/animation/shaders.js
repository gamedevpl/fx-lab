// WebGL2 Shaders for Evolution of Character Animation (1989-2020) — Real 22-Bone 4-Weight Xbot Rig:
//   - Genuine 4-Bone GPU Rigid 1-Bone, Quake MDL Per-Vertex Morph, Linear Blend Skinning (LBS),
//     and exact Kavan et al. (I3D 2007) Unit Dual Quaternion Skinning (DQS)!
//   - Sleek AAA studio PBR shading on Xbot (brushed dark titanium joints + matte ceramic armor + forearm twist rings!)
//   - Architectural sunlit stone staircase arena + 1989 Prince of Persia Rotoscoped 2D Sprite + X-Ray Skeleton / Trajectory!

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform int uRetro;
uniform float uTime;
void main() {
  vec3 top = uRetro == 1 ? vec3(0.07, 0.05, 0.14) : vec3(0.09, 0.13, 0.22);
  vec3 mid = uRetro == 1 ? vec3(0.18, 0.10, 0.20) : vec3(0.19, 0.26, 0.38);
  vec3 bot = uRetro == 1 ? vec3(0.09, 0.07, 0.12) : vec3(0.11, 0.14, 0.19);
  float y = vUv.y;
  vec3 col = y > 0.42 ? mix(mid, top, smoothstep(0.42, 1.0, y)) : mix(bot, mid, smoothstep(0.0, 0.42, y));
  float ph = (uTime / 36.0) * 6.2831853;
  vec2 gc = vec2(0.50 + sin(ph * 3.0) * 0.14, 0.56 + cos(ph * 2.0) * 0.06);
  float glow = exp(-length((vUv - gc) * vec2(1.3, 2.0)) * 2.2);
  col += (uRetro == 1 ? vec3(0.36, 0.20, 0.10) : vec3(0.26, 0.21, 0.15)) * glow;
  if (uRetro == 1) {
    float px = fract(vUv.x * 2.5 + uTime * 0.55);
    float arch = smoothstep(0.04, 0.08, abs(px - 0.5)) * smoothstep(0.85, 0.42, vUv.y);
    col = mix(col * 0.65, col * 1.18, arch * 0.45);
  }
  oCol = vec4(col, 1.0);
}`;

export const CHAR_VS = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec4 aBones;
layout(location = 3) in vec4 aWeights;
layout(location = 4) in float aMatId;

uniform mat4 uViewProj;
uniform mat4 uBones[22];
uniform mat4 uBonesB[22];   // Keyframe B for Stage 2 (1996 Quake MDL per-vertex morph!)
uniform vec4 uDqReal[22];
uniform vec4 uDqDual[22];
uniform int uDeformMode;    // 0=Rigid 1-Bone, 1=Quake Vertex Morph, 2=4-Bone LBS, 3=4-Bone Dual Quaternion (Kavan 2007)
uniform float uMorphT;

out vec3 vWorldPos;
out vec3 vBindPos;
out vec3 vNormal;
out float vMatId;
out float vPinch;
out float vForearmMask;

vec3 qRot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  ivec4 b = ivec4(aBones + 0.5);
  vec4 w = aWeights;
  float wSum = max(w.x + w.y + w.z + w.w, 1e-5);
  w /= wSum;

  // Mask forearm twist region (bones 8/9 LeftForeArm-Hand and 12/13 RightForeArm-Hand) for crisp helical twist bands!
  float faW = 0.0;
  for (int k = 0; k < 4; k++) {
    int bi = b[k];
    if (bi == 8 || bi == 9 || bi == 12 || bi == 13) faW += w[k];
  }
  vForearmMask = smoothstep(0.45, 0.85, faW) * smoothstep(0.36, 0.46, abs(aPos.x)) * smoothstep(0.76, 0.68, abs(aPos.x));

  vec3 posW = aPos;
  vec3 nrmW = aNorm;
  float pinch = 0.0;

  if (uDeformMode == 0) {
    // 1992-93 Rigid single-bone polygon puppet (Alone in the Dark / Virtua Fighter):
    // Inset boundary vertices along joint seams so unmistakable mechanical gaps appear between rigid blocks!
    mat4 M = uBones[b.x];
    posW = (M * vec4(aPos, 1.0)).xyz;
    float jointSeam = clamp(w.y + w.z + w.w, 0.0, 1.0);
    posW -= normalize(mat3(M) * aNorm + vec3(1e-5)) * (jointSeam * 0.036);
    nrmW = normalize(mat3(M) * aNorm);
  } else if (uDeformMode == 1) {
    // 1996 Quake MDL Per-Vertex Linear Interpolation between discrete keyframes -> limbs visibly shrink mid-arc!
    mat4 MA = uBones[b.x]  * w.x + uBones[b.y]  * w.y + uBones[b.z]  * w.z + uBones[b.w]  * w.w;
    mat4 MB = uBonesB[b.x] * w.x + uBonesB[b.y] * w.y + uBonesB[b.z] * w.z + uBonesB[b.w] * w.w;
    vec3 pA = (MA * vec4(aPos, 1.0)).xyz;
    vec3 pB = (MB * vec4(aPos, 1.0)).xyz;
    posW = mix(pA, pB, uMorphT);
    vec3 rawN = mix(mat3(MA) * aNorm, mat3(MB) * aNorm, uMorphT);
    // Measure linear-chord normal/volume collapse so viewer sees Quake MDL limb "swimming" directly!
    pinch = clamp((1.0 - length(rawN)) * 2.8 + length(pB - pA) * 4.0 * uMorphT * (1.0 - uMorphT), 0.0, 1.0);
    nrmW = normalize(rawN + vec3(1e-5));
  } else if (uDeformMode == 2) {
    // 4-Bone Linear Blend Skinning (LBS): weighted matrix average -> authentic 180° candy-wrapper collapse!
    mat4 M = uBones[b.x] * w.x + uBones[b.y] * w.y + uBones[b.z] * w.z + uBones[b.w] * w.w;
    posW = (M * vec4(aPos, 1.0)).xyz;
    vec3 rawN = mat3(M) * aNorm;
    pinch = clamp(1.0 - length(rawN), 0.0, 1.0);
    nrmW = normalize(rawN + vec3(1e-5));
  } else {
    // Exact 4-Bone Unit Dual Quaternion Skinning (Kavan et al., I3D 2007) — zero volume loss!
    vec4 qr0 = uDqReal[b.x], qd0 = uDqDual[b.x];
    vec4 qr = qr0 * w.x;
    vec4 qd = qd0 * w.x;
    for (int k = 1; k < 4; k++) {
      float wk = w[k];
      if (wk > 1e-4) {
        int bk = b[k];
        vec4 qrk = uDqReal[bk], qdk = uDqDual[bk];
        if (dot(qr0, qrk) < 0.0) { qrk = -qrk; qdk = -qdk; }
        qr += qrk * wk;
        qd += qdk * wk;
      }
    }
    float len = max(length(qr), 1e-5);
    qr /= len;
    qd /= len;
    vec3 t = 2.0 * (qr.w * qd.xyz - qd.w * qr.xyz + cross(qr.xyz, qd.xyz));
    posW = qRot(qr, aPos) + t;
    nrmW = normalize(qRot(qr, aNorm));
  }

  vWorldPos = posW;
  vBindPos = aPos;
  vNormal = nrmW;
  vMatId = aMatId;
  vPinch = pinch;
  gl_Position = uViewProj * vec4(posW, 1.0);
}`;

export const CHAR_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vBindPos;
in vec3 vNormal;
in float vMatId;
in float vPinch;
in float vForearmMask;

uniform vec3 uCamPos;
uniform int uFlatShade;
uniform float uShowTwistPattern;

out vec4 oCol;

void main() {
  vec3 N = uFlatShade == 1
    ? normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)))
    : normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 L1 = normalize(vec3(0.55, 0.85, 0.55));
  vec3 L2 = normalize(vec3(-0.75, 0.35, -0.45));

  bool isJoint = vMatId < 0.5;
  // Sleek Xbot studio palette: brushed gunmetal joints + athletic pearl-slate shell + tangerine tech accents!
  vec3 base = isJoint ? vec3(0.14, 0.17, 0.24) : vec3(0.84, 0.82, 0.78);
  float metal = isJoint ? 0.65 : 0.14;
  float rough = isJoint ? 0.24 : 0.36;

  // Authentic 1992-93 Virtua Fighter / Alone in the Dark flat-shaded retro color-blocked puppet look!
  if (uFlatShade == 1) {
    base = isJoint ? vec3(0.08, 0.09, 0.12)
         : (vBindPos.y > 1.48 ? vec3(0.92, 0.78, 0.62)
         : (vBindPos.y > 0.94 ? vec3(0.20, 0.44, 0.88) : vec3(0.86, 0.84, 0.78)));
    rough = 0.82;
    metal = 0.0;
  } else if (!isJoint && uShowTwistPattern > 0.5 && vForearmMask > 0.05) {
    float ang = atan(vBindPos.y - 1.438, vBindPos.z + 0.05);
    float chk = mod(floor((ang / 3.14159) * 4.0 + 4.0) + floor(abs(vBindPos.x) * 28.0), 2.0);
    vec3 stripeCol = mix(vec3(0.95, 0.92, 0.86), vec3(0.94, 0.38, 0.18), chk);
    base = mix(base, stripeCol, vForearmMask);
    // Crimson heat highlight directly on severely collapsed LBS candy-wrapper pinch!
    base = mix(base, vec3(1.0, 0.14, 0.24), smoothstep(0.22, 0.68, vPinch) * 0.65 * vForearmMask);
  } else if (!isJoint) {
    // Sleek subtle orange visor/chest accent & dark athletic lower boots for instant silhouette clarity!
    float isBoot = smoothstep(0.22, 0.12, vBindPos.y);
    float isPants = smoothstep(0.96, 0.86, vBindPos.y) * (1.0 - isBoot);
    base = mix(base, vec3(0.22, 0.28, 0.38), isPants * 0.78);
    base = mix(base, vec3(0.92, 0.62, 0.18), isBoot * 0.88);
    // Highlight Quake MDL chord-shrink swim in warm amber when uShowTwistPattern < -0.5!
    if (uShowTwistPattern < -0.5) {
      base = mix(base, vec3(1.0, 0.52, 0.16), smoothstep(0.22, 0.72, vPinch) * 0.62);
    }
    if (vBindPos.y > 1.57 && vBindPos.y < 1.65 && vBindPos.z > 0.04) {
      base = vec3(0.20, 0.88, 1.0); // crisp cyan visor glow!
    }
  }

  float ndl1 = max(dot(N, L1), 0.0);
  float ndl2 = max(dot(N, L2), 0.0);
  float hemi = 0.22 + 0.22 * N.y;

  vec3 H1 = normalize(L1 + V);
  float specPow = mix(96.0, 18.0, rough);
  float spec = pow(max(dot(N, H1), 0.0), specPow) * mix(0.35, 1.15, metal);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.2) * 0.34;

  vec3 specTint = mix(vec3(1.0, 0.97, 0.92), base * 1.4, metal);
  vec3 col = base * (hemi * vec3(0.75, 0.84, 1.0) + ndl1 * vec3(1.08, 1.02, 0.94) + ndl2 * vec3(0.28, 0.40, 0.56))
           + specTint * spec + vec3(0.55, 0.78, 1.0) * rim;
  if (!isJoint && vBindPos.y > 1.57 && vBindPos.y < 1.65 && vBindPos.z > 0.04) {
    col += vec3(0.14, 0.62, 0.85) * 0.55;
  }

  col = col / (col + 0.62) * 1.26;
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
  vPos = aPos; vNorm = aNorm; vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const ARENA_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNorm;
in vec2 vUv;
uniform vec4 uShadowPts[8]; // Height-aware directional & contact AO shadow capsules (xyz + radius)!
uniform vec3 uFootL;
uniform vec3 uFootR;
uniform float uShowFootRings;
uniform vec2 uFloorScroll;
uniform float uTime;
out vec4 oCol;

void main() {
  vec3 N = normalize(vNorm);
  vec3 L = normalize(vec3(0.55, 0.85, 0.55));
  float ndl = max(dot(N, L), 0.0);

  vec2 tileUv = vUv * 2.0 + uFloorScroll * uTime;
  vec2 g = abs(fract(tileUv - 0.5) - 0.5) / max(fwidth(tileUv), vec2(0.002));
  float gridLine = 1.0 - smoothstep(0.0, 1.4, min(g.x, g.y));

  float isStepTop = smoothstep(0.02, 0.05, vPos.y);
  vec3 stone = mix(vec3(0.20, 0.23, 0.30), vec3(0.32, 0.35, 0.42), isStepTop);
  if (abs(N.y) < 0.72) stone = vec3(0.16, 0.19, 0.26); // crisp darker risers
  stone = mix(stone, vec3(0.54, 0.62, 0.74), gridLine * 0.28);

  // Height-aware multi-bone contact AO + grounded directional drop shadows (tight & dark right on contact, soft when airborne!)
  float contactAO = 1.0;
  float dirShadow = 1.0;
  for (int i = 0; i < 8; i++) {
    vec4 sp = uShadowPts[i];
    if (sp.w <= 0.001) continue;
    float dy = sp.y - vPos.y;
    if (dy < -0.14 || dy > 2.2) continue;
    float hAbove = max(0.0, dy);
    // Crisp dark contact ambient occlusion directly beneath boots, knees, hips, torso & head!
    float cRad = sp.w * (1.0 + hAbove * 0.95);
    float dC = length(vPos.xz - sp.xz);
    float hFade = exp(-hAbove * 2.2);
    float aoOcc = (1.0 - smoothstep(cRad * 0.20, cRad * 1.48, dC)) * hFade * 0.86;
    contactAO = min(contactAO, 1.0 - aoOcc);

    // Directional key-light projection shadow along -L.xz onto steps/floor!
    vec2 projXZ = sp.xz - (L.xz / L.y) * hAbove;
    float sRad = sp.w * (1.18 + hAbove * 0.42);
    float dS = length(vPos.xz - projXZ);
    float sOcc = (1.0 - smoothstep(sRad * 0.32, sRad * 1.68, dS)) * exp(-hAbove * 0.40) * 0.56;
    dirShadow = min(dirShadow, 1.0 - sOcc);
  }
  vec3 col = stone * (0.24 * contactAO + 0.76 * ndl * dirShadow * mix(0.45, 1.0, contactAO));

  if (uShowFootRings > 0.5) {
    float rL = abs(length(vPos.xz - uFootL.xz) - 0.155);
    float rR = abs(length(vPos.xz - uFootR.xz) - 0.155);
    float ring = (1.0 - smoothstep(0.008, 0.028, rL)) * smoothstep(0.24, 0.03, abs(vPos.y - uFootL.y + 0.08))
               + (1.0 - smoothstep(0.008, 0.028, rR)) * smoothstep(0.24, 0.03, abs(vPos.y - uFootR.y + 0.08));
    col += vec3(0.20, 0.96, 0.58) * clamp(ring, 0.0, 1.0) * 0.90;
  }

  float edge = 1.0 - smoothstep(2.45, 3.18, max(abs(vPos.x), abs(vPos.z)));
  col = mix(vec3(0.11, 0.14, 0.19), col, edge);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  oCol = vec4(col, 1.0);
}`;

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
  vec2 grid = vec2(32.0, 48.0);
  vec2 p = (floor(vUv * grid) + 0.5) / grid;
  float ph = floor(uTime * 11.0) * 0.785398;
  float s = sin(ph), c = cos(ph);
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
  vec3 col = vec3(0.08, 0.06, 0.12);
  if (d <= 0.0) {
    if (dHead <= 0.0) col = p.y > hd.y + 0.015 ? vec3(0.32, 0.18, 0.10) : vec3(0.95, 0.76, 0.58);
    else if (dTorso <= 0.0) col = abs(p.y - (hip.y + 0.04)) < 0.028 ? vec3(0.88, 0.16, 0.22) : vec3(0.96, 0.94, 0.88);
    else if (dArms <= 0.0) col = vec3(0.92, 0.88, 0.80);
    else col = vec3(0.32, 0.36, 0.56);
  }
  oCol = vec4(col, 1.0);
}`;

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
void main() { oCol = vec4(vCol, 1.0); }`;
