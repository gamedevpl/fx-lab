# Evolution of Fog & Volumetric Lighting (1997–2026)

Interactive WebGL2 recreation of nearly 30 years of fog and volumetric light-scattering techniques inside a single gothic clockwork cathedral hall (rose window, slowly rotating iron gear slicing sunbeams, receding nave pillars, and two colored lanterns).

> **WebGL2 note:** WebGL2 has no compute shaders, so Stage 6's frustum-aligned froxel volume (`160×90×64`-style) is emulated via frustum-quantized fragment ray integration rather than a 3D compute texture dispatch. All other stages (including the multi-pass screen-space radial blur and colored stained-glass volumetric beams) run directly in WebGL2 fragment passes.

## 8 Eras Covered
1. **1997 — Distance Depth Fog (*Turok: Dinosaur Hunter* 1997 · *Silent Hill* 1999):** Uniform Z-depth fog hiding a short far-clipping plane (hardware depth fog already existed in OpenGL 1.0 in 1992).
2. **2002 — Analytical Aerial Perspective (Hoffman & Preetham, GDC 2002 / SIGGRAPH 2003):** Physical Rayleigh + Mie wavelength extinction and warm sun in-scattering.
3. **2004 — Shadow-Map & Slice Light Shafts (Dobashi 2002 · James 2003 · ATI GDC 2004):** Pre-2007 3D view-aligned volumetric slices through shadow volumes — works in 3D before screen-space, with visible coarse planar slicing.
4. **2007 — Screen-Space Light Scattering (Kenny Mitchell, *GPU Gems 3* Ch. 13, Aug 2007):** Multi-pass radial blur on the primary window occlusion buffer; smoothly fades out as you look away from the window (following Mitchell's own off-screen decay recommendation).
5. **2009 — Raymarched Volumetric Shadows + Interleaved Sampling (Tóth & Umenhoffer, Eurographics 2009):** True 3D shadow raymarching stays intact when looking away from the window, with an interactive toggle exposing raw 18-step banding vs interleaved sampling.
6. **2014 — Temporal Froxel Volumetric Fog (Bart Wronski, SIGGRAPH 2014 / *Assassin's Creed IV*):** Frustum-aligned logarithmic froxels + Henyey–Greenstein anisotropic phase (emulated in WebGL2, with a `Show Froxel Grid` overlay).
7. **2015 — Heterogeneous Media & Local Lights (Sébastien Hillaire / Frostbite, SIGGRAPH 2015):** Animated 3D swirling fog plumes + localized warm amber and cool cyan volumetric point lights.
8. **2020–2026 — Multi-Scattering & Stained-Glass Volumetrics (Hillaire, EGSR 2020 → modern engines):** Multi-octave energy-conserving scattering lifting shadow air + colored stained-glass rose window beams sliced live by the rotating iron clockwork gear.
