import * as Hilo3d from 'hilo3d';

// One portable block owns every numeric shader value on both graphics backends.
Hilo3d.registerUniformBlockBinding('LagoonWaterBlock');
const layout = Hilo3d.createStd140Layout({
  uModel: 'mat4', uViewProjection: 'mat4', uCameraTime: 'vec4',
  uFogColorStart: 'vec4', uWater: 'vec4',
});
const block = `
layout(std140) uniform LagoonWaterBlock {
  mat4 uModel;
  mat4 uViewProjection;
  vec4 uCameraTime;
  vec4 uFogColorStart;
  vec4 uWater;
};`;
const noise = `
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float noise21(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
}
float waveHeight(vec2 p, float time) {
  float warp = noise21(p * 0.9 + vec2(time * 0.018, -time * 0.022)) * 2.8;
  return sin(dot(p, vec2(3.7, 1.6)) - time * 0.66 + warp) * 0.013
    + sin(dot(p, vec2(-2.1, 5.2)) + time * 0.43 + warp * 0.7) * 0.008
    + (noise21(p * 10.0 + vec2(time * 0.11, time * 0.07)) - 0.5) * 0.007;
}`;

const vertexSource = `#version 300 es
precision highp float;
in vec3 a_position;
in vec3 a_normal;
out vec3 vWorld;
out vec3 vLocal;
out vec3 vNormal;
${block}
${noise}
void main() {
  vec3 p = a_position;
  float top = smoothstep(0.65, 0.95, a_normal.y) * (1.0 - uWater.y);
  p.y += waveHeight(p.xz, uCameraTime.w) * top * 0.55;
  vec4 world = uModel * vec4(p, 1.0);
  vWorld = world.xyz;
  vLocal = p;
  vNormal = normalize(mat3(uModel) * a_normal);
  gl_Position = uViewProjection * world;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vLocal;
in vec3 vNormal;
layout(location = 0) out vec4 fragColor;
${block}
${noise}
void main() {
  vec2 p = vLocal.xz;
  float time = uCameraTime.w;
  float height = waveHeight(p, time);
  vec2 gradient = vec2(waveHeight(p + vec2(0.018, 0.0), time) - height,
    waveHeight(p + vec2(0.0, 0.018), time) - height) / 0.018;
  vec3 waveNormal = normalize(mat3(uModel) * vec3(-gradient.x, 1.0, -gradient.y));
  float top = smoothstep(0.4, 0.9, vNormal.y);
  vec3 normal = normalize(mix(vNormal, waveNormal, top));
  vec3 view = normalize(uCameraTime.xyz - vWorld);
  float fresnel = 0.02 + 0.7 * pow(1.0 - max(dot(normal, view), 0.0), 4.5);

  // The shoreline follows the existing asymmetric sand mesh, in its local
  // glTF X/Z coordinates. Noise breaks the foam into small moving patches.
  vec2 shorePoint = vec2(p.x + 0.12, -p.y - 0.1);
  float angle = atan(shorePoint.y, shorePoint.x);
  float shoreRadius = 2.46 + 0.27 * sin(angle + 0.55) + 0.10 * cos(angle * 3.0);
  float shoreDistance = length(shorePoint) - shoreRadius;
  float shallows = 1.0 - smoothstep(0.02, 0.85, max(shoreDistance, 0.0));
  float mottling = noise21(p * 1.7 + vec2(time * 0.016, -time * 0.01));
  vec3 deep = vec3(0.012, 0.115, 0.145);
  vec3 shallow = vec3(0.095, 0.355, 0.295);
  vec3 color = mix(deep, shallow, shallows * 0.72 + mottling * 0.14);
  color *= 0.88 + height * 3.2 + noise21(p * 5.0 + time * 0.025) * 0.14;

  vec3 reflection = reflect(-view, normal);
  float sky = smoothstep(-0.2, 0.8, reflection.y);
  vec3 reflectedColor = mix(vec3(0.065, 0.19, 0.19), vec3(0.36, 0.57, 0.58), sky);
  float cloud = noise21(reflection.xz * 3.4 + vec2(time * 0.008, 0.0));
  reflectedColor += vec3(0.07, 0.08, 0.065) * smoothstep(0.48, 0.8, cloud);
  color = mix(color, reflectedColor, fresnel * top);

  vec3 light = normalize(vec3(-0.55, 0.68, -0.48));
  float highlight = max(dot(normal, normalize(light + view)), 0.0);
  float brokenGlint = 0.35 + noise21(p * 19.0 + vec2(time * 0.12, -time * 0.09)) * 0.65;
  color += vec3(0.62, 0.72, 0.58) * (pow(highlight, 34.0) * 0.065
    + pow(highlight, 150.0) * brokenGlint * 0.23) * top;
  float caustic = pow(max(0.0, 1.0 - abs(noise21(p * 7.0 + gradient * 2.0
    + vec2(time * 0.08, -time * 0.045)) - 0.5) * 7.0), 5.0);
  color += vec3(0.10, 0.19, 0.11) * caustic * shallows * top * 0.16;

  float foamNoise = noise21(p * 11.0 + vec2(time * 0.06, -time * 0.035));
  float surge = sin(time * 0.45 + noise21(p * 1.4) * 5.0) * 0.045;
  float edge = abs(shoreDistance - 0.055 - surge - (noise21(p * 5.0) - 0.5) * 0.10);
  float foam = (1.0 - smoothstep(0.012, 0.105, edge))
    * smoothstep(0.45, 0.72, foamNoise) * top;
  color = mix(color, vec3(0.54, 0.69, 0.59), foam * 0.5);

  if (uWater.z > 0.5) {
    // Broad turquoise paint shapes and slow, broken white strokes read as drawn water.
    float shallowBand = smoothstep(0.40, 0.45, shallows);
    color = mix(vec3(0.018, 0.17, 0.23), vec3(0.08, 0.39, 0.38), shallowBand);
    float ribbon = abs(sin(dot(p, vec2(2.6, 1.3)) + noise21(p * 1.6) * 2.4 - time * 0.44));
    float stroke = (1.0 - smoothstep(0.045, 0.10, ribbon))
      * smoothstep(0.46, 0.64, noise21(p * 2.7 + time * 0.025)) * top;
    color = mix(color, vec3(0.37, 0.66, 0.64), stroke * 0.70);
    float drawnFoam = (1.0 - smoothstep(0.025, 0.07, edge))
      * smoothstep(0.43, 0.57, noise21(p * 5.0 + time * 0.045)) * top;
    color = mix(color, vec3(0.70, 0.85, 0.76), drawnFoam * 0.88);
    color += vec3(0.09, 0.17, 0.18) * smoothstep(0.38, 0.43, fresnel) * top;
  }

  // The lower skirt reads as water depth, rather than a shiny teal pedestal.
  float depth = clamp((-0.1 - vLocal.y) * 1.45, 0.0, 1.0);
  color = mix(color, vec3(0.014, 0.06, 0.065), depth * 0.72);
  color *= mix(0.68, 1.0, top);
  float fog = smoothstep(uFogColorStart.w, uWater.x, distance(uCameraTime.xyz, vWorld));
  fragColor = vec4(mix(color, uFogColorStart.rgb, fog), 1.0);
}`;

interface WaterResources {
  buffer: Hilo3d.UniformBuffer<typeof layout.schema>;
  material: Hilo3d.ShaderMaterial;
}

/** Keep custom UBO identities stable until the owning renderer is destroyed. */
export class LagoonWaterResources {
  private readonly slots: WaterResources[] = [];

  get(index: number): WaterResources {
    let resources = this.slots[index];
    if (!resources) {
      const buffer = new Hilo3d.UniformBuffer(layout);
      const material = new Hilo3d.ShaderMaterial({
        name: `flowing lagoon / surface ${index}`, vs: vertexSource, fs: fragmentSource,
        attributes: { a_position: Hilo3d.MaterialAttributeSemantic.POSITION, a_normal: Hilo3d.MaterialAttributeSemantic.NORMAL },
        uniformBlocks: { LagoonWaterBlock: buffer }, cullMode: 'none',
      });
      resources = { buffer, material };
      this.slots[index] = resources;
    }
    return resources;
  }
}

interface WaterSurface extends WaterResources {
  mesh: Hilo3d.Mesh;
  original: Hilo3d.MaterialInstance | null;
  deep: number;
  castShadows: boolean;
  receiveShadows: boolean;
}

/** Animated water replaces only the lagoon's authored water and old line meshes. */
export class LagoonWater {
  private readonly surfaces: WaterSurface[] = [];
  private readonly hidden: { mesh: Hilo3d.Mesh; visible: boolean }[] = [];
  private readonly cameraTime = new Float32Array(4);
  private readonly fogColorStart = new Float32Array(4);
  private readonly water = new Float32Array(4);
  private time = 0;
  private toon = false;

  constructor(meshes: readonly Hilo3d.Mesh[], resources: LagoonWaterResources, private readonly camera: Hilo3d.Camera,
    private readonly fog?: Hilo3d.Fog) {
    for (const mesh of meshes) {
      const name = `${mesh.name} ${mesh.material?.name ?? ''}`;
      if (/lagoon.*wavelet|tidal.?ripple/i.test(name)) {
        this.hidden.push({ mesh, visible: mesh.visible });
        mesh.visible = false;
        continue;
      }
      if (!/lagoon_(?:surface|deep)/i.test(name)) continue;
      const { buffer, material } = resources.get(this.surfaces.length);
      this.surfaces.push({ mesh, original: mesh.material, buffer, material,
        deep: /lagoon_deep/i.test(name) ? 1 : 0,
        castShadows: mesh.castShadows, receiveShadows: mesh.receiveShadows });
      mesh.material = material;
      mesh.castShadows = false;
      mesh.receiveShadows = false;
    }
  }

  setToon(enabled: boolean): void {
    this.toon = enabled;
  }

  update(dtMilliseconds: number): void {
    if (!this.surfaces.length) return;
    this.time += dtMilliseconds / 1000;
    this.camera.updateViewProjectionMatrix();
    const camera = this.camera.worldMatrix.elements;
    this.cameraTime[0] = camera[12]!;
    this.cameraTime[1] = camera[13]!;
    this.cameraTime[2] = camera[14]!;
    this.cameraTime[3] = this.time;
    const fog = this.fog;
    this.fogColorStart[0] = fog?.color.r ?? 0.04;
    this.fogColorStart[1] = fog?.color.g ?? 0.12;
    this.fogColorStart[2] = fog?.color.b ?? 0.12;
    this.fogColorStart[3] = fog?.start ?? 13;
    for (const surface of this.surfaces) {
      this.water[0] = fog?.end ?? 27;
      this.water[1] = surface.deep;
      this.water[2] = this.toon ? 1 : 0;
      surface.buffer.set('uModel', surface.mesh.worldMatrix.elements);
      surface.buffer.set('uViewProjection', this.camera.viewProjectionMatrix.elements);
      surface.buffer.set('uCameraTime', this.cameraTime);
      surface.buffer.set('uFogColorStart', this.fogColorStart);
      surface.buffer.set('uWater', this.water);
      surface.material.invalidateData();
    }
  }

  dispose(): void {
    for (const surface of this.surfaces) {
      surface.mesh.material = surface.original;
      surface.mesh.castShadows = surface.castShadows;
      surface.mesh.receiveShadows = surface.receiveShadows;
    }
    for (const { mesh, visible } of this.hidden) mesh.visible = visible;
    this.surfaces.length = 0;
    this.hidden.length = 0;
  }
}
