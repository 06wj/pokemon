import * as Hilo3d from 'hilo3d';
import { LIVING_POINTS } from '../ecology/livingContent.ts';
import { COASTAL_LAYOUT, RIVER_SEGMENTS, SEA_LEVEL, isInRiver,
  terrainBaseHeight, waterSurfaceHeight } from '../ecology/layout.ts';
import type { LivingWorld } from '../ecology/livingTypes.ts';

const COUNT = 112;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const fract = (value: number): number => value - Math.floor(value);
const random = (seed: number): number => fract(Math.sin(seed * 127.1 + 311.7) * 43758.5453);
const glslFloat = (value: number): string => Number.isInteger(value) ? value.toFixed(1) : String(value);
const color = (hex: number): Hilo3d.Color => {
  const linear = (v: number): number => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  return new Hilo3d.Color(linear((hex >> 16 & 255) / 255), linear((hex >> 8 & 255) / 255), linear((hex & 255) / 255));
};
const surface = (x: number, z: number): number => isInRiver(x, z) ? waterSurfaceHeight(z) : terrainBaseHeight(x, z);

Hilo3d.registerUniformBlockBinding('LivingSnowParams');
const snowLayout = Hilo3d.createStd140Layout({
  uViewProjection: 'mat4', uWeather: 'vec4', uSunDirection: 'vec4', uSunColor: 'vec4',
  uAmbient: 'vec4', uTree: 'vec4', uFire: 'vec4',
});
const snowBlock = `layout(std140) uniform LivingSnowParams {
  mat4 uViewProjection; vec4 uWeather; vec4 uSunDirection; vec4 uSunColor;
  vec4 uAmbient; vec4 uTree; vec4 uFire;
};`;
const riverShader = `float riverCenterAt(float z) {
  if (z <= ${glslFloat(RIVER_SEGMENTS[0]!.z0)}) return ${glslFloat(RIVER_SEGMENTS[0]!.d)};
  ${RIVER_SEGMENTS.map((s) => `if(z <= ${glslFloat(s.z1)}) {
    float t=(z-(${glslFloat(s.z0)}))/${glslFloat(s.z1 - s.z0)};
    return ((${glslFloat(s.a)}*t+(${glslFloat(s.b)}))*t+(${glslFloat(s.c)}))*t+(${glslFloat(s.d)});
  }`).join('\n')}
  return ${glslFloat(COASTAL_LAYOUT.river.centerline.at(-1)![0]!)};
}`;
const snowVertex = `#version 300 es
precision highp float;
in vec3 a_position; in vec3 a_normal;
out vec3 vWorld; out vec3 vNormal;
${snowBlock}
void main(){vWorld=a_position;vNormal=a_normal;gl_Position=uViewProjection*vec4(a_position,1.0);}`;
const snowFragment = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal;
out vec4 fragColor;
${snowBlock}
${riverShader}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);}
void main(){
  // No ocean/river whitening, including the curved estuary and sloping beach.
  float bankDistance=abs(vWorld.x-riverCenterAt(vWorld.z));
  if(vWorld.y < ${glslFloat(SEA_LEVEL + .055)} || bankDistance < ${glslFloat(COASTAL_LAYOUT.river.halfWidth + .045)}) discard;
  vec2 p=vWorld.xz;
  float treeShade=1.0-smoothstep(uTree.z*.38,uTree.z,length(p-uTree.xy));
  float fireDistance=length(p-uFire.xy);
  float warmth=uFire.z*(1.0-smoothstep(.55,2.15,fireDistance));
  if(uFire.z>.04 && fireDistance<.70) discard;
  float localSnow=uWeather.x*(1.0-treeShade*.34)*(1.0-warmth);
  float patches=noise(p*.77)*.68+noise(p*2.85+5.1)*.32;
  float threshold=1.065-localSnow*1.24;
  float cover=smoothstep(threshold-.085,threshold+.085,patches)*smoothstep(.015,.15,localSnow);
  cover*=smoothstep(${glslFloat(SEA_LEVEL + .15)},${glslFloat(SEA_LEVEL + .59)},vWorld.y);
  cover*=smoothstep(${glslFloat(COASTAL_LAYOUT.river.halfWidth + .045)},${glslFloat(COASTAL_LAYOUT.river.halfWidth + .26)},bankDistance);
  if(cover<.005) discard;
  vec3 normal=normalize(vNormal+vec3((noise(p*8.0)-.5)*.10,0,(noise(p*8.0+9.0)-.5)*.10));
  float direct=max(0.0,dot(normal,normalize(-uSunDirection.xyz)));
  vec3 light=vec3(.12,.15,.19)+uAmbient.rgb*.40+uSunColor.rgb*direct*.48;
  light*=1.0-treeShade*.22;
  light+=vec3(.85,.28,.07)*warmth*.40;
  vec3 snow=vec3(.79,.84,.88)*light*(.95+noise(p*12.0)*.07);
  // Wet/thawing snow becomes slightly cooler and less chalky.
  snow=mix(snow,snow*vec3(.89,.94,.98),uWeather.z*.18);
  fragColor=vec4(max(vec3(0),snow),cover*.96);
}`;

interface CloudSeed { x: number; z: number; phase: number; speed: number; size: number }
interface CloudGeometry { geometry: Hilo3d.Geometry; data: Float32Array; mesh: Hilo3d.Mesh }
interface RainRipple { mesh: Hilo3d.Mesh; material: Hilo3d.PBRMaterial; bornAt: number }

function particleGeometry(): { geometry: Hilo3d.Geometry; data: Float32Array } {
  const data = new Float32Array(COUNT * 12), normals = new Float32Array(COUNT * 12);
  const indices = new Uint16Array(COUNT * 6);
  for (let i = 0; i < COUNT; i++) {
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    for (let vertex = 0; vertex < 4; vertex++) normals[i * 12 + vertex * 3 + 2] = 1;
  }
  return { data, geometry: new Hilo3d.Geometry({ isStatic: false,
    vertices: new Hilo3d.GeometryData(data, 3), normals: new Hilo3d.GeometryData(normals, 3),
    indices: new Hilo3d.GeometryData(indices, 1),
  }) };
}

function snowGroundGeometry(): Hilo3d.Geometry {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  // An integer multiple of the authored .18m terrain grid avoids alternating
  // intersections on the beach. The shader softly clips banks at full precision.
  const step = .36, columns = 97, rows = 81;
  const valid: boolean[] = [];
  const dry = (x: number, z: number): boolean => terrainBaseHeight(x, z) > SEA_LEVEL + .06;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const x = (column - (columns - 1) / 2) * step, z = (row - (rows - 1) / 2) * step;
    const y = terrainBaseHeight(x, z);
    positions.push(x, y + .048, z);
    const nx = -(terrainBaseHeight(x + .12, z) - terrainBaseHeight(x - .12, z)) / .24;
    const nz = -(terrainBaseHeight(x, z + .12) - terrainBaseHeight(x, z - .12)) / .24;
    const length = Math.hypot(nx, 1, nz); normals.push(nx / length, 1 / length, nz / length);
    valid.push(dry(x, z));
  }
  const triangle = (a: number, b: number, c: number): void => {
    if (!valid[a] || !valid[b] || !valid[c]) return;
    const x = (positions[a * 3]! + positions[b * 3]! + positions[c * 3]!) / 3;
    const z = (positions[a * 3 + 2]! + positions[b * 3 + 2]! + positions[c * 3 + 2]!) / 3;
    if (dry(x, z)) indices.push(a, b, c);
  };
  for (let row = 0; row < rows - 1; row++) for (let column = 0; column < columns - 1; column++) {
    const a = row * columns + column, b = a + 1, c = a + columns + 1, d = a + columns;
    triangle(a, c, b); triangle(a, d, c);
  }
  return new Hilo3d.Geometry({ vertices: new Hilo3d.GeometryData(new Float32Array(positions), 3),
    normals: new Hilo3d.GeometryData(new Float32Array(normals), 3), indices: new Hilo3d.GeometryData(new Uint16Array(indices), 1) });
}

function rippleGeometry(): Hilo3d.Geometry {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let i = 0; i <= 24; i++) for (const radius of [1, .80]) {
    const angle = i / 24 * Math.PI * 2;
    positions.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius); normals.push(0, 1, 0);
  }
  for (let i = 0; i < 24; i++) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  return new Hilo3d.Geometry({ vertices: new Hilo3d.GeometryData(new Float32Array(positions), 3),
    normals: new Hilo3d.GeometryData(new Float32Array(normals), 3), indices: new Hilo3d.GeometryData(new Uint16Array(indices), 1) });
}

/** Two fixed 112-particle batches and a lit, island-only accumulation layer.
 * All motion is a function of simulation.elapsed, so pause/reset cannot leave
 * independent weather timers running. No simulation or discovery state is changed. */
export class LivingWeatherEffects {
  private readonly root = new Hilo3d.Node({ name: 'living / weather', pointerEnabled: false,
    onUpdate: () => this.syncCamera() });
  private readonly meshes: Hilo3d.Mesh[] = [];
  private readonly geometries: Hilo3d.Geometry[] = [];
  private readonly seeds: CloudSeed[] = [];
  private readonly rainCycles = new Float64Array(COUNT).fill(NaN);
  private readonly snowBuffer = new Hilo3d.UniformBuffer(snowLayout);
  private readonly snowMaterial: Hilo3d.ShaderMaterial;
  private readonly rain: CloudGeometry;
  private readonly snow: CloudGeometry;
  private readonly ground: Hilo3d.Mesh;
  private readonly ripples: RainRipple[] = [];
  private readonly directional: Hilo3d.DirectionalLight[] = [];
  private readonly ambient: Hilo3d.AmbientLight[] = [];
  private readonly weatherData = new Float32Array(4);
  private readonly sunDirection = new Float32Array([.6, -1, -.4, 0]);
  private readonly sunColor = new Float32Array(4);
  private readonly ambientColor = new Float32Array(4);
  private readonly treeData = new Float32Array([LIVING_POINTS.tree.x, LIVING_POINTS.tree.z, 3.9, 0]);
  private readonly fireData = new Float32Array([LIVING_POINTS.fire.x, LIVING_POINTS.fire.z, 0, 0]);
  private readonly nearFocus = { x: 0, z: 0, radius: 3.5, height: 5 };
  private lastWorld: LivingWorld | null = null;
  private lastKind: LivingWorld['weather']['kind'] | null = null;
  private lastElapsed = -1;
  private changedAt = NaN;
  private disposed = false;

  constructor(private readonly stage: Hilo3d.Stage) {
    this.root.addTo(stage);
    stage.traverse((node) => {
      if (node instanceof Hilo3d.DirectionalLight) this.directional.push(node);
      if (node instanceof Hilo3d.AmbientLight) this.ambient.push(node);
    });
    for (let i = 0; i < COUNT; i++) {
      const near = i >= 80, index = near ? i - 80 : i;
      const radius = Math.sqrt((index + .5) / (near ? 32 : 80)), angle = index * 2.39996323;
      this.seeds.push({ x: Math.cos(angle) * radius * (near ? 1 : 12.9), z: Math.sin(angle) * radius * (near ? 1 : 9.8),
        phase: random(i + 1), speed: random(i + 114), size: random(i + 229) });
    }
    const cloud = (name: string, tint: number, opacity: number): CloudGeometry => {
      const { geometry, data } = particleGeometry(); this.geometries.push(geometry);
      const material = new Hilo3d.PBRMaterial({ name, unlit: true, baseColor: color(tint), opacity,
        compositing: { mode: 'alpha-blend', premultiplied: false }, state: { depthWrite: false }, cullMode: 'none' });
      return { geometry, data, mesh: this.mesh(name, geometry, material) };
    };
    this.rain = cloud('living / 112 fine rain streaks', 0xa2c6d4, .48);
    this.snow = cloud('living / 112 drifting snowflakes', 0xf2f6f8, .83);
    this.rain.mesh.renderOrder = 3; this.snow.mesh.renderOrder = 3;
    this.snowMaterial = new Hilo3d.ShaderMaterial({ name: 'living / lit island snow cover',
      vs: snowVertex, fs: snowFragment,
      attributes: { a_position: Hilo3d.MaterialAttributeSemantic.POSITION, a_normal: Hilo3d.MaterialAttributeSemantic.NORMAL },
      uniformBlocks: { LivingSnowParams: this.snowBuffer },
      compositing: { mode: 'alpha-blend', premultiplied: false }, state: { depthWrite: false }, cullMode: 'none',
    });
    const groundGeometry = snowGroundGeometry(); this.geometries.push(groundGeometry);
    this.ground = this.mesh('living / accumulated ground snow', groundGeometry, this.snowMaterial);
    this.ground.renderOrder = 1;
    const ring = rippleGeometry(); this.geometries.push(ring);
    for (let i = 0; i < 2; i++) {
      const material = new Hilo3d.PBRMaterial({ name: `living / rain impact ${i}`, unlit: true,
        baseColor: color(0xc5dedf), opacity: 0, compositing: { mode: 'alpha-blend', premultiplied: false },
        state: { depthWrite: false }, cullMode: 'none' });
      this.ripples.push({ mesh: this.mesh(`living / rain circle ${i}`, ring, material), material, bornAt: -100 });
    }
  }

  update(_dt: number, world: LivingWorld, elapsed: number): void {
    if (this.disposed || !Number.isFinite(elapsed)) return;
    const reset = elapsed < this.lastElapsed || (elapsed === 0 && world !== this.lastWorld);
    if (reset) {
      this.rainCycles.fill(NaN);
      for (const ripple of this.ripples) { ripple.bornAt = -100; ripple.mesh.visible = false; }
    }
    const kindChanged = world.weather.kind !== this.lastKind;
    if (world.weather.changedAt !== this.changedAt || kindChanged) {
      this.rainCycles.fill(NaN); this.changedAt = world.weather.changedAt;
    }
    const advancing = elapsed > this.lastElapsed;
    this.lastElapsed = elapsed; this.lastWorld = world; this.lastKind = world.weather.kind;
    this.rain.mesh.visible = world.weather.kind === 'rain';
    this.snow.mesh.visible = world.weather.kind === 'snow';
    const camera = this.stage.camera;
    if (camera) {
      camera.updateViewProjectionMatrix();
      if (advancing || reset || kindChanged) this.updateNearFocus(camera);
      if (this.rain.mesh.visible) this.updateCloud(this.rain, 'rain', elapsed, advancing, camera);
      if (this.snow.mesh.visible) this.updateCloud(this.snow, 'snow', elapsed, advancing, camera);
      this.snowBuffer.set('uViewProjection', camera.viewProjectionMatrix.elements);
    }
    this.updateSnowLighting(world, elapsed);
    for (const ripple of this.ripples) {
      const age = elapsed - ripple.bornAt;
      ripple.mesh.visible = age >= 0 && age < .48;
      if (!ripple.mesh.visible) continue;
      const radius = .07 + age * .5; ripple.mesh.setScale(radius, 1, radius);
      ripple.material.opacity = .38 * (1 - age / .48);
    }
  }

  private updateCloud(cloud: CloudGeometry, kind: 'rain' | 'snow', elapsed: number,
    advancing: boolean, camera: Hilo3d.Camera): void {
    const m = camera.worldMatrix.elements;
    const rx = m[0]!, ry = m[1]!, rz = m[2]!, ux = m[4]!, uy = m[5]!, uz = m[6]!;
    for (let i = 0; i < COUNT; i++) {
      const seed = this.seeds[i]!;
      const near = i >= 80, span = near ? this.nearFocus.height : 12;
      const seedX = near ? this.nearFocus.x + seed.x * this.nearFocus.radius : seed.x;
      const seedZ = near ? this.nearFocus.z + seed.z * this.nearFocus.radius : seed.z;
      const speed = (kind === 'rain' ? 9.8 + seed.speed * 4.6 : .46 + seed.speed * .28) / span;
      const cycle = seed.phase + elapsed * speed, phase = fract(cycle), height = (1 - phase) * span;
      const x = seedX + (kind === 'rain' ? phase * span * .094 : Math.sin(elapsed * .46 + i * 1.7) * .40 + phase * .45);
      const z = seedZ + (kind === 'rain' ? phase * .14 : Math.cos(elapsed * .32 + i * .8) * .24);
      const y = surface(x, z) + .055 + height;
      let ax: number, ay: number, az: number, bx: number, by: number, bz: number;
      if (kind === 'rain') {
        const width = .012 + seed.size * .007, length = .48 + seed.size * .35;
        ax = rx * width; ay = ry * width; az = rz * width;
        bx = -length * .14; by = length; bz = -length * .025;
        if (advancing && i % 29 === 0 && Number.isFinite(this.rainCycles[i]!) && Math.floor(cycle) > this.rainCycles[i]!) {
          const impactX = seedX + span * .094, impactZ = seedZ + .14;
          this.rainImpact(impactX, surface(impactX, impactZ) + .032, impactZ, elapsed);
        }
        this.rainCycles[i] = Math.floor(cycle);
      } else {
        const angle = elapsed * (.32 + seed.speed * .34) + i * 2.1;
        const size = (.043 + seed.size * .058) * (near ? .64 : 1), flutter = .72 + .22 * Math.sin(elapsed * .75 + i);
        const cosine = Math.cos(angle), sine = Math.sin(angle);
        ax = (rx * cosine + ux * sine) * size; ay = (ry * cosine + uy * sine) * size; az = (rz * cosine + uz * sine) * size;
        bx = (-rx * sine + ux * cosine) * size * flutter * 2;
        by = (-ry * sine + uy * cosine) * size * flutter * 2;
        bz = (-rz * sine + uz * cosine) * size * flutter * 2;
      }
      const px = kind === 'snow' ? x - bx * .5 : x, py = kind === 'snow' ? y - by * .5 : y, pz = kind === 'snow' ? z - bz * .5 : z;
      const offset = i * 12, data = cloud.data;
      data[offset] = px - ax; data[offset + 1] = py - ay; data[offset + 2] = pz - az;
      data[offset + 3] = px + ax; data[offset + 4] = py + ay; data[offset + 5] = pz + az;
      data[offset + 6] = px + ax + bx; data[offset + 7] = py + ay + by; data[offset + 8] = pz + az + bz;
      data[offset + 9] = px - ax + bx; data[offset + 10] = py - ay + by; data[offset + 11] = pz - az + bz;
    }
    cloud.geometry.vertices!.isDirty = true;
    cloud.geometry.isDirty = true;
  }

  private updateNearFocus(camera: Hilo3d.Camera): void {
    const m = camera.worldMatrix.elements;
    const dy = -m[9]!, distance = dy < -.02 ? Math.max(0, -m[13]! / dy) : 8;
    this.nearFocus.x = Math.max(-11.5, Math.min(11.5, m[12]! - m[8]! * distance));
    this.nearFocus.z = Math.max(-8.5, Math.min(8.5, m[14]! - m[10]! * distance));
    this.nearFocus.radius = Math.max(2.3, Math.min(5.2, Math.abs(m[13]!) * .29));
    this.nearFocus.height = Math.max(2.6, Math.min(7.2, Math.abs(m[13]!) * .75));
  }

  private syncCamera(): void {
    // Stage's public onUpdate hook runs after the controller's follow-camera
    // adjustment and before drawing, including tick(0) photo capture.
    const camera = this.stage.camera;
    if (this.disposed || !camera) return;
    camera.updateViewProjectionMatrix();
    this.snowBuffer.set('uViewProjection', camera.viewProjectionMatrix.elements);
    this.snowMaterial.invalidateData();
  }

  private updateSnowLighting(world: LivingWorld, elapsed: number): void {
    const snow = clamp01(world.weather.snow);
    this.ground.visible = snow > .005;
    this.weatherData.set([snow, elapsed, clamp01(world.weather.wetness), 0]);
    this.sunColor.fill(0); this.ambientColor.fill(0);
    const sun = this.directional.find((light) => light.enabled);
    if (sun) {
      this.sunDirection.set([sun.direction.x, sun.direction.y, sun.direction.z, 0]);
      this.sunColor.set([sun.color.r * sun.amount, sun.color.g * sun.amount, sun.color.b * sun.amount, 0]);
    }
    for (const light of this.ambient) if (light.enabled) {
      this.ambientColor[0] = this.ambientColor[0]! + light.color.r * light.amount;
      this.ambientColor[1] = this.ambientColor[1]! + light.color.g * light.amount;
      this.ambientColor[2] = this.ambientColor[2]! + light.color.b * light.amount;
    }
    this.fireData[2] = world.campfire.lit ? clamp01(world.campfire.heat) : 0;
    this.snowBuffer.set('uWeather', this.weatherData); this.snowBuffer.set('uSunDirection', this.sunDirection);
    this.snowBuffer.set('uSunColor', this.sunColor); this.snowBuffer.set('uAmbient', this.ambientColor);
    this.snowBuffer.set('uTree', this.treeData); this.snowBuffer.set('uFire', this.fireData);
    this.snowMaterial.invalidateData();
  }

  private rainImpact(x: number, y: number, z: number, elapsed: number): void {
    if (terrainBaseHeight(x, z) < SEA_LEVEL + .05) return;
    const ripple = this.ripples.find((item) => elapsed - item.bornAt >= .48);
    if (!ripple) return;
    ripple.bornAt = elapsed; ripple.mesh.setPosition(x, y, z); ripple.mesh.invalidateTransformHistory();
  }

  private mesh(name: string, geometry: Hilo3d.Geometry, material: Hilo3d.MaterialInstance): Hilo3d.Mesh {
    const mesh = new Hilo3d.Mesh({ name, geometry, material, visible: false, pointerEnabled: false,
      useInstanced: false, frustumTest: false, castShadows: false, receiveShadows: false }).addTo(this.root);
    this.meshes.push(mesh); return mesh;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.onUpdate = null;
    for (const mesh of this.meshes) mesh.destroy(this.stage.renderer, true);
    this.root.destroy(this.stage.renderer);
    for (const geometry of this.geometries) {
      geometry.vertices = null; geometry.normals = null; geometry.colors = null; geometry.indices = null;
    }
    this.meshes.length = 0; this.geometries.length = 0; this.seeds.length = 0;
    this.ripples.length = 0; this.directional.length = 0; this.ambient.length = 0; this.lastWorld = null;
  }
}
