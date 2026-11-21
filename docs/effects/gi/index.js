// Evolution of Global Illumination (1996-2026) — WebGPU Compute primary + automatic WebGL2 fallback.
// Pass ?renderer=webgl2 in the URL to force and inspect the WebGL2 fallback on WebGPU-capable browsers.

import { createGiWebGPU } from "./webgpu.js";
import { createGiWebGL2 } from "./webgl2.js";

export async function createGiEffect(gl, opts = {}) {
  const params = opts.params || new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const forceWebGL2 = params.get("renderer") === "webgl2";

  if (!forceWebGL2) {
    try {
      return await createGiWebGPU(opts.canvas || document.getElementById("c"));
    } catch (err) {
      console.info("[FX Lab · GI] WebGPU unavailable, activating WebGL2 fallback:", err?.message || err);
    }
  }
  return createGiWebGL2(gl);
}
