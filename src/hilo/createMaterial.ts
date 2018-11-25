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
const foamFilms = new WeakMap<Hilo3d.MaterialTexture, Hilo3d.Texture>();

/** A gently varying film thickness gives soap surfaces several interference colors at once. */
function foamFilm(source: Hilo3d.MaterialInstance | null): Hilo3d.Texture | null {
  const owner = source?.getTextureSlot('baseColor')?.texture ?? source?.getTextureSlot('normal')?.texture;
  if (!owner) return null;
  const existing = foamFilms.get(owner);
  if (existing) return existing;
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * Math.PI * 2;
      const v = y / size * Math.PI * 2;
      const value = Math.round(128 + 65 * Math.sin(u + 0.8 * Math.sin(v))
        + 37 * Math.cos(v * 2 - u) + 16 * Math.sin(u * 3 + v * 2));
      const offset = (y * size + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  const texture = new Hilo3d.Texture({
    name: 'soap film / varying optical thickness', width: size, height: size,
    image: pixels, flipY: false, minFilter: Hilo3d.constants.LINEAR,
    wrapS: Hilo3d.constants.REPEAT, wrapT: Hilo3d.constants.REPEAT,
  });
  foamFilms.set(owner, texture);
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

function createFaceMaterial(
  source: Hilo3d.MaterialInstance | null,
  environment: EnvironmentLighting | undefined,
  meshName: string,
): Hilo3d.PBRMaterial {
  const mask = facialMask(source);
  const baseSlot = source?.getTextureSlot('baseColor');
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
  });
}

/** Preserve authored PBR surfaces while adding the habitat's shared environment lighting. */
export function createOriginalMaterial(
  source: Hilo3d.MaterialInstance | null,
  environment?: EnvironmentLighting,
  meshName = '',
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
  return new Hilo3d.PBRMaterial(parameters);
}

export function createMaterial(
  key: Exclude<MaterialKey, 'original' | 'toon'>,
  source: Hilo3d.MaterialInstance | null,
  environment?: EnvironmentLighting,
  meshName = '',
): Hilo3d.PBRMaterial {
  // Eyes and mouths stay readable, with the original alpha masks and texture transforms.
  // Removing cartoon body maps makes every finish read as a material instead of a tint filter.
  if (isFacialMaterial(source, meshName)) return createFaceMaterial(source, environment, meshName);
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
    case 'glass':
      return new Hilo3d.PBRMaterial({
        ...common,
        baseColor: color(0xf4fcff), roughness: 0.07,
        transmissionFactor: 0.97, thicknessFactor: 0.85,
        attenuationColor: color(0xd5edf2), attenuationDistance: 3.5, ior: 1.52,
        clearcoatFactor: 0.1, clearcoatRoughnessFactor: 0.06,
        temporalReactiveFactor: 1,
      });
    case 'gold':
      return new Hilo3d.PBRMaterial({
        ...common,
        baseColor: color(0xedb637), metallic: 1, roughness: 0.3,
        anisotropyStrength: 0.38, anisotropyRotation: 0.45,
        specularEnvIntensity: 0.16,
      });
    case 'silver':
      return new Hilo3d.PBRMaterial({
        ...common,
        baseColor: color(0xc9dcf3), metallic: 1, roughness: 0.36,
        anisotropyStrength: 0.22, anisotropyRotation: -0.3,
        specularEnvIntensity: 0.2,
      });
    case 'iridescent':
      return new Hilo3d.PBRMaterial({
        ...common,
        baseColor: color(0xf1faff), metallic: 0, roughness: 0.18,
        transmissionFactor: 0.9, thicknessFactor: 0.12,
        attenuationColor: color(0xeef8ff), attenuationDistance: 3, ior: 1.33,
        anisotropyStrength: 0.78, anisotropyRotation: 0.8,
        clearcoatFactor: 0,
        iridescenceFactor: 1, iridescenceIor: 1.5,
        iridescenceThicknessMap: foamFilm(source),
        iridescenceThicknessMinimum: 120, iridescenceThicknessMaximum: 720,
        temporalReactiveFactor: 1,
      });
  }
}
