// Evolution of Portals & Impossible Spaces (1994-2023) — Interactive WebGL2 SDF Ray-Teleportation Engine.
//   0: 1994 Marathon Overlapping Spaces (two rooms occupy the exact same 3D coordinates behind a divider!)
//   1: 1996 Build / Duke Nukem 3D Overlapping Sectors & Portal Mirror (plus Descent '95; Sector Glitch toggle!)
//   2: 2006 Prey Fixed 3D Portals (plus Narbacular Drop '05; tilted alien-tech portal + flying energy orbs!)
//   3: 2007 Portal Recursive Portals (Blue <-> Orange 8-bounce curved infinite corridor; Depth 1 vs 8; click to shift!)
//   4: 2013 Antichamber Non-Euclidean Shifting Rooms (room transforms behind your back when looking away!)
//   5: 2018 CodeParade Bigger-on-the-Inside Tunnel (tiny 1.8m exterior pavilion holds a 22m infinity hall!)
//   6: 2022 Portal with RTX (moody glossy chamber — blazing golden light beam, crisp shadows & reflections THROUGH portals!)
//   7: 2023 Viewfinder Photo-to-3D Reality (2D Polaroid stamps real 3D sunlit Mediterranean archway & sky into concrete room!)

export const PORTALS_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 oCol;

uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect, uTime;
uniform vec2 uRes;
uniform float uSplitX;
uniform int uStageLeft, uStageRight;
uniform float uDebugOn;     // Per-stage action toggle
uniform vec2 uOrangeOff;    // Interactive clickable portal offset [x, y] on Stages 3 & 6
uniform float uShiftState;  // Antichamber room variant (0 or 1)
uniform float uPhotoStamp;  // Viewfinder photo-stamp blend (0=floating 2D Polaroid, 1=real 3D world!)

const float PI = 3.14159265359;

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdCylinder(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float gridLine(vec2 p, float scale, float width) {
  vec2 g = abs(fract(p * scale - 0.5) - 0.5) / max(fwidth(p * scale), vec2(0.004));
  float l = min(g.x, g.y);
  return 1.0 - clamp(l / width, 0.0, 1.0);
}

// ============================================================================
// STAGE 0 (1994 Marathon) & STAGE 1 (1996 Build / Duke Nukem 3D)
// ============================================================================
vec2 mapMarathonRoom(vec3 p, int sector) {
  float d = p.y; float mat = 0.0;
  float dCeil = 3.6 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dBack = p.z + 3.4; if (dBack < d) { d = dBack; mat = 2.0; }
  float dFront = 3.4 - p.z; if (dFront < d) { d = dFront; mat = 2.0; }
  float dL = p.x + 3.4; if (dL < d) { d = dL; mat = 2.0; }
  float dR = 3.4 - p.x; if (dR < d) { d = dR; mat = 2.0; }

  float dPil = sdBox(p - vec3(0.0, 1.8, -0.2), vec3(0.56, 1.8, 0.56));
  if (dPil < d) { d = dPil; mat = 3.0; }

  if (sector == 0) {
    float dStep = sdBox(p - vec3(-1.85, 0.35, -1.75), vec3(0.65, 0.35, 0.65));
    if (dStep < d) { d = dStep; mat = 4.0; }
    float dOrb = length(p - vec3(-1.85, 1.35 + sin(uTime * 2.2) * 0.12, -1.75)) - 0.36;
    if (dOrb < d) { d = dOrb; mat = 5.0; }
  } else {
    float dCol = sdCylinder(p - vec3(1.65, 1.8, -1.55), 0.32, 1.8);
    if (dCol < d) { d = dCol; mat = 6.0; }
    vec2 rp = rot2(uTime * 0.9) * (p.xz - vec2(-1.65, -1.55));
    float dCrys = sdBox(vec3(rp.x, p.y - 1.45, rp.y), vec3(0.34));
    if (dCrys < d) { d = dCrys; mat = 7.0; }
  }
  return vec2(d, mat);
}

vec3 shadeMarathon(vec3 ro, vec3 rd, bool isDuke, bool glitchOn) {
  int sector = ro.x > 0.0 ? 1 : 0;
  float t = 0.05;
  int hitSector = sector;
  vec2 hit = vec2(-1.0);
  bool crossedMirror = false;

  for (int i = 0; i < 84; i++) {
    vec3 p = ro + rd * t;
    if (p.z < -0.22) {
      int nextSec = p.x >= 0.0 ? 1 : 0;
      if (isDuke && glitchOn) {
        float stripe = fract(gl_FragCoord.y * 0.08 + uTime * 2.5 + p.x * 1.4);
        nextSec = stripe > 0.48 ? 1 : 0;
      }
      sector = nextSec;
    }
    vec2 h = mapMarathonRoom(p, sector);
    if (h.x < 0.003) {
      if (isDuke && !crossedMirror && p.z < -3.35 && p.x > 0.65 && p.x < 2.85 && p.y > 0.45 && p.y < 2.85) {
        crossedMirror = true;
        ro = p + vec3(0.0, 0.0, 0.03);
        rd.z = -rd.z;
        t = 0.04;
        continue;
      }
      hit = vec2(t, h.y);
      hitSector = sector;
      break;
    }
    t += max(h.x * 0.88, 0.004);
    if (t > 24.0) break;
  }

  if (hit.x < 0.0) return vec3(0.05, 0.06, 0.10);
  vec3 p = ro + rd * hit.x;
  vec2 e = vec2(0.003, 0.0);
  vec3 n = normalize(vec3(
    mapMarathonRoom(p + e.xyy, hitSector).x - mapMarathonRoom(p - e.xyy, hitSector).x,
    mapMarathonRoom(p + e.yxy, hitSector).x - mapMarathonRoom(p - e.yxy, hitSector).x,
    mapMarathonRoom(p + e.yyx, hitSector).x - mapMarathonRoom(p - e.yyx, hitSector).x
  ));

  int m = int(floor(hit.y + 0.5));
  vec3 alb = hitSector == 0 ? vec3(0.68, 0.48, 0.28) : vec3(0.16, 0.36, 0.62);
  if (m == 0) {
    float chk = mod(floor(p.x * 1.4) + floor(p.z * 1.4), 2.0);
    alb = hitSector == 0
      ? mix(vec3(0.18, 0.28, 0.22), vec3(0.68, 0.58, 0.42), chk)
      : mix(vec3(0.12, 0.18, 0.34), vec3(0.52, 0.68, 0.86), chk);
  } else if (m == 1) {
    alb = hitSector == 0 ? vec3(0.24, 0.20, 0.18) : vec3(0.14, 0.18, 0.28);
  } else if (m == 3) {
    float band = smoothstep(0.06, 0.02, abs(fract(p.y * 0.85) - 0.5));
    alb = mix(vec3(0.32, 0.34, 0.40), vec3(0.92, 0.70, 0.26), band);
  } else if (m == 5) {
    return vec3(1.9, 0.85, 0.18) * (0.7 + 0.3 * max(dot(n, normalize(vec3(0.3, 0.8, 0.5))), 0.0));
  } else if (m == 7) {
    return vec3(0.18, 1.35, 1.85) * (0.65 + 0.35 * max(dot(n, normalize(vec3(-0.3, 0.8, 0.5))), 0.0));
  } else if (m == 4 || m == 6) {
    alb = hitSector == 0 ? vec3(0.82, 0.32, 0.18) : vec3(0.86, 0.22, 0.36);
  }

  vec3 lPos = hitSector == 0 ? vec3(-1.4, 2.9, 0.5) : vec3(1.4, 2.9, 0.5);
  vec3 ld = normalize(lPos - p);
  float dist = length(lPos - p);
  float diff = max(dot(n, ld), 0.0) * (9.5 / (1.8 + dist * dist * 0.48));
  vec3 col = alb * (0.22 + diff * (hitSector == 0 ? vec3(1.0, 0.86, 0.62) : vec3(0.72, 0.90, 1.0)));

  if (crossedMirror) col = mix(col, vec3(0.45, 0.78, 0.96), 0.18);
  if (isDuke && !crossedMirror && p.z < -3.35 && p.x > 0.55 && p.x < 2.95 && p.y > 0.35 && p.y < 2.95) {
    if (p.x < 0.68 || p.x > 2.82 || p.y < 0.48 || p.y > 2.82) col = vec3(0.88, 0.66, 0.28);
  }
  if (isDuke && glitchOn && abs(p.x) < 0.05 && p.z < -0.22) col = vec3(1.0, 0.22, 0.44);
  return col;
}

// ============================================================================
// STAGE 2 (2006 Prey), STAGE 3 (2007 Portal Recursive 8x), STAGE 6 (2022 Portal with RTX)
// Opposing Blue Portal (Back Wall z=-2.65) <-> Orange Portal (Front Wall z=+2.65) + moody Aperture industrial lab!
// Looking straight toward the Back Wall shows ALL 8 RECURSIONS of glowing Blue & Orange portals + Companion Cubes curving into infinity!!
// ============================================================================
float mapApertureObstacles(vec3 p, bool rtxMode) {
  // Companion cube & pedestal placed slightly right-of-center so you see BOTH the hero cube AND the giant infinite portal tunnel!
  float d = sdBox(p - vec3(0.95, 0.14, -0.55), vec3(0.50, 0.14, 0.50));
  vec3 cp = p - vec3(0.95, 0.64, -0.55);
  cp.xz = rot2(0.45 + sin(uTime * 0.5) * 0.14) * cp.xz;
  d = min(d, sdRoundBox(cp, vec3(0.36), 0.045));
  if (rtxMode) {
    // Sleek dark test cylinder sitting right in the path of the golden RTX portal sunbeam -> casts crisp ray-traced shadow!
    d = min(d, sdCylinder(p - vec3(-0.35, 0.68, -0.45), 0.16, 0.68));
  }
  return d;
}

vec2 mapApertureChamber(vec3 p, bool rtxMode) {
  // Chamber: x in [-2.65, 2.65], y in [0.0, 3.45], z in [-2.65, 2.65]
  float d = p.y; float mat = 0.0;
  float dCeil = 3.45 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dBack = p.z + 2.65; if (dBack < d) { d = dBack; mat = 3.0; } // Blue Portal Wall!
  float dFront = 2.65 - p.z; if (dFront < d) { d = dFront; mat = 4.0; } // Orange Portal Wall!
  float dL = p.x + 2.65; if (dL < d) { d = dL; mat = 2.0; }
  float dR = 2.65 - p.x; if (dR < d) { d = dR; mat = 2.0; }

  // Industrial dark steel side wall ribs (give unmistakable depth cues inside every single recursive bounce!)
  float ribZ = abs(fract((p.z + 2.65) / 1.75) - 0.5) * 1.75;
  float dRibL = sdBox(vec3(p.x + 2.58, p.y - 1.72, ribZ), vec3(0.10, 1.72, 0.09));
  float dRibR = sdBox(vec3(p.x - 2.58, p.y - 1.72, ribZ), vec3(0.10, 1.72, 0.09));
  float dRib = min(dRibL, dRibR);
  if (dRib < d) { d = dRib; mat = 5.0; }

  // Companion cube on pedestal
  float dPed = sdBox(p - vec3(0.95, 0.14, -0.55), vec3(0.50, 0.14, 0.50));
  if (dPed < d) { d = dPed; mat = 5.0; }
  vec3 cp = p - vec3(0.95, 0.64, -0.55);
  cp.xz = rot2(0.45 + sin(uTime * 0.5) * 0.14) * cp.xz;
  float dCube = sdRoundBox(cp, vec3(0.36), 0.045);
  if (dCube < d) { d = dCube; mat = 6.0; }

  // Glowing cyan energy orb flying straight through the Z portal loop (enters Blue at z=-2.65, exits Orange at z=+2.65!)
  float orbPhase = fract(uTime * 0.28);
  float orbZ = mix(2.35, -2.35, orbPhase);
  float dOrb = length(p - vec3(-0.22 + sin(orbPhase * PI) * 0.12, 1.72, orbZ)) - 0.15;
  if (dOrb < d) { d = dOrb; mat = 7.0; }

  if (rtxMode) {
    float dP2 = sdCylinder(p - vec3(-0.35, 0.68, -0.45), 0.16, 0.68);
    if (dP2 < d) { d = dP2; mat = 8.0; }
  }
  return vec2(d, mat);
}

vec3 normalAperture(vec3 p, bool rtxMode) {
  vec2 e = vec2(0.0025, 0.0);
  return normalize(vec3(
    mapApertureChamber(p + e.xyy, rtxMode).x - mapApertureChamber(p - e.xyy, rtxMode).x,
    mapApertureChamber(p + e.yxy, rtxMode).x - mapApertureChamber(p - e.yxy, rtxMode).x,
    mapApertureChamber(p + e.yyx, rtxMode).x - mapApertureChamber(p - e.yyx, rtxMode).x
  ));
}

float softShadowAperture(vec3 ro, vec3 rd, float tMax, float k, bool rtxMode) {
  float res = 1.0, t = 0.04, ph = 1e10;
  for (int i = 0; i < 28; i++) {
    float h = mapApertureObstacles(ro + rd * t, rtxMode);
    if (h < 0.0018) return 0.0;
    float y = (h * h) / (2.0 * ph);
    float d = sqrt(max(0.0, h * h - y * y));
    res = min(res, k * d / max(0.001, t - y));
    ph = h;
    t += clamp(h, 0.025, 0.26);
    if (t >= tMax - 0.06) break;
  }
  return clamp(res, 0.0, 1.0);
}

float portalOvalDist(vec2 xy, vec2 cen, vec2 rad) {
  return length((xy - cen) / rad);
}

vec3 shadeApertureSurface(vec3 p, vec3 n, float matId, bool rtxMode, vec2 blueCen, vec2 orangeCen, vec2 pRad) {
  int m = int(floor(matId + 0.5));
  vec3 alb = vec3(0.42, 0.46, 0.54);
  if (m == 0) {
    // Moody Aperture dark slate/concrete test floor (makes RTX portal light beam & reflections POP!)
    float g = max(smoothstep(0.46, 0.495, abs(fract(p.x * 0.95) - 0.5)), smoothstep(0.46, 0.495, abs(fract(p.z * 0.95) - 0.5)));
    alb = mix(rtxMode ? vec3(0.18, 0.21, 0.27) : vec3(0.28, 0.32, 0.39), vec3(0.10, 0.12, 0.17), g * 0.65);
  } else if (m == 1) {
    alb = vec3(0.24, 0.27, 0.34);
  } else if (m == 2 || m == 3 || m == 4) {
    vec2 uv = (m == 2) ? p.zy : p.xy;
    float g = max(smoothstep(0.47, 0.495, abs(fract(uv.x * 0.85) - 0.5)), smoothstep(0.47, 0.495, abs(fract(uv.y * 0.85) - 0.5)));
    // Classic Aperture two-tone chamber: dark industrial lower dado + clean architectural gray-white upper panels!
    vec3 panel = p.y < 1.05 ? vec3(0.18, 0.21, 0.28) : (rtxMode ? vec3(0.38, 0.41, 0.48) : vec3(0.56, 0.60, 0.66));
    alb = mix(panel, vec3(0.11, 0.14, 0.19), g * 0.65);
  } else if (m == 5) {
    alb = vec3(0.14, 0.17, 0.23);
  } else if (m == 6) {
    float stripe = smoothstep(0.12, 0.08, abs(p.y - 0.64));
    alb = mix(vec3(0.56, 0.60, 0.66), vec3(0.98, 0.30, 0.55), stripe);
  } else if (m == 7) {
    return vec3(0.35, 1.55, 2.35);
  } else if (m == 8) {
    alb = vec3(0.28, 0.34, 0.44);
  }

  // Overhead chamber key light (dimmer in Portal RTX so the golden portal light beam dominates!)
  vec3 lPos = vec3(0.3, 3.15, 0.2);
  vec3 toL = lPos - p; float dL = length(toL); vec3 ld = toL / max(dL, 1e-4);
  float sh = softShadowAperture(p + n * 0.03, ld, dL - 0.1, 7.0, rtxMode);
  vec3 light = vec3(0.12, 0.15, 0.21) * (0.55 + 0.45 * n.y);
  light += vec3(0.95, 0.94, 0.92) * (max(dot(n, ld), 0.0) * sh * (rtxMode ? 2.4 : 5.4) / (1.5 + dL * dL * 0.36));

  // Vivid Electric Blue portal glow from Back Wall (z = -2.62) & Fiery Orange portal glow from Front Wall (z = +2.62)!
  vec3 blueP = vec3(blueCen.x, blueCen.y, -2.58);
  vec3 toB = blueP - p; float dB = length(toB);
  light += vec3(0.06, 0.62, 1.45) * (max(dot(n, toB / max(dB, 1e-4)), 0.0) * 0.78 + 0.22) * (3.6 / (0.85 + dB * dB * 0.52));

  vec3 orgP = vec3(orangeCen.x, orangeCen.y, 2.58);
  vec3 toO = orgP - p; float dO = length(toO);
  light += vec3(1.55, 0.46, 0.05) * (max(dot(n, toO / max(dO, 1e-4)), 0.0) * 0.78 + 0.22) * (3.4 / (0.85 + dO * dO * 0.52));

  // ON STAGE 6 (2022 Portal with RTX): A blazing golden sun spotlight inside the Orange chamber shoots a REAL ray-traced
  // beam & crisp shadows of the cylinder & companion cube STRAIGHT THROUGH the Blue Portal across the dark reflective floor!
  if (rtxMode) {
    vec3 virtualSun = vec3(blueCen.x - 0.35, blueCen.y + 0.65, -5.8);
    vec3 toV = virtualSun - p;
    float dV = length(toV);
    vec3 vd = toV / max(dV, 1e-4);
    if (vd.z < -0.05 && p.z > -2.62) {
      float tBlue = (-2.64 - p.z) / vd.z;
      vec3 hitB = p + vd * tBlue;
      float oval = portalOvalDist(hitB.xy, blueCen, pRad * 0.96);
      if (oval < 1.0) {
        float beamEdge = smoothstep(1.0, 0.80, oval);
        float pSh = softShadowAperture(p + n * 0.03, vd, tBlue - 0.05, 11.0, true);
        light += vec3(2.2, 1.28, 0.42) * (max(dot(n, vd), 0.0) * pSh * beamEdge * 6.5 / (1.0 + dV * dV * 0.08));
      }
    }
  }
  return alb * light;
}

vec3 shadePortalsAperture(vec3 ro, vec3 rd, int mode, bool actionOn) {
  // mode 0 = Prey (2006 tilted alien portal), mode 1 = Portal (2007 recursive 8x vs 1x), mode 2 = Portal RTX (2022)
  bool rtxMode = (mode == 2);
  int maxDepth = (mode == 0) ? 2 : (mode == 1 ? (actionOn ? 1 : 8) : 7);
  vec2 blueCen = vec2(-0.18, 1.48);
  vec2 orangeCen = (mode == 0)
    ? vec2(-0.18, 1.48)
    : vec2(clamp(-0.18 + uOrangeOff.x, -1.25, 0.95), clamp(1.48 + uOrangeOff.y, 1.15, 2.05));
  vec2 pRad = (mode == 0) ? vec2(0.86, 1.15) : vec2(0.92, 1.22);

  vec3 curRo = ro;
  vec3 curRd = rd;
  vec3 tint = vec3(1.0);
  vec3 outCol = vec3(0.04, 0.06, 0.10);

  for (int bounce = 0; bounce < 9; bounce++) {
    float t = 0.04;
    vec2 hit = vec2(-1.0);
    for (int i = 0; i < 74; i++) {
      vec3 p = curRo + curRd * t;
      vec2 h = mapApertureChamber(p, rtxMode);
      if (h.x < 0.0025) { hit = vec2(t, h.y); break; }
      t += max(h.x * 0.9, 0.003);
      if (t > 16.0) break;
    }
    if (hit.x < 0.0) break;

    vec3 p = curRo + curRd * hit.x;
    int m = int(floor(hit.y + 0.5));

    // Check Blue Portal on Back Wall (m == 3, z ~ -2.65) or Orange Portal on Front Wall (m == 4, z ~ +2.65)
    if (m == 3 || m == 4) {
      bool isBlue = (m == 3);
      vec2 cen = isBlue ? blueCen : orangeCen;
      float oval = portalOvalDist(p.xy, cen, pRad);

      // Blazing high-contrast glowing portal ring!
      if (oval >= 0.92 && oval <= 1.15) {
        float core = smoothstep(1.15, 1.01, oval) * smoothstep(0.90, 0.98, oval);
        vec3 rimCol = (mode == 0)
          ? vec3(0.20, 1.45, 0.92) // Prey bio-emerald portal
          : (isBlue ? vec3(0.08, 0.85, 2.25) : vec3(2.35, 0.62, 0.06));
        outCol = rimCol * (0.95 + core * 1.45) * tint;
        break;
      }

      if (oval < 0.92) {
        if (bounce >= maxDepth) {
          vec3 cap = isBlue ? vec3(0.04, 0.24, 0.52) : vec3(0.55, 0.18, 0.03);
          outCol = cap * tint;
          break;
        }
        vec2 local = p.xy - cen;
        if (mode == 0) {
          // 2006 Prey: dramatic 38-degree tilted non-axis-aligned alien corridor!
          vec2 rl = rot2(0.66) * local;
          curRo = vec3(orangeCen.x + rl.x, orangeCen.y + rl.y, isBlue ? 2.58 : -2.58);
          vec2 rdxy = rot2(0.66) * curRd.xy;
          curRd = normalize(vec3(rdxy.x, rdxy.y, curRd.z));
        } else {
          // 2007 Portal / 2022 Portal RTX: teleport Back (-2.65) -> Front (+2.58) with subtle 6-deg curve -> ICONIC INFINITE HALL!
          vec2 dstCen = isBlue ? orangeCen : blueCen;
          // Show orange rim reflection on alternating hops by slightly rotating XZ!
          curRo = vec3(dstCen.x + local.x, dstCen.y + local.y, isBlue ? 2.58 : -2.58);
          vec2 xz = rot2(isBlue ? 0.085 : -0.085) * curRd.xz;
          curRd = normalize(vec3(xz.x, curRd.y, xz.y));
        }
        tint *= (mode == 2 ? vec3(0.97, 0.96, 0.96) : vec3(0.93, 0.95, 0.97));
        continue;
      }
    }

    vec3 n = normalAperture(p, rtxMode);
    vec3 col = shadeApertureSurface(p, n, hit.y, rtxMode, blueCen, orangeCen, pRad);

    // Subtle volumetric sunbeam haze pouring out of the Blue Portal in 2022 Portal with RTX!
    if (rtxMode && bounce == 0) {
      float beamT = clamp(hit.x, 0.0, 5.2);
      vec3 midP = curRo + curRd * (beamT * 0.55);
      float bDist = portalOvalDist(midP.xy, blueCen + vec2(0.15, -0.25), pRad * 1.15);
      float shaft = smoothstep(1.15, 0.1, bDist) * smoothstep(2.6, -2.5, midP.z) * 0.14;
      col += vec3(1.25, 0.78, 0.30) * shaft;
    }

    // Glossy mirror floor reflections on 2022 Portal with RTX (reflects glowing Blue portal + golden RTX light!)
    if (rtxMode && m == 0 && bounce == 0) {
      vec3 reflRd = reflect(curRd, n);
      vec3 reflRo = p + n * 0.03;
      float rt = 0.04; vec2 rh = vec2(-1.0);
      for (int j = 0; j < 44; j++) {
        vec2 h2 = mapApertureChamber(reflRo + reflRd * rt, true);
        if (h2.x < 0.004) { rh = vec2(rt, h2.y); break; }
        rt += max(h2.x * 0.9, 0.005);
        if (rt > 14.0) break;
      }
      if (rh.x > 0.0) {
        vec3 rp = reflRo + reflRd * rh.x;
        int rm = int(floor(rh.y + 0.5));
        vec3 rCol = vec3(0.0);
        if (rm == 3 && portalOvalDist(rp.xy, blueCen, pRad) < 1.14) {
          float ov = portalOvalDist(rp.xy, blueCen, pRad);
          rCol = ov > 0.90 ? vec3(0.14, 1.05, 2.35) : vec3(0.45, 0.56, 0.72);
        } else {
          vec3 rn = normalAperture(rp, true);
          rCol = shadeApertureSurface(rp, rn, rh.y, true, blueCen, orangeCen, pRad);
        }
        float fres = 0.12 + 0.42 * pow(1.0 - max(dot(n, -curRd), 0.0), 3.2);
        col = mix(col, rCol, fres);
      }
    }

    outCol = col * tint;
    break;
  }
  return outCol;
}

// ============================================================================
// STAGE 4 (2013 Antichamber)
// ============================================================================
vec2 mapAntichamber(vec3 p, int variant) {
  float d = p.y; float mat = 0.0;
  float dCeil = 3.8 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dL = p.x + 3.2; if (dL < d) { d = dL; mat = 2.0; }
  float dR = 3.2 - p.x; if (dR < d) { d = dR; mat = 2.0; }
  float dBack = p.z + 4.4; if (dBack < d) { d = dBack; mat = 2.0; }

  float dMono = sdBox(p - vec3(0.0, 1.9, -0.35), vec3(0.46, 1.9, 0.46));
  if (dMono < d) { d = dMono; mat = 3.0; }

  if (variant == 0) {
    for (int s = 0; s < 5; s++) {
      float fs = float(s);
      float ds = sdBox(p - vec3(-1.7, 0.25 + fs * 0.44, -1.2 - fs * 0.55), vec3(0.72, 0.18, 0.32));
      if (ds < d) { d = ds; mat = 4.0; }
    }
    float dArch = sdBox(p - vec3(1.75, 1.5, -2.2), vec3(0.55, 1.5, 0.32));
    if (dArch < d) { d = dArch; mat = 5.0; }
  } else {
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      vec3 cp = p - vec3(-1.65 + sin(uTime + fk) * 0.15, 0.9 + fk * 0.85, -2.0 - fk * 0.45);
      cp.xy = rot2(uTime * 0.5 + fk) * cp.xy;
      float dc = sdBox(cp, vec3(0.36));
      if (dc < d) { d = dc; mat = 6.0; }
    }
    float dWin = sdCylinder(p - vec3(1.75, 1.65, -2.1), 0.65, 1.65);
    if (dWin < d) { d = dWin; mat = 7.0; }
  }
  return vec2(d, mat);
}

vec3 shadeAntichamber(vec3 ro, vec3 rd) {
  int variant = int(mod(floor(uShiftState + 0.5), 2.0));
  float t = 0.04; vec2 hit = vec2(-1.0);
  for (int i = 0; i < 74; i++) {
    vec2 h = mapAntichamber(ro + rd * t, variant);
    if (h.x < 0.0025) { hit = vec2(t, h.y); break; }
    t += max(h.x * 0.9, 0.004);
    if (t > 18.0) break;
  }
  if (hit.x < 0.0) return vec3(0.95);
  vec3 p = ro + rd * hit.x;
  vec2 e = vec2(0.003, 0.0);
  vec3 n = normalize(vec3(
    mapAntichamber(p + e.xyy, variant).x - mapAntichamber(p - e.xyy, variant).x,
    mapAntichamber(p + e.yxy, variant).x - mapAntichamber(p - e.yxy, variant).x,
    mapAntichamber(p + e.yyx, variant).x - mapAntichamber(p - e.yyx, variant).x
  ));
  int m = int(floor(hit.y + 0.5));
  vec3 col = variant == 0 ? vec3(0.92, 0.93, 0.96) : vec3(0.09, 0.11, 0.16);
  if (m == 3) col = variant == 0 ? vec3(0.10, 0.11, 0.15) : vec3(0.94, 0.95, 0.97);
  else if (m == 4) col = vec3(0.98, 0.72, 0.14);
  else if (m == 5) col = vec3(0.08, 0.74, 0.96);
  else if (m == 6) col = vec3(0.98, 0.22, 0.34);
  else if (m == 7) col = vec3(0.12, 0.88, 0.54);

  float shade = 0.72 + 0.28 * max(dot(n, normalize(vec3(0.35, 0.85, 0.45))), 0.0);
  float edge = gridLine(abs(n.y) > 0.5 ? p.xz : (abs(n.x) > 0.5 ? p.zy : p.xy), 0.75, 1.3);
  vec3 lineCol = variant == 0 ? vec3(0.12, 0.14, 0.18) : vec3(0.28, 0.92, 0.78);
  return mix(col * shade, lineCol, edge * 0.45);
}

// ============================================================================
// STAGE 5 (2018 CodeParade): "Bigger on the Inside" 1.8m Stone Pavilion -> 22m Vaulted Hall!
// ============================================================================
vec2 mapInsideHall(vec3 p) {
  float d = p.y; float mat = 0.0;
  float dCeil = 2.62 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dL = p.x + 1.15; if (dL < d) { d = dL; mat = 2.0; }
  float dR = 1.15 - p.x; if (dR < d) { d = dR; mat = 2.0; }
  float dEnd = p.z + 21.0; if (dEnd < d) { d = dEnd; mat = 3.0; }

  vec3 rp = p;
  rp.z = mod(p.z + 1.2, 2.4) - 1.2;
  float dRib = min(min(
    sdBox(rp - vec3(-1.05, 1.31, 0.0), vec3(0.12, 1.31, 0.14)),
    sdBox(rp - vec3( 1.05, 1.31, 0.0), vec3(0.12, 1.31, 0.14))),
    sdBox(rp - vec3( 0.0, 2.50, 0.0), vec3(1.15, 0.14, 0.14)));
  if (dRib < d) { d = dRib; mat = 4.0; }

  float dGem = length(p - vec3(0.0, 1.35 + sin(uTime * 2.0) * 0.16, -15.5)) - 0.55;
  if (dGem < d) { d = dGem; mat = 5.0; }
  return vec2(d, mat);
}

vec2 mapExteriorCourtyard(vec3 p) {
  float d = p.y; float mat = 0.0;
  float boxOuter = sdBox(p - vec3(0.0, 1.45, 0.0), vec3(1.35, 1.45, 0.90));
  float doorCut = sdBox(p - vec3(0.0, 1.27, 0.72), vec3(1.05, 1.28, 0.45));
  float kiosk = max(boxOuter, -doorCut);
  if (kiosk < d) { d = kiosk; mat = 1.0; }

  float dPostL = sdCylinder(p - vec3(-3.2, 1.6, -2.6), 0.28, 1.6);
  float dPostR = sdCylinder(p - vec3( 3.2, 1.6, -2.6), 0.28, 1.6);
  float dBackWall = sdBox(p - vec3(0.0, 0.55, -3.4), vec3(3.6, 0.55, 0.32));
  float dEnv = min(min(dPostL, dPostR), dBackWall);
  if (dEnv < d) { d = dEnv; mat = 2.0; }
  return vec2(d, mat);
}

vec3 shadeCodeParade(vec3 ro, vec3 rd) {
  bool enterInterior = false;
  float tDoor = 1e9;
  if (ro.z > 0.86 && rd.z < -0.01) {
    float td = (0.86 - ro.z) / rd.z;
    if (td > 0.01) {
      vec3 dp = ro + rd * td;
      if (abs(dp.x) < 1.05 && dp.y > 0.0 && dp.y < 2.55) tDoor = td;
    }
  } else if (ro.z <= 0.86 && abs(ro.x) < 1.15 && ro.y < 2.62) {
    enterInterior = true; tDoor = 0.0;
  }

  float tExt = 0.04; vec2 hitExt = vec2(-1.0);
  if (!enterInterior) {
    for (int i = 0; i < 68; i++) {
      vec2 h = mapExteriorCourtyard(ro + rd * tExt);
      if (h.x < 0.0025) { hitExt = vec2(tExt, h.y); break; }
      tExt += max(h.x * 0.9, 0.004);
      if (tExt > min(tDoor, 28.0)) break;
    }
  }

  if (enterInterior || (tDoor < 1e8 && (hitExt.x < 0.0 || tDoor < hitExt.x))) {
    float tIn = max(tDoor + 0.02, 0.02); vec2 hitIn = vec2(-1.0);
    for (int i = 0; i < 80; i++) {
      vec2 h = mapInsideHall(ro + rd * tIn);
      if (h.x < 0.003) { hitIn = vec2(tIn, h.y); break; }
      tIn += max(h.x * 0.9, 0.005);
      if (tIn > 28.0) break;
    }
    if (hitIn.x > 0.0) {
      vec3 p = ro + rd * hitIn.x;
      vec2 e = vec2(0.003, 0.0);
      vec3 n = normalize(vec3(
        mapInsideHall(p + e.xyy).x - mapInsideHall(p - e.xyy).x,
        mapInsideHall(p + e.yxy).x - mapInsideHall(p - e.yxy).x,
        mapInsideHall(p + e.yyx).x - mapInsideHall(p - e.yyx).x
      ));
      int m = int(floor(hitIn.y + 0.5));
      if (m == 5) return vec3(0.24, 1.55, 2.05);
      if (m == 3) return vec3(1.55, 1.15, 0.65);
      vec3 alb = vec3(0.20, 0.25, 0.36);
      if (m == 0) {
        float chk = mod(floor(p.x * 2.0) + floor(p.z * 0.9), 2.0);
        alb = mix(vec3(0.14, 0.18, 0.28), vec3(0.76, 0.72, 0.66), chk);
      } else if (m == 4) alb = vec3(0.94, 0.70, 0.28);
      else if (m == 2) alb = vec3(0.22, 0.34, 0.52);
      float ribLight = 0.55 + 0.45 * cos(p.z * 2.618);
      float depthGlow = exp(-max(0.0, p.z + 15.5) * 0.18) * 1.1;
      vec3 col = alb * (0.32 + 0.78 * ribLight * (0.6 + 0.4 * max(n.y, 0.0)));
      col += vec3(0.18, 0.82, 1.0) * depthGlow * 0.45;
      return mix(col, vec3(0.10, 0.20, 0.34), (1.0 - exp(-max(0.0, -p.z) * 0.055)) * 0.65);
    }
  }

  if (hitExt.x < 0.0) {
    float sky = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    return mix(vec3(0.68, 0.82, 0.96), vec3(0.18, 0.44, 0.80), pow(sky, 0.7));
  }
  vec3 p = ro + rd * hitExt.x;
  vec2 e = vec2(0.003, 0.0);
  vec3 n = normalize(vec3(
    mapExteriorCourtyard(p + e.xyy).x - mapExteriorCourtyard(p - e.xyy).x,
    mapExteriorCourtyard(p + e.yxy).x - mapExteriorCourtyard(p - e.yxy).x,
    mapExteriorCourtyard(p + e.yyx).x - mapExteriorCourtyard(p - e.yyx).x
  ));
  int m = int(floor(hitExt.y + 0.5));
  vec3 alb = vec3(0.84, 0.78, 0.68);
  if (m == 0) {
    float chk = mod(floor(p.x * 0.9) + floor(p.z * 0.9), 2.0);
    alb = mix(vec3(0.74, 0.70, 0.62), vec3(0.58, 0.54, 0.48), chk);
  } else if (m == 1) {
    bool isTrim = p.z > 0.82 && abs(p.x) < 1.20 && p.y < 2.70;
    alb = isTrim ? vec3(0.94, 0.72, 0.24) : vec3(0.78, 0.28, 0.20);
  }
  vec3 sun = normalize(vec3(0.58, 0.78, 0.42));
  // Crisp courtyard shadow cast by the tiny 1.8m pavilion onto the plaza!
  float sh = 1.0;
  float st = 0.08;
  for (int i = 0; i < 24; i++) {
    vec3 sp = p + n * 0.04 + sun * st;
    float h = sdBox(sp - vec3(0.0, 1.45, 0.0), vec3(1.35, 1.45, 0.90));
    if (h < 0.005) { sh = 0.0; break; }
    sh = min(sh, 7.0 * h / st);
    st += clamp(h, 0.05, 0.35);
    if (st > 8.0) break;
  }
  return alb * (vec3(0.24, 0.30, 0.42) + vec3(1.18, 1.04, 0.84) * (max(dot(n, sun), 0.0) * sh));
}

// ============================================================================
// STAGE 7 (2023 Viewfinder): 2D Photo Becomes Real 3D Architecture!
// ============================================================================
vec2 mapDarkRoom(vec3 p) {
  float d = p.y; float mat = 0.0;
  float dCeil = 3.6 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dBack = p.z + 3.2; if (dBack < d) { d = dBack; mat = 2.0; }
  float dL = p.x + 3.2; if (dL < d) { d = dL; mat = 2.0; }
  float dR = 3.2 - p.x; if (dR < d) { d = dR; mat = 2.0; }
  float dCrate = sdBox(p - vec3(-1.8, 0.48, -1.6), vec3(0.48));
  if (dCrate < d) { d = dCrate; mat = 3.0; }
  return vec2(d, mat);
}

vec2 mapPhotoWorld(vec3 p) {
  float d = p.y; float mat = 0.0;
  float dPilL = sdCylinder(p - vec3(-0.92, 1.45, -2.05), 0.22, 1.45);
  float dPilR = sdCylinder(p - vec3( 0.92, 1.45, -2.05), 0.22, 1.45);
  float dLint = sdBox(p - vec3(0.0, 2.95, -2.05), vec3(1.35, 0.22, 0.28));
  float dArchBack = sdCylinder(p - vec3(-1.35, 1.5, -5.2), 0.24, 1.5);
  float dArchBack2 = sdCylinder(p - vec3( 1.35, 1.5, -5.2), 0.24, 1.5);
  float dBridge = sdBox(p - vec3(0.0, 0.16, -3.8), vec3(1.15, 0.16, 2.4));
  float dSunOrb = length(p - vec3(0.0, 1.85 + sin(uTime * 1.4) * 0.14, -4.4)) - 0.44;
  float dArch = min(min(min(dPilL, dPilR), dLint), min(dArchBack, dArchBack2));
  if (dArch < d) { d = dArch; mat = 1.0; }
  if (dBridge < d) { d = dBridge; mat = 2.0; }
  if (dSunOrb < d) { d = dSunOrb; mat = 3.0; }
  return vec2(d, mat);
}

bool insidePhotoFrustum(vec3 p) {
  float depth = 2.9 - p.z;
  if (depth < 1.35 || depth > 14.0) return false;
  return abs(p.x) < depth * 0.38 && abs(p.y - 1.55) < depth * 0.30;
}

vec3 shadePhotoWorldColor(vec3 ro, vec3 rd) {
  float t = 0.04; vec2 hit = vec2(-1.0);
  for (int i = 0; i < 64; i++) {
    vec2 h = mapPhotoWorld(ro + rd * t);
    if (h.x < 0.003) { hit = vec2(t, h.y); break; }
    t += max(h.x * 0.9, 0.005);
    if (t > 18.0) break;
  }
  if (hit.x < 0.0) {
    float s = clamp(rd.y * 0.7 + 0.4, 0.0, 1.0);
    return mix(vec3(1.0, 0.84, 0.56), vec3(0.16, 0.56, 0.96), pow(s, 0.75));
  }
  vec3 p = ro + rd * hit.x;
  vec2 e = vec2(0.003, 0.0);
  vec3 n = normalize(vec3(
    mapPhotoWorld(p + e.xyy).x - mapPhotoWorld(p - e.xyy).x,
    mapPhotoWorld(p + e.yxy).x - mapPhotoWorld(p - e.yxy).x,
    mapPhotoWorld(p + e.yyx).x - mapPhotoWorld(p - e.yyx).x
  ));
  int m = int(floor(hit.y + 0.5));
  if (m == 3) return vec3(1.75, 1.18, 0.36);
  vec3 alb = m == 0 ? vec3(0.88, 0.74, 0.56) : (m == 1 ? vec3(0.95, 0.86, 0.70) : vec3(0.18, 0.68, 0.80));
  float ndl = max(dot(n, normalize(vec3(0.45, 0.85, 0.35))), 0.0);
  return alb * (vec3(0.32, 0.38, 0.52) + vec3(1.22, 0.98, 0.70) * ndl);
}

vec3 shadeViewfinder(vec3 ro, vec3 rd) {
  if (uPhotoStamp < 0.5) {
    if (rd.z < -0.02 && ro.z > 0.65) {
      float tp = (0.65 - ro.z) / rd.z;
      vec3 pp = ro + rd * tp;
      vec2 card = pp.xy - vec2(0.0, 1.52);
      if (abs(card.x) < 0.96 && abs(card.y) < 0.78) {
        if (abs(card.x) > 0.86 || card.y > 0.68 || card.y < -0.56) return vec3(0.94, 0.91, 0.85);
        vec2 photoUv = (card - vec2(0.0, 0.06)) / vec2(0.86, 0.62);
        vec3 photoRd = normalize(vec3(photoUv.x * 0.58, photoUv.y * 0.44, -1.0));
        return shadePhotoWorldColor(vec3(0.0, 1.55, 2.4), photoRd);
      }
    }
  }

  float t = 0.04; bool hitIsPhoto = false; vec2 hit = vec2(-1.0);
  for (int i = 0; i < 84; i++) {
    vec3 p = ro + rd * t;
    bool inP = uPhotoStamp >= 0.5 && insidePhotoFrustum(p);
    vec2 h = inP ? mapPhotoWorld(p) : mapDarkRoom(p);
    if (h.x < 0.003) { hit = vec2(t, h.y); hitIsPhoto = inP; break; }
    t += max(min(h.x * 0.88, 0.25), 0.005);
    if (t > 16.0) break;
  }

  if (hit.x < 0.0) {
    float s = clamp(rd.y * 0.7 + 0.4, 0.0, 1.0);
    return mix(vec3(1.0, 0.84, 0.56), vec3(0.16, 0.56, 0.96), pow(s, 0.75));
  }

  vec3 p = ro + rd * hit.x;
  if (uPhotoStamp >= 0.5 && !hitIsPhoto) {
    float depth = 2.9 - p.z;
    if (depth > 1.32 && depth < 14.0) {
      float dx = abs(abs(p.x) - depth * 0.38);
      float dy = abs(abs(p.y - 1.55) - depth * 0.30);
      if ((dx < 0.045 && abs(p.y - 1.55) <= depth * 0.30 + 0.045) ||
          (dy < 0.045 && abs(p.x) <= depth * 0.38 + 0.045)) {
        return vec3(1.0, 0.96, 0.88) * 1.15;
      }
    }
  }
  if (hitIsPhoto) return shadePhotoWorldColor(ro, rd);

  vec2 e = vec2(0.003, 0.0);
  vec3 n = normalize(vec3(
    mapDarkRoom(p + e.xyy).x - mapDarkRoom(p - e.xyy).x,
    mapDarkRoom(p + e.yxy).x - mapDarkRoom(p - e.yxy).x,
    mapDarkRoom(p + e.yyx).x - mapDarkRoom(p - e.yyx).x
  ));
  int m = int(floor(hit.y + 0.5));
  float g = gridLine(abs(n.y) > 0.5 ? p.xz : (abs(n.x) > 0.5 ? p.zy : p.xy), 0.9, 1.4);
  vec3 alb = mix(vec3(0.18, 0.21, 0.28), vec3(0.11, 0.13, 0.19), g * 0.65);
  if (m == 3) alb = vec3(0.28, 0.32, 0.40);
  float ndl = max(dot(n, normalize(vec3(0.2, 0.85, 0.5))), 0.0);
  return alb * (0.30 + 0.82 * ndl);
}

vec3 evalPortalStage(int stage, bool debugOn, vec3 ro, vec3 rd) {
  if (stage == 0) return shadeMarathon(ro, rd, false, false);
  if (stage == 1) return shadeMarathon(ro, rd, true, debugOn);
  if (stage == 2) return shadePortalsAperture(ro, rd, 0, debugOn);
  if (stage == 3) return shadePortalsAperture(ro, rd, 1, debugOn);
  if (stage == 4) return shadeAntichamber(ro, rd);
  if (stage == 5) return shadeCodeParade(ro, rd);
  if (stage == 6) return shadePortalsAperture(ro, rd, 2, debugOn);
  return shadeViewfinder(ro, rd);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));

  bool isLeft = uSplitX > 0.0 && vUv.x < uSplitX;
  int stage = isLeft ? uStageLeft : uStageRight;
  bool debugOn = uDebugOn > 0.5 && !isLeft;

  vec3 col = evalPortalStage(stage, debugOn, uCamPos, rd);
  col = acesFilm(col * 1.10);
  vec2 v = (vUv - 0.5) * vec2(1.12, 1.0);
  col *= clamp(1.0 - dot(v, v) * 0.20, 0.78, 1.0);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));

  if (uSplitX > 0.0 && abs(vUv.x - uSplitX) < 1.5 / uRes.x) {
    col = vec3(0.93, 0.65, 0.37);
  }
  oCol = vec4(col, 1.0);
}
`;
