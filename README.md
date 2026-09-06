# Pokémon Viewer · [简体中文](README.zh-CN.md)

A browser-based 3D Pokémon viewer built with [Hilo3D](https://hilo3d.js.org), React and TypeScript. It includes 151 first-generation Pokémon, skeletal animation, material presets and type-based habitat scenes. The application UI is in Chinese.

[Live demo](https://06wj.github.io/pokemon/)

## Overview

![Full application interface showing Venusaur with its original material](docs/screenshots/venusaur-original.jpg)

- 151 regular-form models and 869 animation clips, loaded on demand as GLB assets.
- Six material presets: Original, Anime (toon), Pixel, Gold, Glaze (original surfaces with clearcoat) and Bubble (iridescent). Pixel uses a fixed pixel grid, four lighting levels, ordered dithering and a limited color palette. Pixel and Glaze retain the `glass` and `silver` URL keys for existing links.
- Six habitat scenes selected by Pokémon type, with environment lighting and particle effects.
- WebGPU and WebGL2 rendering, with a manual backend switch.
- Responsive controls for model selection, animation playback, orbit, zoom and fullscreen.

## Material examples

Venusaur rendered with three presets. These WebGPU captures use the same camera view and are cropped to the model region.

| Anime / Toon | Gold | Bubble / Iridescent |
| --- | --- | --- |
| ![Venusaur with toon shading](docs/screenshots/venusaur-toon-detail.jpg) | ![Venusaur with gold material](docs/screenshots/venusaur-gold-detail.jpg) | ![Venusaur with iridescent material](docs/screenshots/venusaur-iridescent-detail.jpg) |

Toon and Pixel also stylize the habitat. Both reuse the original pigment/normal/depth pass. Pixel filters nine depth-aware samples per cell on a small render target, with softened lighting thresholds and reduced ordered dithering to limit shimmer. It expands that grid with nearest-neighbor sampling and resolves it again after tone mapping so block edges stay sharp. Desktop blocks are about 4 CSS pixels; narrow viewports keep 2-pixel blocks. Models are scaled to the same idle-pose height, without shrinking wide wings or long tails to fit a width/depth limit. The DOM interface remains at full resolution. Material changes preserve skeletal animation and expression atlases.

## Controls and URL parameters

- Search by displayed name or Pokédex number; select a model from the list.
- Drag to orbit; use the mouse wheel or pinch gesture to zoom.
- Open the action menu to select an available animation. Supported actions are retained when changing models.
- Desktop shortcuts: **← / →** select models, **R** resets the camera, **⌘ / Ctrl + K** focuses search. The action menu supports arrow keys, Enter and Esc.
- Click the **WebGPU / WebGL2** label to switch backends. This reloads the page, preserving the model and material but resetting the camera and action.

Example: [`?backend=webgpu&material=toon#003`](https://06wj.github.io/pokemon/?backend=webgpu&material=toon#003).

| Parameter | Values | Default |
| --- | --- | --- |
| `backend` | `auto`, `webgpu`, `webgl2` | Automatic selection |
| `material` | `original`, `toon`, `glass`, `gold`, `silver`, `iridescent` | `original` |
| URL hash | Pokédex number, e.g. `#003` | `#001` |

WebGPU support and output depend on the browser and GPU. If rendering is incorrect, switch to [WebGL2](https://06wj.github.io/pokemon/?backend=webgl2#003). Errors after WebGPU initialization begins are displayed without silently switching backends.

## Implementation

- **Stack:** Hilo3D `2.0.0-alpha.4`, React 19, TypeScript 7 and Vite 8.
- **Application:** React manages selection, controls and URL state; `PokemonStageController` manages the 3D scene and rendering lifecycle.
- **Assets:** self-contained GLBs with skeletal animation and embedded textures. Per-mesh joint palettes fit the 128-bone GPU path on WebGL2 and WebGPU.
- **Materials and lighting:** material adapters, HDR environment lighting, toon shading, habitat-specific water and particle effects.
- **Delivery:** eligible opaque color textures use JPEG without reducing resolution. Other PNGs, including normal/data maps and expression textures, retain their original bytes. Models and the WebGPU shader compiler load on demand.

## Asset credits

This is an unofficial technical demonstration, not affiliated with or endorsed by the Pokémon rights holders. Pokémon characters and associated assets belong to their respective owners; this repository does not grant rights to those assets.

- Species and type data: [official Traditional Chinese Pokédex](https://tw.portal-pokemon.com/play/pokedex/).
- Environment lighting: [Poly Haven HDRI credits](public/environments/CREDITS.md).
- Generated backdrops: ImageGen; see [prompts and asset notes](public/backdrops/README.md).

## Development

### Run locally

Use **Node.js 22.18+** for the full toolchain and resource tests. Exported models are included; Blender is only needed when rebuilding assets.

```bash
npm ci
npm run dev
```

```bash
npm run typecheck
node scripts/test-viewer-location.mjs
node scripts/test-animation-selection.mjs
npm run test:toon
npm run build
npm run preview
```

Builds write `dist/` with relative asset paths for subdirectory hosting. Keep the generated `.wasm` file: the WebGPU shader compiler loads it on demand. Runtime model metadata is trimmed during builds, and production source maps are disabled. Documentation screenshots live outside `public/`, so they do not increase the deployed gallery payload.

The viewer uses Hilo3D `2.0.0-alpha.7` with `shadowUpdateMode: 'full'`, so animated shadow slices refresh completely within the same frame instead of being deferred by the page-update budget.

Toon rendering caches mesh selection and writes pigment plus native surface attributes in one MRT draw. The pigment target uses sRGB 8-bit storage; the painted HDR scene and contour resolution remain unchanged. The adapter composes the public shader sources from the pinned Hilo3D version, so review it when upgrading. Explicit instancing and unsupported raster states retain the separate pigment/normal path. Touch-first devices use 1024px shadows; desktop devices use 2048px.

### Project structure

```text
src/app/          App lifecycle, selection and URL state
src/components/   Gallery, materials and accessible viewer controls
src/content/      Pokémon, habitats, material themes and model manifest
src/hilo/         Rendering, animation, water, particles and material adapters
public/           Shipped models, habitats, backdrops and environment lighting
scripts/          Blender exports, asset optimization and validation
docs/screenshots/ Browser captures used by these READMEs
```

### Rebuild and verify assets

Supply original Blender files locally in `source/Gen1/`; `source/` is intentionally ignored by Git. With **Blender 5.1**, run from the repository root:

```bash
blender --background --factory-startup --python scripts/export-gen1.py -- --ids 001 003 005
# Export the full collection, or resume an existing export:
blender --background --factory-startup --python scripts/export-gen1.py -- --all --skip-existing
```

Exports preserve skeletal animation and embedded textures, compact per-mesh skin palettes, and update `src/content/animatedModels.json`. Existing models can be compacted with `python3 scripts/gen1_skinning.py --all`. Habitat generation lives in `scripts/create-habitats.py`.

```bash
python3 scripts/test-gen1-skinning.py
npm run models:validate
# Requires Python 3 + Pillow; does not require Blender:
npm run assets:optimize -- --ids 003
# Omit --ids to process all delivery assets.
```

The optimizer converts eligible opaque color maps to JPEG only when they meet error limits and become smaller. It preserves resolution, uses 4:4:4 sampling, leaves other PNGs/icons untouched, and deduplicates identical embedded image payloads without changing materials or geometry. JPEG is lossy: check new assets visually on both backends and on target devices.

Originals are backed up under `source/asset-optimization/originals/`; the [per-file report](scripts/asset-optimization-report.json) records backup paths, sizes and output hashes. Keep a separate copy of these local backups. Matching output hashes are skipped on reruns to prevent repeated lossy compression. Legacy palette-quantized PNGs can be restored with `npm run assets:optimize -- --restore-quantized-pngs` when original backups are available.

### Deploy

Set the repository's GitHub Pages source to **GitHub Actions**. The included [workflow](.github/workflows/deploy-pages.yml) builds and publishes pushes to `master`. No application server is required.
