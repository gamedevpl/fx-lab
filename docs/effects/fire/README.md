# Evolution of Fire (1985–2026)

Eight eras of real-time game fire sharing the same raymarched stone courtyard, curved brick wall, charred oak logs, and wet flagstones in raw WebGL2.

**Live demo:** <https://gamedevpl.github.io/fx-lab/fire/>

## Stages

| Step | Era | Technique | What changes |
|---:|---|---|---|
| 1 | **1985** | **Palette Cycling (CLUT)** | A static `64×80` index map never moves—only a 16-color lookup table shifts each frame. Enable Split to expose the frozen index buffer on the left. |
| 2 | **1995** | **PSX Doom 2D Cellular Automaton** | Runs live at 30 Hz on a `96×112` heat grid (`spreadFire`): each pixel reads heat from the row below, drifts sideways by `±1`, and cools by random decay `0..3` through the 37-color Doom LUT. |
| 3 | **1998** | **Sprite & Additive Billboard** | An 8-frame pixel sprite sheet pasted onto a camera-facing quad with LDR additive blending. Toggle `Wireframe` or orbit up to inspect hard depth clipping against the logs. |
| 4 | **2004** | **Soft Particles & Heat Haze** | Depth-difference fade (`smoothstep(-0.18, 0.44, sceneDepth - bT)`) hides geometry seams while scrolling sine waves refract the brick backdrop behind rising hot air. |
| 5 | **2012** | **6-Way Flipbook & Kelvin HDR** | Lazily bakes directional transmittance along all 6 axes (`±X`, `±Y`, `±Z`) plus core scatter and screen-space flow vectors from the 3D fluid solver, then interpolates frames with optical flow, blackbody radiation, and separable HDR bloom. |
| 6 | **2018** | **3D Volumetric Raymarching** | Steps 44 jittered samples through a procedural 3D heat and soot volume using Beer–Lambert absorption—eliminating billboard popping from any camera angle. |
| 7 | **2022** | **Sparse Volume, Self-Shadow & GI** | Secondary shadow-march rays darken dense soot folds and scatter warm firelight onto the brick wall and wet puddles. Toggle `Voxel Grid` to visualize active non-empty blocks. |
| 8 | **2026** | **Live 3D Navier–Stokes Fluid** | Real-time `24×36×24` Eulerian solver with thermal buoyancy, fuel combustion, vorticity confinement, Jacobi pressure projection, and semi-Lagrangian advection. Press `Sweep Sphere` to push a solid iron collider through the live flames. |

## Files

- [`simulations.js`](./simulations.js) — CPU generators & solvers: 1985 CLUT index buffer, live PSX Doom cellular automaton, 8-frame sprite atlas, `24×36×24` 3D Navier–Stokes solver, and lazy 6-way directional flipbook baker.
- [`shaders.js`](./shaders.js) — GLSL ES 3.00 shaders for the SDF courtyard with 16-bit depth packing, all 8 fire stages, Gaussian bloom blur, and unified ACES filmic tone mapping.
- [`index.js`](./index.js) — WebGL2 orchestration, RGBA16F/RGBA8 FBO fallback, 30 Hz fixed-step accumulators, and interactive `Wireframe` / `Voxel Grid` / `Sweep Sphere` actions.
