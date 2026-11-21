# Evolution of Toon & NPR Shading (1996–2026)

Thirty years of Non-Photorealistic Rendering (NPR) and cel shading running live in raw WebGL2 on one stylized Ronin-Sentinel diorama:

1. **1996 — Decaudin Cartoon Rendering (INRIA):** Philippe Decaudin's foundational paper (*"Cartoon-looking rendering of 3D-scenes"*, INRIA 1996): 2-tone flat cel shading with outlines extracted from depth (`Z`) and surface normal discontinuities.
2. **1998 — Gooch Warm-to-Cool Shading (SIGGRAPH):** Amy & Bruce Gooch et al. (SIGGRAPH 1998) replaced black shadows with cool-to-warm luminance shifts so black technical ink outlines stay readable everywhere.
3. **2000 — Early Cel-Shaded Games (*Jet Set Radio* Era):** 1D 3-band toon ramps paired with a genuine geometric **Inverted Hull** back-face extrusion outline (`gl.cullFace(gl.FRONT)`), with a toggle to inspect the extruded hull shell in crimson.
4. **2002 — *Wind Waker* Style Cel Ramp:** Saturated 2-tone cartoon colors, crisp cast shadows, bright specular caps, and clean silhouette edges without heavy black linework.
5. **2009 — *Borderlands* Ink & Cross-Hatching Style:** Bold 3×3 Sobel depth & normal ink outlines paired with comic cross-hatching in shadows (inspired by *Borderlands*' hand-painted hatch textures + Sobel depth edges).
6. **2014 — *Guilty Gear Xrd* (Motomura, GDC 2015):** Artist-edited smooth proxy normals (toggleable against raw 3D normals), ILM shadow/specular masks, crisp UV-aligned inner ink lines, and stepped limited-frame anime motion.
7. **2018 — *Spider-Verse* Halftone & Mixed 1s/2s:** Screen-locked Ben-Day halftone dots in highlights/midtones, diagonal ink hatching in shadows, subtle CMYK registration offset, and animation alternating between "on twos" (12 fps) and "on ones" (smooth).
8. **2026 — Painterly Anisotropic Kuwahara (Structure Tensor):** Real-time 8-sector Anisotropic Kuwahara filtering (Kyprianidis et al. 2009) aligned to a GPU Structure Tensor—producing flowing directional oil brushstrokes inspired by modern hand-painted 3D art (such as *Arcane*). Click anywhere to aim the key light.

## Files

- [`scene.js`](./scene.js) — Procedural 3D Ronin-Sentinel mesh with dual raw/edited normals, ILM AO masks, and UV-aligned inner ink lines.
- [`shaders.js`](./shaders.js) — 7 GLSL ES 3.00 shaders (`SKY_FS`, `SHADOW`, `SCENE`, `HULL`, `TENSOR`, `TENSOR_BLUR`, `FINAL_FS`).
- [`index.js`](./index.js) — Shadow map, MRT G-buffer, back-face Inverted Hull, Structure Tensor, and interactive light/toggle controller.
