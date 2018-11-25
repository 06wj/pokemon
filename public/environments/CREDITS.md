# Environment lighting sources

The original high dynamic range photographs below are bundled locally. All derived lighting
textures preserve linear HDR data; photographs are used for actual illumination and reflections.

| Source | Artist | Original local file | License |
| --- | --- | --- | --- |
| [Forest Slope](https://polyhaven.com/a/forest_slope) | Andreas Mischok / Poly Haven | `forest_slope_1k.hdr` | CC0 |
| [Studio Small 09](https://polyhaven.com/a/studio_small_09) | Sergej Majboroda / Poly Haven | `studio_small_09_1k.hdr` | CC0 |

Downloaded 2026-09-05 from Poly Haven's asset distribution service:

- https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/forest_slope_1k.hdr
- https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr

Poly Haven's [asset license](https://polyhaven.com/license) allows redistribution and use under
[Creative Commons CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
These asset licenses are separate from the application's code license.

## Derived files

- `forest-specular.bin`, `studio-specular.bin`: 128px canonical cubemaps with eight GGX roughness
  levels, stored as linear RGBA16F. Level zero retains the photographed radiance; higher levels
  use 512-sample importance convolution with solid-angle/PDF selection from an HDR mip pyramid,
  avoiding glitter from tiny bright light sources. Alpha is one.
- `forest-diffuse.bin`, `studio-diffuse.bin`: 16px diffuse cubemaps (irradiance / π), reconstructed smoothly from nine spherical harmonic
  coefficients. Every HDR source pixel contributes with its solid angle and the cosine-lobe
  convolution is analytic; no stochastic sampling noise remains in diffuse lighting.
- `brdf-lut.bin`: 128px two-channel split-sum GGX integration table (1024 samples, stored RGBA16F).
- `bake-manifest.json`: source exposure calibration and exact baking settings.

Regenerate with `python3 scripts/bake-environments.py` from the repository root (Python 3 + NumPy).
The compact binary header and texel format are documented in that script. The GPU reads the
baked data directly; no convolution runs during page load. Source HDR files remain available for
rebaking, and are not downloaded by the browser at runtime.
