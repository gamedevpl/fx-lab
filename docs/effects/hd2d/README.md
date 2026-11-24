# HD-2D Miniature Diorama (8 Steps)

Interactive WebGL2 deconstruction of how flat, cheap-looking pixel-art 3D geometry transforms into a miniature **HD-2D dungeon diorama** in 8 live passes.

## The 8 Passes

1. **Raw Pixel 3D (Pass 1):** Nearest-neighbor pixel-art cubes under a wide 50° camera with full roof rafters and flat neutral lighting.
2. **Cutaway Walls & Telephoto Lens (Pass 2):** Slices off the ceiling into crisp dark cutaway caps and tightens the camera to a 24° diorama lens, compressing depth like a tabletop board.
3. **Pixel-Art Normal Maps (Pass 3):** Pairs every `64×64` `gl.NEAREST` brick, flagstone, oak door, and barrel texture with a procedural tangent-space normal map so grazing light catches individual stone bevels.
4. **Warm Torches vs Cool Blue Ambient (Pass 4):** Directional PCF shadow map + 12 flickering HDR point lights (center wall torches, upper gallery windows & cyan shrine, foreground braziers & teal lantern) against deep twilight-blue shadow fill.
5. **Low-Res 3D Fighters & Sparks (Pass 5):** Animated low-res 3D knight with glowing enchanted rune blade facing a skeleton sentinel with floating pixel HP bar, grounded shadows, and rising golden embers (toggleable to *Octopath Traveler*-style 2D camera-facing pixel sprites).
6. **RGBA16F HDR Bloom & Drifting Foreground Mist (Pass 6):** Multi-pass separable Gaussian bloom around emissive torches, windows, and cyan runes, plus a drifting foreground mist veil floating in front of the lens.
7. **1904 Scheimpflug Tilt-Shift DoF (Pass 7):** 24-tap Golden-Angle Vogel spiral bokeh along a tilted focal plane inspired by Theodor Scheimpflug's 1904 aerial-camera patent, the 1973 Canon TS 35 mm tilt-shift lens, 2000s miniature-faking photography (Barbieri, Laforet), *SimCity* (2013), and *Octopath Traveler*'s HD-2D look (2018). Lit top windows, the upper-right cyan orb, and foreground braziers melt into circular HDR bokeh while the center duel stays razor-sharp.
8. **Full HD-2D Miniature Diorama (Pass 8):** ACES filmic tone mapping, warm/cool split grading, and subtle lens vignette at 60 FPS. Click anywhere to move the tilted focal strip and trigger a golden spell burst.
