// Evolution of Collision Detection & Tunneling (1988-2024) — WebGPU Compute primary + automatic WebGL2 fallback.
// Pass ?renderer=webgl2 in the URL to inspect the WebGL2 fallback on WebGPU-capable browsers.

import { createCollisionsWebGPU } from "./webgpu.js";
import { createCollisionsWebGL2 } from "./webgl2.js";

export async function createCollisionsEffect(gl, opts = {}) {
  const params = opts.params || new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const forceWebGL2 = params.get("renderer") === "webgl2";

  if (!forceWebGL2) {
    try {
      return await createCollisionsWebGPU(opts.canvas || document.getElementById("c"));
    } catch (err) {
      console.info("[FX Lab · Collisions] WebGPU unavailable, activating WebGL2 fallback:", err?.message || err);
    }
  }
  return createCollisionsWebGL2(gl);
}
