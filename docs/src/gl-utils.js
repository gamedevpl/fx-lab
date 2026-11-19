// Shared math and WebGL2 helpers for FX Lab.

export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function norm3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeLookAt(eye, target, up) {
  const f = norm3(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
  const s = norm3(...cross3(f, up));
  const u = cross3(s, f);
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
     (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]),
    1,
  ]);
}

export function makePerspective(fovRad, aspect, near, far) {
  const f = 1.0 / Math.tan(fovRad * 0.5);
  const nf = 1.0 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0,
  ]);
}

export function cameraBasisFromOrbit(yaw, pitch, dist, lookY) {
  const cp = Math.cos(pitch);
  const pos = [
    Math.sin(yaw) * cp * dist,
    lookY + Math.sin(pitch) * dist,
    Math.cos(yaw) * cp * dist,
  ];
  const target = [0, lookY, 0];
  const fwd = norm3(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
  const right = norm3(...cross3(fwd, [0, 1, 0]));
  const up = cross3(right, fwd);
  return { pos, target, fwd, right, up };
}

export const FULL_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID & 1) * 2 - 1, ((gl_VertexID >> 1) & 1) * 2 - 1);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("Shader compile failed:\n" + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function linkProgram(gl, vsSrc, fsSrc) {
  return linkPrograms(gl, [[vsSrc, fsSrc]])[0];
}

// Compiles and links multiple programs in a batch so ANGLE/Metal can parallelize across cores.
export function linkPrograms(gl, pairs) {
  const entries = pairs.map(([vsSrc, fsSrc]) => {
    const p = gl.createProgram();
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(vs);
    gl.compileShader(fs);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    return { p, vs, fs };
  });

  for (const { p, vs, fs } of entries) {
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const vsLog = gl.getShaderInfoLog(vs) || "";
      const fsLog = gl.getShaderInfoLog(fs) || "";
      const pLog = gl.getProgramInfoLog(p) || "";
      throw new Error(`Program link failed:\n${pLog}\nVS: ${vsLog}\nFS: ${fsLog}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  }
  return entries.map(e => e.p);
}

export function makeTex2D(gl, w, h, internalFmt, fmt, type, filter, data = null, wrap = gl.CLAMP_TO_EDGE) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return t;
}

export function hdrFormat(gl) {
  const ok = !!gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("OES_texture_float_linear");
  return ok
    ? { internalFmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT, isFloat: true }
    : { internalFmt: gl.RGBA8, fmt: gl.RGBA, type: gl.UNSIGNED_BYTE, isFloat: false };
}
