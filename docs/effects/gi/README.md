# Evolution of Global Illumination (1996–2026)

Interactive **WebGPU Compute** sandbox (with automatic **WebGL2 fallback**) comparing 30 years of real-time indirect lighting inside one Cornell-inspired architectural gallery with a vivid crimson wall, electric cyan wall, thin dividing partition (light-leak test), and clickable moving pendant lamp.

## WebGPU Primary + Automatic WebGL2 Fallback

Global Illumination is the first FX Lab effect powered natively by **WebGPU Compute Shaders (WGSL)**:
- **3D Storage Textures (`texture_storage_3d<rgba16float, write>`):** live `32×24×32` voxel radiance injection + 3-level 3D mipmap chain (`16×12×16 → 8×6×8 → 4×3×4`) for Voxel Cone Tracing and multi-bounce caching.
- **Storage Buffers (`var<storage, read_write>`):** live `6×4×6` Valve Ambient Cube irradiance volume probes.
- **Workgroup Shared Memory (`var<workgroup>`):** `8×5×8 = 320` DDGI probes tracing 64 Fibonacci rays/frame in parallel into `512×40` octahedral irradiance & Chebyshev depth/depth² visibility atlases.
- **Multi-Pass Sannikov Radiance Cascades:** 3-level (`C2 → C1 → C0`) world-space octahedral interval ray-marching with depth-aware bilinear cascade merging (`256` effective angular directions per pixel in constant texel memory).
- **Hardware Ray Tracing note:** WebGPU does not yet expose hardware RT cores (`gpuweb/gpuweb#11056` is preliminary with no shipping timeline), so all ray queries run as software SDF compute tracing.
- **WebGL2 Fallback:** On browsers without WebGPU (e.g. Firefox on Linux/Android or older Safari), or when `?renderer=webgl2` is appended to the URL, FX Lab automatically runs a matching multi-pass WebGL2 fallback (including MRT G-Buffer, real screen-space SSAO & SSDO/SSGI, 3-pass fragment Radiance Cascades, and analytical 3D probe/voxel emulation) with zero blank error screens.

## 8 Eras & Verified Sources

1. **1996 — Baked Lightmaps (*Quake*, 1996):** Static luxelized radiosity/lightmaps vs early-1990s flat constant ambient. Clicking **Move Lamp** exposes why static lightmaps break on dynamic lights—the baked bounce stays frozen on the original wall.
2. **1998–2004 — Irradiance Volumes & Light Probes:** Greger et al. (*IEEE CG&A*, 1998) and Valve's *Half-Life 2* 6-axis Ambient Cube (2004)—years before SSAO. Dynamic objects pick up live bounce, yet trilinear probe interpolation leaks light straight through the thin dividing wall (**Show Probes**).
3. **2007 — SSAO (*Crysis*, Martin Mittring, SIGGRAPH 2007):** Explicitly **ambient occlusion (crevice darkening), not true GI**—no colored wall bounce, plus classic depth-discontinuity haloing and screen-edge decay (**AO Buffer**).
4. **2009 — SSDO / Screen-Space GI (Ritschel et al., I3D 2009 · LPV, Kaplanyan 2009):** Real screen-space bounce started with SSDO (2009), alongside Anton Kaplanyan's 3D Light Propagation Volumes (*Crysis 2*, 2009). Clicking **Look Away** pans the crimson wall off-screen so its screen-space red bounce vanishes live.
5. **2011 — Voxel Cone Tracing / SVOGI (Crassin et al. 2011 · UE4 demo 2012 · *Enlighten* in *Battlefield 3* 2011):** True 3D voxel cone tracing survives camera rotation, though coarse voxels stay soft and subtly leak across walls thinner than a voxel cell (**Show Voxels**).
6. **2019 — DDGI — Dynamic Diffuse GI (Majercik et al., JCGT 2019):** Alongside early hardware RT GI (*Metro Exodus*, 2019) and followed by ReSTIR GI (2021). Octahedral probe grids paired with Chebyshev upper-bound depth visibility eliminate thin-wall light leaking (**Show Probes**).
7. **2022 — Software SDF GI (*Unreal Engine 5 Lumen* style, 2022):** Software ray tracing against Signed Distance Fields + multi-bounce radiance surface cache + À-Trous bilateral denoising (**Move Lamp**).
8. **2023–2026 — Radiance Cascades (Alexander Sannikov, working paper 2023 · *Path of Exile 2* 2D screen-space · three.js Split RC PR #35349):** Placed chronologically after 2022 Lumen; multi-scale angular/spatial intervals deliver noise-free, penumbra-accurate GI with live `8×8` cascade block inspection (**Show Cascades**).

## Files

- `index.js` — Smart entry point selecting WebGPU Compute or automatic WebGL2 fallback (`?renderer=webgl2`).
- `webgpu.js` — WebGPU device/pipeline/compute-pass orchestrator.
- `wgsl.js` — WGSL compute & render shaders (voxels, Ambient Cubes, DDGI, G-Buffer, SSAO/SSDO, SDF GI, À-Trous bilateral, 3-level Radiance Cascades, compose).
- `webgl2.js` — Automatic multi-pass WebGL2 fallback engine.
- `shared.js` — Shared camera, `Look Away`, `Move Lamp`, click-to-place-lamp, and tech badges.
