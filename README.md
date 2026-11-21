# FX Lab

Interactive WebGL2 sandbox for real-time graphics effects from [gamedev.pl](https://gamedev.pl).

**Live demo:** <https://gamedevpl.github.io/fx-lab/>

## Included effects

1. **[Pixel-Art Gaussian Splats](https://gamedevpl.github.io/fx-lab/splats/)** (5 steps · [source & notes](./docs/effects/splats/README.md)) — Procedural 3D Gaussian surfels rendered with EWA covariance projection, hard pixel grid snapping, 3-band stepped lighting, 24-color palette voting, Bayer 4×4 ordered dithering, and 1 px depth outlines.
2. **[Evolution of Fire](https://gamedevpl.github.io/fx-lab/fire/)** (8 eras, 1985–2026 · [source & notes](./docs/effects/fire/README.md)) — Indexed palette cycling (CLUT), live 30 Hz PSX Doom cellular automaton, additive billboard sprite, soft particles with heat haze, baked 6-way directional lit flipbook with optical flow and blackbody HDR, 3D volumetric raymarching, sparse volume self-shadowing with split firelight GI, and a live 24×36×24 3D Navier–Stokes + vorticity confinement fluid solver with an interactive iron sphere collider.
3. **[Evolution of Water](https://gamedevpl.github.io/fx-lab/water/)** (8 eras, 1985–2026 · [source & notes](./docs/effects/water/README.md)) — Indexed palette cycling, dual scrolling UV warp, Beer–Lambert depth absorption, Schlick Fresnel reflections, 6-wave Gerstner displacement with contact foam, Snell refraction with RGB caustics, spectral waves with backlit emerald SSS, and a live 128×128 zero-mean viscous shallow-water PDE with a 3D liquid splash crown, Worthington rebound jet, ballistic droplets, and click-to-ripple interaction.
4. **[Evolution of Shadows](https://gamedevpl.github.io/fx-lab/shadows/)** (8 eras, 1988–2026 · [source & notes](./docs/effects/shadows/README.md)) — 1988 ground blob discs, planar `y = 0` projection, *Doom 3*-style stencil volumes, real `88×88` hard shadow map aliasing, 16-tap Poisson PCF, PCSS contact-hardening, cone-traced ray-traced area lights with crevice AO and blue sky fill, and colored stained-glass shadows with crystal lens caustics and color-bounce GI.
5. **[Evolution of Cloth](https://gamedevpl.github.io/fx-lab/cloth/)** (8 eras, 1988–2026 · [source & notes](./docs/effects/cloth/README.md)) — 1988 2-frame `32×24` pixel banner, rigid hinged flap, travelling sine-wave vertex shader, Verlet mass-spring physics, 2-hop bending stiffness with woven linen normal map, PBR Charlie velvet sheen + backlit translucency, stretch-free XPBD sphere wrapping, and per-triangle aerodynamic wind with PCF self-shadows and live tearing.
6. **[Evolution of Fur](https://gamedevpl.github.io/fx-lab/fur/)** (8 eras, 1992–2026 · [source & notes](./docs/effects/fur/README.md)) — 1992 flat painted polygon mesh, directional normal maps, 8-layer & 40-layer instanced *Shell Texturing* with gravity combing and root AO, Kajiya–Kay anisotropic specular, Marschner dual-lobe scattering with golden backlit rim, 30,000 geometric clumped 3D hair strands, and a live `64×32` spring-damper wind, head-shake & petting groom.
7. **[Evolution of Glass & Caustics](https://gamedevpl.github.io/fx-lab/glass/)** (8 eras, 1995–2026 · [source & notes](./docs/effects/glass/README.md)) — 1995 flat alpha transparency, studio env-map reflections, Schlick Fresnel (`F₀ = 0.04`), single-surface Snell refraction, thick double refraction with Beer–Lambert volume absorption, Cauchy chromatic dispersion, real-time `512×512` GPU photon-splatted caustics with frosted microfacets, and 4-bounce Total Internal Reflection with 98,304 six-band spectral caustic photons and interactive sun aiming.
8. **[Evolution of Clouds & Sky](https://gamedevpl.github.io/fx-lab/clouds/)** (8 eras, 1992–2026 · [source & notes](./docs/effects/clouds/README.md)) — 1992 banded sky with 2D pixel sprites, 1997 skybox scrolling cloud plane, 2002 camera-facing 3D billboard puffs, physical Rayleigh & Mie atmosphere, GPU-baked `64³` tileable Perlin–Worley 3D volumetric raymarching, Beer–Lambert self-shadowing with Henyey–Greenstein silver lining, Nubis-style multi-scattering powder with storm anvil toggle, and real-time crepuscular god-rays with interactive time-of-day sun placement.
9. **[Evolution of Grass & Foliage](https://gamedevpl.github.io/fx-lab/grass/)** (8 eras, 1992–2026 · [source & notes](./docs/effects/grass/README.md)) — 1992 flat pixel tile, 1996 crossed alpha-cutout X-cards (with wireframe toggle), 2001 10-layer stacked shell grass, 28,000 GPU-instanced 3D curved blades, multi-octave travelling wind waves & root AO, backlit golden subsurface scattering, 650 swaying 3D wildflowers with drifting cloud shadows & sunlit pollen, and a live 128×128 spring-damper trampling trail field parted by a rolling carved orb and mouse clicks.
10. **[Evolution of Path Tracing](https://gamedevpl.github.io/fx-lab/pathtracing/)** (8 eras, 1975–2026 · [source & notes](./docs/effects/pathtracing/README.md)) — 1975 Blinn–Phong local rasterization, 1980 Whitted ray tracing (hard shadows, chrome mirror & Snell crystal glass), 1984 Cook distributed ray tracing (soft area shadows, glossy gold, thin-lens DoF & swinging pendulum motion blur), 1986 Kajiya 1 SPP unbiased Monte Carlo path tracing, multi-SPP progressive temporal accumulation, importance sampling + NEE + Veach MIS, ReSTIR multi-light RIS + 4-pass edge-stopping À-Trous SVGF denoising, and 2026 interactive real-time browser path tracing.
11. **[Evolution of Toon & NPR Shading](https://gamedevpl.github.io/fx-lab/toon/)** (8 eras, 1996–2026 · [source & notes](./docs/effects/toon/README.md)) — 1996 Decaudin cartoon rendering (2-tone cel + Z/normal discontinuity ink), 1998 Gooch warm-to-cool technical illustration, 2000 cel-shaded games with authentic back-face Inverted Hull geometry, 2002 *Wind Waker*-style saturated cel ramps, 2009 *Borderlands*-style Sobel ink & comic cross-hatching, 2014 *Guilty Gear Xrd* artist-edited normals, ILM masks, UV inner lines & stepped anime timing, 2018 *Spider-Verse*-style Ben-Day halftone, shadow hatching, CMYK offset & mixed 1s/2s animation, and 2026 real-time 8-sector Anisotropic Kuwahara painterly oil brushstrokes driven by a GPU Structure Tensor.
12. **[Evolution of Anti-Aliasing & Temporal Upscaling](https://gamedevpl.github.io/fx-lab/aa/)** (8 eras, 1990–2026 · [source & notes](./docs/effects/aa/README.md)) — 1990 Haeberli & Akeley 4×4 SSAA, 1993 hardware 4× MSAA (smooth geometry edges with remaining specular aliasing), 2011 Timothy Lottes FXAA, 2012 Jorge Jimenez SMAA (sharp textures while subpixel wires still break up), 2010–2013 Early TAA (*Halo: Reach* / *Crysis 2* / *UE4*) showing motion ghosting, 2014 Motion Vectors + Catmull-Rom + YCoCg AABB clipping (Lottes 2011 / Malan 2012 / Karis SIGGRAPH 2014), Toksvig/Kaplanyan Specular AA, and FSR 2 / TSR-style 50%-axis (25% pixels) Halton(2,3) temporal upscaling with a clickable 4× pixel magnifier loupe.
13. **[Evolution of Reflections](https://gamedevpl.github.io/fx-lab/reflections/)** (8 eras, 1976–2026 · [source & notes](./docs/effects/reflections/README.md)) — 1976 Blinn & Newell equirectangular environment mapping, 1996 *Duke Nukem 3D* / *Unreal* planar portal mirror, 1999 GeForce 256 / DX7 hardware cubemaps, 2011 *Crysis 2* DX11 real screen-space reflections (SSR) exposing behind-pillar occlusion holes and off-screen clipping, 2012 parallax-corrected cubemaps (Bjorke 2004 · popularized by Lagarde & Zanuttini, SIGGRAPH 2012), 2013 Brian Karis Split-Sum roughness IBL, 2018 *Battlefield V* DXR ray-traced reflections, and *UE5 Lumen* / *Cyberpunk 2077 RT Overdrive* multi-bounce glossy reflections with contact hardening and temporal denoising.
14. **[Evolution of Surface Detail](https://gamedevpl.github.io/fx-lab/surface/)** (8 eras, 1978–2026 · [source & notes](./docs/effects/surface/README.md)) — 1978 Blinn Bump Mapping, 1998 Normal Mapping (Cohen & Cignoni 1998 · *Evolva* / *Giants* 2000 · *Doom 3* 2004), 2001 Kaneko / Welsh Parallax Mapping, 2005 Policarpo Relief Mapping, 2006 Tatarchuk Parallax Occlusion Mapping (POM) with live heightfield soft self-shadows (flat silhouette), 2009 programmable DX11 Tessellation & Displacement with wireframe toggle (true jagged 3D silhouette!), 2018–2020 NVIDIA Turing / DX12 Ultimate Meshlets, and 2022–2026 UE5 Nanite-style virtualized micropolygon clusters (emulated in WebGL2 via dense vertex-displaced meshes).
15. **[Evolution of Fog & Volumetric Lighting](https://gamedevpl.github.io/fx-lab/fog/)** (8 eras, 1997–2026 · [source & notes](./docs/effects/fog/README.md)) — 1997 *Turok* / 1999 *Silent Hill* distance depth fog (masking far-clipping), 2002 Hoffman & Preetham analytical Rayleigh/Mie aerial perspective, 2004 pre-2007 shadow-map 3D light-shaft slices, 2007 Kenny Mitchell (*GPU Gems 3* Ch. 13) screen-space radial god rays smoothly fading out when looking away, 2009 Tóth & Umenhoffer 3D raymarched volumetric shadows with interleaved sampling toggle, 2014 Bart Wronski temporal froxel fog (emulated in WebGL2, with Froxel Grid overlay), 2015 Sébastien Hillaire / Frostbite heterogeneous swirling mist & local colored lanterns, and 2020–2026 Hillaire (EGSR 2020) multi-scattering with stained-glass cathedral sunbeams sliced by a turning iron clockwork gear.

## Project structure

Each effect lives in its own self-contained folder under `docs/effects/<id>/` with a technical `README.md`, CPU scene/simulation module, GLSL shader module, and WebGL2 renderer:

```text
docs/
├── index.html                                                                                              # Root entry (loads default effect)
├── splats/ fire/ water/ shadows/ cloth/ fur/ glass/ clouds/ grass/ pathtracing/ toon/ aa/ reflections/ surface/ fog/ # Clean per-effect routes with dedicated Open Graph cards
├── src/                                                                                                    # Shared app shell, catalog metadata, WebGL2 helpers
└── effects/
    ├── splats/                                                                                             # README.md · scene.js · shaders.js · index.js
    ├── fire/                                                                                               # README.md · simulations.js · shaders.js · index.js
    ├── water/                                                                                              # README.md · simulation.js · shaders.js · index.js
    ├── shadows/                                                                                            # README.md · shaders.js · index.js
    ├── cloth/                                                                                              # README.md · simulation.js · shaders.js · index.js
    ├── fur/                                                                                                # README.md · groom.js · shaders.js · index.js
    ├── glass/                                                                                              # README.md · optics.js · shaders.js · index.js
    ├── clouds/                                                                                             # README.md · atmosphere.js · shaders.js · index.js
    ├── grass/                                                                                              # README.md · scene.js · shaders.js · index.js
    ├── pathtracing/                                                                                        # README.md · shaders.js · index.js
    ├── toon/                                                                                               # README.md · scene.js · shaders.js · index.js
    ├── aa/                                                                                                 # README.md · shaders.js · index.js
    ├── reflections/                                                                                        # README.md · shaders.js · index.js
    ├── surface/                                                                                            # README.md · mesh.js · shaders.js · index.js
    └── fog/                                                                                                # README.md · shaders.js · index.js
```

## Controls

- **Drag** — Orbit and tilt the camera
- **Scroll / Pinch** — Zoom in and out
- **Double-click / `R`** — Reset camera
- **Drag amber divider / `S`** — Toggle and slide before/after split-screen comparison
- **`←` / `→`** — Step backward or forward
- **`Space`** — Pause or resume simulation
- **`E`** — Open the effects catalog
- **`1`–`9`** — Jump directly to an effect
- **Click pool (Water Step 8)** — Inject live concentric ripples

## Running locally

No build step and no external dependencies — plain ES modules and raw WebGL2 inside `docs/`.

```sh
python3 -m http.server 8080 --directory docs
```

Then open `http://localhost:8080/`.

## License

MIT — see [LICENSE](./LICENSE).
