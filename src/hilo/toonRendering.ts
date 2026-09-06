import * as Hilo3d from 'hilo3d';
import { ToonMeshSelection } from './toonMeshSelection';
import { createToonGeometryMaterial, getToonGeometryUnsupportedReason, type ToonGeometryMaterial } from './toonGeometry';

/** Alternate pass materials measure pigment using the original geometry and animation. */
export class ToonModel {
  readonly surfaces: {
    meshes: Set<Hilo3d.Mesh>; material: Hilo3d.PBRMaterial;
    geometryMaterial: ToonGeometryMaterial | null; excluded: Hilo3d.Mesh[];
  }[] = [];
  readonly meshes = new Set<Hilo3d.Mesh>();

  constructor(meshes: readonly Hilo3d.Mesh[]) {
    const groups = new Map<Hilo3d.PBRMaterial, (typeof this.surfaces)[number]>();
    for (const source of meshes) {
      const material = source.material;
      // Transparent lenses, ghost vapor and fire retain their authored optical effects.
      if (!(material instanceof Hilo3d.PBRMaterial) || material.forwardQueue !== 'opaque' || material.opacity < 0.95
        || /fire|flame/i.test(`${source.name} ${material.name}`)) continue;
      const base = material.getTextureSlot('baseColor');
      const opacityMap = material.getTextureSlot('opacity');
      const state = Hilo3d.resolveMaterialPassState(material, 'forward') ?? undefined;
      // MRT also writes normal maps, roughness and metallic. Equal pigment alone
      // no longer makes two different source materials interchangeable.
      const existing = groups.get(material);
      this.meshes.add(source);
      if (existing) { existing.meshes.add(source); continue; }
      const pigment = new Hilo3d.PBRMaterial({
        name: `anime pigment / ${source.name}`,
        // Keep the lit PBR vertex variant used by material-attributes: that pass
        // compares depth with 'equal'. Unlit can round clip positions differently,
        // leaving normal-buffer holes that become broken ink at oblique views.
        // Emission carries pigment; the black conductor removes diffuse lighting.
        baseColor: new Hilo3d.Color(0, 0, 0, material.baseColor.a), baseColorMap: base,
        metallic: 1, roughness: 1, diffuseEnvIntensity: 0, specularEnvIntensity: 0,
        emission: base ?? new Hilo3d.Color(material.baseColor.r, material.baseColor.g, material.baseColor.b),
        emissionFactor: material.baseColor,
        opacity: material.opacity, opacityMap,
        coverage: material.coverage, compositing: material.compositing,
        state,
      });
      const group = { meshes: new Set([source]), material: pigment,
        geometryMaterial: getToonGeometryUnsupportedReason(source) ? null
          : createToonGeometryMaterial(material, `anime geometry / ${source.name}`), excluded: [] };
      this.surfaces.push(group);
      groups.set(material, group);
    }
  }

  dispose(): void {
    for (const group of this.surfaces) { group.meshes.clear(); group.excluded.length = 0; }
    this.surfaces.length = 0;
    this.meshes.clear();
  }
}

const vertex = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 positions[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
  vUv = positions[gl_VertexID] * 0.5 + 0.5;
#ifdef HILO_WEBGPU
  vUv.y = 1.0 - vUv.y;
#endif
}`;

Hilo3d.registerUniformBlockBinding('AnimeInkBlock');
const layout = Hilo3d.createStd140Layout({ sizeInk: 'vec4', lightNear: 'vec4', farDepth: 'vec4' });

const fragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform sampler2D sceneColor;
uniform sampler2D pigmentColor;
uniform sampler2D surfaceData;
uniform sampler2D sceneDepth;
layout(std140) uniform AnimeInkBlock { vec4 sizeInk; vec4 lightNear; vec4 farDepth; };
layout(location = 0) out vec4 outputColor;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
ivec2 pixel(ivec2 p) { return clamp(p, ivec2(0), ivec2(sizeInk.xy) - 1); }
vec4 pigment(ivec2 p) { return texelFetch(pigmentColor, pixel(p), 0); }
vec4 surface(ivec2 p) { return texelFetch(surfaceData, pixel(p), 0); }
vec3 decodeNormal(vec4 data) {
  // Hilo3D alpha.7 stores octahedral normals in unsigned normalized RG channels.
  vec2 xy = data.xy * 2.0 - 1.0;
  vec3 n = vec3(xy, 1.0 - abs(xy.x) - abs(xy.y));
  float fold = clamp(-n.z, 0.0, 1.0);
  n.xy += mix(vec2(fold), vec2(-fold), step(vec2(0.0), n.xy));
  return normalize(n);
}
float depthAt(ivec2 p) {
  float z = texelFetch(sceneDepth, pixel(p), 0).r;
  z = mix(z, 1.0 - z, farDepth.y);
  return lightNear.w * farDepth.x / max(farDepth.x - z * (farDepth.x - lightNear.w), 0.00001);
}
void main() {
  // The vertex stage supplies backend-native render-target coordinates.
  ivec2 p = ivec2(vUv * vec2(textureSize(sceneColor, 0)));
  vec4 original = texelFetch(sceneColor, p, 0);
  vec4 base = pigment(p);
  float mask = step(0.5, base.a);
  float nearby = 0.0;
  float inner = 0.0;
  float z = depthAt(p);
  vec4 centerSurface = surface(p);
  vec3 normal = decodeNormal(centerSurface);
  // Compute derivatives before any mask-dependent control flow on both backends.
  float diffuse = dot(normal, normalize(lightNear.xyz));
  float feather = max(fwidth(diffuse) * 0.8, 0.012);
  vec3 inkPigment = base.rgb;
  float inkSamples = mask;
  int radius = max(1, int(floor(sizeInk.z)));
  const ivec2 directions[8] = ivec2[8](ivec2(1,0), ivec2(-1,0), ivec2(0,1), ivec2(0,-1),
    ivec2(1,1), ivec2(-1,1), ivec2(1,-1), ivec2(-1,-1));
  for (int i = 0; i < 8; i++) {
    ivec2 q = p + directions[i] * radius;
    vec4 neighbor = pigment(q);
    float neighborMask = step(0.5, neighbor.a);
    // Empty pigment never contributes ink or creases. In particular, the painted
    // backdrop can skip all eight neighboring depth/normal reads without losing detail.
    if (neighborMask < 0.5) continue;
    float qz = depthAt(q);
    inkPigment += neighbor.rgb;
    inkSamples += 1.0;
    if (mask > 0.5) {
      float crease = smoothstep(0.35, 0.62, 1.0 - dot(normal, decodeNormal(surface(q))));
      float separation = smoothstep(0.045, 0.11, abs(z - qz));
      inner = max(inner, crease * 0.6 + separation * 0.75);
    } else {
      // A nearer piece of scenery must occlude the silhouette ink as well as the model.
      nearby += step(qz - 0.025, z);
    }
  }

  vec3 color = original.rgb;
  if (mask > 0.5) {
    float lit = smoothstep(0.23 - feather, 0.23 + feather, diffuse);
    float shade = smoothstep(-0.42 - feather, -0.42 + feather, diffuse);
    vec3 shadow = mix(vec3(0.34, 0.39, 0.56), vec3(0.55, 0.59, 0.76), shade);
    vec3 cel = base.rgb * mix(shadow, vec3(1.18, 1.16, 1.10), lit);
    float illumination = luma(original.rgb) / max(luma(base.rgb), 0.018);
    // Keep cast shadows and authored material response without posterizing texture colors.
    cel *= mix(0.72, 1.0, smoothstep(0.24, 0.85, illumination));
    // Alpha packs a receiver flag in bit 0 and seven metallic bits above it.
    float metallic = floor(floor(centerSurface.a * 255.0 + 0.5) * 0.5) / 127.0;
    color = mix(cel, original.rgb, mix(0.08, 0.5, metallic));
    color += min(max(original.rgb - base.rgb * 2.5, vec3(0.0)), base.rgb * 0.08);
  }
  vec3 ink = vec3(0.006, 0.009, 0.019) + inkPigment / max(inkSamples, 1.0) * 0.045;
  float silhouette = (1.0 - mask) * smoothstep(0.0, 3.5, nearby);
  float edge = max(silhouette, mask * clamp(inner, 0.0, 0.7));
  color = mix(color, ink, edge * 0.94);
  outputColor = vec4(color, original.a);
}`;

type SceneParameters = {
  rendererLists: Hilo3d.RendererListHandle[];
  colorAttachments: Hilo3d.RenderPipelineColorAttachment[];
  depthStencilAttachment?: Hilo3d.RenderPipelineDepthStencilAttachment;
};
type ScreenParameters = {
  inputTextures: Hilo3d.RenderGraphTextureAccessHandle[];
  colorAttachments: Hilo3d.RenderPipelineColorAttachment[];
};

/** Paint the creature and solid scenery after their complete original PBR render. */
export class ToonRendering implements Hilo3d.ForwardRenderPipelineFeature {
  readonly name = 'anime cel and ink';
  readonly injectionPoint = 'before-post-process' as const;
  readonly requirements = { sampledSceneColor: true, sampledDepth: false };
  enabled = false;
  model: ToonModel | null = null;
  habitat: ToonModel | null = null;
  pixelRatio = 1;

  create(): Hilo3d.ForwardRenderPipelineFeatureRuntime {
    const owner = this;
    const buffer = new Hilo3d.UniformBuffer(layout);
    const shader = new Hilo3d.Shader({ vs: vertex, fs: fragment });
    const screen = new Hilo3d.FullscreenRenderPass({
      name: 'Anime / cel paint and contour', shader, uniformBuffers: [buffer],
      pipelineState: { ...Hilo3d.DEFAULT_MATERIAL_PIPELINE_STATE, depthTest: false, depthWrite: false, cullMode: 'none' },
    });
    const albedo: Hilo3d.ScriptableRenderPass<SceneParameters> = {
      name: 'Anime / original pigment',
      setup(builder, parameters) {
        for (const attachment of parameters.colorAttachments) builder.useColorAttachment(attachment);
        if (parameters.depthStencilAttachment) builder.useDepthStencilAttachment(parameters.depthStencilAttachment);
        for (const list of parameters.rendererLists) builder.useRendererList(list);
      },
      execute({ commands }, parameters) {
        for (const list of parameters.rendererLists) commands.drawRendererList(list);
      },
    };
    const geometry: typeof albedo = { ...albedo, name: 'Anime / pigment and surface' };
    const normals: typeof albedo = { ...albedo, name: 'Anime / surface normals' };
    const scenePool = new Hilo3d.RenderPassParameterPool<SceneParameters>(
      () => ({ rendererLists: [], colorAttachments: [] }),
      (p) => { p.rendererLists.length = 0; p.colorAttachments.length = 0; delete p.depthStencilAttachment; },
    );
    const screenPool = new Hilo3d.RenderPassParameterPool<ScreenParameters>(
      () => ({ inputTextures: [], colorAttachments: [] }),
      (p) => { p.inputTextures.length = 0; p.colorAttachments.length = 0; },
    );
    const selection = new ToonMeshSelection<ToonModel['surfaces'][number]>();
    const light = new Hilo3d.Vector3();
    const sizeInk = new Float32Array(4);
    const lightNear = new Float32Array(4);
    const farDepth = new Float32Array(4);
    return {
      record({ pipeline, resources, cullingResults }) {
        const model = owner.model;
        const habitat = owner.habitat;
        if (!owner.enabled || !resources.color) { selection.clear(); return; }
        const { surfaces, excluded } = selection.update(pipeline.scene, model, habitat);
        if (!surfaces.length) return;
        let useMrt = true;
        for (const surface of surfaces) {
          if (!surface.geometryMaterial) { useMrt = false; break; }
          for (const mesh of surface.meshes) {
            if (getToonGeometryUnsupportedReason(mesh)) { useMrt = false; break; }
          }
          if (!useMrt) break;
        }
        const view = pipeline.camera as Hilo3d.PerspectiveCamera;
        const { graph, output } = pipeline;
        const extent = { width: output.width, height: output.height };
        // sRGB storage preserves dark pigment precision while halving this target's bytes per pixel.
        const pigmentTarget = graph.createTexture('anime pigment', { format: 'rgba8unorm-srgb', extent });
        const normalTarget = graph.createTexture('anime normals', { format: 'rgba8unorm', extent });
        const target = graph.createTexture('anime painted scene', { format: 'rgba16float', extent });
        // Pigment draws also build the contour depth, avoiding another geometry pass.
        const depthTarget = graph.createTexture('anime depth', { format: 'depth32float', extent });
        const pigmentParameters = pipeline.acquirePassParameters(scenePool);
        for (const surface of surfaces) {
          if (useMrt) surface.geometryMaterial!.sync();
          pigmentParameters.rendererLists.push(pipeline.createRendererList({ cullingResults, queue: 'opaque', sorting: 'material-front-to-back',
            overrideMaterial: useMrt ? surface.geometryMaterial! : surface.material,
            excludeMeshes: surface.excluded, castShadowsOnly: true }));
        }
        // Keep every material draw in one render pass so tile GPUs retain color/depth
        // attachments on-chip instead of loading and storing them for each material.
        pigmentParameters.colorAttachments.push({ texture: pigmentTarget, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } });
        if (useMrt) pigmentParameters.colorAttachments.push({ texture: normalTarget, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } });
        pigmentParameters.depthStencilAttachment = { texture: depthTarget, depthLoadOp: 'clear', depthStoreOp: 'store',
          depthClearValue: view.depthMode === 'reversed' ? 0 : 1 };
        graph.addPass(useMrt ? geometry : albedo, pigmentParameters);
        if (!useMrt) {
          // Preserve the established path for explicit instancing or unusual raster state.
          const normalParameters = pipeline.acquirePassParameters(scenePool);
          normalParameters.rendererLists.push(pipeline.createRendererList({ cullingResults, queue: 'opaque', sorting: 'material-front-to-back',
            materialPass: 'material-attributes', excludeMeshes: excluded, castShadowsOnly: true }));
          normalParameters.colorAttachments.push({ texture: normalTarget, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } });
          normalParameters.depthStencilAttachment = { texture: depthTarget, depthReadOnly: true };
          graph.addPass(normals, normalParameters);
        }
        const m = view.viewMatrix.elements;
        light.set(m[0]! * 3 + m[4]! * 5 + m[8]! * 2,
          m[1]! * 3 + m[5]! * 5 + m[9]! * 2,
          m[2]! * 3 + m[6]! * 5 + m[10]! * 2).normalize();
        sizeInk.set([output.width, output.height, Math.max(1, owner.pixelRatio * 1.1), 0]);
        lightNear.set([light.x, light.y, light.z, view.near]);
        farDepth.set([view.far ?? 120, view.depthMode === 'reversed' ? 1 : 0, 0, 0]);
        buffer.set('sizeInk', sizeInk);
        buffer.set('lightNear', lightNear);
        buffer.set('farDepth', farDepth);
        const p = pipeline.acquirePassParameters(screenPool);
        p.inputTextures.push(resources.color, pigmentTarget, normalTarget, depthTarget);
        p.colorAttachments.push({ texture: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } });
        graph.addPass(screen, p);
        resources.replaceColor(target, 'linear');
      },
      destroy() { selection.clear(); shader.destroy(); },
    };
  }
}

const antialiasFragment = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D paintedScene;
layout(location = 0) out vec4 outputColor;
float luminance(vec3 c) { return sqrt(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0)); }
void main() {
  vec2 texel = 1.0 / vec2(textureSize(paintedScene, 0));
  vec2 uv = vUv;
  vec4 center = textureLod(paintedScene, uv, 0.0);
  float nw = luminance(textureLod(paintedScene, uv + vec2(-1.0, -1.0) * texel, 0.0).rgb);
  float ne = luminance(textureLod(paintedScene, uv + vec2(1.0, -1.0) * texel, 0.0).rgb);
  float sw = luminance(textureLod(paintedScene, uv + vec2(-1.0, 1.0) * texel, 0.0).rgb);
  float se = luminance(textureLod(paintedScene, uv + vec2(1.0, 1.0) * texel, 0.0).rgb);
  float middle = luminance(center.rgb);
  float low = min(middle, min(min(nw, ne), min(sw, se)));
  float high = max(middle, max(max(nw, ne), max(sw, se)));
  if (high - low < max(0.025, high * 0.10)) { outputColor = center; return; }
  vec2 direction = vec2(sw + se - nw - ne, nw + sw - ne - se);
  float reduction = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  direction = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduction), vec2(-6.0), vec2(6.0)) * texel;
  vec3 narrow = (textureLod(paintedScene, uv - direction / 6.0, 0.0).rgb
    + textureLod(paintedScene, uv + direction / 6.0, 0.0).rgb) * 0.5;
  vec3 wide = narrow * 0.5 + (textureLod(paintedScene, uv - direction * 0.5, 0.0).rgb
    + textureLod(paintedScene, uv + direction * 0.5, 0.0).rgb) * 0.25;
  float wideLight = luminance(wide);
  outputColor = vec4(wideLight < low || wideLight > high ? narrow : wide, center.a);
}`;

/** Smooth the ink after tone mapping, so thin dark contours keep their intended weight. */
export function toonAntialias(owner: ToonRendering): Hilo3d.ForwardRenderPipelineFeature {
  return {
    name: 'anime contour antialias', injectionPoint: 'before-output',
    requirements: { sampledSceneColor: true, sampledDepth: false },
    create() {
      const shader = new Hilo3d.Shader({ vs: vertex, fs: antialiasFragment });
      const pass = new Hilo3d.FullscreenRenderPass({ name: 'Anime / smooth ink', shader,
        pipelineState: { ...Hilo3d.DEFAULT_MATERIAL_PIPELINE_STATE, depthTest: false, depthWrite: false, cullMode: 'none' } });
      const pool = new Hilo3d.RenderPassParameterPool<ScreenParameters>(
        () => ({ inputTextures: [], colorAttachments: [] }),
        (p) => { p.inputTextures.length = 0; p.colorAttachments.length = 0; },
      );
      return {
        record({ pipeline, resources }) {
          if (!owner.enabled || !resources.color) return;
          const target = pipeline.graph.createTexture('anime antialiased scene', {
            format: 'rgba8unorm', extent: { width: pipeline.output.width, height: pipeline.output.height },
          });
          const p = pipeline.acquirePassParameters(pool);
          p.inputTextures.push(resources.color);
          p.colorAttachments.push({ texture: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } });
          pipeline.graph.addPass(pass, p);
          resources.replaceColor(target, resources.colorEncoding);
        },
        destroy() { shader.destroy(); },
      };
    },
  };
}
