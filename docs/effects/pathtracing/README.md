# Evolution of Path Tracing (1975–2026)

Fifty-one years of light transport and ray tracing running live in raw WebGL2 inside one analytical Cornell Gallery room:

1. **1975 — Blinn–Phong Local Shading:** Flat local diffuse + specular shading with zero shadows, zero reflections, and zero light bounces.
2. **1980 — Whitted Ray Tracing:** Recursive mirror reflection, Snell crystal glass refraction (`IOR 1.52`), and razor-sharp hard shadows against flat grey ambient.
3. **1984 — Cook Distributed Ray Tracing:** Stochastic sampling across an area ceiling light, glossy GGX reflection cone, thin-lens aperture (optical Depth of Field), and shutter interval (true motion blur on a swinging bronze pendulum).
4. **1986 — Kajiya Path Tracing (1 SPP):** Genuine unbiased Monte Carlo hemisphere path tracing producing crimson/teal Cornell global illumination color bleeding—with iconic heavy 1 SPP salt-and-pepper noise and fireflies.
5. **1998 — Multi-SPP Progressive Accumulation:** Temporal averaging cleans up Monte Carlo noise over hundreds of samples when the camera stays still, then resets to raw noise the instant you move—showing why brute-force accumulation is too slow for real-time interaction.
6. **2005 — Importance Sampling, NEE & Veach MIS:** Cosine-weighted hemisphere sampling, Next Event Estimation toward the area light, and Veach's power-heuristic Multiple Importance Sampling dramatically slash variance at the exact same 2 SPP budget.
7. **2020 — ReSTIR & SVGF Denoising:** Multi-light Resampled Importance Sampling (RIS) paired with an albedo-demodulated, 4-pass edge-stopping joint-bilateral À-Trous wavelet denoiser (weighted by world normal, depth, strict material ID, and luminance) produces clean real-time GI from just 1 SPP.
8. **2026 — Real-Time Browser Path Tracing:** Live interactive 60 FPS denoised multi-bounce GI with a dynamic clickable glowing orb light and cyan architectural accent strip (representing today's WebGPU compute/TSL + SVGF browser path tracers, running here on universal raw WebGL2).

## Files

- [`shaders.js`](./shaders.js) — 4 GLSL ES 3.00 shaders (`PT_TRACE_FS`, `ACCUM_FS`, `ATROUS_FS`, `FINAL_FS`).
- [`index.js`](./index.js) — MRT G-buffer, ping-pong temporal accumulation, 4-pass À-Trous SVGF pipeline, and interactive light-orb controls.
