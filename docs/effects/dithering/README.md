# Evolution of Dithering & 1-Bit Stippling (1973–2026)

Interactive WebGL2 tour of 53 years of dithering — from 1-bit bi-level display hacks to modern surface-anchored 3D blue-noise stippling — rendered on a live analytical raytraced **ringed gas giant**, swirling Great Storm vortex, backlit eclipsing moon, and diagonal Milky Way dust band.

## The 8 Eras

1. **1-Bit Hard Threshold (Pre-1973):** Pure `step(0.46, luma)` quantization on 1-bit displays (Xerox Alto / PLATO era). Every cloud band, smooth terminator gradient, and ring collapses into stark solid shapes.
2. **Ordered Bayer Matrix (Bryce Bayer, 1973):** Recursive `8×8` (toggleable `4×4`) threshold matrix (*IEEE ICC 1973*) disperses dots across every gray level so halftones reappear from two colors — revealing Bayer's unmistakable crosshatch plaid in the 4× loupe.
3. **Floyd–Steinberg Error Diffusion (1976):** Live real-time CPU error diffusion (`7/16`, `3/16`, `5/16`, `1/16`, toggleable serpentine scan) eliminates the regular grid, yet visibly boils and crawls whenever the planet or camera moves. Press **Space** to freeze and see it snap razor-sharp!
4. **Macintosh Atkinson Dithering (Bill Atkinson, Apple 1984):** Live CPU 6-neighbor `1/8` kernel (`6/8` diffused, 25% discarded) created for the 1-bit `512×342` Macintosh CRT. Dropping 25% of error clips faint space noise to pure ink-black and boosts crisp comic-book contrast.
5. **Screen-Door Stipple Alpha & Limited Color (Mega Drive / VGA, 1988–94):** 9-bit `RGB333` palette dithering plus zero-alpha screen-door checkerboard transparency for the planetary rings (just like *Sonic* Mega Drive waterfalls). Toggle **CRT Composite** (or drag Split) to watch analog horizontal phosphor bleed melt the checkerboard into translucent silk.
6. **15-Bit RGB555 Hardware Dithering (PlayStation 1, 1994):** Quantizing smooth lighting to 5 bits per channel triggers concentric contour banding across the planet's terminator; the PS1 GPU's exact `4×4` signed pre-truncation hardware dither matrix erases the bands.
7. **Blue Noise & Obra Dinn Sphere-Lock (Ulichney 1993 · Lucas Pope 2018):** Deterministic `64×64` Void-and-Cluster blue noise (`O(1)` GPU lookup, zero plaid, zero boiling) projected onto world ray directions so orbiting the camera keeps 1-bit dots nailed to 3D space instead of swimming across monitor glass.
8. **3D Surface-Anchored Stippling (2024–26):** Dual-octave blue-noise stippling anchored directly to the spinning planet's co-rotating equal-area cube coordinates, ring plane, and moon, blended through an exact closed-form Irwin–Hall/Bates variance-preserving CDF so dot grain stays crisp and uniform at any zoom level.
