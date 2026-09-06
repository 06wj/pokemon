import * as Hilo3d from 'hilo3d';
import type { MaterialKey } from '../content/materials';
import type { EnvironmentLighting } from './environment';

/** PBR factors are linear; authored palette values are display sRGB. */
function color(hex: number): Hilo3d.Color {
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return new Hilo3d.Color(linear((hex >> 16 & 255) / 255), linear((hex >> 8 & 255) / 255), linear((hex & 255) / 255));
}

function copyColor(value: Hilo3d.Color | undefined): Hilo3d.Color | undefined {
  return value ? new Hilo3d.Color(value.r, value.g, value.b, value.a) : undefined;
}

function surfaceName(source: Hilo3d.MaterialInstance | null, meshName = ''): string {
  const texture = source?.getTextureSlot('baseColor')?.texture;
  // Material and mesh names identify both standalone eyes and expression surfaces.
  return `${source?.name ?? ''} ${texture?.name ?? ''} ${meshName}`.trim();
}

export function isFacialMaterial(source: Hilo3d.MaterialInstance | null, meshName = ''): boolean {
  return /eye|iris|mouth|pupil/i.test(surfaceName(source, meshName));
}

function inheritSurface(source: Hilo3d.MaterialInstance | null): Partial<Hilo3d.PBRMaterialParameters> {
  if (!source) return {};
  const raster = Hilo3d.resolveMaterialPassState(source, 'forward');
  return {
    state: raster ?? undefined,
    cullMode: raster?.cullMode,
    frontFace: raster?.frontFace,
    coverage: source.coverage,
    compositing: source.compositing,
    opacity: source.opacity,
    temporalReactiveFactor: source.temporalReactiveFactor,
    baseColorMap: source.getTextureSlot('baseColor'),
    normalMap: source.getTextureSlot('normal'),
    parallaxMap: source.getTextureSlot('parallax'),
    normalScale: source.normalScale,
    opacityMap: source.getTextureSlot('opacity'),
  };
}

const facialMasks = new WeakMap<Hilo3d.MaterialTexture, Hilo3d.Texture | null>();
const bubbleFilms = new WeakMap<Hilo3d.MaterialTexture, Hilo3d.Texture>();
const bubbleEyeTransmissions = new WeakMap<Hilo3d.MaterialTexture, Hilo3d.Texture>();
/** Broad optical thickness bands avoid the crumpled-film look of tightly spaced rainbow stripes. */
function bubbleFilm(source: Hilo3d.MaterialInstance | null): Hilo3d.Texture | null {
  const owner = source?.getTextureSlot('baseColor')?.texture ?? source?.getTextureSlot('normal')?.texture;
  if (!owner) return null;
  const existing = bubbleFilms.get(owner);
  if (existing) return existing;
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * Math.PI * 2;
      const v = y / size * Math.PI * 2;
      const value = Math.round(128 + 70 * Math.sin(u + 0.35 * Math.sin(v))
        + 35 * Math.cos(v - u));
      const offset = (y * size + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  const texture = new Hilo3d.Texture({
    name: 'soap bubble / broad optical thickness bands', width: size, height: size,
    image: pixels, flipY: false, minFilter: Hilo3d.constants.LINEAR,
    wrapS: Hilo3d.constants.REPEAT, wrapT: Hilo3d.constants.REPEAT,
  });
  bubbleFilms.set(owner, texture);
  owner.on('destroy', () => texture.destroy());
  return texture;
}

/** Expression atlases include opaque skin surrounds and red unused cells. Only those atlases
 * need a pigment mask; standalone eye maps must retain their authored iris/sclera colors.
 */
function facialMask(source: Hilo3d.MaterialInstance | null): Hilo3d.Texture | null {
  const texture = source?.getTextureSlot('baseColor')?.texture;
  if (!texture) return null;
  if (facialMasks.has(texture)) return facialMasks.get(texture) ?? null;
  const image = texture.image;
  if (!image || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = texture.width;
  canvas.height = texture.height;
  if (!canvas.width || !canvas.height) return null;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    if (image instanceof ImageData) context.putImageData(image, 0, 0);
    else if (!ArrayBuffer.isView(image)) context.drawImage(image as CanvasImageSource, 0, 0);
    else return null;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let unusedRedPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! > 245 && pixels[i + 1]! < 12 && pixels[i + 2]! < 12 && pixels[i + 3]! >= 128) unusedRedPixels++;
    }
    if (unusedRedPixels < canvas.width * canvas.height * 0.01) {
      facialMasks.set(texture, null);
      return null;
    }
    const histogram = new Map<number, { count: number; r: number; g: number; b: number }>();
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
      // Pure red and black are unused cells/corners of the shipped expression atlases.
      if (pixels[i + 3]! < 128 || Math.max(r, g, b) < 12 || (r > 245 && g < 12 && b < 12)) continue;
      const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
      const entry = histogram.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      entry.count++; entry.r += r; entry.g += g; entry.b += b;
      histogram.set(key, entry);
    }
    const dominant = [...histogram.values()].sort((a, b) => b.count - a.count)[0];
    if (!dominant || dominant.count < canvas.width * canvas.height * 0.18) {
      facialMasks.set(texture, null); return null;
    }
    const skin = [dominant.r / dominant.count, dominant.g / dominant.count, dominant.b / dominant.count];
    // Do not key neutral eye whites or near-black pupils on an ambiguous atlas.
    if (Math.min(...skin) > 215 || Math.max(...skin) < 48) {
      facialMasks.set(texture, null); return null;
    }
    const data = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      const distance = Math.hypot(pixels[i]! - skin[0]!, pixels[i + 1]! - skin[1]!, pixels[i + 2]! - skin[2]!);
      const coverage = Math.max(0, Math.min(1, (distance - 20) / 20));
      const alpha = Math.round(pixels[i + 3]! * coverage);
      data[i] = pixels[i]!;
      data[i + 1] = pixels[i + 1]!;
      data[i + 2] = pixels[i + 2]!;
      data[i + 3] = alpha;
    }
    context.putImageData(new ImageData(new Uint8ClampedArray(data.buffer), canvas.width, canvas.height), 0, 0);
    // Use the same browser-image upload path as the original atlas. Pigment and coverage
    // now share one texel lookup; separate opacity-slot coordinates cannot diverge.
    const mask = new Hilo3d.Texture({
      name: `facial pigment and coverage / ${texture.name}`, image: canvas,
      width: canvas.width, height: canvas.height,
      minFilter: texture.minFilter, magFilter: texture.magFilter,
      wrapS: texture.wrapS, wrapT: texture.wrapT,
      flipY: texture.flipY, uv: texture.uv, premultiplyAlpha: false,
    });
    facialMasks.set(texture, mask);
    texture.on('destroy', () => mask.destroy());
    return mask;
  } catch {
    facialMasks.set(texture, null);
    return null;
  }
}

export function needsFacialBacking(source: Hilo3d.MaterialInstance | null, meshName = ''): boolean {
  return isFacialMaterial(source, meshName) && facialMask(source) !== null;
}

/** The eye stays a colored drawing on the film: whites transmit much more than dark/color pigment. */
function bubbleEyeTransmission(source: Hilo3d.MaterialInstance | null): Hilo3d.MaterialTextureSlotInput | null {
  const slot = source?.getTextureSlot('baseColor');
  if (!slot || typeof document === 'undefined') return null;
  const owner = slot.texture;
  let texture = bubbleEyeTransmissions.get(owner);
  if (!texture) {
    const canvas = document.createElement('canvas');
    canvas.width = owner.width; canvas.height = owner.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !canvas.width || !canvas.height || !owner.image || ArrayBuffer.isView(owner.image)) return null;
    try {
      if (owner.image instanceof ImageData) context.putImageData(owner.image, 0, 0);
      else context.drawImage(owner.image as CanvasImageSource, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        // The minimum channel separates neutral sclera/highlights from saturated irises.
        const neutral = Math.min(pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!) / 255;
        const white = Math.max(0, Math.min(1, (neutral - 0.45) / 0.5));
        const smoothWhite = white * white * (3 - 2 * white);
        const transmission = Math.round(255 * (0.2 + 0.5 * smoothWhite));
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = transmission;
        pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      texture = new Hilo3d.Texture({
        name: `bubble eye / pigment transmission / ${owner.name}`, image: canvas,
        width: owner.width, height: owner.height,
        minFilter: owner.minFilter, magFilter: owner.magFilter,
        wrapS: owner.wrapS, wrapT: owner.wrapT, flipY: owner.flipY, uv: owner.uv,
        premultiplyAlpha: false,
      });
      bubbleEyeTransmissions.set(owner, texture);
      const ownedTexture = texture;
      owner.on('destroy', () => ownedTexture.destroy());
    } catch { return null; }
  }
  return { ...slot, texture, encoding: 'data', channels: ['r', 'r', 'r', 'r'] };
}

/** Shared by the body and painted eyes so their film highlights have the same optical response. */
function bubbleSurface(source: Hilo3d.MaterialInstance | null): Hilo3d.PBRMaterialParameters {
  return {
    baseColor: color(0xffffff), metallic: 0, roughness: 0.09,
    normalMap: null, parallaxMap: null,
    transmissionFactor: 0.96, thicknessFactor: 0.025,
    attenuationColor: color(0xffffff), attenuationDistance: Infinity, ior: 1.33,
    specularEnvIntensity: 0.85,
    clearcoatFactor: 0,
    iridescenceFactor: 1, iridescenceIor: 1.55,
    iridescenceThicknessMap: bubbleFilm(source),
    iridescenceThicknessMinimum: 200, iridescenceThicknessMaximum: 580,
    temporalReactiveFactor: 1,
  };
}

function createFaceMaterial(
  source: Hilo3d.MaterialInstance | null,
  environment: EnvironmentLighting | undefined,
  meshName: string,
  bubbleEye = false,
): Hilo3d.PBRMaterial {
  const mask = facialMask(source);
  const baseSlot = source?.getTextureSlot('baseColor');
  const eyeTransmission = bubbleEye ? bubbleEyeTransmission(source) : null;
  return new Hilo3d.PBRMaterial({
    ...inheritSurface(source),
    ...environment?.material,
    name: `facial pigment / ${surfaceName(source, meshName)}`,
    specularEnvIntensity: 0,
    baseColor: color(0xffffff), metallic: 0, roughness: 0.72, ior: 1.38,
    ...(mask && baseSlot ? {
      coverage: { mode: 'mask', cutoff: 0.42 }, compositing: { mode: 'opaque' }, opacity: 1,
      baseColorMap: { ...baseSlot, texture: mask },
      opacityMap: null,
    } as Hilo3d.PBRMaterialParameters : {}),
    ...(bubbleEye ? {
      ...bubbleSurface(source),
      transmissionMap: eyeTransmission,
      transmissionFactor: eyeTransmission ? 1 : 0.35,
    } : {}),
  });
}

/** Preserve authored PBR surfaces while adding the habitat's shared environment lighting. */
export function createOriginalMaterial(
  source: Hilo3d.MaterialInstance | null,
  environment?: EnvironmentLighting,
  meshName = '',
  overrides: Hilo3d.PBRMaterialParameters = {},
): Hilo3d.PBRMaterial {
  const original = source instanceof Hilo3d.PBRMaterial ? source : null;
  const parameters: Hilo3d.PBRMaterialParameters = {
    ...inheritSurface(source),
    name: surfaceName(source, meshName),
    unlit: source?.lightType === 'NONE',
    baseColor: copyColor(original?.baseColor),
    metallic: original?.metallic,
    roughness: original?.roughness,
    metallicMap: source?.getTextureSlot('metallic'),
    roughnessMap: source?.getTextureSlot('roughness'),
    metallicRoughnessMap: source?.getTextureSlot('metallicRoughness'),
    occlusionMap: source?.getTextureSlot('occlusion'),
    occlusionStrength: original?.occlusionStrength,
    isOcclusionInMetallicRoughnessMap: original?.isOcclusionInMetallicRoughnessMap,
    emission: source?.getTextureSlot('emission') ?? original?.emission,
    emissionFactor: copyColor(original?.emissionFactor),
    isSpecularGlossiness: original?.isSpecularGlossiness,
    specular: copyColor(original?.specular),
    glossiness: original?.glossiness,
    specularGlossinessMap: source?.getTextureSlot('specularGlossiness'),
    lightMap: source?.getTextureSlot('light'),
    clearcoatFactor: original?.clearcoatFactor,
    clearcoatMap: source?.getTextureSlot('clearcoat'),
    clearcoatRoughnessFactor: original?.clearcoatRoughnessFactor,
    clearcoatRoughnessMap: source?.getTextureSlot('clearcoatRoughness'),
    clearcoatNormalMap: source?.getTextureSlot('clearcoatNormal'),
    clearcoatNormalScale: original?.clearcoatNormalScale,
    anisotropyStrength: original?.anisotropyStrength,
    anisotropyRotation: original?.anisotropyRotation,
    anisotropyMap: source?.getTextureSlot('anisotropy'),
    transmissionFactor: original?.transmissionFactor,
    transmissionMap: source?.getTextureSlot('transmission'),
    thicknessFactor: original?.thicknessFactor,
    thicknessMap: source?.getTextureSlot('thickness'),
    attenuationDistance: original?.attenuationDistance,
    attenuationColor: copyColor(original?.attenuationColor),
    ior: original?.ior,
    iridescenceFactor: original?.iridescenceFactor,
    iridescenceMap: source?.getTextureSlot('iridescence'),
    iridescenceIor: original?.iridescenceIor,
    iridescenceThicknessMinimum: original?.iridescenceThicknessMinimum,
    iridescenceThicknessMaximum: original?.iridescenceThicknessMaximum,
    iridescenceThicknessMap: source?.getTextureSlot('iridescenceThickness'),
    diffuseEnvMap: source?.getTextureSlot('diffuseEnvironment') ?? environment?.material.diffuseEnvMap,
    diffuseEnvSphereHarmonics3: original?.diffuseEnvSphereHarmonics3,
    diffuseEnvIntensity: original?.diffuseEnvMap || original?.diffuseEnvSphereHarmonics3
      ? original.diffuseEnvIntensity : environment?.material.diffuseEnvIntensity ?? original?.diffuseEnvIntensity,
    specularEnvMap: source?.getTextureSlot('specularEnvironment') ?? environment?.material.specularEnvMap,
    specularEnvIntensity: original?.specularEnvMap
      ? original.specularEnvIntensity : environment?.material.specularEnvIntensity ?? original?.specularEnvIntensity,
    brdfLUT: (original?.brdfLUT as Hilo3d.Texture | null | undefined) ?? environment?.material.brdfLUT,
    isSpecularEnvMapIncludeMipmaps: original?.specularEnvMap
      ? original.isSpecularEnvMapIncludeMipmaps : environment?.material.isSpecularEnvMapIncludeMipmaps,
  };
  return new Hilo3d.PBRMaterial({ ...parameters, ...overrides });
}

export function createMaterial(
  key: Exclude<MaterialKey, 'original' | 'toon' | 'glass'>,
  source: Hilo3d.MaterialInstance | null,
  environment?: EnvironmentLighting,
  meshName = '',
): Hilo3d.PBRMaterial {
  // Keep the legacy key so existing links select the new glazed finish.
  if (key === 'silver') {
    if (/fire|flame/i.test(surfaceName(source, meshName))) return createOriginalMaterial(source, environment, meshName);
    return createOriginalMaterial(source, environment, meshName, {
      name: `crystal glaze / ${surfaceName(source, meshName)}`,
      unlit: false,
      clearcoatFactor: 1, clearcoatRoughnessFactor: 0.035,
      clearcoatMap: null, clearcoatRoughnessMap: null, clearcoatNormalMap: null,
    });
  }
  // Replacement finishes isolate eye/mouth pigment from the body color.
  if (isFacialMaterial(source, meshName)) {
    return createFaceMaterial(source, environment, meshName,
      key === 'iridescent' && /eye|iris|pupil/i.test(surfaceName(source, meshName)));
  }
  // Animated flame geometry belongs to the authored creature and keeps its luminous pigment.
  if (/fire|flame/i.test(surfaceName(source, meshName))) return createOriginalMaterial(source, environment, meshName);
  const common: Hilo3d.PBRMaterialParameters = {
    ...environment?.material,
    name: `${key} / ${source?.name ?? meshName}`,
    coverage: source?.coverage.mode === 'mask' ? source.coverage : { mode: 'opaque' },
    // Preserve silhouette cutouts without reintroducing the cartoon RGB pigment.
    opacityMap: source?.coverage.mode === 'mask' && source.getTextureSlot('baseColor')
      ? { ...source.getTextureSlot('baseColor')!, encoding: 'data', channels: ['a', 'a', 'a', 'a'] }
      : null,
    compositing: { mode: 'opaque' },
    opacity: 1,
    cullMode: source ? Hilo3d.resolveMaterialPassState(source, 'forward')?.cullMode : 'back',
    normalMap: source?.getTextureSlot('normal'),
    normalScale: source?.normalScale,
    metallic: 0,
  };
  switch (key) {
    case 'gold':
      return new Hilo3d.PBRMaterial({
        ...common,
        baseColor: color(0xedb637), metallic: 1, roughness: 0.3,
        anisotropyStrength: 0.38, anisotropyRotation: 0.45,
        specularEnvIntensity: 0.16,
      });
    case 'iridescent':
      return new Hilo3d.PBRMaterial({
        ...common,
        // An almost weightless shell: little refraction, no metal or skin microrelief.
        // Low surface IOR keeps the center clear; interference brightens grazing angles.
        ...bubbleSurface(source),
      });
  }
}
