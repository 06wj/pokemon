import * as Hilo3d from 'hilo3d';

export type EnvironmentKind = 'forest' | 'studio';
export type EnvironmentMaterial = Pick<Hilo3d.PBRMaterialParameters,
  'diffuseEnvMap' | 'specularEnvMap' | 'brdfLUT' | 'isSpecularEnvMapIncludeMipmaps' |
  'diffuseEnvIntensity' | 'specularEnvIntensity'>;

/** Shared IBL resources. Spread material into a new PBRMaterial; its topology is immutable. */
export interface EnvironmentLighting {
  readonly kind: EnvironmentKind;
  readonly material: Readonly<EnvironmentMaterial>;
  /** Destroy once after all materials that share this environment have been removed. */
  dispose(): void;
}

interface BakedTexture {
  side: number;
  faces: number;
  levels: number;
  mipmaps: Hilo3d.TextureMipmap[];
}

async function readBake(url: string): Promise<BakedTexture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Environment ${response.status}: ${url}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 16) throw new Error(`Incomplete IBL header: ${url}`);
  const header = new DataView(buffer, 0, 16);
  const side = header.getUint32(4, true);
  const levels = header.getUint32(8, true);
  const faces = header.getUint32(12, true);
  if (header.getUint32(0, true) !== 0x314c4249 || side < 1 || side > 512 ||
      (side & (side - 1)) !== 0 || levels < 1 || levels > Math.log2(side) + 1 ||
      (faces !== 1 && faces !== 6)) throw new Error(`Invalid IBL texture: ${url}`);
  let offset = 16;
  const mipmaps: Hilo3d.TextureMipmap[] = [];
  for (let level = 0; level < levels; level++) {
    const size = Math.max(1, side >> level);
    const components = size * size * 4;
    for (let face = 0; face < faces; face++) {
      if (offset + components * 2 > buffer.byteLength) throw new Error(`Truncated IBL texture: ${url}`);
      mipmaps.push({
        width: size, height: size,
        data: new Uint16Array(buffer, offset, components),
        ...(faces === 6 ? { face: face as Hilo3d.TextureCubeFace } : {}),
      });
      offset += components * 2;
    }
  }
  if (offset !== buffer.byteLength) throw new Error(`Unexpected IBL byte length: ${url}`);
  return { side, faces, levels, mipmaps };
}

function textureFromBake(bake: BakedTexture, name: string): Hilo3d.MaterialTexture {
  const parameters = {
    name,
    width: bake.side,
    height: bake.side,
    format: Hilo3d.constants.RGBA,
    internalFormat: Hilo3d.constants.RGBA16F,
    type: Hilo3d.constants.HALF_FLOAT,
    minFilter: bake.levels > 1 ? Hilo3d.constants.LINEAR_MIPMAP_LINEAR : Hilo3d.constants.LINEAR,
    magFilter: Hilo3d.constants.LINEAR,
    wrapS: Hilo3d.constants.CLAMP_TO_EDGE,
    wrapT: Hilo3d.constants.CLAMP_TO_EDGE,
    isImageCanRelease: false,
    mipmaps: bake.mipmaps,
  };
  return bake.faces === 6 ? new Hilo3d.CubeTexture(parameters) : new Hilo3d.Texture(parameters);
}

/**
 * Load preconvolved, linear HDR lighting derived from the locally bundled CC0 photographs.
 * Offline GGX mip levels avoid an expensive render-time bake and work on WebGL2 and WebGPU.
 * Renderer ownership is explicit: keep this handle alongside the Stage, then dispose it once.
 */
export async function loadEnvironment(
  renderer: Hilo3d.Renderer,
  assetBase: string,
  kind: EnvironmentKind,
): Promise<EnvironmentLighting> {
  await renderer.ready;
  const base = `${assetBase.replace(/\/$/, '')}/environments`;
  const [diffuse, specular, brdf] = await Promise.all([
    readBake(`${base}/${kind}-diffuse.bin`),
    readBake(`${base}/${kind}-specular.bin`),
    readBake(`${base}/brdf-lut.bin`),
  ]);
  const diffuseEnvMap = textureFromBake(diffuse, `${kind} / cosine irradiance`);
  const specularEnvMap = textureFromBake(specular, `${kind} / GGX radiance`);
  const brdfLUT = textureFromBake(brdf, 'GGX split-sum BRDF') as Hilo3d.Texture;
  let disposed = false;
  return {
    kind,
    material: {
      diffuseEnvMap, specularEnvMap, brdfLUT,
      diffuseEnvIntensity: 0.7,
      specularEnvIntensity: 0.65,
      // This engine flag selects a packed 2D atlas; actual cube mip chains use textureLod.
      isSpecularEnvMapIncludeMipmaps: false,
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      diffuseEnvMap.destroy();
      specularEnvMap.destroy();
      brdfLUT.destroy();
    },
  };
}
