import * as Hilo3d from 'hilo3d';

Hilo3d.registerUniformBlockBinding('EcologyAtmosphereParams');
const layout = Hilo3d.createStd140Layout({
  uViewProjection: 'mat4', uCameraWorld: 'mat4', uWeather: 'vec4', uFraming: 'vec4',
});
const block = `layout(std140) uniform EcologyAtmosphereParams {
  mat4 uViewProjection;
  mat4 uCameraWorld;
  vec4 uWeather;
  vec4 uFraming;
};`;

const backgroundVertex = `#version 300 es
precision highp float;
in vec3 a_position;
out vec4 vProjected;
void main() {
  vProjected = vec4(a_position.xy, 0.9999, 1.0);
  gl_Position = vProjected;
}`;

const oceanVertex = `#version 300 es
precision highp float;
in vec3 a_position;
out vec4 vProjected;
${block}
void main() {
  // The sea has a real depth surface at the Blender beach's waterline.
  vec3 position = vec3(a_position.x, -1.05, a_position.y);
  vProjected = uViewProjection * vec4(position, 1.0);
  gl_Position = vProjected;
}`;

const fragment = `#version 300 es
precision highp float;
in vec4 vProjected;
${block}
out vec4 fragColor;

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
float starLayer(vec2 coordinate, float cells, float seed) {
  vec2 grid = coordinate * cells;
  vec2 cell = floor(grid);
  float chance = hash21(cell + seed);
  vec2 offset = vec2(hash21(cell + 19.2 + seed), hash21(cell + 47.1 + seed));
  vec2 p = fract(grid) - mix(vec2(0.18), vec2(0.82), offset);
  float radius = mix(0.018, 0.053, chance);
  float aa = max(fwidth(grid.x), fwidth(grid.y));
  float star = 1.0 - smoothstep(radius, radius + aa * 0.85, length(p));
  float twinkle = 0.70 + 0.30 * sin(uWeather.x * (0.55 + chance) + chance * 70.0);
  return star * step(0.986, chance) * twinkle;
}
vec3 skyColor(vec2 uv, vec3 ray) {
  float dusk = uWeather.y, horizon = uFraming.x;
  float h = clamp((uv.y - horizon) / max(0.15, 1.0 - horizon), 0.0, 1.0);
  float azimuth = atan(ray.x, -ray.z);
  vec3 morning = mix(vec3(0.97, 0.77, 0.53), vec3(0.42, 0.64, 0.73), smoothstep(0.0, 0.92, h));
  morning = mix(morning, vec3(0.38, 0.55, 0.68), smoothstep(0.54, 1.0, h) * 0.48);
  float haze = exp(-h * 6.0);
  morning += vec3(0.04, 0.035, 0.02) * haze;

  vec3 night = mix(vec3(0.30, 0.29, 0.39), vec3(0.055, 0.10, 0.22), smoothstep(0.0, 0.62, h));
  night = mix(night, vec3(0.025, 0.048, 0.115), smoothstep(0.30, 1.0, h) * 0.7);
  vec2 stars = vec2(azimuth * 0.39, h * 0.56 + ray.y * 0.14);
  float starlight = starLayer(stars, 43.0, 1.7) + starLayer(stars, 81.0, 12.9) * 0.47;
  night += vec3(0.75, 0.84, 1.0) * starlight * smoothstep(0.06, 0.25, h);
  return mix(morning, night, dusk);
}
float shoreDistance(vec2 point) {
  // Matches the 192-sector Blender coast, including its three authored wave bands.
  float angle = atan(point.y / 12.55, point.x / 15.65);
  float wobble = 0.65 * sin(angle * 3.0 + 0.4) + 0.40 * cos(angle * 5.0 - 0.7)
    + 0.18 * sin(angle * 11.0);
  vec2 radii = vec2(15.65 + wobble, 12.55 + wobble * 0.8);
  return (length(point / radii) - 1.0) * 13.6 + 0.09;
}
vec3 seaColor(vec2 uv, vec3 ray, vec3 sky) {
  float time = uWeather.x, dusk = uWeather.y;
  vec3 origin = uCameraWorld[3].xyz;
  float depth = (-1.05 - origin.y) / min(ray.y, -0.0001);
  vec3 world = origin + ray * clamp(depth, 0.0, 2200.0);
  vec2 p = world.xz;
  float coast = shoreDistance(p);
  float shallow = 1.0 - smoothstep(0.4, 7.7, max(coast, 0.0));
  float distanceFromEye = length(world - origin);
  float grain = noise21(p * 0.32 + vec2(time * 0.008, -time * 0.011));
  vec3 dawnDeep = vec3(0.105, 0.38, 0.49);
  vec3 duskDeep = vec3(0.065, 0.17, 0.28);
  vec3 dawnShallow = vec3(0.33, 0.73, 0.65);
  vec3 duskShallow = vec3(0.13, 0.40, 0.43);
  vec3 water = mix(mix(dawnDeep, duskDeep, dusk), mix(dawnShallow, duskShallow, dusk), shallow * 0.90);
  water *= 0.94 + grain * 0.11;

  float ripple = sin(dot(p, vec2(1.7, 0.72)) + sin(p.y * 0.49 + time * 0.18) * 0.7 - time * 0.55);
  float fineRipple = sin(dot(p, vec2(-2.1, 3.4)) + ripple * 0.7 + time * 0.83);
  float broken = noise21(p * 1.8 + vec2(-time * 0.016, time * 0.022));
  float band = 1.0 - smoothstep(0.025, 0.12, abs(ripple + fineRipple * 0.13));
  float stroke = band * smoothstep(0.50, 0.73, broken);
  float nearVisibility = 1.0 - smoothstep(45.0, 170.0, distanceFromEye);
  water += mix(vec3(0.23, 0.29, 0.20), vec3(0.16, 0.25, 0.34), dusk) * stroke * 0.33 * nearVisibility;

  float starGlint = starLayer(p * vec2(0.075, 0.28), 4.4, 36.1);
  water += vec3(0.46, 0.68, 0.73) * starGlint * dusk * 0.24 * nearVisibility;

  float surge = sin(time * 0.44 + noise21(p * 0.46) * 4.0) * 0.10;
  float line = abs(coast - 0.08 - surge - (noise21(p * 2.8) - 0.5) * 0.10);
  float foam = (1.0 - smoothstep(0.035, 0.20, line)) * smoothstep(0.25, 0.62, broken);
  float outerLine = abs(coast - 0.76 - sin(time * 0.32 + p.x * 0.2) * 0.12);
  foam += (1.0 - smoothstep(0.025, 0.10, outerLine)) * smoothstep(0.58, 0.73, broken) * 0.16;
  water = mix(water, mix(vec3(0.83, 0.90, 0.75), vec3(0.53, 0.70, 0.69), dusk), min(0.82, foam * 0.77));

  float perspective = smoothstep(uFraming.x - 0.34, uFraming.x + 0.005, uv.y);
  vec3 mist = mix(vec3(0.68, 0.72, 0.65), vec3(0.24, 0.30, 0.39), dusk);
  water = mix(water, mist, perspective * 0.64);
  float horizon = smoothstep(uFraming.x - 0.045, uFraming.x + 0.035, uv.y);
  horizon = max(horizon, smoothstep(-0.005, 0.01, ray.y));
  return mix(water, sky, horizon);
}
void main() {
  vec2 uv = vProjected.xy / vProjected.w * 0.5 + 0.5;
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 localRay = normalize(vec3(ndc.x * uWeather.z * uWeather.w, ndc.y * uWeather.w, -1.0));
  vec3 ray = normalize(mat3(uCameraWorld) * localRay);
  vec3 sky = skyColor(uv, ray);
  vec3 color = seaColor(uv, ray, sky);
  float vignette = 1.0 - smoothstep(0.45, 0.87, length((uv - 0.5) * vec2(0.82, 1.0))) * 0.07;
  color = max(vec3(0.0), color * vignette);
  // Both the hand-picked sky palette and water enter the common HDR pipeline in linear light.
  vec3 linearColor = mix(color / 12.92, pow((color + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), color));
  fragColor = vec4(linearColor, 1.0);
}`;

/** Two quads: a depth-correct shore surface and an edge-free painted sky/ocean beyond it. */
export class EcologyAtmosphere {
  private readonly parameters = new Hilo3d.UniformBuffer(layout);
  private readonly weather = new Float32Array(4);
  private readonly framing = new Float32Array(4);
  private readonly meshes: Hilo3d.Mesh[];
  private readonly materials: Hilo3d.ShaderMaterial[];
  private time = 0;
  private mood = 0;
  private targetMood = 0;
  private lastUpdate = performance.now();
  private destroyed = false;

  constructor(private readonly stage: Hilo3d.Stage, private readonly camera: Hilo3d.PerspectiveCamera) {
    const background = new Hilo3d.ShaderMaterial({
      name: 'ecology / clear dawn and dusk horizon', vs: backgroundVertex, fs: fragment,
      attributes: { a_position: Hilo3d.MaterialAttributeSemantic.POSITION },
      uniformBlocks: { EcologyAtmosphereParams: this.parameters },
      state: { depthTest: false, depthWrite: false }, cullMode: 'none',
    });
    const ocean = new Hilo3d.ShaderMaterial({
      name: 'ecology / open sea and coastal foam', vs: oceanVertex, fs: fragment,
      attributes: { a_position: Hilo3d.MaterialAttributeSemantic.POSITION },
      uniformBlocks: { EcologyAtmosphereParams: this.parameters },
      state: { depthTest: true, depthWrite: true }, cullMode: 'none',
    });
    this.materials = [background, ocean];
    this.meshes = [
      new Hilo3d.Mesh({ name: 'ecology / endless painted horizon',
        geometry: new Hilo3d.PlaneGeometry({ width: 2, height: 2 }), material: background,
        useInstanced: false, frustumTest: false, renderOrder: -10000,
        castShadows: false, receiveShadows: false }).addTo(stage),
      new Hilo3d.Mesh({ name: 'ecology / coastal waterline',
        geometry: new Hilo3d.PlaneGeometry({ width: 160, height: 160 }), material: ocean,
        useInstanced: false, frustumTest: false, renderOrder: -9999,
        castShadows: false, receiveShadows: false }).addTo(stage),
    ];
    this.update(0);
  }

  setTimeOfDay(timeOfDay: 'dawn' | 'dusk'): void {
    this.targetMood = timeOfDay === 'dusk' ? 1 : 0;
  }

  update(dtSeconds: number): void {
    if (this.destroyed) return;
    const now = performance.now();
    const transitionDt = Math.min(0.1, Math.max(0, (now - this.lastUpdate) / 1000));
    this.lastUpdate = now;
    this.time += Math.min(0.1, Math.max(0, dtSeconds));
    // Time-of-day transitions remain responsive while the ecological simulation is paused.
    this.mood += (this.targetMood - this.mood) * (1 - Math.exp(-transitionDt * 2.1));
    this.camera.updateViewProjectionMatrix();
    const world = this.camera.worldMatrix.elements;
    this.weather[0] = this.time;
    this.weather[1] = this.mood;
    this.weather[2] = this.camera.aspect;
    this.weather[3] = Math.tan(this.camera.fov * Math.PI / 360);
    this.framing[0] = 0.755;
    this.framing[1] = Math.atan2(-world[8]!, -world[10]!);
    this.framing[2] = this.stage.height;
    this.framing[3] = -1.05;
    this.parameters.set('uViewProjection', this.camera.viewProjectionMatrix.elements);
    this.parameters.set('uCameraWorld', world);
    this.parameters.set('uWeather', this.weather);
    this.parameters.set('uFraming', this.framing);
    for (const material of this.materials) material.invalidateData();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.destroy(this.stage.renderer);
    }
  }
}
