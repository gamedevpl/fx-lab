// Evolution of Portals & Impossible Spaces (1994-2023) — Interactive WebGL2 FPP Non-Euclidean Engine.
//   0: 1994 Marathon Overlapping Spaces (two rooms occupy the exact same 3D coordinates)
//   1: 1996 Build / Duke Nukem 3D Overlapping Sectors & Portal Mirror (plus Descent '95; Sector Glitch toggle!)
//   2: 2006 Prey Fixed 3D Portals (plus Narbacular Drop '05; tilted 38-deg alien gateway)
//   3: 2007 Portal Recursive Blue <-> Orange Loop (10x recursion + live FPP Fly-Through!)
//   4: 2013 Antichamber 5-Room 360-deg Riemann-Sheet Paradox (4 right-angle turns != back to start!)
//   5: 2018 CodeParade Bigger-on-the-Inside Pavilion (1.4m exterior kiosk -> 24m vaulted hall, bidirectional FPP fly-through!)
//   6: 2022 Portal with RTX (golden sunbeam, sharp shadows & glossy floor reflections straight through infinite portals!)
//   7: 2023 Viewfinder Photo-to-3D Reality (stamp 2D Polaroid into dead-end wall & walk FPP onto the real 3D bridge!)

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
uniform vec2 uOrangeOff;    // Interactive clickable portal offset [x, y]
uniform float uShiftState;  // Continuous unwrapped orbit angle (radians) for Antichamber 5-room 360-deg Riemann sheet!
uniform float uPhotoStamp;  // Viewfinder photo-stamp blend (0=floating 2D Polaroid, 1=stamped into real 3D!)
uniform float uInHall;      // CodeParade explicit interior flag (1.0 when FPP camera is inside the 24m hall!)
uniform int uPortalParity;  // Flips 0 <-> 1 on every exact 5.30m portal pass -> ZERO Blue/Orange flash!

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

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
  float t = 0.05; int hitSector = sector; vec2 hit = vec2(-1.0);
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
        crossedMirror = true; ro = p + vec3(0.0, 0.0, 0.03); rd.z = -rd.z; t = 0.04; continue;
      }
      hit = vec2(t, h.y); hitSector = sector; break;
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
    alb = hitSector == 0 ? mix(vec3(0.18, 0.28, 0.22), vec3(0.68, 0.58, 0.42), chk)
                         : mix(vec3(0.12, 0.18, 0.34), vec3(0.52, 0.68, 0.86), chk);
  } else if (m == 1) alb = hitSector == 0 ? vec3(0.24, 0.20, 0.18) : vec3(0.14, 0.18, 0.28);
  else if (m == 3) alb = mix(vec3(0.32, 0.34, 0.40), vec3(0.92, 0.70, 0.26), smoothstep(0.06, 0.02, abs(fract(p.y * 0.85) - 0.5)));
  else if (m == 5) return vec3(1.9, 0.85, 0.18) * (0.7 + 0.3 * max(dot(n, normalize(vec3(0.3, 0.8, 0.5))), 0.0));
  else if (m == 7) return vec3(0.18, 1.35, 1.85) * (0.65 + 0.35 * max(dot(n, normalize(vec3(-0.3, 0.8, 0.5))), 0.0));
  else if (m == 4 || m == 6) alb = hitSector == 0 ? vec3(0.82, 0.32, 0.18) : vec3(0.86, 0.22, 0.36);

  vec3 lPos = hitSector == 0 ? vec3(-1.4, 2.9, 0.5) : vec3(1.4, 2.9, 0.5);
  vec3 ld = normalize(lPos - p); float dist = length(lPos - p);
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
// STAGE 2 (2006 Prey), STAGE 3 (2007 Portal Fly-Through 10x), STAGE 6 (2022 Portal with RTX)
// Alternating Electric Blue & Fiery Orange portals on opposite walls + seamless FPP Fly-Through!
// ============================================================================
float mapApertureObstacles(vec3 p, bool hasPillar) {
  float d = sdBox(p - vec3(1.12, 0.14, -0.35), vec3(0.46, 0.14, 0.46));
  vec3 cp = p - vec3(1.12, 0.60, -0.35);
  cp.xz = rot2(0.45 + sin(uTime * 0.5) * 0.14) * cp.xz;
  d = min(d, sdRoundBox(cp, vec3(0.34), 0.045));
  if (hasPillar) {
    // Sleek shadow-casting column right inside the Portal RTX golden sunbeam path (clear of P4 fly-through center!)
    d = min(d, sdCylinder(p - vec3(-0.46, 0.66, -1.05), 0.14, 0.66));
  }
  return d;
}

vec2 mapApertureChamber(vec3 p, bool hasPillar) {
  float d = p.y; float mat = 0.0;
  float dCeil = 3.45 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dBack = p.z + 2.65; if (dBack < d) { d = dBack; mat = 3.0; } // Blue Portal Wall
  float dFront = 2.65 - p.z; if (dFront < d) { d = dFront; mat = 4.0; } // Orange Portal Wall
  float dL = p.x + 2.65; if (dL < d) { d = dL; mat = 2.0; }
  float dR = 2.65 - p.x; if (dR < d) { d = dR; mat = 2.0; }

  float ribZ = abs(fract((p.z + 2.65) / 1.76667) - 0.5) * 1.76667;
  float dRib = min(
    sdBox(vec3(p.x + 2.58, p.y - 1.72, ribZ), vec3(0.10, 1.72, 0.09)),
    sdBox(vec3(p.x - 2.58, p.y - 1.72, ribZ), vec3(0.10, 1.72, 0.09)));
  if (dRib < d) { d = dRib; mat = 5.0; }

  float dPed = sdBox(p - vec3(1.12, 0.14, -0.35), vec3(0.46, 0.14, 0.46));
  if (dPed < d) { d = dPed; mat = 5.0; }
  vec3 cp = p - vec3(1.12, 0.60, -0.35);
  cp.xz = rot2(0.45 + sin(uTime * 0.5) * 0.14) * cp.xz;
  float dCube = sdRoundBox(cp, vec3(0.34), 0.045);
  if (dCube < d) { d = dCube; mat = 6.0; }

  // Truly infinite seamless glowing orb wrapping modulo exact 5.30m chamber depth across the portal plane!
  float orbZ = 2.65 - fract(uTime * 0.42) * 5.30;
  float dzOrb = mod(p.z - orbZ + 2.65, 5.30) - 2.65;
  float orbX = 0.40 + sin(uTime * 0.85) * 0.08;
  float dOrb = length(vec3(p.x - orbX, p.y - 1.66, dzOrb)) - 0.11;
  if (dOrb < d) { d = dOrb; mat = 7.0; }

  if (hasPillar) {
    float dP2 = sdCylinder(p - vec3(-0.46, 0.66, -1.05), 0.14, 0.66);
    if (dP2 < d) { d = dP2; mat = 8.0; }
  }
  return vec2(d, mat);
}

vec3 normalAperture(vec3 p, bool hasPillar) {
  vec2 e = vec2(0.0025, 0.0);
  return normalize(vec3(
    mapApertureChamber(p + e.xyy, hasPillar).x - mapApertureChamber(p - e.xyy, hasPillar).x,
    mapApertureChamber(p + e.yxy, hasPillar).x - mapApertureChamber(p - e.yxy, hasPillar).x,
    mapApertureChamber(p + e.yyx, hasPillar).x - mapApertureChamber(p - e.yyx, hasPillar).x
  ));
}

float softShadowAperture(vec3 ro, vec3 rd, float tMax, float k, bool hasPillar) {
  float res = 1.0, t = 0.04, ph = 1e10;
  for (int i = 0; i < 28; i++) {
    float h = mapApertureObstacles(ro + rd * t, hasPillar);
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

float portalOvalDist(vec2 xy, vec2 cen, vec2 rad) { return length((xy - cen) / rad); }

vec3 shadeApertureSurface(vec3 p, vec3 n, float matId, bool rtxMode, bool hasPillar, bool sunlitRoom, bool frontIsOrange, vec2 blueCen, vec2 orangeCen, vec2 pRad) {
  int m = int(floor(matId + 0.5));
  vec3 alb = vec3(0.42, 0.46, 0.54);
  if (m == 0) {
    float g = max(smoothstep(0.46, 0.495, abs(fract(p.x * 0.9434) - 0.5)), smoothstep(0.46, 0.495, abs(fract((p.z + 2.65) * 0.9434) - 0.5)));
    alb = mix(rtxMode ? vec3(0.14, 0.18, 0.25) : vec3(0.18, 0.22, 0.29), vec3(0.05, 0.07, 0.11), g * 0.78);
  } else if (m == 1) alb = vec3(0.14, 0.17, 0.24);
  else if (m == 2 || m == 3 || m == 4) {
    vec2 uv = (m == 2) ? vec2((p.z + 2.65) * 0.7547, p.y * 0.85) : (p.xy * 0.85);
    float g = max(smoothstep(0.47, 0.495, abs(fract(uv.x) - 0.5)), smoothstep(0.47, 0.495, abs(fract(uv.y) - 0.5)));
    vec3 panel = p.y < 1.05 ? vec3(0.14, 0.17, 0.24) : (rtxMode ? vec3(0.26, 0.31, 0.39) : vec3(0.32, 0.37, 0.44));
    alb = mix(panel, vec3(0.07, 0.09, 0.14), g * 0.72);
  } else if (m == 5) alb = vec3(0.10, 0.12, 0.18);
  else if (m == 6) alb = mix(vec3(0.54, 0.58, 0.64), vec3(0.96, 0.24, 0.50), smoothstep(0.12, 0.08, abs(p.y - 0.60)));
  else if (m == 7) return vec3(0.25, 1.35, 2.15);
  else if (m == 8) alb = vec3(0.46, 0.52, 0.60);

  vec3 lPos = vec3(0.3, 3.15, 0.2);
  vec3 toL = lPos - p; float dL = length(toL); vec3 ld = toL / max(dL, 1e-4);
  float sh = softShadowAperture(p + n * 0.03, ld, dL - 0.1, 7.0, hasPillar);
  vec3 light = (rtxMode ? vec3(0.03, 0.045, 0.08) : vec3(0.09, 0.12, 0.18)) * (0.55 + 0.45 * n.y);
  light += vec3(0.90, 0.92, 0.96) * (max(dot(n, ld), 0.0) * sh * (rtxMode ? 0.42 : 2.35) / (1.5 + dL * dL * 0.36));

  if (sunlitRoom) {
    // Warm sunlit golden chamber visible THROUGH the RTX portal so the viewer immediately sees WHERE the sunbeam comes from!
    vec3 sunDir = normalize(vec3(-0.35, 0.82, 0.45));
    light += vec3(2.85, 1.85, 0.72) * (0.55 + 0.75 * max(dot(n, sunDir), 0.0));
  }

  vec3 colNegZ = frontIsOrange ? vec3(1.65, 0.48, 0.05) : vec3(0.06, 0.66, 1.55);
  vec3 colPosZ = frontIsOrange ? vec3(0.06, 0.66, 1.55) : vec3(1.65, 0.48, 0.05);

  vec3 blueP = vec3(blueCen.x, blueCen.y, -2.58);
  vec3 toB = blueP - p; float dB = length(toB);
  light += colNegZ * (max(dot(n, toB / max(dB, 1e-4)), 0.0) * 0.78 + 0.22) * ((rtxMode ? 2.4 : 2.9) / (0.85 + dB * dB * 0.50));

  vec3 orgP = vec3(orangeCen.x, orangeCen.y, 2.58);
  vec3 toO = orgP - p; float dO = length(toO);
  light += colPosZ * (max(dot(n, toO / max(dO, 1e-4)), 0.0) * 0.78 + 0.22) * ((rtxMode ? 1.8 : 2.6) / (0.85 + dO * dO * 0.50));

  // STAGE 6 (Portal RTX): Blazing golden sunbeam + razor-sharp shadows pouring STRAIGHT OUT of the portal onto the floor, pillar & cube!
  if (rtxMode && !sunlitRoom) {
    vec3 virtualSun = vec3(blueCen.x - 0.74, blueCen.y + 2.15, -5.20);
    vec3 toV = virtualSun - p; float dV = length(toV); vec3 vd = toV / max(dV, 1e-4);
    if (vd.z < -0.05 && p.z > -2.62) {
      float tBlue = (-2.64 - p.z) / vd.z;
      vec3 hitB = p + vd * tBlue;
      float oval = portalOvalDist(hitB.xy, blueCen, pRad * 0.94);
      if (oval < 1.0) {
        float beamEdge = smoothstep(1.0, 0.80, oval);
        float pSh = softShadowAperture(p + n * 0.025, vd, tBlue - 0.05, 16.0, hasPillar);
        float ndv = max(dot(n, vd), 0.0);
        // Rich golden amber direct sunbeam preserving crisp floor tiles, razor pillar shadow & glossy blue portal reflection!
        light += vec3(5.2, 2.55, 0.68) * (ndv * pSh * beamEdge * 8.2 / (1.0 + dV * dV * 0.045));
      }
    }
    // Warm golden GI bounce radiating off the sunlit floor pool onto adjacent pillar/cube/walls!
    vec3 giPool = vec3(0.05, 0.08, -0.35);
    vec3 toGI = giPool - p; float dGI = length(toGI);
    light += vec3(1.15, 0.62, 0.18) * (max(dot(n, toGI / max(dGI, 1e-4)), 0.0) * 0.55 + 0.45) * (1.25 / (0.75 + dGI * dGI * 0.55));
  }
  return alb * light;
}

vec3 shadePortalsAperture(vec3 ro, vec3 rd, int mode, bool actionOn) {
  bool rtxMode = (mode == 2);
  bool hasPillar = (mode != 0);
  int maxDepth = (mode == 0) ? 2 : (mode == 1 ? (actionOn ? 1 : 10) : 6);
  vec2 blueCen = vec2(-0.08, 1.50);
  vec2 orangeCen = (mode == 0)
    ? vec2(-0.08, 1.50)
    : vec2(clamp(-0.08 + uOrangeOff.x, -1.15, 0.95), clamp(1.50 + uOrangeOff.y, 1.15, 2.05));
  vec2 pRad = (mode == 0) ? vec2(0.90, 1.18) : vec2(0.98, 1.26);

  vec3 curRo = ro; vec3 curRd = rd;
  float totalDist = 0.0;
  vec3 outCol = vec3(0.04, 0.06, 0.10);

  for (int bounce = 0; bounce < 11; bounce++) {
    bool frontIsOrange = (mode != 0) && (((bounce + uPortalParity) & 1) == 1);
    float t = 0.004; vec2 hit = vec2(-1.0);
    for (int i = 0; i < 76; i++) {
      vec2 h = mapApertureChamber(curRo + curRd * t, hasPillar);
      if (h.x < 0.0022) { hit = vec2(t, h.y); break; }
      t += max(h.x * 0.9, 0.0025);
      if (t > 16.0) break;
    }
    if (hit.x < 0.0) break;

    totalDist += hit.x;
    vec3 p = curRo + curRd * hit.x;
    int m = int(floor(hit.y + 0.5));

    if (m == 3 || m == 4) {
      bool isNegZ = (m == 3);
      vec2 cen = isNegZ ? blueCen : orangeCen;
      float oval = portalOvalDist(p.xy, cen, pRad);
      bool rimIsOrange = isNegZ ? frontIsOrange : !frontIsOrange;

      if (oval >= 0.91 && oval <= 1.15) {
        float core = smoothstep(1.15, 1.01, oval) * smoothstep(0.89, 0.98, oval);
        vec3 rimCol = (mode == 0)
          ? vec3(0.16, 1.38, 0.88)
          : (rimIsOrange ? vec3(2.25, 0.34, 0.02) : vec3(0.04, 0.72, 2.35));
        float distFade = exp(-totalDist * 0.012);
        outCol = rimCol * (0.88 + core * 1.15) * distFade;
        break;
      }

      if (oval < 0.91) {
        if (bounce >= maxDepth) {
          outCol = (rimIsOrange ? vec3(0.55, 0.18, 0.03) : vec3(0.04, 0.24, 0.55)) * exp(-totalDist * 0.014);
          break;
        }
        vec2 local = p.xy - cen;
        if (mode == 0) {
          vec2 rl = rot2(0.66) * local;
          curRo = vec3(orangeCen.x + rl.x, orangeCen.y + rl.y, isNegZ ? 2.644 : -2.644);
          vec2 rdxy = rot2(0.66) * curRd.xy;
          curRd = normalize(vec3(rdxy.x, rdxy.y, curRd.z));
        } else {
          // Exact 5.30m wall-to-wall seamless teleport -> ZERO distance jump & ZERO angle snap!
          vec2 dstCen = isNegZ ? orangeCen : blueCen;
          curRo = vec3(dstCen.x + local.x, dstCen.y + local.y, isNegZ ? 2.646 : -2.646);
        }
        continue;
      }
    }

    vec3 n = normalAperture(p, hasPillar);
    bool sunlitRoom = rtxMode && (bounce >= 1);
    vec3 col = shadeApertureSurface(p, n, hit.y, rtxMode, hasPillar, sunlitRoom, frontIsOrange, blueCen, orangeCen, pRad);

    // Glossy raytraced floor reflection in Portal RTX (reflects glowing portal ring, sunlit pillar, cube & golden walls!)
    if (rtxMode && m == 0 && bounce == 0) {
      vec3 reflRd = reflect(curRd, n);
      vec3 reflRo = p + n * 0.025;
      float rt = 0.03; vec2 rh = vec2(-1.0);
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
          vec3 pGlow = frontIsOrange ? vec3(2.45, 0.50, 0.06) : vec3(0.14, 1.15, 2.65);
          rCol = ov > 0.89 ? pGlow : vec3(1.55, 1.05, 0.48);
        } else {
          vec3 rn = normalAperture(rp, true);
          rCol = shadeApertureSurface(rp, rn, rh.y, true, true, false, frontIsOrange, blueCen, orangeCen, pRad);
        }
        float fres = 0.24 + 0.54 * pow(1.0 - max(dot(n, -curRd), 0.0), 3.0);
        col = mix(col, rCol, fres);
      }
    }

    // 14-step raymarched volumetric golden god-ray shaft pouring THROUGH the portal with live shadow streaks behind pillar & cube!
    if (rtxMode && bounce == 0) {
      vec3 virtualSun = vec3(blueCen.x - 0.74, blueCen.y + 2.15, -5.20);
      float tEnd = min(hit.x, 6.2);
      float vol = 0.0;
      float stepLen = tEnd / 14.0;
      for (int s = 0; s < 14; s++) {
        float ts = (float(s) + 0.5) * stepLen;
        vec3 vp = curRo + curRd * ts;
        if (vp.z > -2.62 && vp.z < 2.55 && vp.y > 0.02 && vp.y < 3.40) {
          vec3 toV = virtualSun - vp;
          float dV = length(toV);
          vec3 vd = toV / max(dV, 1e-4);
          if (vd.z < -0.05) {
            float tBlue = (-2.64 - vp.z) / vd.z;
            vec3 hitB = vp + vd * tBlue;
            float ov = portalOvalDist(hitB.xy, blueCen, pRad * 0.94);
            if (ov < 1.0) {
              float edge = smoothstep(1.0, 0.65, ov);
              // Fast analytic occlusion check along ray toward portal so the pillar cuts a visible dark shadow streak through the air!
              float occ = softShadowAperture(vp, vd, min(tBlue - 0.05, 4.0), 10.0, true);
              float fade = exp(-max(0.0, vp.z + 2.65) * 0.28);
              vol += edge * occ * fade * stepLen;
            }
          }
        }
      }
      col += vec3(1.95, 1.12, 0.34) * (vol * 0.22);
    }

    // Smooth continuous distance attenuation instead of discrete per-bounce tint -> ZERO brightness jump on portal crossing!
    outCol = col * exp(-totalDist * 0.012);
    break;
  }
  return outCol;
}

// ============================================================================
// STAGE 4 (2013 Antichamber): TRUE 5-ROOM 360-DEG RIEMANN-SHEET PARADOX!!
// Orbit 360 deg around the central monolith -> 4 corners = 4 distinct rooms -> 360 deg lands in a 5th impossible room!
// The branch cut ALWAYS stays hidden behind the opaque central monolith -> ZERO visual seam!
// ============================================================================
int riemannRoomAt(vec3 p) {
  float a = atan(p.x, p.z);
  float delta = mod(a - uShiftState + PI, TAU) - PI;
  float unwrapped = uShiftState + delta;
  // 5 distinct rooms mapped across 90-degree quadrants! (4 turns = 360 deg -> room 4 != room 0!)
  float quad = floor((unwrapped + PI * 0.25) / (PI * 0.5));
  return int(mod(mod(quad, 5.0) + 5.0, 5.0));
}

vec2 mapAntichamber5(vec3 p) {
  // Spacious square looping gallery around central monolith: outer walls at +-3.75, central pillar +-0.95!
  float d = p.y; float mat = 0.0;
  float dCeil = 3.75 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dOut = 3.75 - max(abs(p.x), abs(p.z));
  if (dOut < d) { d = dOut; mat = 2.0; }
  float dMono = sdBox(p - vec3(0.0, 1.88, 0.0), vec3(0.95, 1.88, 0.95));
  if (dMono < d) { d = dMono; mat = 3.0; }

  // Place one unmistakable iconic sculpture in each 90-deg hallway quadrant at outer radius ~2.88m (zero camera clipping at r=1.85!)
  int rId = riemannRoomAt(p);
  float a = atan(p.x, p.z);
  float delta = mod(a - uShiftState + PI, TAU) - PI;
  float qIdx = floor((uShiftState + delta + PI * 0.25) / (PI * 0.5));
  float qCenter = qIdx * (PI * 0.5);
  vec2 lp2 = rot2(-qCenter) * p.xz;
  vec3 lp = vec3(lp2.x, p.y, lp2.y - 2.88);

  if (rId == 0) {
    // Room 0: Golden Escher ascending steps!
    for (int s = 0; s < 4; s++) {
      float fs = float(s);
      float ds = sdBox(lp - vec3(-0.72 + fs * 0.48, 0.28 + fs * 0.40, 0.0), vec3(0.26, 0.16, 0.42));
      if (ds < d) { d = ds; mat = 4.0; }
    }
  } else if (rId == 1) {
    // Room 1: Floating Crimson Twin Cubes!
    vec3 cp = lp - vec3(0.0, 1.50 + sin(uTime * 1.8) * 0.16, 0.0);
    cp.xy = rot2(uTime * 0.7) * cp.xy;
    float dc = min(sdBox(cp, vec3(0.42)), sdBox(lp - vec3(0.0, 0.34, 0.0), vec3(0.46, 0.34, 0.46)));
    if (dc < d) { d = dc; mat = 5.0; }
  } else if (rId == 2) {
    // Room 2: Twin Cobalt & Amber Archway!
    float dA = min(min(
      sdCylinder(lp - vec3(-0.75, 1.55, 0.0), 0.24, 1.55),
      sdCylinder(lp - vec3( 0.75, 1.55, 0.0), 0.24, 1.55)),
      sdBox(lp - vec3(0.0, 3.05, 0.0), vec3(1.05, 0.22, 0.30)));
    if (dA < d) { d = dA; mat = 6.0; }
  } else if (rId == 3) {
    // Room 3: Emerald Floating Sphere on Plinth!
    float dS = min(sdBox(lp - vec3(0.0, 0.42, 0.0), vec3(0.44, 0.42, 0.44)), length(lp - vec3(0.0, 1.55 + sin(uTime * 1.6) * 0.12, 0.0)) - 0.46);
    if (dS < d) { d = dS; mat = 7.0; }
  } else {
    // Room 4 (THE 5TH IMPOSSIBLE ROOM AT 360 DEG!): Neon Magenta Spinning Obelisk + Ring!
    vec3 sp = lp - vec3(0.0, 1.55, 0.0);
    sp.xz = rot2(uTime * 0.95) * sp.xz;
    float dSp = min(sdBox(sp, vec3(0.26, 1.25, 0.26)), sdBox(lp - vec3(0.0, 0.26, 0.0), vec3(0.55, 0.26, 0.55)));
    if (dSp < d) { d = dSp; mat = 8.0; }
  }
  return vec2(d, mat);
}

vec3 shadeAntichamber(vec3 ro, vec3 rd) {
  float t = 0.04; vec2 hit = vec2(-1.0);
  for (int i = 0; i < 76; i++) {
    vec2 h = mapAntichamber5(ro + rd * t);
    if (h.x < 0.0025) { hit = vec2(t, h.y); break; }
    t += max(h.x * 0.85, 0.004);
    if (t > 14.0) break;
  }
  if (hit.x < 0.0) return vec3(0.92);
  vec3 p = ro + rd * hit.x;
  vec2 e = vec2(0.003, 0.0);
  vec3 n = normalize(vec3(
    mapAntichamber5(p + e.xyy).x - mapAntichamber5(p - e.xyy).x,
    mapAntichamber5(p + e.yxy).x - mapAntichamber5(p - e.yxy).x,
    mapAntichamber5(p + e.yyx).x - mapAntichamber5(p - e.yyx).x
  ));
  int rId = riemannRoomAt(p);
  int m = int(floor(hit.y + 0.5));

  // Each of the 5 rooms has its own unmistakable bold Antichamber wall & ink theme!
  vec3 wallCol = vec3(0.93, 0.94, 0.96);
  vec3 lineCol = vec3(0.10, 0.12, 0.16);
  if (rId == 1) { wallCol = vec3(0.11, 0.12, 0.17); lineCol = vec3(0.96, 0.26, 0.38); }
  else if (rId == 2) { wallCol = vec3(0.10, 0.24, 0.44); lineCol = vec3(0.98, 0.78, 0.24); }
  else if (rId == 3) { wallCol = vec3(0.90, 0.94, 0.88); lineCol = vec3(0.08, 0.68, 0.44); }
  else if (rId == 4) { wallCol = vec3(0.16, 0.10, 0.24); lineCol = vec3(0.98, 0.30, 0.88); }

  vec3 col = wallCol;
  if (m == 3) col = (rId == 0 || rId == 3) ? vec3(0.12, 0.14, 0.19) : vec3(0.92, 0.94, 0.96);
  else if (m == 4) col = vec3(0.98, 0.72, 0.12); // Gold stairs
  else if (m == 5) col = vec3(0.98, 0.20, 0.34); // Crimson cubes
  else if (m == 6) col = vec3(0.98, 0.68, 0.16); // Amber arch pillars
  else if (m == 7) col = vec3(0.10, 0.86, 0.54); // Emerald sphere
  else if (m == 8) col = vec3(1.05, 0.28, 0.92); // Neon magenta spire (5th room!)

  float shade = 0.70 + 0.30 * max(dot(n, normalize(vec3(0.35, 0.85, 0.45))), 0.0);
  float edge = gridLine(abs(n.y) > 0.5 ? p.xz : (abs(n.x) > 0.5 ? p.zy : p.xy), 0.80, 1.35);
  return mix(col * shade, lineCol, edge * 0.48);
}

// ============================================================================
// STAGE 5 (2018 CodeParade): BIDIRECTIONAL "1.4m Outside / 24m Inside" FPP PAVILION!!
// Works seamlessly outside, orbiting 360 deg around the back, flying 14m deep INSIDE, and looking back out!
// ============================================================================
vec2 mapInsideHall(vec3 p) {
  float d = p.y; float mat = 0.0;
  float dCeil = 2.62 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dL = p.x + 1.18; if (dL < d) { d = dL; mat = 2.0; }
  float dR = 1.18 - p.x; if (dR < d) { d = dR; mat = 2.0; }
  float dEnd = p.z + 23.5; if (dEnd < d) { d = dEnd; mat = 3.0; }

  vec3 rp = p;
  rp.z = mod(p.z + 1.2, 2.4) - 1.2;
  float dRib = min(min(
    sdBox(rp - vec3(-1.08, 1.31, 0.0), vec3(0.12, 1.31, 0.14)),
    sdBox(rp - vec3( 1.08, 1.31, 0.0), vec3(0.12, 1.31, 0.14))),
    sdBox(rp - vec3( 0.0, 2.50, 0.0), vec3(1.18, 0.14, 0.14)));
  if (dRib < d) { d = dRib; mat = 4.0; }

  float dGem = length(p - vec3(0.0, 1.35 + sin(uTime * 2.0) * 0.16, -18.5)) - 0.62;
  if (dGem < d) { d = dGem; mat = 5.0; }
  return vec2(d, mat);
}

vec2 mapExteriorCourtyard(vec3 p) {
  float d = p.y; float mat = 0.0;
  // TINY 1.4m-deep crimson terracotta stone kiosk! (z in [-0.70, +0.70])
  float boxOuter = sdBox(p - vec3(0.0, 1.45, 0.0), vec3(1.36, 1.45, 0.70));
  float doorCut = sdBox(p - vec3(0.0, 1.27, 0.56), vec3(1.06, 1.28, 0.35));
  float kiosk = max(boxOuter, -doorCut);
  if (kiosk < d) { d = kiosk; mat = 1.0; }

  // Courtyard colonnade pillars & low wall well behind the tiny 1.4m kiosk (proving zero depth behind it, zero camera occlusion!)
  float dPostL = sdCylinder(p - vec3(-4.6, 1.65, -4.4), 0.28, 1.65);
  float dPostR = sdCylinder(p - vec3( 4.6, 1.65, -4.4), 0.28, 1.65);
  float dBackWall = sdBox(p - vec3(0.0, 0.52, -5.4), vec3(5.0, 0.52, 0.30));
  float dEnv = min(min(dPostL, dPostR), dBackWall);
  if (dEnv < d) { d = dEnv; mat = 2.0; }
  return vec2(d, mat);
}

vec3 shadeExteriorColor(vec3 ro, vec3 rd, float tStart) {
  float tExt = tStart; vec2 hitExt = vec2(-1.0);
  for (int i = 0; i < 68; i++) {
    vec2 h = mapExteriorCourtyard(ro + rd * tExt);
    if (h.x < 0.0025) { hitExt = vec2(tExt, h.y); break; }
    tExt += max(h.x * 0.9, 0.004);
    if (tExt > 30.0) break;
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
    bool isTrim = p.z > 0.62 && abs(p.x) < 1.22 && p.y < 2.70;
    alb = isTrim ? vec3(0.96, 0.72, 0.22) : vec3(0.80, 0.26, 0.20);
  }
  vec3 sun = normalize(vec3(0.58, 0.78, 0.42));
  float sh = 1.0, st = 0.08;
  for (int i = 0; i < 24; i++) {
    float h = sdBox(p + n * 0.04 + sun * st - vec3(0.0, 1.45, 0.0), vec3(1.36, 1.45, 0.70));
    if (h < 0.005) { sh = 0.0; break; }
    sh = min(sh, 7.0 * h / st);
    st += clamp(h, 0.05, 0.35);
    if (st > 8.0) break;
  }
  return alb * (vec3(0.24, 0.30, 0.42) + vec3(1.18, 1.04, 0.84) * (max(dot(n, sun), 0.0) * sh));
}

vec3 shadeCodeParade(vec3 ro, vec3 rd) {
  bool startInside = uInHall > 0.5 || (ro.z <= 0.66 && abs(ro.x) < 1.15 && ro.y < 2.60);

  // Case 1: Camera is INSIDE the 24m hall! (Zero dead zone at z = 0.66 -> zero doorway flash!)
  if (startInside) {
    float tExit = 1e9;
    if (rd.z > 0.002) {
      float te = (0.68 - ro.z) / rd.z;
      if (te >= 0.0) {
        vec3 ep = ro + rd * te;
        if (abs(ep.x) < 1.06 && ep.y > 0.0 && ep.y < 2.55) tExit = te;
      }
    }
    float tIn = 0.002; vec2 hitIn = vec2(-1.0);
    for (int i = 0; i < 82; i++) {
      vec3 p = ro + rd * tIn;
      if (p.z > 0.68) break;
      vec2 h = mapInsideHall(p);
      if (h.x < 0.003) { hitIn = vec2(tIn, h.y); break; }
      tIn += max(h.x * 0.9, 0.004);
      if (tIn > min(tExit, 28.0)) break;
    }
    if (tExit < 1e8 && (hitIn.x < 0.0 || tExit < hitIn.x)) {
      return shadeExteriorColor(ro, rd, tExit + 0.02);
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
      if (m == 5) return vec3(0.24, 1.60, 2.15);
      if (m == 3) return vec3(1.55, 1.15, 0.65);
      vec3 alb = vec3(0.20, 0.25, 0.36);
      if (m == 0) alb = mix(vec3(0.14, 0.18, 0.28), vec3(0.76, 0.72, 0.66), mod(floor(p.x * 2.0) + floor(p.z * 0.9), 2.0));
      else if (m == 4) alb = vec3(0.95, 0.70, 0.26);
      else if (m == 2) alb = vec3(0.22, 0.35, 0.54);
      float ribLight = 0.55 + 0.45 * cos(p.z * 2.618);
      float depthGlow = exp(-max(0.0, p.z + 18.5) * 0.16) * 1.1;
      vec3 col = alb * (0.32 + 0.78 * ribLight * (0.6 + 0.4 * max(n.y, 0.0))) + vec3(0.18, 0.82, 1.0) * depthGlow * 0.45;
      return mix(col, vec3(0.10, 0.20, 0.34), (1.0 - exp(-max(0.0, -p.z) * 0.045)) * 0.60);
    }
    return vec3(0.12, 0.18, 0.28);
  }

  // Case 2: Camera is OUTSIDE -> check if ray crosses front doorway portal (z = +0.66) with ZERO dead zone (td >= 0.0)!
  float tDoor = 1e9;
  if (ro.z > 0.66 && rd.z < -0.002) {
    float td = (0.66 - ro.z) / rd.z;
    if (td >= 0.0) {
      vec3 dp = ro + rd * td;
      if (abs(dp.x) < 1.06 && dp.y > 0.0 && dp.y < 2.55) tDoor = td;
    }
  }
  float tExt = 0.004; vec2 hitExt = vec2(-1.0);
  for (int i = 0; i < 68; i++) {
    vec2 h = mapExteriorCourtyard(ro + rd * tExt);
    if (h.x < 0.0025) { hitExt = vec2(tExt, h.y); break; }
    tExt += max(h.x * 0.9, 0.004);
    if (tExt > min(tDoor, 28.0)) break;
  }
  if (tDoor < 1e8 && (hitExt.x < 0.0 || tDoor <= hitExt.x)) {
    float tIn = max(tDoor, 0.0) + 0.002; vec2 hitIn = vec2(-1.0);
    for (int i = 0; i < 112; i++) {
      vec2 h = mapInsideHall(ro + rd * tIn);
      if (h.x < 0.003) { hitIn = vec2(tIn, h.y); break; }
      tIn += max(h.x * 0.9, 0.005);
      if (tIn > 32.0) break;
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
      if (m == 5) return vec3(0.24, 1.60, 2.15);
      if (m == 3) return vec3(1.55, 1.15, 0.65);
      vec3 alb = vec3(0.20, 0.25, 0.36);
      if (m == 0) alb = mix(vec3(0.14, 0.18, 0.28), vec3(0.76, 0.72, 0.66), mod(floor(p.x * 2.0) + floor(p.z * 0.9), 2.0));
      else if (m == 4) alb = vec3(0.95, 0.70, 0.26);
      else if (m == 2) alb = vec3(0.22, 0.35, 0.54);
      float ribLight = 0.55 + 0.45 * cos(p.z * 2.618);
      float depthGlow = exp(-max(0.0, p.z + 18.5) * 0.16) * 1.1;
      vec3 col = alb * (0.32 + 0.78 * ribLight * (0.6 + 0.4 * max(n.y, 0.0))) + vec3(0.18, 0.82, 1.0) * depthGlow * 0.45;
      return mix(col, vec3(0.10, 0.20, 0.34), (1.0 - exp(-max(0.0, -p.z) * 0.045)) * 0.60);
    }
    return vec3(1.55, 1.15, 0.65);
  }
  return shadeExteriorColor(ro, rd, 0.04);
}

// ============================================================================
// STAGE 7 (2023 Viewfinder): Stamp 2D Polaroid & WALK FPP ONTO THE 3D BRIDGE!
// ============================================================================
vec2 mapDarkRoom(vec3 p) {
  float d = p.y; float mat = 0.0;
  float dCeil = 3.6 - p.y; if (dCeil < d) { d = dCeil; mat = 1.0; }
  float dBack = p.z + 2.4; if (dBack < d) { d = dBack; mat = 2.0; }
  float dL = p.x + 3.2; if (dL < d) { d = dL; mat = 2.0; }
  float dR = 3.2 - p.x; if (dR < d) { d = dR; mat = 2.0; }
  float dCrate = sdBox(p - vec3(-1.95, 0.48, -1.2), vec3(0.46));
  if (dCrate < d) { d = dCrate; mat = 3.0; }
  return vec2(d, mat);
}

vec2 mapPhotoWorld(vec3 p) {
  float d = p.y; float mat = 0.0;
  // Walkable turquoise-inlaid sandstone bridge stretching straight out through the stamped wall!
  float dBridge = sdBox(p - vec3(0.0, 0.14, -4.2), vec3(1.10, 0.14, 3.6));
  float dPilL = sdCylinder(p - vec3(-1.05, 1.48, -2.8), 0.22, 1.48);
  float dPilR = sdCylinder(p - vec3( 1.05, 1.48, -2.8), 0.22, 1.48);
  float dLint = sdBox(p - vec3(0.0, 3.02, -2.8), vec3(1.42, 0.22, 0.28));
  float dPilL2 = sdCylinder(p - vec3(-1.15, 1.48, -6.2), 0.24, 1.48);
  float dPilR2 = sdCylinder(p - vec3( 1.15, 1.48, -6.2), 0.24, 1.48);
  float dLint2 = sdBox(p - vec3(0.0, 3.02, -6.2), vec3(1.52, 0.22, 0.28));
  float dSunOrb = length(p - vec3(0.0, 1.92 + sin(uTime * 1.4) * 0.14, -5.8)) - 0.48;
  float dArch = min(min(min(dPilL, dPilR), dLint), min(min(dPilL2, dPilR2), dLint2));
  if (dArch < d) { d = dArch; mat = 1.0; }
  if (dBridge < d) { d = dBridge; mat = 2.0; }
  if (dSunOrb < d) { d = dSunOrb; mat = 3.0; }
  return vec2(d, mat);
}

bool insidePhotoFrustum(vec3 p) {
  float depth = 2.6 - p.z;
  if (depth < 1.35 || depth > 18.0) return false;
  return abs(p.x) < depth * 0.42 && abs(p.y - 1.55) < depth * 0.34;
}

vec3 shadePhotoWorldAt(vec3 p, float matId) {
  vec2 e = vec2(0.003, 0.0);
  vec3 n = normalize(vec3(
    mapPhotoWorld(p + e.xyy).x - mapPhotoWorld(p - e.xyy).x,
    mapPhotoWorld(p + e.yxy).x - mapPhotoWorld(p - e.yxy).x,
    mapPhotoWorld(p + e.yyx).x - mapPhotoWorld(p - e.yyx).x
  ));
  int m = int(floor(matId + 0.5));
  if (m == 3) return vec3(1.75, 1.18, 0.36);
  vec3 alb = m == 0 ? vec3(0.88, 0.74, 0.56) : (m == 1 ? vec3(0.95, 0.86, 0.70) : vec3(0.18, 0.72, 0.84));
  if (m == 2) {
    float strip = smoothstep(0.18, 0.14, abs(p.x)) + smoothstep(0.08, 0.04, abs(abs(p.x) - 0.96));
    alb = mix(vec3(0.90, 0.80, 0.64), vec3(0.12, 0.78, 0.88), clamp(strip, 0.0, 1.0));
  }
  float ndl = max(dot(n, normalize(vec3(0.45, 0.85, 0.35))), 0.0);
  return alb * (vec3(0.32, 0.38, 0.52) + vec3(1.22, 0.98, 0.70) * ndl);
}

vec3 shadePhotoWorldColor(vec3 ro, vec3 rd) {
  float t = 0.04; vec2 hit = vec2(-1.0);
  for (int i = 0; i < 66; i++) {
    vec2 h = mapPhotoWorld(ro + rd * t);
    if (h.x < 0.003) { hit = vec2(t, h.y); break; }
    t += max(h.x * 0.9, 0.005);
    if (t > 20.0) break;
  }
  if (hit.x < 0.0) {
    float s = clamp(rd.y * 0.7 + 0.4, 0.0, 1.0);
    return mix(vec3(1.0, 0.84, 0.56), vec3(0.16, 0.56, 0.96), pow(s, 0.75));
  }
  return shadePhotoWorldAt(ro + rd * hit.x, hit.y);
}

vec3 shadeViewfinder(vec3 ro, vec3 rd) {
  if (uPhotoStamp < 0.5) {
    if (rd.z < -0.02 && ro.z > 0.75) {
      float tp = (0.75 - ro.z) / rd.z;
      vec3 pp = ro + rd * tp;
      vec2 card = pp.xy - vec2(0.0, 1.52);
      if (abs(card.x) < 0.94 && abs(card.y) < 0.78) {
        if (abs(card.x) > 0.84 || card.y > 0.68 || card.y < -0.56) return vec3(0.95, 0.92, 0.86);
        vec2 photoUv = (card - vec2(0.0, 0.06)) / vec2(0.84, 0.62);
        vec3 photoRd = normalize(vec3(photoUv.x * 0.58, photoUv.y * 0.44, -1.0));
        return shadePhotoWorldColor(vec3(0.0, 1.55, 2.2), photoRd);
      }
    }
  }

  float t = 0.04; bool hitIsPhoto = false; vec2 hit = vec2(-1.0);
  for (int i = 0; i < 86; i++) {
    vec3 p = ro + rd * t;
    bool inP = uPhotoStamp >= 0.5 && (p.z < -2.42 || insidePhotoFrustum(p));
    vec2 h = inP ? mapPhotoWorld(p) : mapDarkRoom(p);
    if (h.x < 0.003) { hit = vec2(t, h.y); hitIsPhoto = inP; break; }
    t += max(min(h.x * 0.88, 0.25), 0.005);
    if (t > 18.0) break;
  }

  if (hit.x < 0.0) {
    float s = clamp(rd.y * 0.7 + 0.4, 0.0, 1.0);
    return mix(vec3(1.0, 0.84, 0.56), vec3(0.16, 0.56, 0.96), pow(s, 0.75));
  }

  vec3 p = ro + rd * hit.x;
  if (uPhotoStamp >= 0.5 && !hitIsPhoto) {
    float depth = 2.6 - p.z;
    if (depth > 1.32 && depth < 18.0) {
      float dx = abs(abs(p.x) - depth * 0.42);
      float dy = abs(abs(p.y - 1.55) - depth * 0.34);
      if ((dx < 0.045 && abs(p.y - 1.55) <= depth * 0.34 + 0.045) ||
          (dy < 0.045 && abs(p.x) <= depth * 0.42 + 0.045)) {
        return vec3(1.0, 0.96, 0.88) * 1.15;
      }
    }
  }
  if (hitIsPhoto) return shadePhotoWorldAt(p, hit.y);

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
