# FX Lab

Interactive WebGL2 sandbox for real-time graphics effects from [gamedev.pl](https://gamedev.pl).

**Live demo:** <https://gamedevpl.github.io/fx-lab/>

## Included effects

1. **Pixel-Art Gaussian Splats** (5 steps) — Procedural 3D Gaussian surfels rendered with EWA covariance projection, hard pixel grid snapping, 3-band stepped lighting, 24-color palette voting, Bayer 4×4 ordered dithering, and 1 px depth outlines.
2. **Evolution of Fire** (8 eras, 1985–2026) — Indexed palette cycling (CLUT), live 30 Hz PSX Doom cellular automaton, additive billboard sprite, soft particles with heat haze, baked 6-way directional lit flipbook with optical flow and blackbody HDR, 3D volumetric raymarching, sparse volume self-shadowing with split firelight GI, and a live 24×36×24 3D Navier–Stokes + vorticity confinement fluid solver with an interactive iron sphere collider.
3. **Evolution of Water** (8 eras, 1985–2026) — Indexed palette cycling, dual scrolling UV warp, Beer–Lambert depth absorption, Schlick Fresnel reflections, 6-wave Gerstner displacement with contact foam, Snell refraction with RGB caustics, spectral waves with backlit emerald SSS, and a live 128×128 zero-mean viscous shallow-water PDE with a 3D liquid splash crown, Worthington rebound jet, 48 ballistic droplets, and click-to-ripple interaction.

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
