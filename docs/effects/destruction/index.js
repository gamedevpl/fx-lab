// Evolution of Destruction & Fracturing (1998-2023) — WebGPU Compute primary + automatic WebGL2 fallback.
// Pass ?renderer=webgl2 in the URL to force and inspect the WebGL2 fallback on WebGPU-capable browsers.

import { createDestructionWebGPU } from "./webgpu.js";
import { createDestructionWebGL2 } from "./webgl2.js";

export async function createDestructionEffect(gl, opts = {}) {
  const params = opts.params || new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const forceWebGL2 = params.get("renderer") === "webgl2";

  if (!forceWebGL2) {
    try {
      return await createDestructionWebGPU(opts.canvas || document.getElementById("c"));
    } catch (err) {
      console.info("[FX Lab · Destruction] WebGPU unavailable, activating WebGL2 fallback:", err?.message || err);
    }
  }
  return createDestructionWebGL2(gl);
}
