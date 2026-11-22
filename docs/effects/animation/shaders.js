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

// 1989 Rotoscope Light-Table: real CC BY 4.0 running footage (Arellano et al., PLOS ONE 2015) traced live into a 12 FPS EGA pixel sprite!
export const ROTO_VS = /* glsl */`#version 300 es
precision highp float;
uniform mat4 uViewProj;
uniform vec3 uPos;
uniform vec3 uCamRight;
out vec2 vUv;
void main() {
  vec2 c = vec2((gl_VertexID & 1) == 1 ? 1.0 : -1.0, (gl_VertexID & 2) == 2 ? 1.0 : 0.0);
  vUv = vec2(c.x * 0.5 + 0.5, c.y);
  vec3 p = uPos + uCamRight * (c.x * 0.96) + vec3(0.0, 0.04 + c.y * 1.92, 0.0);
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

export const ROTO_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uRotoAtlas;
uniform float uTime;
out vec4 oCol;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  // Rounded 1989 rotoscope light-table / studio monitor bezel
  float dOuter = sdRoundBox(vUv - 0.5, vec2(0.485, 0.485), 0.032);
  if (dOuter > 0.0) discard;

  float fi = mod(floor(uTime * 12.0), 12.0);
  vec2 scrMin = vec2(0.055, 0.095);
  float scrSize = 0.89;
  vec2 s = (vUv - scrMin) / scrSize;
  bool inScreen = (s.x >= 0.0 && s.x <= 1.0 && s.y >= 0.0 && s.y <= 1.0);

  if (!inScreen) {
    // Brushed studio monitor bezel + subtle rim highlight
    vec3 bezel = mix(vec3(0.055, 0.062, 0.082), vec3(0.105, 0.118, 0.148), vUv.y);
    float rim = smoothstep(-0.016, -0.002, dOuter);
    bezel += vec3(0.14, 0.17, 0.22) * rim;
    // Inner recessed screen frame shadow
    float dScr = sdRoundBox(vUv - (scrMin + scrSize * 0.5), vec2(scrSize * 0.5), 0.004);
    bezel *= mix(0.45, 1.0, smoothstep(0.0, 0.014, dScr));

    // Bottom 12-frame cinema filmstrip indicator bar (lights up active 12 FPS frame 0..11!)
    if (vUv.y >= 0.025 && vUv.y <= 0.068 && vUv.x >= 0.055 && vUv.x <= 0.945) {
      float fx = (vUv.x - 0.055) / 0.89 * 12.0;
      float idx = floor(fx);
      float cellX = fract(fx);
      float cellY = (vUv.y - 0.025) / 0.043;
      if (cellX > 0.10 && cellX < 0.90 && cellY > 0.14 && cellY < 0.86) {
        bool isActive = abs(idx - fi) < 0.5;
        vec3 pip = isActive ? vec3(0.28, 0.96, 1.0) : vec3(0.16, 0.20, 0.28);
        if (isActive) pip += vec3(0.25, 0.18, 0.0) * smoothstep(0.5, 0.0, abs(cellX - 0.5));
        bezel = pip;
      } else {
        bezel = vec3(0.03, 0.035, 0.048);
      }
    }
    oCol = vec4(bezel, 1.0);
    return;
  }

  // Exact 1:1 tile coordinates (Row 0 = real CC BY 4.0 footage, Row 1 = traced 1989 EGA sprite)
  float tx = clamp(s.x, 0.008, 0.992);
  float ty = clamp(1.0 - s.y, 0.008, 0.992);
  float tileBase = fi / 12.0;
  float tileW = 1.0 / 12.0;

  // Sample real VHS frame with gentle horizontal analog chroma bleed (strictly clamped within tile!)
  float txL = clamp(tx - 0.0045, 0.008, 0.992);
  float txR = clamp(tx + 0.0045, 0.008, 0.992);
  vec3 rawC = texture(uRotoAtlas, vec2(tileBase + tx  * tileW, ty * 0.5)).rgb;
  vec3 rawL = texture(uRotoAtlas, vec2(tileBase + txL * tileW, ty * 0.5)).rgb;
  vec3 rawR = texture(uRotoAtlas, vec2(tileBase + txR * tileW, ty * 0.5)).rgb;
  vec3 vhs = vec3(
    mix(rawC.r, rawR.r, 0.35),
    0.50 * rawC.g + 0.25 * rawL.g + 0.25 * rawR.g,
    mix(rawC.b, rawL.b, 0.35)
  );
  // Subtle 1989 CRT scanlines & analog film grain
  float scan = 0.90 + 0.10 * sin(s.y * 280.0);
  float grain = (hash21(floor(s * 128.0) + vec2(fi * 7.1, fi * 13.7)) - 0.5) * 0.035;
  vhs = clamp(vhs * scan + grain, 0.0, 1.0);
  vhs = mix(vhs, smoothstep(vec3(0.03), vec3(0.97), vhs), 0.35);

  // Sample exact pixel-locked 1989 EGA sprite (Row 1) + 4-neighbor silhouette edge for live cyan trace outline!
  vec2 uvSpr = vec2(tileBase + tx * tileW, 0.5 + ty * 0.5);
  vec4 spr = texture(uRotoAtlas, uvSpr);
  float stepX = 1.0 / 48.0;
  float stepY = 1.0 / 48.0;
  float aL = texture(uRotoAtlas, vec2(tileBase + clamp(tx - stepX, 0.008, 0.992) * tileW, 0.5 + ty * 0.5)).a;
  float aR = texture(uRotoAtlas, vec2(tileBase + clamp(tx + stepX, 0.008, 0.992) * tileW, 0.5 + ty * 0.5)).a;
  float aU = texture(uRotoAtlas, vec2(tileBase + tx * tileW, 0.5 + clamp(ty - stepY, 0.008, 0.992) * 0.5)).a;
  float aD = texture(uRotoAtlas, vec2(tileBase + tx * tileW, 0.5 + clamp(ty + stepY, 0.008, 0.992) * 0.5)).a;
  float sprOutline = (spr.a > 0.5 && min(min(aL, aR), min(aU, aD)) < 0.5) ? 1.0 : 0.0;

  // Live animated rotoscoping trace laser sweeping left <-> right across the real runner (exact 4.5s period)!
  float traceX = 0.50 + 0.42 * sin(uTime * 1.3962634);
  float nearBeam = exp(-abs(s.x - traceX) * 14.0);

  // Left of sweep: Real CC BY 4.0 VHS footage + animator's cyan pixel tracing grid + glowing traced contour!
  vec2 pGrid = abs(fract(s * 48.0) - 0.5);
  float gridLine = step(0.43, max(pGrid.x, pGrid.y));
  vec3 vhsSide = vhs;
  vhsSide = mix(vhsSide, vec3(0.20, 0.85, 1.0), gridLine * (0.10 + 0.24 * nearBeam));
  vhsSide = mix(vhsSide, vec3(0.18, 0.92, 1.0), spr.a * (0.08 + 0.16 * nearBeam));
  vhsSide = mix(vhsSide, vec3(0.32, 0.98, 1.0), sprOutline * (0.82 + 0.18 * nearBeam));
  // Blinking red VCR REC indicator dot (top-left of VHS pane)
  float dRec = length(s - vec2(0.085, 0.915));
  float recBlink = step(0.35, fract(uTime * 1.4));
  if (dRec < 0.022) {
    vhsSide = mix(vec3(0.28, 0.04, 0.06), vec3(1.0, 0.18, 0.20), recBlink);
  } else if (dRec < 0.036 && recBlink > 0.5) {
    vhsSide += vec3(0.45, 0.06, 0.08) * smoothstep(0.036, 0.022, dRec);
  }

  // Right of sweep: 1989 Prince of Persia scrolling stone palace dungeon + crisp EGA traced sprite!
  vec2 qPix = floor(s * 48.0) / 48.0;
  float scrollX = uTime * 0.52;
  vec2 bUv = vec2(qPix.x + scrollX, qPix.y);
  float rowIdx = floor(bUv.y * 12.0);
  float brickOff = mod(rowIdx, 2.0) * 0.5;
  vec2 brickCell = vec2(bUv.x * 5.0 + brickOff, bUv.y * 12.0);
  vec2 bf = fract(brickCell);
  float mortar = (bf.x < 0.07 || bf.y < 0.11) ? 1.0 : 0.0;
  float brickVar = hash21(floor(brickCell));
  vec3 palBg = mix(vec3(0.11, 0.08, 0.17), vec3(0.18, 0.13, 0.24), brickVar);
  float torchDist = length(vec2(fract(bUv.x * 0.85) - 0.5, qPix.y - 0.62) * vec2(1.4, 1.0));
  float torchFlicker = 0.88 + 0.12 * sin(uTime * 13.0 + sin(uTime * 5.7));
  palBg += vec3(0.38, 0.18, 0.06) * exp(-torchDist * 4.2) * torchFlicker;
  palBg = mix(palBg, vec3(0.04, 0.03, 0.07), mortar * 0.85);
  // Palace stone floor ledge under runner's boots
  if (qPix.y < 0.085) {
    float flTile = step(0.08, fract((qPix.x + scrollX) * 6.0));
    palBg = mix(vec3(0.06, 0.05, 0.10), vec3(0.24, 0.19, 0.28), flTile);
    if (qPix.y > 0.062) palBg += vec3(0.12, 0.09, 0.13);
  }
  float footSh = smoothstep(0.22, 0.02, length(vec2((s.x - 0.52) * 1.1, (s.y - 0.078) * 5.2)));
  palBg *= (1.0 - 0.55 * footSh);
  palBg = mix(palBg, vec3(0.22, 0.68, 0.82), gridLine * 0.18 * nearBeam);
  vec3 sprSide = mix(palBg, spr.rgb, step(0.5, spr.a));

  // Combine VHS (left) -> Traced Sprite (right) across live tracing sweep!
  vec3 col = s.x < traceX ? vhsSide : sprSide;

  // Luminous cyan-to-gold tracing laser + hot digitizer spark where beam intersects the runner!
  float dBeam = abs(s.x - traceX);
  float beamCore = exp(-dBeam * 145.0);
  float beamGlow = exp(-dBeam * 32.0);
  col += vec3(0.22, 0.90, 1.0) * beamGlow * 0.42;
  col += mix(vec3(0.60, 0.98, 1.0), vec3(1.0, 0.86, 0.32), spr.a) * beamCore * 1.15;

  // Subtle CRT glass vignette at screen corners
  vec2 v2 = (s - 0.5) * 2.0;
  col *= 1.0 - 0.12 * dot(v2, v2);
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
