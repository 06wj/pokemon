import * as Hilo3d from 'hilo3d';

const compatibleVersion = '2.0.0-alpha.7';
const shaderRevision = 'toon-pigment-and-attributes-1';
const definitions = new WeakMap<Hilo3d.MaterialDefinition, Hilo3d.MaterialDefinition>();
let shaderSources: { vertexSource: string; fragmentSource: string } | undefined;

function replaceOnce(source: string, marker: string, replacement: string): string {
  const index = source.indexOf(marker);
  if (index < 0 || source.indexOf(marker, index + marker.length) >= 0) {
    throw new Error('Toon MRT: the published Hilo3D shader structure has changed; review the adapter before upgrading.');
  }
  return source.slice(0, index) + replacement + source.slice(index + marker.length);
}

function getShaderSources(): NonNullable<typeof shaderSources> {
  if (shaderSources) return shaderSources;
  if (Hilo3d.version !== compatibleVersion) {
    throw new Error(`Toon MRT requires hilo3d ${compatibleVersion}; found ${Hilo3d.version}.`);
  }
  // Shader.shaders is the public source-composition API. Reuse the engine's entire
  // vertex and surface evaluators so skin/morph, UV decoding, alpha and normal maps
  // continue to follow the same implementation as the original PBR material.
  const vertex = Hilo3d.Shader.shaders['basic.vert'];
  const fragment = Hilo3d.Shader.shaders['pbr.frag'];
  const fog = Hilo3d.Shader.shaders['chunk/fog_main.frag'];
  if (!vertex || !fragment || !fog) throw new Error('Toon MRT: required public Hilo3D shader sources are unavailable.');
  const outputDeclaration = 'layout(location = 0) out highp vec4 hilo_FragColor;';
  const attributesOutput = `            hilo_FragColor = hiloMaterialAttributes(
                reflectionTraceNormal,
                reflectionTraceRoughness,
                materialMetallic,
                1.0
            );`;
  const extended = replaceOnce(fragment, outputDeclaration, `${outputDeclaration}
layout(location = 1) out highp vec4 toon_SurfaceData;`);
  const fragmentSource = replaceOnce(extended, attributesOutput, `
            // Pigment previously travelled through emission, independent of vertex
            // RGB; vertex alpha and the complete native alpha test above still apply.
            color.rgb = hiloEvaluatePBREmission(u_baseColor.rgb, baseColorSample.rgb);
            #ifdef HILO_IGNORE_TRANSPARENT
                color.a = 1.0;
            #endif
            ${fog}
            hilo_FragColor = color;
${attributesOutput.replace('hilo_FragColor', 'toon_SurfaceData')}`);
  shaderSources = {
    vertexSource: `#define HILO_MATERIAL_ATTRIBUTES_PASS 1\n${vertex}`,
    fragmentSource: `#define HILO_MATERIAL_ATTRIBUTES_PASS 1\n${fragmentSource}`,
  };
  return shaderSources;
}

/** Returns a reason to retain the existing two-pass path, or null when MRT is supported. */
export function getToonGeometryUnsupportedReason(mesh: Hilo3d.Mesh): string | null {
  if (!(mesh.material instanceof Hilo3d.PBRMaterial)) return 'The surface is not a native PBR material.';
  if (mesh.useInstanced || mesh.instanceCount > 1) {
    // alpha.7 does not inject its built-in HILO_INSTANCED variant into custom GLSL.
    return 'The published custom-shader API does not preserve the instanced vertex variant.';
  }
  return getMaterialUnsupportedReason(mesh.material);
}

function getMaterialUnsupportedReason(source: Hilo3d.PBRMaterial): string | null {
  if (source.forwardQueue !== 'opaque' || source.compositing.mode !== 'opaque') {
    return 'Blended and transmission surfaces retain their original optical rendering.';
  }
  if (source.coverage.mode === 'alpha-to-coverage') return 'Alpha-to-coverage requires an MSAA attachment.';
  const pass = source.definition.getPass('forward');
  if (pass?.shader.kind !== 'builtin' || pass.shader.family !== 'pbr') {
    return 'The surface does not use the native PBR shader.';
  }
  const state = Hilo3d.resolveMaterialPassState(source, 'forward');
  if (!state?.depthTest || !state.depthWrite || (state.depthCompare !== 'less' && state.depthCompare !== 'less-equal')) {
    return 'The auxiliary MRT pass requires ordinary depth testing and writing.';
  }
  if (state.blend || state.alphaToCoverage) return 'The auxiliary MRT pass requires unblended color outputs.';
  return null;
}

function getDefinition(source: Hilo3d.PBRMaterial): Hilo3d.MaterialDefinition {
  const cached = definitions.get(source.definition);
  if (cached) return cached;
  const state = Hilo3d.resolveMaterialPassState(source, 'forward');
  if (!state) throw new Error('Toon MRT: the original material has no forward pass.');
  const original = source.definition;
  const definition = new Hilo3d.MaterialDefinition({
    id: `toon-mrt:${original.id}`,
    family: original.family,
    domain: original.domain,
    shaderRevision,
    staticFeatures: original.staticFeatures,
    coverage: original.coverage,
    compositing: original.compositing,
    instanceOverrides: original.instanceOverrides,
    textureSlots: original.textureSlots,
    profiles: original.profiles,
    // A custom forward pass permits two color attachments and includes fog. The
    // native material-attributes role only permits its own fixed attachment layouts.
    // Both outputs share one depth write, eliminating cross-variant equal tests.
    passes: [{
      role: 'forward', fragmentOutput: 'color', fallback: 'required', state,
      shader: { kind: 'glsl', ...getShaderSources(), sourceRevision: shaderRevision },
    }],
  });
  definitions.set(original, definition);
  return definition;
}

/**
 * Auxiliary pigment (location 0, linear RGB) and native encoded surface attributes
 * (location 1, rgba8unorm). The complete original forward render remains unchanged.
 *
 * Unlike the old black-conductor pigment pass, this deliberately has no residual
 * grazing-angle specular contribution: pigment is the authored base color plus fog.
 * Normal, roughness and packed metallic/reflection-receiver data use the unmodified
 * native attribute evaluator. No shadow lighting is added to pigment.
 *
 * Share by original material identity, call sync() before recording, and never call
 * destroyTextures(): the texture and uniform-buffer resources belong to source.
 */
export class ToonGeometryMaterial extends Hilo3d.MaterialInstance {
  // alpha.7's draw validation uses this public custom-GLSL marker for arbitrary MRT layouts.
  readonly isShaderMaterial = true;
  private sourceRevision = -1;

  constructor(readonly source: Hilo3d.PBRMaterial, name?: string) {
    const unsupported = getMaterialUnsupportedReason(source);
    if (unsupported) throw new Error(`Toon MRT: ${unsupported}`);
    super(getDefinition(source), {
      name: name ?? `anime geometry / ${source.name ?? source.id}`,
      coverage: source.coverage, compositing: source.compositing,
    });
    // Preserve dependency flags as well as values: some renderer bindings invoke
    // MaterialBindingInfo.get directly instead of calling getUniformData.
    for (const key of Object.keys(source.uniforms)) {
      this.uniforms[key] = {
        ...source.getUniformInfo(key),
        get: (mesh, _material, info) => source.getUniformData(key, mesh, info),
      };
    }
    for (const key of Object.keys(source.attributes)) {
      this.attributes[key] = {
        ...source.getAttributeInfo(key),
        get: (mesh, _material, info) => source.getAttributeData(key, mesh, info),
      };
    }
    this.sync();
  }

  // Standard semantic UBO packing reads these three properties directly.
  override get opacity(): number { return this.source.opacity; }
  get specular(): Hilo3d.Color { return this.source.specular; }
  get emission(): Hilo3d.MaterialTextureValue { return this.source.emission; }

  /** Source scalar setters invalidate automatically; referenced color/UV edits require source.invalidateData(). */
  sync(): void {
    if (this.sourceRevision === this.source.revision) return;
    for (const slot of this.source.definition.textureSlots) {
      this.setTextureSlot(slot.name, this.source.getTextureSlot(slot.name));
    }
    for (const name of Object.keys(this.uniformBlocks)) {
      if (!Object.hasOwn(this.source.uniformBlocks, name)) delete this.uniformBlocks[name];
    }
    Object.assign(this.uniformBlocks, this.source.uniformBlocks);
    this.invalidateData();
    this.sourceRevision = this.source.revision;
  }
}

export function createToonGeometryMaterial(source: Hilo3d.PBRMaterial, name?: string): ToonGeometryMaterial {
  return new ToonGeometryMaterial(source, name);
}
