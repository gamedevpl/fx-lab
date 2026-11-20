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

## Project structure

Each effect lives in its own self-contained folder under `docs/effects/<id>/` with a technical `README.md`, CPU scene/simulation module, GLSL shader module, and WebGL2 renderer:

```text
docs/
├── index.html                                                           # Root entry (loads default effect)
├── splats/ fire/ water/ shadows/ cloth/ fur/ glass/ clouds/ grass/ pathtracing/ # Clean per-effect routes with dedicated Open Graph cards
├── src/                                                                 # Shared app shell, catalog metadata, WebGL2 helpers
└── effects/
    ├── splats/                                                          # README.md · scene.js · shaders.js · index.js
    ├── fire/                                                            # README.md · simulations.js · shaders.js · index.js
    ├── water/                                                           # README.md · simulation.js · shaders.js · index.js
    ├── shadows/                                                         # README.md · shaders.js · index.js
    ├── cloth/                                                           # README.md · simulation.js · shaders.js · index.js
    ├── fur/                                                             # README.md · groom.js · shaders.js · index.js
    ├── glass/                                                           # README.md · optics.js · shaders.js · index.js
    ├── clouds/                                                          # README.md · atmosphere.js · shaders.js · index.js
    ├── grass/                                                           # README.md · scene.js · shaders.js · index.js
    └── pathtracing/                                                     # README.md · shaders.js · index.js
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
