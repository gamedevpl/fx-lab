# Evolution of Anti-Aliasing & Temporal Upscaling (1990–2026)

Thirty-six years of real-time anti-aliasing and temporal reconstruction running live in raw WebGL2 on an analytical **AA Torture-Test Courtyard** (shallow diagonal eaves, subpixel tension wires, fine resolution chart, fluted chrome sphere, metallic louvers, and a swinging crimson pendulum) with a clickable pixel-accurate **4× Magnifier Loupe**:

1. **1990 — Aliased 1× vs 4×4 SSAA (Haeberli & Akeley, SIGGRAPH 1990):** Hardware accumulation-buffer supersampling shades 16 subpixel samples per pixel—clean on edges, wires and speculars, but 16× the shading cost.
2. **1993 — Hardware 4× MSAA (RealityEngine 1993 → PC GPUs):** Tests 4 rotated-grid geometry coverage samples while running the fragment shader only **once** per pixel—smoothing triangle silhouettes while leaving shader & specular aliasing on the fluted chrome sphere and louvers.
3. **2011 — FXAA (Timothy Lottes, NVIDIA 2011):** Fast single-pass post-process edge filter operating on screen luminance—smooths jagged contours cheaply, at the cost of softening fine textures and stripes.
4. **2012 — SMAA (Jorge Jimenez et al., Eurographics 2012):** Morphological `L`/`Z`/`U` edge-pattern search preserves texture sharpness far better than FXAA, yet single-frame post-AA still cannot reconstruct subpixel wires narrower than one pixel (they break into dashed shimmering dots in the 4× loupe).
5. **2010–2013 — Early TAA (*Halo: Reach* 2010 · *Crysis 2* 2011 · *UE4 Infiltrator* 2013):** Halton(2,3) subpixel jitter + temporal history accumulation finally stabilizes subpixel wires—but without motion reprojection and neighborhood clipping, the swinging pendulum leaves an unmistakable **ghosting trail**.
6. **2014 — TAA + YCoCg Clipping (Lottes 2011 · Malan 2012 · Karis SIGGRAPH 2014):** Exact analytical per-pixel motion vectors, 5-tap Catmull-Rom reprojection, and YCoCg neighborhood AABB clipping drastically reduce motion ghosting (though faint residual trails can still appear across extreme high-contrast disocclusions).
7. **2016 — Specular AA (Toksvig 2005 · Kaplanyan et al. 2016):** A dedicated shading-side technique—filtering subpixel normal variance into GGX roughness² eliminates sparkling metallic highlights on the fluted chrome sphere and louvers.
8. **2022–2026 — Temporal Upscaling (FSR 2 / TSR Style, 50% Axis = 25% Pixels):** Renders the scene into a true half-width × half-height buffer (**25% total pixels**, like Performance mode) with 16-point Halton(2,3) jitter, then reconstructs a crisp 100% frame using motion vectors, Catmull-Rom history, YCoCg clipping, Specular AA, and RCAS sharpening.

## Files

- [`shaders.js`](./shaders.js) — 6 GLSL ES 3.00 shaders (`SCENE_FS`, `FXAA_FS`, `SMAA_EDGE_FS`, `SMAA_BLEND_FS`, `TAA_FS`, `FINAL_FS`).
- [`index.js`](./index.js) — Dual full-res / 25%-pixel MRT buffers, Halton(2,3) jitter, exact camera/object motion tracking, ping-pong TAA history, and clickable 4× Loupe.
