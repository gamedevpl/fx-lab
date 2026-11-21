// Evolution of 3D Pixel Art (1992-2023) — Interactive WebGL2 Multi-Era Diorama + Real Texel-Snapping + 4x Loupe.
//   0: 1992      Comanche Voxel Space (vertical heightmap terrain columns)
//   1: 1994      Donkey Kong Country Pre-rendered 3D -> 2D Sprites (8 discrete yaw snaps + 16-bit palette + Bayer dither)
//   2: 1997      Blood 3D Voxel Props (true cubic 3D grid-quantized voxel architecture & rotating windmill!)
//   3: 2018      Dead Cells 3D-to-Pixel-Art Pipeline (low-res no-AA 3D + cel-shaded normal bands + 1px ink outline)
//   4: 2018      Octopath Traveler HD-2D (crisp pixel-art adventurer sprite inside sunlit 3D diorama + tilt-shift DoF + bloom!)
//   5: 2018      Return of the Obra Dinn (Lucas Pope — 1-bit monochrome + sphere/world-locked dither toggle!)
//   6: 2019      A Short Hike Naive Low-Res 3D (tiny nearest-neighbor FBO — cozy look, wild pixel crawl & shimmer!)
//   7: 2021-2023 t3ssel8r Texel-Snapped Sub-Pixel Camera + Depth/Normal Outlines (rock-solid pixel grid + silky smooth scroll!)

// Pass 1: 3D Coastal Windmill Island Diorama (MRT: oCol = linear/sRGB color, oGeom = vec4(normal.xyz*0.5+0.5, linearDepth/20.0))
export const PIXEL3D_SCENE_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 oCol;
layout(location = 1) out vec4 oGeom;

uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect, uTime;
uniform float uOrthoSize;    // > 0.0 -> true Orthographic camera (t3ssel8r texel-snapped!); 0.0 -> Perspective
uniform int uMode;           // 0=Comanche, 1=DKC, 2=Blood Voxels, 3=DeadCells, 4=HD2D, 5=ObraDinn, 6=NaiveLowRes, 7=t3ssel8r
uniform float uQuantRot;     // 1.0 -> quantize windmill & camera yaw to 8 angles (DKC pre-rendered sprites!)
uniform float uLockDither;   // Obra Dinn: 1.0 = world/sphere-locked dither, 0.0 = swimming screen-space dither!
uniform vec2 uRenderRes;

const float PI = 3.14159265359;

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdCylinder(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdCone(vec3 p, float r, float h) {
  vec2 q = vec2(length(p.xz), p.y);
  vec2 tip = q - vec2(0.0, h);
  vec2 mantleDir = normalize(vec2(h, r));
  float mantle = dot(tip, mantleDir);
  float d = max(mantle, -q.y);
  float projected = dot(tip, vec2(mantleDir.y, -mantleDir.x));
  if (q.y > h && projected < 0.0) d = max(d, length(tip));
  if (q.x > r && projected > length(vec2(h, r))) d = max(d, length(q - vec2(r, 0.0)));
  return d;
}

float bayer4(vec2 p) {
  int x = int(mod(floor(p.x), 4.0));
  int y = int(mod(floor(p.y), 4.0));
  const float m[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[y * 4 + x] + 0.5) / 16.0;
}

// Crisp 12x12 pixel-art adventurer sprite standing on the island path (for HD-2D Octopath stage!)
bool evalHeroSprite(vec2 uv, out vec3 col) {
  vec2 g = floor(uv * vec2(12.0, 14.0));
  int x = int(g.x), y = int(g.y);
  col = vec3(0.0);
  if (x < 0 || x >= 12 || y < 0 || y >= 14) return false;
  // Boots
  if (y <= 1 && ((x >= 3 && x <= 4) || (x >= 7 && x <= 8))) { col = vec3(0.22, 0.14, 0.10); return true; }
  // Blue tunic + belt
  if (y >= 2 && y <= 6 && x >= 3 && x <= 8) {
    col = (y == 4) ? vec3(0.88, 0.68, 0.22) : vec3(0.16, 0.44, 0.84);
    if (x == 3 || x == 8) col *= 0.72;
    return true;
  }
  // Flowing crimson traveler cape + scarf
  if (y >= 3 && y <= 7 && (x == 2 || x == 9 || (y == 7 && x >= 3 && x <= 8))) {
    col = vec3(0.86, 0.18, 0.24); return true;
  }
  // Face + eyes
  if (y >= 8 && y <= 10 && x >= 4 && x <= 7) {
    col = vec3(0.96, 0.78, 0.64);
    if (y == 9 && (x == 4 || x == 7)) col = vec3(0.12, 0.14, 0.22);
    return true;
  }
  // Golden spiky traveler hair / hat
  if ((y == 11 && x >= 3 && x <= 8) || (y == 12 && x >= 4 && x <= 8) || (y == 13 && x >= 5 && x <= 7)) {
    col = vec3(0.95, 0.76, 0.24); return true;
  }
  // Glowing wooden staff on right side
  if (x == 10 && y >= 2 && y <= 11) {
    col = y >= 10 ? vec3(0.45, 0.96, 1.0) : vec3(0.54, 0.34, 0.18);
    return true;
  }
  return false;
}

// ============================================================================
// STAGE 0: 1992 COMANCHE VOXEL SPACE (Classic vertical heightmap column terrain!)
// ============================================================================
float comancheHeight(vec2 xz) {
  float r = length(xz);
  float island = exp(-r * r * 0.085) * 1.65;
  float hills = 0.55 * sin(xz.x * 0.52) * cos(xz.y * 0.48) + 0.28 * sin(xz.x * 1.15 + xz.y * 0.95);
  float ridge = exp(-pow(length(xz - vec2(-1.6, -1.2)), 2.0) * 0.35) * 1.25;
  return max(0.0, island + ridge + hills * exp(-r * 0.14));
}

vec3 shadeComancheVoxelSpace(vec3 ro, vec3 rd) {
  // Quantize screen into chunky 1992 320x200 vertical voxel columns!
  vec2 qUv = (floor(vUv * vec2(200.0, 125.0)) + 0.5) / vec2(200.0, 125.0);
  vec2 ndc = qUv * 2.0 - 1.0;
  vec3 r = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));

  // Classic sky bands
  vec3 col = mix(vec3(0.76, 0.88, 0.96), vec3(0.24, 0.52, 0.88), clamp(r.y * 1.4 + 0.15, 0.0, 1.0));
  if (r.y < 0.0) col = vec3(0.10, 0.44, 0.62); // sea

  // Discrete depth-slice terrain column march (classic NovaLogic Voxel Space!)
  float t = 0.4;
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + r * t;
    vec2 cell = floor(p.xz * 5.0) / 5.0; // chunky square voxel column grid!
    float h = comancheHeight(cell);
    if (p.y <= h) {
      float hN = comancheHeight(cell + vec2(0.18, 0.14));
      float slope = clamp((h - hN) * 2.6 + 0.55, 0.25, 1.15);
      vec3 c = h < 0.16 ? vec3(0.84, 0.76, 0.54)
             : (h < 0.95 ? vec3(0.24, 0.62, 0.28)
             : (h < 1.75 ? vec3(0.52, 0.48, 0.40) : vec3(0.86, 0.88, 0.92)));
      // Little voxel pine peaks
      float tree = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
      if (h > 0.35 && h < 1.25 && tree > 0.82) c = vec3(0.12, 0.42, 0.22);
      float fog = clamp(t / 24.0, 0.0, 0.72);
      col = mix(c * slope, vec3(0.68, 0.84, 0.94), fog);
      break;
    }
    t += 0.14 + t * 0.015;
    if (t > 22.0) break;
  }
  return col;
}

// ============================================================================
// CORE 3D COASTAL WINDMILL ISLAND DIORAMA (shared by Stages 1..7!)
// ============================================================================
vec2 mapDioramaRaw(vec3 p, float sailAngle) {
  float d = 1e9; float mat = 0.0;

  // Water plane at y = 0.0
  float dWater = p.y;
  if (dWater < d) { d = dWater; mat = 0.0; }

  // Stepped coastal grassy cliff island (radius ~2.35m, height ~0.58m)
  float dCliff = sdCylinder(p - vec3(0.0, 0.26, 0.0), 2.35, 0.28) - 0.08;
  float dGrassTop = sdCylinder(p - vec3(0.0, 0.52, 0.0), 2.28, 0.09) - 0.04;
  if (dCliff < d) { d = dCliff; mat = 1.0; }     // Warm limestone cliff rock
  if (dGrassTop < d) { d = dGrassTop; mat = 2.0; } // Lush grass meadow

  // Wooden lakeside pier jutting out into the turquoise water (+Z)
  float dPier = sdBox(p - vec3(0.0, 0.26, 2.65), vec3(0.42, 0.07, 0.65));
  if (dPier < d) { d = dPier; mat = 6.0; }

  // Cozy Timber-and-Stone Windmill Cottage centered at (-0.15, 0.58, -0.20)
  vec3 cp = p - vec3(-0.15, 0.58, -0.20);
  float dWall = sdBox(cp - vec3(0.0, 0.62, 0.0), vec3(0.76, 0.62, 0.68));
  if (dWall < d) { d = dWall; mat = 3.0; } // Cream plaster & timber walls

  // Steep pitched crimson shingled roof (diagonal edge = ULTIMATE pixel-shimmer torture test!)
  vec3 rp = cp - vec3(0.0, 1.24, 0.0);
  float roofSlope = max(abs(rp.x) * 0.76 + rp.y * 0.65 - 0.68, -rp.y);
  float dRoof = max(roofSlope, abs(rp.z) - 0.84);
  if (dRoof < d) { d = dRoof; mat = 4.0; } // Crimson tiled roof

  // Stone chimney sticking out of right roof slope
  float dChim = sdBox(cp - vec3(0.48, 1.66, -0.22), vec3(0.14, 0.34, 0.14));
  if (dChim < d) { d = dChim; mat = 1.0; }

  // Warm glowing arched doorway & golden lantern window on front face (+Z)
  float dWin = sdBox(cp - vec3(0.32, 0.68, 0.69), vec3(0.17, 0.19, 0.04));
  if (dWin < d) { d = dWin; mat = 7.0; } // Warm lantern glow!
  float dDoor = sdBox(cp - vec3(-0.28, 0.40, 0.69), vec3(0.20, 0.40, 0.04));
  if (dDoor < d) { d = dDoor; mat = 6.0; }

  // ROTATING 4-BLADE WOODEN WINDMILL ON FRONT GABLE (+Z = +0.76)!!
  // Thin spinning diagonal sails = 10/10 visual proof of Naive Shimmer vs Texel-Snapped Stability!
  vec3 wp = cp - vec3(-0.02, 1.26, 0.80);
  float dHub = length(wp) - 0.14;
  if (dHub < d) { d = dHub; mat = 6.0; }
  vec3 sp = wp;
  sp.xy = rot2(sailAngle) * sp.xy;
  // Cross arms + wide cloth sail frames
  float dArm1 = sdBox(sp, vec3(1.12, 0.06, 0.04));
  float dArm2 = sdBox(sp, vec3(0.06, 1.12, 0.04));
  float dSail1 = min(
    sdBox(sp - vec3( 0.66,  0.14, 0.02), vec3(0.36, 0.12, 0.02)),
    sdBox(sp - vec3(-0.66, -0.14, 0.02), vec3(0.36, 0.12, 0.02))
  );
  float dSail2 = min(
    sdBox(sp - vec3(-0.14,  0.66, 0.02), vec3(0.12, 0.36, 0.02)),
    sdBox(sp - vec3( 0.14, -0.66, 0.02), vec3(0.12, 0.36, 0.02))
  );
  float dArms = min(dArm1, dArm2);
  float dSails = min(dSail1, dSail2);
  if (dArms < d) { d = dArms; mat = 6.0; }
  if (dSails < d) { d = dSails; mat = 8.0; } // Warm cream windmill sails!

  // 3 Tiered Emerald Pine Trees around the cottage
  vec3 trees[3] = vec3[3](
    vec3(-1.42, 0.58, -0.55),
    vec3( 1.38, 0.58, -0.45),
    vec3(-1.18, 0.58,  0.95)
  );
  float scales[3] = float[3](1.05, 0.92, 0.78);
  for (int i = 0; i < 3; i++) {
    vec3 tp = (p - trees[i]) / scales[i];
    float dTr = sdCylinder(tp - vec3(0.0, 0.25, 0.0), 0.11, 0.25) * scales[i];
    if (dTr < d) { d = dTr; mat = 6.0; }
    float c1 = sdCone(tp - vec3(0.0, 0.36, 0.0), 0.58, 0.68);
    float c2 = sdCone(tp - vec3(0.0, 0.76, 0.0), 0.46, 0.62);
    float c3 = sdCone(tp - vec3(0.0, 1.12, 0.0), 0.32, 0.50);
    float dFol = min(c1, min(c2, c3)) * scales[i];
    if (dFol < d) { d = dFol; mat = 5.0; } // Tiered emerald pine needles
  }

  // Seaside glowing lantern post cleanly to the right along the pier edge (keeps doorway & windmill 100% open!)
  vec3 lp = p - vec3(1.24, 0.58, 1.32);
  float dPost = sdCylinder(lp - vec3(0.0, 0.42, 0.0), 0.055, 0.42);
  if (dPost < d) { d = dPost; mat = 6.0; }
  float dLamp = length(lp - vec3(0.0, 0.90, 0.0)) - 0.12;
  if (dLamp < d) { d = dLamp; mat = 7.0; }

  return vec2(d, mat);
}

// ============================================================================
// STAGE 2: 1997 BLOOD 3D VOXELS (True DDA grid-quantized cubic 3D voxels!)
// ============================================================================
vec3 shadeBloodVoxels(vec3 ro, vec3 rd, float sailAngle, out float outDepth, out vec3 outNorm) {
  float voxSize = 0.14;
  vec3 p = ro / voxSize;
  vec3 r = rd;
  // Advance ray into bounding sphere first
  float t0 = max(0.0, length(ro) - 5.2);
  p = (ro + rd * t0) / voxSize;

  vec3 mapP = floor(p);
  vec3 deltaD = abs(1.0 / max(abs(r), vec3(1e-5)));
  vec3 stepS = sign(r);
  vec3 sideD = (stepS * (mapP - p) + (stepS * 0.5) + 0.5) * deltaD;
  vec3 mask = vec3(0.0);
  float hitMat = -1.0;

  for (int i = 0; i < 110; i++) {
    vec3 worldCell = (mapP + 0.5) * voxSize;
    if (worldCell.y < -0.15) break;
    vec2 h = mapDioramaRaw(worldCell, sailAngle);
    if (h.x < voxSize * 0.48) {
      hitMat = h.y;
      break;
    }
    mask = step(sideD.xyz, sideD.yzx) * step(sideD.xyz, sideD.zxy);
    sideD += mask * deltaD;
    mapP += mask * stepS;
  }

  if (hitMat < 0.0) {
    outDepth = 20.0; outNorm = vec3(0, 1, 0);
    return mix(vec3(0.74, 0.88, 0.98), vec3(0.24, 0.54, 0.88), clamp(rd.y * 1.4 + 0.2, 0.0, 1.0));
  }

  vec3 n = -mask * stepS;
  if (length(n) < 0.5) n = vec3(0, 1, 0);
  outNorm = n;
  vec3 wp = (mapP + 0.5) * voxSize;
  outDepth = length(wp - ro);

  int m = int(floor(hitMat + 0.5));
  vec3 alb = vec3(0.5);
  if (m == 0) alb = vec3(0.14, 0.58, 0.76);
  else if (m == 1) alb = vec3(0.62, 0.56, 0.48);
  else if (m == 2) alb = vec3(0.32, 0.72, 0.30);
  else if (m == 3) alb = vec3(0.92, 0.86, 0.74);
  else if (m == 4) alb = vec3(0.84, 0.24, 0.22);
  else if (m == 5) alb = vec3(0.14, 0.52, 0.28);
  else if (m == 6) alb = vec3(0.48, 0.31, 0.18);
  else if (m == 7) return vec3(1.0, 0.86, 0.36);
  else if (m == 8) alb = vec3(0.96, 0.91, 0.78);

  vec3 sun = normalize(vec3(0.58, 0.78, 0.44));
  float ndl = max(dot(n, sun), 0.0);
  // Crisp face-dependent voxel shading!
  float faceTint = abs(n.y) > 0.5 ? 1.05 : (abs(n.x) > 0.5 ? 0.86 : 0.94);
  return alb * faceTint * (0.34 + 0.78 * ndl);
}

vec3 calcNormal(vec3 p, float sailAngle) {
  vec2 e = vec2(0.0025, 0.0);
  return normalize(vec3(
    mapDioramaRaw(p + e.xyy, sailAngle).x - mapDioramaRaw(p - e.xyy, sailAngle).x,
    mapDioramaRaw(p + e.yxy, sailAngle).x - mapDioramaRaw(p - e.yxy, sailAngle).x,
    mapDioramaRaw(p + e.yyx, sailAngle).x - mapDioramaRaw(p - e.yyx, sailAngle).x
  ));
}

float calcShadow(vec3 ro, vec3 rd, float sailAngle) {
  float res = 1.0, t = 0.06;
  for (int i = 0; i < 28; i++) {
    float h = mapDioramaRaw(ro + rd * t, sailAngle).x;
    if (h < 0.003) return 0.0;
    res = min(res, 7.5 * h / t);
    t += clamp(h, 0.03, 0.28);
    if (t > 6.5) break;
  }
  return clamp(res, 0.0, 1.0);
}

// Quantize color cleanly to retro 16-color/32-color palette (for Dead Cells / DKC!)
vec3 quantizePalette(vec3 c, float steps) {
  return floor(clamp(c, 0.0, 1.0) * steps + 0.5) / steps;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;

  // Orthographic (t3ssel8r Stage 7) vs Perspective (Stages 0..6)
  vec3 ro, rd;
  if (uOrthoSize > 0.0) {
    ro = uCamPos + uCamRight * (ndc.x * uAspect * uOrthoSize) + uCamUp * (ndc.y * uOrthoSize);
    rd = uCamFwd;
  } else {
    ro = uCamPos;
    rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));
  }

  // Windmill sail rotation (smooth continuous in normal stages; snapped to 8 discrete frames in DKC 1994!)
  float sailAngle = uQuantRot > 0.5
    ? floor(uTime * 3.0) * (PI / 4.0)
    : uTime * 0.72;

  if (uMode == 0) {
    vec3 c0 = shadeComancheVoxelSpace(ro, rd);
    oCol = vec4(c0, 1.0);
    oGeom = vec4(0.5, 1.0, 0.5, 1.0);
    return;
  }

  if (uMode == 2) {
    float vDepth; vec3 vNorm;
    vec3 c2 = shadeBloodVoxels(ro, rd, sailAngle, vDepth, vNorm);
    oCol = vec4(c2, 1.0);
    oGeom = vec4(vNorm * 0.5 + 0.5, clamp(vDepth / 20.0, 0.0, 1.0));
    return;
  }

  // Standard raymarch of the 3D Windmill Island Diorama
  float t = 0.04; vec2 hit = vec2(-1.0);
  for (int i = 0; i < 86; i++) {
    vec2 h = mapDioramaRaw(ro + rd * t, sailAngle);
    if (h.x < 0.0025) { hit = vec2(t, h.y); break; }
    t += max(h.x * 0.88, 0.004);
    if (t > 24.0) break;
  }

  // Stage 4 (HD-2D Octopath): Intersect crisp 2D Pixel-Art Adventurer billboard standing prominently on the sunlit path!
  bool hitSprite = false;
  vec3 spriteCol = vec3(0.0);
  float tSprite = 1e9;
  if (uMode == 4) {
    vec3 spCen = vec3(0.32, 0.98, 1.48);
    float denom = dot(rd, uCamFwd);
    if (abs(denom) > 0.01) {
      float ts = dot(spCen - ro, uCamFwd) / denom;
      if (ts > 0.1 && (hit.x < 0.0 || ts < hit.x)) {
        vec3 spHit = ro + rd * ts - spCen;
        float sx = dot(spHit, uCamRight) / 0.78 + 0.5;
        float sy = spHit.y / 0.92 + 0.5;
        vec3 sc;
        if (evalHeroSprite(vec2(sx, sy), sc)) {
          hitSprite = true; spriteCol = sc; tSprite = ts;
        }
      }
    }
  }

  if (hitSprite) {
    oCol = vec4(spriteCol * 1.06, 1.0);
    oGeom = vec4(-uCamFwd * 0.5 + 0.5, clamp(tSprite / 20.0, 0.0, 1.0));
    return;
  }

  // Sky gradient + fluffy pixel clouds
  if (hit.x < 0.0) {
    float sy = clamp(rd.y * 1.45 + 0.20, 0.0, 1.0);
    vec3 sky = mix(vec3(0.78, 0.90, 0.98), vec3(0.24, 0.56, 0.90), pow(sy, 0.72));
    if (uMode == 5) {
      // Obra Dinn 1-bit sky (exact screen-matched dot density!)
      vec2 spAng = vec2(atan(rd.x, rd.z), asin(clamp(rd.y, -1.0, 1.0)));
      vec2 dCoord = uLockDither > 0.5 ? spAng * 540.0 : gl_FragCoord.xy;
      float bit = step(bayer4(dCoord), 0.72 - sy * 0.35);
      sky = mix(vec3(0.14, 0.16, 0.13), vec3(0.92, 0.90, 0.80), bit);
    }
    oCol = vec4(sky, 1.0);
    oGeom = vec4(0.5, 0.5, 1.0, 1.0);
    return;
  }

  vec3 p = ro + rd * hit.x;
  vec3 n = calcNormal(p, sailAngle);
  int m = int(floor(hit.y + 0.5));

  vec3 alb = vec3(0.5);
  if (m == 0) {
    float wave = sin(p.x * 3.8 + uTime * 2.2) * cos(p.z * 3.4 - uTime * 1.8);
    float foam = smoothstep(2.58, 2.38, length(p.xz));
    alb = mix(vec3(0.11, 0.56, 0.76), vec3(0.24, 0.74, 0.88), wave * 0.5 + 0.5);
    alb = mix(alb, vec3(0.90, 0.96, 0.98), foam * 0.72);
  } else if (m == 1) {
    alb = vec3(0.60, 0.54, 0.46) * (0.90 + 0.10 * sin(p.y * 16.0));
  } else if (m == 2) {
    float path = smoothstep(0.42, 0.30, abs(p.x)) * step(0.3, p.z);
    alb = mix(vec3(0.30, 0.72, 0.30), vec3(0.76, 0.68, 0.54), path);
  } else if (m == 3) {
    // Cream plaster with dark timber framing beams
    float beam = step(0.44, abs(fract(p.x * 1.4) - 0.5)) + step(0.45, abs(fract(p.y * 1.6) - 0.5));
    alb = mix(vec3(0.92, 0.87, 0.75), vec3(0.36, 0.24, 0.16), clamp(beam, 0.0, 1.0) * 0.75);
  } else if (m == 4) {
    float shingle = step(0.42, abs(fract(p.y * 6.5) - 0.5));
    alb = mix(vec3(0.84, 0.24, 0.20), vec3(0.62, 0.15, 0.15), shingle * 0.55);
  } else if (m == 5) {
    alb = vec3(0.14, 0.54, 0.28);
  } else if (m == 6) {
    alb = vec3(0.48, 0.30, 0.17);
  } else if (m == 7) {
    alb = vec3(1.0, 0.84, 0.34);
  } else {
    alb = vec3(0.96, 0.92, 0.80); // cream windmill sails
  }

  vec3 sun = normalize(vec3(0.58, 0.78, 0.44));
  // Stage 7 (t3ssel8r): Quantize shadow sample point to world texel grid so cast shadows NEVER crawl either!!
  vec3 shadP = (uMode == 7) ? floor(p * 18.0 + 0.5) / 18.0 : p;
  float sh = (m == 0 || m == 7) ? 1.0 : calcShadow(shadP + n * 0.03, sun, sailAngle);
  float ndl = max(dot(n, sun), 0.0);

  // Warm lantern point glow
  vec3 lampP = vec3(0.86, 1.48, 1.38);
  float dL = length(lampP - p);
  float lampGlow = 0.85 / (0.35 + dL * dL * 1.6);

  vec3 lit;
  if (m == 7) {
    lit = (uMode == 5) ? vec3(0.92, 0.90, 0.80) : vec3(1.15, 0.90, 0.38);
  } else if (uMode == 3 || uMode == 7) {
    // Dead Cells (3) & t3ssel8r (7): crisp hue-shifted 3-band pixel-art cel lighting!
    float illum = ndl * (0.28 + 0.72 * sh);
    float band = illum < 0.22 ? 0.0 : (illum < 0.62 ? 0.55 : 1.0);
    vec3 shadeCol = mix(vec3(0.32, 0.38, 0.58), vec3(1.10, 1.03, 0.92), band);
    lit = alb * shadeCol + vec3(1.0, 0.68, 0.24) * lampGlow * 0.35;
  } else if (uMode == 1) {
    // 1994 DKC Pre-rendered SNES: glossy 90s Phong plastic highlight + 4x4 Bayer ordered dither into 16-bit palette!
    vec3 h = normalize(sun - rd);
    float spec = pow(max(dot(n, h), 0.0), 22.0) * 0.55;
    vec3 raw = alb * (0.28 + 0.84 * ndl * (0.35 + 0.65 * sh)) + vec3(spec);
    float b = bayer4(gl_FragCoord.xy) - 0.5;
    lit = quantizePalette(raw + b * 0.14, 5.0);
  } else if (uMode == 5) {
    // 2018 Return of the Obra Dinn (Lucas Pope): 1-BIT MONOCHROME WORLD/SPHERE-LOCKED DITHER!!
    float lum = clamp(dot(alb, vec3(0.299, 0.587, 0.114)) * (0.24 + 0.95 * ndl * (0.25 + 0.75 * sh)) + lampGlow * 0.25, 0.0, 1.0);
    vec2 spAng = vec2(atan(rd.x, rd.z), asin(clamp(rd.y, -1.0, 1.0)));
    vec2 dCoord = uLockDither > 0.5 ? (spAng * 540.0) : gl_FragCoord.xy;
    float bit = step(bayer4(dCoord), lum);
    lit = mix(vec3(0.14, 0.16, 0.13), vec3(0.92, 0.90, 0.80), bit);
  } else {
    // Stages 4 (HD-2D) & 6 (A Short Hike): warm cozy sunlight + distance fog!
    lit = alb * (vec3(0.32, 0.38, 0.52) + vec3(1.12, 1.02, 0.86) * ndl * (0.35 + 0.65 * sh))
        + vec3(1.0, 0.68, 0.24) * lampGlow * 0.42;
    if (uMode == 6) {
      // A Short Hike iconic warm pastel distance haze
      float fog = clamp((hit.x - 4.5) / 14.0, 0.0, 0.45);
      lit = mix(lit, vec3(0.84, 0.88, 0.94), fog);
    }
  }

  oCol = vec4(clamp(lit, 0.0, 1.25), 1.0);
  oGeom = vec4(n * 0.5 + 0.5, clamp(hit.x / 20.0, 0.0, 1.0));
}
`;

// Pass 2: Composite + Sub-Pixel Smooth Upscale + Depth/Normal Outlines + HD-2D Tilt-Shift DoF + 4x Loupe!
export const PIXEL3D_POST_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 oCol;

uniform sampler2D uColLeft, uGeomLeft;
uniform sampler2D uColRight, uGeomRight;
uniform vec2 uRes;
uniform vec2 uLowResLeft, uLowResRight;
uniform vec2 uSubPxLeft, uSubPxRight;   // Exact fractional sub-pixel shift [0..1) for silky t3ssel8r camera!
uniform float uSplitX;
uniform int uStageLeft, uStageRight;
uniform float uOutlineOn;
uniform vec2 uLoupeTarget;
uniform float uLoupeOn;

vec3 sampleStagePixel(sampler2D tCol, sampler2D tGeom, vec2 uv, vec2 lowRes, vec2 subPx, int stage) {
  // Stage 4 (HD-2D Octopath Traveler): Soft tilt-shift Depth-of-Field blur on top & bottom + warm golden bloom!
  if (stage == 4) {
    float focusBand = abs(uv.y - 0.48);
    float blurR = smoothstep(0.14, 0.46, focusBand) * 4.5;
    vec2 px = blurR / max(lowRes, vec2(1.0));
    vec3 acc = texture(tCol, uv).rgb * 0.36;
    acc += texture(tCol, clamp(uv + vec2( px.x,  px.y), vec2(0.002), vec2(0.998))).rgb * 0.16;
    acc += texture(tCol, clamp(uv + vec2(-px.x,  px.y), vec2(0.002), vec2(0.998))).rgb * 0.16;
    acc += texture(tCol, clamp(uv + vec2( px.x, -px.y), vec2(0.002), vec2(0.998))).rgb * 0.16;
    acc += texture(tCol, clamp(uv + vec2(-px.x, -px.y), vec2(0.002), vec2(0.998))).rgb * 0.16;
    // Warm HD-2D sunlight bloom glow on bright windows/lamps
    vec3 hi = max(acc - vec3(0.75), vec3(0.0));
    return clamp(acc + hi * 0.65, 0.0, 1.0);
  }

  // Exact sub-pixel compensated UV for t3ssel8r Stage 7 (silky 60fps scroll on locked world texels!)
  vec2 shiftedUv = clamp(uv + subPx / max(lowRes, vec2(1.0)), vec2(0.002), vec2(0.998));
  vec2 texel = 1.0 / max(lowRes, vec2(1.0));
  vec2 qUv = (floor(shiftedUv * lowRes) + 0.5) / lowRes;

  vec3 col = texture(tCol, qUv).rgb;

  // Stage 3 (Dead Cells), Stage 5 (Obra Dinn crisp ink edge), Stage 7 (t3ssel8r depth silhouette + bright normal creases!)
  if ((stage == 3 || stage == 5 || stage == 7) && uOutlineOn > 0.5) {
    vec4 gC = texture(tGeom, qUv);
    vec4 gR = texture(tGeom, clamp(qUv + vec2(texel.x, 0.0), vec2(0.002), vec2(0.998)));
    vec4 gL = texture(tGeom, clamp(qUv - vec2(texel.x, 0.0), vec2(0.002), vec2(0.998)));
    vec4 gU = texture(tGeom, clamp(qUv + vec2(0.0, texel.y), vec2(0.002), vec2(0.998)));
    vec4 gD = texture(tGeom, clamp(qUv - vec2(0.0, texel.y), vec2(0.002), vec2(0.998)));

    float dC = gC.w;
    float dDiff = max(max(gR.w - dC, gL.w - dC), max(gU.w - dC, gD.w - dC));
    vec3 nC = gC.xyz * 2.0 - 1.0;
    float nDiff = max(
      max(1.0 - dot(nC, gR.xyz * 2.0 - 1.0), 1.0 - dot(nC, gL.xyz * 2.0 - 1.0)),
      max(1.0 - dot(nC, gU.xyz * 2.0 - 1.0), 1.0 - dot(nC, gD.xyz * 2.0 - 1.0))
    );

    if (stage == 5) {
      // Obra Dinn crisp dark 1-bit ink silhouette contour!
      if (dDiff > 0.025 || nDiff > 0.42) col = vec3(0.12, 0.14, 0.11);
    } else if (stage == 3) {
      // Dead Cells dark silhouette outline + 16-color palette lock
      if (dDiff > 0.022) col *= 0.24;
    } else {
      // t3ssel8r signature: dark depth outer outline + subtle warm highlight on convex inner normal creases!
      if (dDiff > 0.024) col *= 0.32;
      else if (nDiff > 0.36 && dC < 0.95) col = mix(col, vec3(1.0, 0.96, 0.86), 0.26);
    }
  }
  return clamp(col, 0.0, 1.0);
}

vec3 evalFinalAt(vec2 uv) {
  bool isLeft = uSplitX > 0.0 && uv.x < uSplitX;
  if (isLeft) {
    return sampleStagePixel(uColLeft, uGeomLeft, uv, uLowResLeft, uSubPxLeft, uStageLeft);
  }
  return sampleStagePixel(uColRight, uGeomRight, uv, uLowResRight, uSubPxRight, uStageRight);
}

void main() {
  vec2 uv = vUv;
  vec3 col = evalFinalAt(uv);

  // Crisp amber split divider
  if (uSplitX > 0.0 && abs(uv.x - uSplitX) < 1.5 / uRes.x) {
    col = vec3(0.93, 0.65, 0.37);
  }

  // Interactive 4x Pixel Magnifier Loupe (zooms straight onto windmill blade & sloped roof edge!)
  if (uLoupeOn > 0.5) {
    float aspect = uRes.x / max(1.0, uRes.y);
    vec2 px = uv * uRes;
    vec2 tgtPx = uLoupeTarget * uRes;
    float boxSizePx = min(uRes.x, uRes.y) * 0.32;
    vec2 boxCen = aspect > 1.0
      ? vec2(uRes.x - boxSizePx * 0.62 - 26.0, uRes.y - boxSizePx * 0.62 - 76.0)
      : vec2(uRes.x - boxSizePx * 0.58 - 22.0, uRes.y * 0.62);
    vec2 boxHalf = vec2(boxSizePx * 0.5);
    vec2 retHalf = boxHalf * 0.25;

    // Reticle square
    vec2 dRet = abs(px - tgtPx) - retHalf;
    float retEdge = max(dRet.x, dRet.y);
    if (abs(retEdge) < 2.2 && dRet.x < 3.0 && dRet.y < 3.0) col = vec3(1.0, 0.84, 0.24);

    // Connector tether line
    vec2 seg = boxCen - tgtPx;
    float segLen = length(seg);
    if (segLen > 1.0) {
      vec2 dir = seg / segLen;
      float proj = clamp(dot(px - tgtPx, dir), length(retHalf) * 0.9, segLen - boxSizePx * 0.55);
      if (length((px - tgtPx) - dir * proj) < 1.35) col = mix(col, vec3(1.0, 0.84, 0.24), 0.72);
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
      if (min(abs(px.x - boxCen.x), abs(px.y - boxCen.y)) < 0.9 && length(px - boxCen) < 12.0) {
        col = mix(col, vec3(1.0, 0.86, 0.30), 0.65);
      }
    } else if (boxEdge < 3.5) {
      col = vec3(1.0, 0.84, 0.24);
    } else if (boxEdge < 5.5) {
      col = vec3(0.08, 0.09, 0.14);
    }
  }

  oCol = vec4(col, 1.0);
}
`;
