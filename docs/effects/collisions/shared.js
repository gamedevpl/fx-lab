// Shared deterministic simulation core for Evolution of Collision Detection & Tunneling (1988-2024).
// Drives both the primary WebGPU Compute renderer (4,096 GPU bullets + 3D spatial hash compute grid)
// and the automatic WebGL2 fallback (512 bullets + full-fidelity CPU fallback).
//
// Layout designed for instant split-screen clarity:
//   - Stages 0, 3, 5, 6, 7: Horizontal razor-thin steel bulkhead along z = 0; high-velocity projectiles
//     fire from back (-Z) toward the camera (+Z), so a vertical 50% split bar compares Left (Discrete
//     crimson breach pouring toward the viewer!) vs Right (Swept CCD 0% tunneling!) side-by-side!
//   - Stage 1 (1993 Doom p_map.c Bug): Twin East (+X) & West (-X) walls with a center Mancubus turret
//     firing identical fireballs both ways (East subdivides & hits; West lacks abs() & clips straight through!).

export const DEFAULT_CAMERA = {
  yaw: 0.0,
  pitch: 0.44,
  dist: 12.6,
  target: [0.0, 1.05, 0.2],
  fov: 42,
  minDist: 6.5,
  maxDist: 23.0,
  minPitch: 0.08,
  maxPitch: 1.32,
};

export const MAX_INSTANCES = 1400;
export const GRID_DIMS = [16, 8, 16]; // 2,048 spatial hash cells covering [-4.8..4.8] x [0..4.8] x [-4.8..4.8]

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createPrimitiveMesh() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  function pushFace(origin, right, up, normal, seg) {
    const base = positions.length / 3;
    for (let j = 0; j <= seg; j++) {
      const v = j / seg;
      for (let i = 0; i <= seg; i++) {
        const u = i / seg;
        positions.push(
          origin[0] + right[0] * u + up[0] * v,
          origin[1] + right[1] * u + up[1] * v,
          origin[2] + right[2] * u + up[2] * v
        );
        normals.push(normal[0], normal[1], normal[2]);
        uvs.push(u, v);
      }
    }
    const st = seg + 1;
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * st + i;
        indices.push(a, a + 1, a + st + 1, a, a + st + 1, a + st);
      }
    }
  }

  pushFace([-0.5, -0.5,  0.5], [ 1, 0, 0], [0, 1, 0], [ 0,  0,  1], 3);
  pushFace([ 0.5, -0.5, -0.5], [-1, 0, 0], [0, 1, 0], [ 0,  0, -1], 3);
  pushFace([ 0.5, -0.5,  0.5], [ 0, 0,-1], [0, 1, 0], [ 1,  0,  0], 3);
  pushFace([-0.5, -0.5, -0.5], [ 0, 0, 1], [0, 1, 0], [-1,  0,  0], 3);
  pushFace([-0.5,  0.5,  0.5], [ 1, 0, 0], [0, 0,-1], [ 0,  1,  0], 3);
  pushFace([-0.5, -0.5, -0.5], [ 1, 0, 0], [0, 0, 1], [ 0, -1,  0], 3);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

export function computeCameraBasis(cam, aspect) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const tx = cam.target[0], ty = cam.target[1], tz = cam.target[2];
  const ex = tx + cam.dist * cp * sy;
  const ey = ty + cam.dist * sp;
  const ez = tz + cam.dist * cp * cy;

  let fx = tx - ex, fy = ty - ey, fz = tz - ez;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;

  let rx = -fz, ry = 0, rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;

  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const tanHalf = Math.tan(((cam.fov || 42) * Math.PI) / 360);
  const near = 0.25, far = 95.0;

  const view = new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * ex + ry * ey + rz * ez),
    -(ux * ex + uy * ey + uz * ez),
    (fx * ex + fy * ey + fz * ez),
    1,
  ]);
  const f = 1.0 / tanHalf;
  const projGL = new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
  const projGPU = new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (far * near) / (near - far), 0,
  ]);

  function mulMat4(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  return {
    eye: [ex, ey, ez],
    fwd: [fx, fy, fz],
    right: [rx, ry, rz],
    up: [ux, uy, uz],
    tanHalf, aspect, near, far, view,
    viewProjGL: mulMat4(projGL, view),
    viewProjGPU: mulMat4(projGPU, view),
  };
}

function emitSfx(detail) {
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(new CustomEvent("fxlab:sfx", { detail }));
  }
}

// Material IDs (v0.w):
//   0 = Armored Steel Test Wall (flashes emerald on block, crimson on tunnel!)
//   1 = Dark Tactical Turret / Pedestal
//   2 = Electric Cyan (Swept-CCD / Quake Minkowski Hull / Spatial Hash)
//   3 = Fiery Orange / Gold (Doom Fireball / Ricochet Spark / Active SAP Pair)
//   4 = Vivid Crimson (TUNNELED! / Breach / OBB Colliding)
//   5 = Vivid Emerald (BLOCKED / SAFE / TOI Lock-On / Separated Plane)
//   6 = Translucent Tick-Ghost Sphere
//   7 = Brushed Steel Spinning Rotor Bar / Railgun Barrel
//   8 = Glowing Amber Trajectory Laser / Sub-Step Midpoint
export function createCollisionStageSim(stageIdx) {
  const rng = mulberry32(19882024 + stageIdx * 6151);

  const sim = {
    stage: stageIdx,
    time: 0,
    tickAccum: 0,
    blockedCount: 0,
    tunneledCount: 0,
    wallFlashGood: 0,
    wallFlashBad: 0,
    wallFlashGoodR: 0,
    wallFlashBadL: 0,
    projectiles: [],
    sparks: [],
    sapBodies: [],
    rodAngle: 0,
    rodLastHit: 0,
    rodLastMiss: 0,
    rodGhosts: [],
    autoFireTimer: 0,
    shockwavePending: false,
    resetGpuPending: true,
    lowTickRate: false,
    thinWall: true,
    slowMo: false,
    angularSubstep: false,
  };

  function initSapBodies() {
    sim.sapBodies = [];
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2 + rng() * 0.4;
      const rad = 0.8 + rng() * 2.4;
      const r = 0.24 + rng() * 0.14;
      sim.sapBodies.push({
        x: Math.cos(ang) * rad,
        y: 0.5 + (i % 4) * 0.52 + rng() * 0.2,
        z: Math.sin(ang) * rad,
        vx: (rng() - 0.5) * 3.8,
        vy: (rng() - 0.5) * 1.4,
        vz: (rng() - 0.5) * 3.8,
        r,
        overlap: false,
      });
    }
  }

  function spawnSparks(x, y, z, normalX, normalZ, count, isBad = false) {
    for (let i = 0; i < count; i++) {
      if (sim.sparks.length >= 160) sim.sparks.shift();
      const ang = rng() * Math.PI * 2;
      const spd = 2.0 + rng() * 6.0;
      sim.sparks.push({
        x, y, z,
        vx: normalX * (2.6 + rng() * 4.5) + Math.cos(ang) * spd * 0.65,
        vy: 1.4 + rng() * 4.0,
        vz: normalZ * (2.6 + rng() * 4.5) + Math.sin(ang) * spd * 0.65,
        scale: isBad ? (0.09 + rng() * 0.08) : (0.07 + rng() * 0.07),
        mat: isBad ? 4 : 3,
        age: 0,
        maxAge: isBad ? 0.55 : 0.48,
        kind: 0,
        ringAxis: Math.abs(normalX) > 0.5 ? 0 : 1, // 0=YZ ring, 1=XY ring
      });
    }
    sim.sparks.push({
      x, y, z,
      vx: 0, vy: 0, vz: 0,
      scale: 0.24,
      mat: isBad ? 4 : 5,
      age: 0,
      maxAge: 0.48,
      kind: 1,
      ringAxis: Math.abs(normalX) > 0.5 ? 0 : 1,
    });
  }

  function fireVolley(customX = null, customY = null, hyper = false) {
    const y0 = customY !== null ? customY : (1.10 + (rng() - 0.5) * 0.95);

    if (stageIdx === 1) {
      // ---- STAGE 1: 1993 DOOM P_MAP.C DIRECTIONAL BUG! ----
      // Twin identical Mancubus fireballs fired simultaneously EAST (+X) & WEST (-X)!
      const z0 = (rng() - 0.5) * 1.45;
      const speed = 15.6;
      sim.projectiles.push({
        x: 0.35, y: y0, z: z0, vx: speed, vy: 0, vz: 0,
        r: 0.22, mat: 3, dir: 1, ghosts: [[0.35, y0, z0, 0]],
        status: "flying", age: 0,
      });
      sim.projectiles.push({
        x: -0.35, y: y0, z: z0, vx: -speed, vy: 0, vz: 0,
        r: 0.22, mat: 3, dir: -1, ghosts: [[-0.35, y0, z0, 0]],
        status: "flying", age: 0,
      });
      if (sim.projectiles.length > 26) sim.projectiles.splice(0, 2);
      emitSfx({ type: "portalShot" });
      return;
    }

    // Stages 3 (Quake BSP) & 5 (Speculative/TOI) fire from FRONT (+Z) into the visible front face of the wall (z = +0.08)
    // so the glowing cyan Minkowski hull, Speculative Contact target discs & TOI rings are 100% unobstructed!
    const fromFront = (stageIdx === 3 || stageIdx === 5);
    const x0 = customX !== null
      ? customX
      : (stageIdx === 3 ? (-1.45 + (rng() - 0.5) * 2.2) : ((rng() - 0.5) * 4.8));
    const speed = hyper ? 22.0 : (stageIdx === 0 ? 18.8 : (stageIdx === 5 ? 14.5 : 19.6));
    const zStart = fromFront ? 4.05 : -4.15;
    sim.projectiles.push({
      x: x0, y: y0, z: zStart,
      vx: 0, vy: 0, vz: fromFront ? -speed : speed,
      r: 0.21,
      mat: stageIdx === 0 ? 4 : (stageIdx === 3 || stageIdx === 5 ? 2 : 3),
      dir: fromFront ? -1 : 1,
      ghosts: [[x0, y0, zStart, 0]],
      status: "flying",
      age: 0,
    });
    if (sim.projectiles.length > 28) sim.projectiles.shift();
    if (hyper) emitSfx({ type: "dialTick", norm: 0.85 });
  }

  function reset() {
    sim.time = 0;
    sim.tickAccum = 0;
    sim.blockedCount = 0;
    sim.tunneledCount = 0;
    sim.wallFlashGood = 0;
    sim.wallFlashBad = 0;
    sim.wallFlashGoodR = 0;
    sim.wallFlashBadL = 0;
    sim.projectiles = [];
    sim.sparks = [];
    sim.rodAngle = 0;
    sim.rodGhosts = [];
    sim.rodLastHit = 0;
    sim.rodLastMiss = 0;
    sim.autoFireTimer = 0.08;
    sim.resetGpuPending = true;
    initSapBodies();
  }

  function stepFixedTick(tickDt) {
    const wallHalfThick = (stageIdx === 6 && !sim.thinWall) ? 0.34 : (stageIdx === 1 ? 0.11 : 0.08);
    const wallHalfY = 2.55;
    const wallHalfX = stageIdx === 3 ? 2.4 : 3.85;

    for (let i = sim.projectiles.length - 1; i >= 0; i--) {
      const p = sim.projectiles[i];
      p.age += tickDt;
      if (p.age > 3.2) { sim.projectiles.splice(i, 1); continue; }
      if (p.status === "blocked") {
        p.vy -= 14.5 * tickDt;
        p.x += p.vx * tickDt;
        p.y += p.vy * tickDt;
        p.z += p.vz * tickDt;
        if (p.y < p.r) { p.y = p.r; p.vy = -p.vy * 0.42; p.vx *= 0.78; p.vz *= 0.78; }
        continue;
      }

      // ---- STAGE 1: 1993 DOOM P_MAP.C DIRECTIONAL BUG (East +X vs West -X) ----
      if (stageIdx === 1) {
        const prevX = p.x;
        const moveX = p.vx * tickDt;
        const nextX = prevX + moveX;
        const wallX = p.dir > 0 ? 2.45 : -2.45;
        const MAXMOVE_HALF = 0.45;

        if (moveX > MAXMOVE_HALF) {
          // EAST (+X): condition TRUE -> subdivides into 2 half-steps -> HITS WALL!
          const midX = prevX + moveX * 0.5;
          p.ghosts.push([midX, p.y, p.z, 1]); // golden subdivided midpoint!
          if (Math.abs(midX - wallX) <= wallHalfThick + p.r || (prevX < wallX && midX >= wallX - p.r)) {
            p.x = wallX - wallHalfThick - p.r;
            p.status = "blocked";
            p.vx = -3.8; p.vy = 2.6;
            sim.blockedCount++;
            sim.wallFlashGoodR = 1.0;
            spawnSparks(wallX - wallHalfThick, p.y, p.z, -1, 0, 18, false);
            emitSfx({ type: "dialTick", norm: 0.9 });
            continue;
          }
          p.x = nextX;
          p.ghosts.push([p.x, p.y, p.z, 0]);
          if (Math.abs(p.x - wallX) <= wallHalfThick + p.r || (midX < wallX && p.x >= wallX - p.r)) {
            p.x = wallX - wallHalfThick - p.r;
            p.status = "blocked";
            p.vx = -3.8; p.vy = 2.6;
            sim.blockedCount++;
            sim.wallFlashGoodR = 1.0;
            spawnSparks(wallX - wallHalfThick, p.y, p.z, -1, 0, 18, false);
            emitSfx({ type: "dialTick", norm: 0.9 });
          }
        } else {
          // WEST (-X): moveX < 0 so `moveX > MAXMOVE_HALF` is FALSE -> NO SUBDIVISION -> CLIPS STRAIGHT THROUGH!
          p.x = nextX;
          p.ghosts.push([p.x, p.y, p.z, 0]);
          const crossed = prevX > wallX + wallHalfThick && nextX < wallX - wallHalfThick;
          if (crossed && p.status === "flying") {
            p.status = "tunneled";
            p.mat = 4;
            sim.tunneledCount++;
            sim.wallFlashBadL = 1.0;
            spawnSparks(wallX, p.y, p.z, -1, 0, 14, true);
            emitSfx({ type: "ragdollShove" });
          }
        }
        if (p.ghosts.length > 10) p.ghosts.shift();
        continue;
      }

      // ---- HORIZONTAL WALL STAGES (0, 3, 5, 6, 7): Firing -Z -> +Z across wall at z = 0 ----
      const prevZ = p.z;
      const nextZ = p.z + p.vz * tickDt;
      const inWallXY = p.y >= 0.0 && p.y <= wallHalfY && Math.abs(p.x) <= wallHalfX;

      if (stageIdx === 0) {
        // 1988 DISCRETE POINT-IN-TIME CHECK -> FAST BULLETS JUMP CLEANLY ACROSS z = 0!
        p.z = nextZ;
        p.ghosts.push([p.x, p.y, p.z, 0]);
        if (p.ghosts.length > 9) p.ghosts.shift();
        const overlapsNow = inWallXY && Math.abs(p.z) <= (wallHalfThick + p.r * 0.72);
        const crossed = inWallXY && prevZ < -wallHalfThick && nextZ > wallHalfThick;
        if (overlapsNow) {
          p.status = "blocked";
          p.z = -(wallHalfThick + p.r);
          p.vz = -p.vz * 0.30; p.vy = 2.4 + rng() * 2.0;
          sim.blockedCount++;
          sim.wallFlashGood = 1.0;
          spawnSparks(p.x, p.y, -wallHalfThick, 0, -1, 14, false);
        } else if (crossed && p.status === "flying") {
          p.status = "tunneled";
          p.mat = 4;
          sim.tunneledCount++;
          sim.wallFlashBad = 1.0;
          spawnSparks(p.x, p.y, 0, 0, 1, 14, true);
          emitSfx({ type: "ragdollShove" });
        }
        continue;
      }

      // CONTINUOUS SWEPT CCD / QUAKE MINKOWSKI HULL / SPECULATIVE & TOI (0% TUNNELING!)
      const fromFront = p.dir < 0;
      const hitPlaneZ = fromFront ? (wallHalfThick + p.r) : -(wallHalfThick + p.r);
      const hitWall = fromFront ? (prevZ >= hitPlaneZ && nextZ <= hitPlaneZ) : (prevZ <= hitPlaneZ && nextZ >= hitPlaneZ);
      const inBounds = stageIdx === 3 ? (p.y >= 0 && p.y <= wallHalfY && p.x >= -3.8 && p.x <= 1.0) : inWallXY;
      if (inBounds && hitWall) {
        p.ghosts.push([p.x, p.y, hitPlaneZ, 2]); // emerald TOI exact contact lock!
        p.z = hitPlaneZ;
        p.status = "blocked";
        p.vz = (fromFront ? 1 : -1) * (2.8 + rng() * 3.0);
        p.vy = 2.0 + rng() * 2.8;
        p.vx = (rng() - 0.5) * 3.4;
        sim.blockedCount++;
        sim.wallFlashGood = 1.0;
        spawnSparks(p.x, p.y, fromFront ? wallHalfThick : -wallHalfThick, 0, fromFront ? 1 : -1, 18, false);
        emitSfx({ type: "dialTick", norm: 0.78 });
      } else {
        p.z = nextZ;
        p.ghosts.push([p.x, p.y, p.z, 0]);
        if (p.ghosts.length > 9) p.ghosts.shift();
      }
    }

    // ---- STAGE 7: FAST-SPINNING LONG ROD ROTATIONAL TUNNELING EDGE CASE ----
    if (stageIdx === 7) {
      const omega = 15.5;
      const prevA = sim.rodAngle;
      const nextA = prevA + omega * tickDt;
      const prevMod = ((prevA % Math.PI) + Math.PI) % Math.PI;
      const nextMod = ((nextA % Math.PI) + Math.PI) % Math.PI;
      sim.rodAngle = nextA;
      sim.rodGhosts.push(nextA);
      if (sim.rodGhosts.length > 6) sim.rodGhosts.shift();

      if (nextMod < prevMod) {
        if (sim.angularSubstep) {
          sim.rodLastHit = 1.0;
          sim.blockedCount++;
          spawnSparks(1.65, 1.35, 3.25, 0, 0, 14, false);
          emitSfx({ type: "dialTick", norm: 0.95 });
        } else {
          sim.rodLastMiss = 1.0;
          sim.tunneledCount++;
          spawnSparks(1.65, 1.35, 3.25, 0, 0, 10, true);
        }
      }
    }
  }

  function step(dt) {
    const scaleDt = (stageIdx === 5 && sim.slowMo) ? dt * 0.25 : dt;
    const cdt = Math.min(scaleDt, 0.033);
    sim.time += cdt;

    if (sim.wallFlashGood > 0) sim.wallFlashGood = Math.max(0, sim.wallFlashGood - dt * 2.8);
    if (sim.wallFlashBad > 0) sim.wallFlashBad = Math.max(0, sim.wallFlashBad - dt * 2.2);
    if (sim.wallFlashGoodR > 0) sim.wallFlashGoodR = Math.max(0, sim.wallFlashGoodR - dt * 2.8);
    if (sim.wallFlashBadL > 0) sim.wallFlashBadL = Math.max(0, sim.wallFlashBadL - dt * 2.2);
    if (sim.rodLastHit > 0) sim.rodLastHit = Math.max(0, sim.rodLastHit - dt * 2.6);
    if (sim.rodLastMiss > 0) sim.rodLastMiss = Math.max(0, sim.rodLastMiss - dt * 2.2);

    if (stageIdx === 2) {
      const bound = 3.35;
      for (const b of sim.sapBodies) {
        b.x += b.vx * cdt; b.y += b.vy * cdt; b.z += b.vz * cdt;
        if (b.x < -bound + b.r) { b.x = -bound + b.r; b.vx = Math.abs(b.vx); }
        if (b.x >  bound - b.r) { b.x =  bound - b.r; b.vx = -Math.abs(b.vx); }
        if (b.z < -bound + b.r) { b.z = -bound + b.r; b.vz = Math.abs(b.vz); }
        if (b.z >  bound - b.r) { b.z =  bound - b.r; b.vz = -Math.abs(b.vz); }
        if (b.y < 0.35 + b.r) { b.y = 0.35 + b.r; b.vy = Math.abs(b.vy); }
        if (b.y > 2.60 - b.r) { b.y = 2.60 - b.r; b.vy = -Math.abs(b.vy); }
        b.overlap = false;
      }
      const sorted = [...sim.sapBodies].sort((a, b) => (a.x - a.r) - (b.x - b.r));
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        for (let j = i + 1; j < sorted.length; j++) {
          const b = sorted[j];
          if (b.x - b.r > a.x + a.r) break;
          if (Math.abs(a.z - b.z) <= a.r + b.r) {
            a.overlap = true; b.overlap = true;
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const d = Math.hypot(dx, dy, dz), minD = a.r + b.r;
            if (d > 0.001 && d < minD) {
              const nx = dx / d, ny = dy / d, nz = dz / d, push = (minD - d) * 0.5;
              a.x -= nx * push; a.y -= ny * push; a.z -= nz * push;
              b.x += nx * push; b.y += ny * push; b.z += nz * push;
              const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz;
              if (rv < 0) {
                a.vx += rv * nx; a.vy += rv * ny; a.vz += rv * nz;
                b.vx -= rv * nx; b.vy -= rv * ny; b.vz -= rv * nz;
              }
            }
          }
        }
      }
    }

    if (stageIdx !== 2 && stageIdx !== 4) {
      sim.autoFireTimer -= cdt;
      if (sim.autoFireTimer <= 0) {
        fireVolley();
        sim.autoFireTimer = stageIdx === 1 ? 0.92 : (stageIdx === 5 ? 0.85 : 0.62);
      }
    }

    const tickHz = (stageIdx === 0 && sim.lowTickRate) ? 10 : (stageIdx === 0 ? 14 : 18);
    const tickDt = 1.0 / tickHz;
    sim.tickAccum += cdt;
    while (sim.tickAccum >= tickDt) {
      sim.tickAccum -= tickDt;
      stepFixedTick(tickDt);
    }

    for (let i = sim.sparks.length - 1; i >= 0; i--) {
      const s = sim.sparks[i];
      s.age += cdt;
      if (s.age >= s.maxAge) { sim.sparks.splice(i, 1); continue; }
      if (s.kind === 1) {
        s.scale += cdt * 3.8;
      } else {
        s.vy -= 16.0 * cdt;
        s.x += s.vx * cdt; s.y += s.vy * cdt; s.z += s.vz * cdt;
        if (s.y < 0.05) { s.y = 0.05; s.vy = -s.vy * 0.45; s.vx *= 0.75; s.vz *= 0.75; }
      }
    }
  }

  function packInstances(out, maxCount) {
    let c = 0;
    function push(x, y, z, mat, rx, ry, rz, shape, sx, sy, sz, alpha = 1.0, glow = 0.0, seed = 0.0) {
      if (c >= maxCount) return;
      const o = c * 16;
      out[o+0] = x; out[o+1] = y; out[o+2] = z; out[o+3] = mat;
      out[o+4] = rx; out[o+5] = ry; out[o+6] = rz; out[o+7] = shape;
      out[o+8] = sx; out[o+9] = sy; out[o+10] = sz; out[o+11] = alpha;
      out[o+12] = glow; out[o+13] = seed; out[o+14] = 0; out[o+15] = 0;
      c++;
    }

    // ---- STAGE 1: 1993 DOOM TWIN EAST/WEST WALLS + CENTER MANCUBUS TURRET ----
    if (stageIdx === 1) {
      push(0, 0.55, 0, 1, 0, 0, 0, 0, 0.90, 1.10, 1.10, 1.0, 0.0);
      push(0, 1.25, 0, 7, 0, 0, 0, 0, 1.15, 0.42, 0.52, 1.0, 0.15);
      // EAST (+X) Wall -> BLOCKS FIREBALLS (emerald!)
      push(2.45, 1.35, 0, 0, 0, 0, 0, 0, 0.22, 2.70, 4.40, 1.0, sim.wallFlashGoodR);
      push(2.45, 2.76, 0, 5, 0, 0, 0, 0, 0.28, 0.12, 4.46, 1.0, 0.8 + sim.wallFlashGoodR);
      // WEST (-X) Wall -> FIREBALLS CLIP THROUGH (crimson!)
      push(-2.45, 1.35, 0, 0, 0, 0, 0, 0, 0.22, 2.70, 4.40, 1.0, -sim.wallFlashBadL);
      push(-2.45, 2.76, 0, 4, 0, 0, 0, 0, 0.28, 0.12, 4.46, 1.0, 0.8 + sim.wallFlashBadL);
    }
    // ---- STAGE 2: 1995 SWEEP-AND-PRUNE 1D AXIS RAILS ----
    else if (stageIdx === 2) {
      push(0, 0.06, 3.55, 1, 0, 0, 0, 0, 7.2, 0.08, 0.16, 1.0, 0.0);
      push(-3.65, 0.06, 0, 1, 0, 0, 0, 0, 0.16, 0.08, 7.2, 1.0, 0.0);
      for (let i = 0; i < sim.sapBodies.length; i++) {
        const b = sim.sapBodies[i];
        const m = b.overlap ? 3 : 2;
        const glw = b.overlap ? 0.95 : 0.25;
        push(b.x, b.y, b.z, m, 0, 0, 0, 1, b.r * 2, b.r * 2, b.r * 2, 1.0, glw, i * 0.07);
        push(b.x, 0.13 + (i % 3) * 0.035, 3.55, b.overlap ? 3 : 5, 0, 0, 0, 0, b.r * 2.0, 0.05, 0.22, 1.0, glw);
        push(-3.65, 0.13 + (i % 3) * 0.035, b.z, b.overlap ? 3 : 5, 0, 0, 0, 0, 0.22, 0.05, b.r * 2.0, 1.0, glw);
        push(b.x, b.y * 0.5, b.z, m, 0, 0, 0, 0, 0.02, b.y, 0.02, 0.45, 0.2);
      }
    }
    // ---- STAGE 4: 2007 GPU SPATIAL HASH ARENA ----
    else if (stageIdx === 4) {
      const cPos = [[-4.4, -4.4], [4.4, -4.4], [-4.4, 4.4], [4.4, 4.4]];
      for (const [cx, cz] of cPos) push(cx, 1.8, cz, 1, 0, 0, 0, 0, 0.22, 3.6, 0.22, 1.0, 0.1);
      push(0, 1.35, 0, 0, 0, 0, 0, 0, 1.05, 2.70, 1.05, 1.0, 0.45);
    }
    // ---- STAGES 0, 3, 5, 6, 7: HORIZONTAL STEEL BULKHEAD (z = 0, edge-to-edge X!) ----
    else {
      const wThick = (stageIdx === 6 && !sim.thinWall) ? 0.68 : 0.16;
      const wSpanX = stageIdx === 3 ? 4.8 : 7.8;
      const wCenterX = stageIdx === 3 ? -1.4 : 0.0;
      const wallGlow = sim.wallFlashGood > sim.wallFlashBad ? sim.wallFlashGood : -sim.wallFlashBad;
      push(wCenterX, 1.28, 0, 0, 0, 0, 0, 0, wSpanX, 2.56, wThick, 1.0, wallGlow);
      push(wCenterX, 0.08, 0, 1, 0, 0, 0, 0, wSpanX + 0.24, 0.16, wThick + 0.34, 1.0, 0.0);
      const topMat = stageIdx === 0 ? 4 : 5;
      push(wCenterX, 2.60, 0, topMat, 0, 0, 0, 0, wSpanX + 0.08, 0.10, wThick + 0.12, 1.0, 0.80);

      // Stage 3 (1996 Quake BSP Minkowski Hull & OBBTree SAT):
      if (stageIdx === 3) {
        // Translucent cyan Minkowski inflated hull around left horizontal wall!
        push(wCenterX, 1.28, 0, 2, 0, 0, 0, 0, wSpanX + 0.42, 2.88, wThick + 0.44, 0.26, 0.85);
        // Live rotating OBBTree SAT pair on the right (x = +2.35)!
        const a1 = sim.time * 1.15;
        const obbZ = Math.sin(sim.time * 1.6) * 0.85;
        const satOverlap = Math.abs(obbZ) < 0.42;
        push(2.35, 1.25, -0.75, satOverlap ? 4 : 5, 0, a1, 0.25, 0, 1.15, 0.65, 0.55, 1.0, satOverlap ? 0.9 : 0.4);
        push(2.35, 1.25,  0.65 + obbZ * 0.5, satOverlap ? 4 : 2, 0, -a1 * 1.3, -0.2, 0, 0.95, 0.72, 0.52, 1.0, satOverlap ? 0.9 : 0.4);
        push(2.35, 1.25, -0.05 + obbZ * 0.25, satOverlap ? 4 : 5, 0, Math.sin(a1) * 0.25, 0, 0, 1.95, 1.45, 0.04, 0.36, 0.9);
      }

      // Stage 7 (2019-24 Chaos/Jolt/Box2D 3.0): Fast-spinning long rod rotational tunneling demo in foreground!
      if (stageIdx === 7) {
        const hubX = 1.65, hubY = 1.35, hubZ = 1.95;
        push(hubX, 0.68, hubZ, 1, 0, 0, 0, 0, 0.40, 1.36, 0.40, 1.0, 0.0);
        const pinMat = sim.rodLastMiss > 0.1 ? 4 : (sim.rodLastHit > 0.1 ? 5 : 2);
        push(hubX, 1.20, hubZ + 1.35, pinMat, 0, 0, 0, 0, 0.10, 2.40, 0.10, 1.0, 0.95);
        for (let g = 0; g < sim.rodGhosts.length - 1; g++) {
          const ga = sim.rodGhosts[g];
          const al = 0.16 + (g / sim.rodGhosts.length) * 0.28;
          push(hubX, hubY, hubZ, sim.angularSubstep ? 5 : 4, 0, ga, 0, 0, 0.11, 0.14, 3.10, al, 0.80);
        }
        push(hubX, hubY, hubZ, 7, 0, sim.rodAngle, 0, 0, 0.14, 0.18, 3.15, 1.0, 0.35);
      }
    }

    // ---- PACK HERO PROJECTILES, GHOST TICK BEADS, LASER TRAILS & SPECULATIVE CONTACTS ----
    for (let i = 0; i < sim.projectiles.length; i++) {
      const p = sim.projectiles[i];
      push(p.x, p.y, p.z, p.mat, 0, 0, 0, 1, p.r * 2.0, p.r * 2.0, p.r * 2.0, 1.0, 0.95);

      for (let g = 0; g < p.ghosts.length; g++) {
        const [gx, gy, gz, gKind] = p.ghosts[g];
        const fade = 0.28 + (g / Math.max(1, p.ghosts.length)) * 0.54;
        const gMat = gKind === 1 ? 8 : (gKind === 2 ? 5 : (p.status === "tunneled" ? 4 : 6));
        const gSize = gKind === 1 ? p.r * 1.55 : p.r * 1.15;
        push(gx, gy, gz, gMat, 0, 0, 0, 1, gSize, gSize, gSize, fade, 0.85);

        if (g > 0) {
          const [px, py, pz] = p.ghosts[g - 1];
          const dx = Math.abs(gx - px), dz = Math.abs(gz - pz);
          const beamMat = p.status === "tunneled" ? 4 : (stageIdx === 3 || stageIdx === 5 || stageIdx === 6 ? 2 : 8);
          if (dx > 0.04) {
            push((gx + px) * 0.5, gy, gz, beamMat, 0, 0, 0, 0, dx, 0.045, 0.045, 0.68, 0.9);
          } else if (dz > 0.04) {
            push(gx, gy, (gz + pz) * 0.5, beamMat, 0, 0, 0, 0, 0.045, 0.045, dz, 0.68, 0.9);
          }
        }
      }

      // Stage 5: Glowing Speculative Contact Disc projected ahead onto FRONT wall face z = +0.14!
      if (stageIdx === 5 && p.status === "flying" && p.z > 0.16) {
        const prox = Math.max(0.22, 1.0 - p.z / 4.1);
        push(p.x, p.y, 0.14, 2, 0, Math.PI * 0.5, 0, 2, 0.04, 0.85 * prox + 0.24, 0.85 * prox + 0.24, 0.90 * prox, 1.0);
        const distZ = Math.max(0.05, p.z - 0.14);
        push(p.x, p.y, 0.14 + distZ * 0.5, 2, 0, 0, 0, 0, 0.032, 0.032, distZ, 0.62 * prox, 0.90);
      }
    }

    // ---- PACK RICOCHET SPARKS & IMPACT / BREACH HALO RINGS ----
    for (let i = 0; i < sim.sparks.length; i++) {
      const s = sim.sparks[i];
      const al = 1.0 - s.age / s.maxAge;
      if (s.kind === 1) {
        const ry = s.ringAxis === 1 ? Math.PI * 0.5 : 0;
        push(s.x, s.y, s.z, s.mat, 0, ry, 0, 2, 0.05, s.scale, s.scale, al * 0.88, 1.0);
      } else {
        push(s.x, s.y, s.z, s.mat, 0, 0, 0, 1, s.scale * al, s.scale * al, s.scale * al, 1.0, 1.0);
      }
    }

    return c;
  }

  reset();
  return { sim, reset, fireVolley, step, packInstances };
}

export function createCollisionsController(backendName) {
  const sims = new Map();
  let activeL = 0;
  let activeR = 6;

  function getSim(stage) {
    if (!sims.has(stage)) sims.set(stage, createCollisionStageSim(stage));
    return sims.get(stage);
  }

  function setActiveStages(sL, sR) {
    if (sL !== activeL || sR !== activeR) {
      activeL = sL;
      activeR = sR;
      getSim(activeL).reset();
      if (activeR !== activeL) getSim(activeR).reset();
    }
  }

  function dispatchBoth(fn) {
    fn(getSim(activeL));
    if (activeR !== activeL) fn(getSim(activeR));
  }

  return {
    getSim,
    setActiveStages,
    enterStep() {
      for (const s of sims.values()) s.reset();
    },
    onReset() {
      getSim(activeL).reset();
      if (activeR !== activeL) getSim(activeR).reset();
    },
    triggerAction(actionId) {
      if (actionId === "tickrate") dispatchBoth(s => { s.sim.lowTickRate = !s.sim.lowTickRate; });
      else if (actionId === "doomvolley") dispatchBoth(s => s.fireVolley(0, 1.25, true));
      else if (actionId === "shuffle") dispatchBoth(s => s.reset());
      else if (actionId === "hypershot") dispatchBoth(s => s.fireVolley(-1.2, 1.25, true));
      else if (actionId === "shockwave") dispatchBoth(s => { s.sim.shockwavePending = true; });
      else if (actionId === "slowmo") dispatchBoth(s => { s.sim.slowMo = !s.sim.slowMo; });
      else if (actionId === "wallthick") dispatchBoth(s => { s.sim.thinWall = !s.sim.thinWall; });
      else if (actionId === "angular") dispatchBoth(s => { s.sim.angularSubstep = !s.sim.angularSubstep; });
    },
    isActionActive(actionId) {
      const s = getSim(activeR).sim;
      if (actionId === "tickrate") return s.lowTickRate;
      if (actionId === "slowmo") return s.slowMo;
      if (actionId === "wallthick") return !s.thinWall;
      if (actionId === "angular") return s.angularSubstep;
      return false;
    },
    onCanvasClick(ndcX, ndcY) {
      const x = Math.max(-3.2, Math.min(3.2, ndcX * 3.6));
      const y = Math.max(0.45, Math.min(2.25, 1.30 + ndcY * 1.1));
      dispatchBoth(s => {
        if (s.sim.stage === 4) s.sim.shockwavePending = true;
        else s.fireVolley(x, y, true);
      });
    },
    update(dt, paused) {
      if (paused) return;
      getSim(activeL).step(dt);
      if (activeR !== activeL) getSim(activeR).step(dt);
    },
    getTechBadge(stepIdx) {
      const isGPU = backendName === "webgpu";
      const s = getSim(activeR).sim;
      const b = s.blockedCount, t = s.tunneledCount;
      const badges = [
        `1988 · DISCRETE AABB & GJK · TUNNELED: ${t}`,
        `1993 · DOOM P_MAP.C · EAST HIT: ${b} · WEST CLIP: ${t}`,
        `1995 · I-COLLIDE SWEEP-AND-PRUNE BROADPHASE`,
        `1996 · QUAKE BSP MINKOWSKI HULL & OBBTREE SAT`,
        isGPU ? `2007 · WEBGPU SPATIAL HASH · 4,096 BODIES` : `2007 · WEBGL2 SPATIAL HASH · 512 BODIES`,
        `2011–13 · SPECULATIVE CONTACTS & TOI · HIT: ${b}`,
        `2017–18 · PHYSX 3.4 & UNITY CCD · 0 TUNNELED`,
        isGPU ? `2019–24 · WEBGPU SWEPT CCD · 4,096 BULLETS` : `2019–24 · WEBGL2 SWEPT CCD · 512 BULLETS`,
      ];
      return badges[stepIdx] || badges[7];
    },
  };
}
