// Procedural red-fox totem geometry, 24,000 clumped 3D fur strands & 64x32 live spring-damper groom solver.

import { clamp, smoothstep, norm3, cross3 } from "../../src/gl-utils.js";

export const STRAND_COUNT = 30000;
export const STRAND_SEGS = 5;        // 5 quad segments (12 vertices) per tapered 3D fur strand
export const GROOM_W = 64;
export const GROOM_H = 32;
export const POLLEN_COUNT = 72;

// Deterministic PRNG so FX Lab and 60fps video renders match identically.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ----------------------------------------------------------------------------
// 1. Sculpted Red-Fox Head Surface & Natural Coat Coloring / Fur Length Masks
// ----------------------------------------------------------------------------
// Maps a unit sphere direction (dx, dy, dz) onto a stylized, cute plush red-fox head with
// pointed triangular ears, fluffy cheeks, and a gentle snout (+Z faces forward).
export function evalFoxSurface(dx, dy, dz) {
  // Base slightly wide fox head silhouette
  let sx = 1.04;
  let sy = 0.90;
  let sz = 0.96;

  // Fluffy lower cheek tufts fanning out slightly at y in [-0.35, 0.10]
  const cheekMask = Math.exp(-((dy + 0.14) ** 2) / 0.11) * Math.exp(-((Math.abs(dx) - 0.78) ** 2) / 0.16);
  sx += 0.15 * cheekMask;

  // Soft tapered fox muzzle protruding toward +Z
  const muzzle = smoothstep(0.55, 0.98, dz) * Math.exp(-((dy + 0.18) ** 2) / 0.10) * Math.exp(-(dx * dx) / 0.18);
  sz += 0.34 * muzzle;

  // Subtle brow ridge above eyes
  const brow = smoothstep(0.45, 0.85, dz) * Math.exp(-((dy - 0.24) ** 2) / 0.05) * Math.exp(-((Math.abs(dx) - 0.30) ** 2) / 0.09);
  sz += 0.05 * brow;

  let px = dx * sx;
  let py = dy * sy;
  let pz = dz * sz;

  // Sculpted pointed fox ears smoothly extruded from the upper crown (left & right).
  const earDirL = norm3(-0.56, 0.81, -0.08);
  const earDirR = norm3( 0.56, 0.81, -0.08);
  const dL = dx * earDirL[0] + dy * earDirL[1] + dz * earDirL[2];
  const dR = dx * earDirR[0] + dy * earDirR[1] + dz * earDirR[2];
  const dEar = Math.max(dL, dR);
  let earTip = 0.0;
  if (dEar > 0.84) {
    const t = clamp((dEar - 0.84) / 0.16, 0, 1);
    const eShape = Math.pow(t, 1.55);
    const eDir = dL >= dR ? earDirL : earDirR;
    // Slight forward cup + upward taper into crisp fox ear tips!
    px += eDir[0] * eShape * 0.74;
    py += eDir[1] * eShape * 0.82;
    pz += (eDir[2] * 0.5 + 0.12) * eShape * 0.65;
    earTip = t;
  }

  return { x: px, y: py + 1.12, z: pz, earTip };
}

// Compute smooth surface normal via finite differences on the unit sphere.
export function evalFoxNormal(dx, dy, dz) {
  const ref = Math.abs(dy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t1 = norm3(...cross3([dx, dy, dz], ref));
  const t2 = cross3([dx, dy, dz], t1);
  const eps = 0.012;
  const p0 = evalFoxSurface(dx, dy, dz);
  const d1 = norm3(dx + t1[0] * eps, dy + t1[1] * eps, dz + t1[2] * eps);
  const d2 = norm3(dx + t2[0] * eps, dy + t2[1] * eps, dz + t2[2] * eps);
  const p1 = evalFoxSurface(d1[0], d1[1], d1[2]);
  const p2 = evalFoxSurface(d2[0], d2[1], d2[2]);
  const n = norm3(...cross3([p1.x - p0.x, p1.y - p0.y, p1.z - p0.z], [p2.x - p0.x, p2.y - p0.y, p2.z - p0.z]));
  // Ensure outward orientation
  if (n[0] * dx + n[1] * dy + n[2] * dz < 0) return [-n[0], -n[1], -n[2]];
  return n;
}

// Linear-space natural red-fox coat palette & fur length map!
// Keeps fur very short around the shiny eyes & nose so the face stays expressive and crisp.
export function evalFoxCoat(dx, dy, dz, earTip) {
  // Rich linear-space fox orange, creamy white cheeks/chin, espresso ear tips & muzzle markings.
  const foxOrange = [0.62, 0.155, 0.022];
  const foxDeep   = [0.38, 0.075, 0.012];
  const foxCream  = [0.84, 0.72, 0.56];
  const earDark   = [0.055, 0.028, 0.022];

  // Classic red fox cream cheeks & lower muzzle mask
  const cheekWhite = smoothstep(0.05, -0.22, dy + 0.12 * Math.cos(dx * 2.8)) * smoothstep(-0.35, 0.25, dz);
  // Subtle cream brow dots above eyes
  const browDot = Math.exp(-((Math.abs(dx) - 0.30) ** 2 + (dy - 0.25) ** 2 + (dz - 0.88) ** 2) / 0.018);
  const whiteMask = clamp(cheekWhite + browDot * 0.45, 0, 1);

  // Darker russet dorsal stripe down the forehead & crown
  const dorsal = Math.exp(-(dx * dx) / 0.14) * smoothstep(-0.1, 0.7, dy);
  let r = foxOrange[0] * (1 - dorsal * 0.35) + foxDeep[0] * (dorsal * 0.35);
  let g = foxOrange[1] * (1 - dorsal * 0.35) + foxDeep[1] * (dorsal * 0.35);
  let b = foxOrange[2] * (1 - dorsal * 0.35) + foxDeep[2] * (dorsal * 0.35);

  r = r * (1 - whiteMask) + foxCream[0] * whiteMask;
  g = g * (1 - whiteMask) + foxCream[1] * whiteMask;
  b = b * (1 - whiteMask) + foxCream[2] * whiteMask;

  // Iconic dark espresso fox ear tips!
  const tipMask = smoothstep(0.42, 0.88, earTip);
  r = r * (1 - tipMask) + earDark[0] * tipMask;
  g = g * (1 - tipMask) + earDark[1] * tipMask;
  b = b * (1 - tipMask) + earDark[2] * tipMask;

  // Natural fur length: plush & long on cheeks/ruff/crown, velvety short trim right around eyes & nose!
  const eyeDistL = Math.hypot(dx + 0.34, dy - 0.10, dz - 0.92);
  const eyeDistR = Math.hypot(dx - 0.34, dy - 0.10, dz - 0.92);
  const noseDist = Math.hypot(dx, dy + 0.17, dz - 0.98);
  const faceClear = smoothstep(0.10, 0.26, Math.min(eyeDistL, eyeDistR)) * smoothstep(0.10, 0.24, noseDist);

  const cheekFluff = 1.0 + 0.44 * Math.exp(-((dy + 0.15) ** 2) / 0.12) * smoothstep(0.28, 0.85, Math.abs(dx));
  const earShort = 1.0 - 0.45 * smoothstep(0.25, 0.90, earTip);
  const furLen = (0.195 * cheekFluff * earShort) * (0.18 + 0.82 * faceClear);

  return { col: [r, g, b], furLen, faceClear };
}

// ----------------------------------------------------------------------------
// 2. Fox Shell / Base Mesh (64x48 sphere sculpted by evalFoxSurface)
//    Vertex layout: [px, py, pz, nx, ny, nz, u, v, r, g, b, furLen] = 12 floats
// ----------------------------------------------------------------------------
export function buildFoxShellMesh() {
  const segU = 72, segV = 54;
  const verts = [];
  const idxs = [];
  for (let iy = 0; iy <= segV; iy++) {
    const v = iy / segV;
    const phi = v * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let ix = 0; ix <= segU; ix++) {
      const u = ix / segU;
      const th = u * Math.PI * 2.0 - Math.PI * 0.5;
      const dx = sp * Math.cos(th);
      const dy = cp;
      const dz = sp * Math.sin(th);
      const p = evalFoxSurface(dx, dy, dz);
      const n = evalFoxNormal(dx, dy, dz);
      const coat = evalFoxCoat(dx, dy, dz, p.earTip);
      verts.push(p.x, p.y, p.z, n[0], n[1], n[2], u, v, coat.col[0], coat.col[1], coat.col[2], coat.furLen);
    }
  }
  const stride = segU + 1;
  for (let iy = 0; iy < segV; iy++) {
    for (let ix = 0; ix < segU; ix++) {
      const a = iy * stride + ix;
      const b = a + stride;
      idxs.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idxs) };
}

// ----------------------------------------------------------------------------
// 3. Solid Accessories: Mossy Forest Stump + Shiny Black Eyes & Fox Nose
//    Vertex layout: [px, py, pz, nx, ny, nz, u, v, matId] = 9 floats
//    mat 1 = weathered stump wood, mat 2 = mossy stone rim, mat 3 = glossy eye/nose, mat 4 = brass collar
// ----------------------------------------------------------------------------
function pushSolid(arr, px, py, pz, nx, ny, nz, u, v, mat) {
  const l = Math.hypot(nx, ny, nz) || 1;
  arr.push(px, py, pz, nx / l, ny / l, nz / l, u, v, mat);
}

function addSolidSphere(verts, idxs, cx, cy, cz, rx, ry, rz, latN, lonN, mat) {
  const base = verts.length / 9;
  for (let y = 0; y <= latN; y++) {
    const v = y / latN, phi = v * Math.PI, sp = Math.sin(phi), cp = Math.cos(phi);
    for (let x = 0; x <= lonN; x++) {
      const u = x / lonN, th = u * Math.PI * 2;
      const nx = sp * Math.cos(th), ny = cp, nz = sp * Math.sin(th);
      pushSolid(verts, cx + nx * rx, cy + ny * ry, cz + nz * rz, nx / rx, ny / ry, nz / rz, u, v, mat);
    }
  }
  const st = lonN + 1;
  for (let y = 0; y < latN; y++) {
    for (let x = 0; x < lonN; x++) {
      const a = base + y * st + x, b = a + st;
      idxs.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
}

function addSolidCyl(verts, idxs, y0, y1, r0, r1, segs, mat) {
  const base = verts.length / 9;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs, a = u * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const bark = 1.0 + 0.035 * Math.sin(a * 9.0) + 0.02 * Math.cos(a * 17.0);
    pushSolid(verts, ca * r0 * bark, y0, sa * r0 * bark, ca, 0.08, sa, u, 0, mat);
    pushSolid(verts, ca * r1 * bark, y1, sa * r1 * bark, ca, 0.08, sa, u, 1, mat);
  }
  for (let i = 0; i < segs; i++) {
    const k = base + i * 2;
    idxs.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  // Top & bottom caps
  for (const [cy, r, ny] of [[y0, r0, -1], [y1, r1, 1]]) {
    const cIdx = verts.length / 9;
    pushSolid(verts, 0, cy, 0, 0, ny, 0, 0.5, 0.5, mat);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const bark = 1.0 + 0.035 * Math.sin(a * 9.0) + 0.02 * Math.cos(a * 17.0);
      pushSolid(verts, Math.cos(a) * r * bark, cy, Math.sin(a) * r * bark, 0, ny, 0, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a), mat);
    }
    for (let i = 0; i < segs; i++) {
      if (ny > 0) idxs.push(cIdx, cIdx + 1 + i, cIdx + 2 + i);
      else idxs.push(cIdx, cIdx + 2 + i, cIdx + 1 + i);
    }
  }
}

export function buildBasePedestalMesh() {
  const verts = [], idxs = [];
  // Weathered forest wood stump + mossy ring
  addSolidCyl(verts, idxs, -0.55, 0.05, 1.38, 1.18, 40, 1.0);
  addSolidCyl(verts, idxs, 0.05, 0.24, 1.16, 1.04, 36, 2.0);
  // Subtle antique brass neck collar anchoring the plush fox totem!
  addSolidCyl(verts, idxs, 0.22, 0.34, 0.72, 0.68, 32, 4.0);
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idxs) };
}

export function buildFoxFeaturesMesh() {
  const verts = [], idxs = [];
  // Expressive glossy obsidian bead eyes positioned right on the sculpted brow/cheeks
  const eL = evalFoxSurface(-0.34, 0.10, 0.93);
  const eR = evalFoxSurface( 0.34, 0.10, 0.93);
  addSolidSphere(verts, idxs, eL.x * 0.97, eL.y, eL.z * 0.99, 0.115, 0.125, 0.105, 16, 20, 3.0);
  addSolidSphere(verts, idxs, eR.x * 0.97, eR.y, eR.z * 0.99, 0.115, 0.125, 0.105, 16, 20, 3.0);
  // Cute glossy black fox nose at tip of the muzzle!
  const nose = evalFoxSurface(0.0, -0.17, 0.985);
  addSolidSphere(verts, idxs, nose.x, nose.y + 0.01, nose.z + 0.03, 0.125, 0.095, 0.105, 14, 18, 3.0);
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idxs) };
}

// ----------------------------------------------------------------------------
// 4. 24,000 Geometric Clumped 3D Fur Strands Generator (Steps 7 & 8!)
//    Each strand instance stores 12 floats:
//      [rx, ry, rz, nx, ny, nz, colR, colG, colB, length, uGroom, seed]
//    Strands cluster organically around ~720 clump guide hairs for true mammal coat texture!
// ----------------------------------------------------------------------------
export function buildClumpedStrands() {
  const rng = makeRng(20261122);
  const CLUMPS = 720;
  const clumpDir = new Float32Array(CLUMPS * 3);
  const clumpBend = new Float32Array(CLUMPS * 3);

  // Golden-angle Fibonacci distribution of clump guides over the sphere
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let c = 0; c < CLUMPS; c++) {
    const y = 1 - (c / (CLUMPS - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * c;
    clumpDir[c * 3] = Math.cos(th) * rad;
    clumpDir[c * 3 + 1] = y;
    clumpDir[c * 3 + 2] = Math.sin(th) * rad;
    clumpBend[c * 3] = (rng() - 0.5) * 0.35;
    clumpBend[c * 3 + 1] = -0.35 - rng() * 0.35;
    clumpBend[c * 3 + 2] = (rng() - 0.5) * 0.35;
  }

  const data = new Float32Array(STRAND_COUNT * 12);
  let out = 0;
  let attempts = 0;
  while (out < STRAND_COUNT && attempts < STRAND_COUNT * 4) {
    attempts++;
    const cIdx = Math.floor(rng() * CLUMPS);
    const gx = clumpDir[cIdx * 3], gy = clumpDir[cIdx * 3 + 1], gz = clumpDir[cIdx * 3 + 2];

    // Scatter strand tightly around its clump guide to create visible silky locks!
    const spread = 0.085 * Math.sqrt(rng());
    const [dx, dy, dz] = norm3(
      gx + (rng() - 0.5) * spread * 2.2,
      gy + (rng() - 0.5) * spread * 2.2,
      gz + (rng() - 0.5) * spread * 2.2,
    );

    // Skip underside tucked inside the collar
    if (dy < -0.78) continue;

    const p = evalFoxSurface(dx, dy, dz);
    const n = evalFoxNormal(dx, dy, dz);
    const coat = evalFoxCoat(dx, dy, dz, p.earTip);
    // Skip only directly underneath the eyeball and nose sockets; keep plush short velvet around eyelids!
    if (coat.faceClear < 0.04) continue;

    // Pull tip slightly toward clump center + slight natural curl variation
    const len = coat.furLen * (0.78 + 0.44 * rng()) * 1.18;
    const uGroom = (Math.atan2(dz, dx) / (Math.PI * 2) + 1.25) % 1.0;
    const vGroom = Math.acos(clamp(dy, -1, 1)) / Math.PI;
    // Pack (uGroom, vGroom) cleanly into 12-float instance record:
    // Reuse [nx,ny,nz] slightly biased by clumpBend so strands inside a clump lean together!
    const clN = norm3(
      n[0] + clumpBend[cIdx * 3] * 0.25,
      n[1] + clumpBend[cIdx * 3 + 1] * 0.25,
      n[2] + clumpBend[cIdx * 3 + 2] * 0.25,
    );

    const o = out * 12;
    data[o + 0] = p.x;
    data[o + 1] = p.y;
    data[o + 2] = p.z;
    data[o + 3] = clN[0];
    data[o + 4] = clN[1];
    data[o + 5] = clN[2];
    data[o + 6] = coat.col[0] * (0.86 + 0.28 * rng());
    data[o + 7] = coat.col[1] * (0.86 + 0.28 * rng());
    data[o + 8] = coat.col[2] * (0.86 + 0.28 * rng());
    data[o + 9] = len;
    data[o + 10] = uGroom;
    data[o + 11] = vGroom + Math.floor(rng() * 100) * 1.0; // integer part = seed, fract = vGroom!
    out++;
  }
  return { data, count: out };
}

// ----------------------------------------------------------------------------
// 5. Live 64x32 Spring-Damper Groom Field (Wind Waves, Head Shake Inertia & Petting!)
//    Packs 3D displacement into an RGBA8 texture: rgb = 0.5 + disp * 0.5, a = flutter energy.
// ----------------------------------------------------------------------------
export function createGroomSim() {
  const N = GROOM_W * GROOM_H;
  const disp = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const texBuf = new Uint8Array(N * 4);

  function reset() {
    disp.fill(0);
    vel.fill(0);
    pack();
  }

  // Pet / comb the fur interactively at spherical UV (u, v) with impulse direction (ix, iy, iz).
  function petAtUV(u, v, ix, iy, iz, radius = 0.16) {
    for (let y = 0; y < GROOM_H; y++) {
      const vg = (y + 0.5) / GROOM_H;
      const dv = vg - v;
      for (let x = 0; x < GROOM_W; x++) {
        const ug = (x + 0.5) / GROOM_W;
        let du = Math.abs(ug - u);
        if (du > 0.5) du = 1.0 - du;
        const d2 = du * du + dv * dv;
        const w = Math.exp(-d2 / (radius * radius));
        if (w > 0.01) {
          const o = (y * GROOM_W + x) * 3;
          vel[o + 0] += ix * w * 14.0;
          vel[o + 1] += iy * w * 14.0;
          vel[o + 2] += iz * w * 14.0;
        }
      }
    }
  }

  // Step the spring-damper field driven by swirling forest gusts + head shake angular acceleration!
  function step(dt, time, gustStrength, headAngAcc) {
    const stiff = 26.0;
    const damp = 5.4;
    for (let y = 0; y < GROOM_H; y++) {
      const v = (y + 0.5) / GROOM_H;
      const phi = v * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let x = 0; x < GROOM_W; x++) {
        const u = (x + 0.5) / GROOM_W;
        const th = u * Math.PI * 2.0 - Math.PI * 0.5;
        const dx = sp * Math.cos(th), dz = sp * Math.sin(th);

        // Travelling gust wave sweeping across the fox coat from left to right!
        const wave = Math.sin(dx * 3.8 - time * 5.2 + cp * 2.4) * 0.5 + 0.5;
        const swirl = Math.cos(dz * 4.5 + time * 4.1 - dx * 2.2);
        const fx = (0.45 + 0.85 * wave) * gustStrength + (-dz * headAngAcc * 1.8);
        const fy = (0.18 * swirl - 0.12) * gustStrength;
        const fz = (0.28 * swirl) * gustStrength + (dx * headAngAcc * 1.8);

        const o = (y * GROOM_W + x) * 3;
        vel[o + 0] += (fx * 18.0 - stiff * disp[o + 0] - damp * vel[o + 0]) * dt;
        vel[o + 1] += (fy * 18.0 - stiff * disp[o + 1] - damp * vel[o + 1]) * dt;
        vel[o + 2] += (fz * 18.0 - stiff * disp[o + 2] - damp * vel[o + 2]) * dt;

        disp[o + 0] = clamp(disp[o + 0] + vel[o + 0] * dt, -1.0, 1.0);
        disp[o + 1] = clamp(disp[o + 1] + vel[o + 1] * dt, -1.0, 1.0);
        disp[o + 2] = clamp(disp[o + 2] + vel[o + 2] * dt, -1.0, 1.0);
      }
    }
    pack();
  }

  function pack() {
    for (let i = 0; i < N; i++) {
      const o = i * 3, p = i * 4;
      texBuf[p + 0] = Math.round(clamp(disp[o + 0] * 0.5 + 0.5, 0, 1) * 255);
      texBuf[p + 1] = Math.round(clamp(disp[o + 1] * 0.5 + 0.5, 0, 1) * 255);
      texBuf[p + 2] = Math.round(clamp(disp[o + 2] * 0.5 + 0.5, 0, 1) * 255);
      const energy = clamp(Math.hypot(vel[o], vel[o + 1], vel[o + 2]) * 0.25, 0, 1);
      texBuf[p + 3] = Math.round(energy * 255);
    }
    return texBuf;
  }

  reset();
  return { texBuf, reset, petAtUV, step, pack };
}

// ----------------------------------------------------------------------------
// 6. Sunlit Forest Pollen Motes (drifting softly in the golden sunbeams)
// ----------------------------------------------------------------------------
export function buildPollenBuffer() {
  const rng = makeRng(9091);
  const data = new Float32Array(POLLEN_COUNT * 4);
  for (let i = 0; i < POLLEN_COUNT; i++) {
    data[i * 4 + 0] = (rng() - 0.5) * 4.4;
    data[i * 4 + 1] = 0.25 + rng() * 2.6;
    data[i * 4 + 2] = (rng() - 0.5) * 3.8;
    data[i * 4 + 3] = rng();
  }
  return data;
}
