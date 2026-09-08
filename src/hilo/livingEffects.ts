import * as Hilo3d from 'hilo3d';
import { LIVING_POINTS } from '../ecology/livingContent.ts';
import { isInRiver, isOnBridge, terrainBaseHeight, waterSurfaceHeight } from '../ecology/layout.ts';
import type { EcologyPoint } from '../ecology/layout.ts';
import type { LivingEffect, LivingEffectResident, LivingFruit, LivingWorld } from '../ecology/livingTypes.ts';
import { LivingWeatherEffects } from './livingWeatherEffects.ts';
import { LivingElementalEffects, createLivingEmitterFrame } from './livingElementalEffects.ts';

type Point3 = { x: number; y: number; z: number };
type ParticleKind = 'water' | 'fire' | 'gold' | 'pollen' | 'crumb';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => { const t = clamp01(value); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const linear = (value: number): number => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const color = (hex: number): Hilo3d.Color => new Hilo3d.Color(
  linear((hex >> 16 & 255) / 255), linear((hex >> 8 & 255) / 255), linear((hex & 255) / 255));

/** Same subtle canopy movement is used by the authored tree and its ripe fruit. */
export function livingTreeShakeOffset(elapsed: number, shakeAt: number, out: EcologyPoint): void {
  const age = elapsed - shakeAt;
  const envelope = age >= 0 && age < 1.15 ? Math.exp(-age * 2.2) * (1 - age / 1.15) : 0;
  out.x = Math.sin(age * 35) * .15 * envelope;
  out.z = Math.sin(age * 27) * .07 * envelope;
}

// Five well-separated attachment points on the authored front crown.  The
// source GLB's ornamental Fruit_hero-fruit-tree batch is hidden by Landscape.
const CROWN_OFFSETS: readonly Point3[] = [
  { x: -3.04, y: 4.696, z: 1.062 }, { x: -1.551, y: 4.922, z: 2.323 },
  { x: .818, y: 4.903, z: 2.640 }, { x: 2.636, y: 4.813, z: 1.708 },
  { x: 2.252, y: 6.179, z: -.566 },
];

function groundAt(x: number, z: number): number {
  return isInRiver(x, z) && !isOnBridge(x, z) ? waterSurfaceHeight(z) : terrainBaseHeight(x, z);
}

/** Small colored triangle builder. All generated geometry is created once. */
class Shape {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];

  triangle(a: readonly number[], b: readonly number[], c: readonly number[], shade: Hilo3d.Color, alpha = 1): void {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-8) return;
    for (const point of [a, b, c]) {
      this.positions.push(point[0]!, point[1]!, point[2]!);
      this.normals.push(nx / length, ny / length, nz / length);
      this.colors.push(shade.r, shade.g, shade.b, alpha);
    }
  }

  geometry(): Hilo3d.Geometry {
    return new Hilo3d.Geometry({
      vertices: new Hilo3d.GeometryData(new Float32Array(this.positions), 3),
      normals: new Hilo3d.GeometryData(new Float32Array(this.normals), 3),
      colors: new Hilo3d.GeometryData(new Float32Array(this.colors), 4),
    });
  }
}

function fruitGeometry(cut: number): Hilo3d.Geometry {
  const shape = new Shape(), peel = color(0xf4a35c), flesh = color(0xffedb8);
  const normal = [.24, .61, .755], norm = Math.hypot(...normal);
  const n = normal.map((value) => value / norm);
  const rows: number[][][] = [];
  const isCut = (point: readonly number[]): boolean => point[0]! * n[0]! + point[1]! * n[1]! + point[2]! * n[2]! >= cut - 1e-5;
  for (let row = 0; row <= 8; row++) {
    const points: number[][] = [];
    for (let column = 0; column <= 12; column++) {
      const latitude = Math.PI * row / 8, angle = Math.PI * 2 * column / 12;
      const point = [Math.sin(latitude) * Math.cos(angle), Math.cos(latitude), Math.sin(latitude) * Math.sin(angle)];
      const beyond = Math.max(0, point[0]! * n[0]! + point[1]! * n[1]! + point[2]! * n[2]! - cut);
      for (let axis = 0; axis < 3; axis++) point[axis] = point[axis]! - n[axis]! * beyond;
      points.push(point);
    }
    rows.push(points);
  }
  for (let row = 0; row < 8; row++) for (let column = 0; column < 12; column++) {
    const a = rows[row]![column]!, b = rows[row + 1]![column]!;
    const c = rows[row + 1]![column + 1]!, d = rows[row]![column + 1]!;
    shape.triangle(a, c, b, isCut(a) && isCut(b) && isCut(c) ? flesh : peel);
    shape.triangle(a, d, c, isCut(a) && isCut(c) && isCut(d) ? flesh : peel);
  }
  if (cut > .7) {
    const bark = color(0x705139), leaf = color(0x8da65b);
    for (let side = 0; side < 5; side++) {
      const a = side / 5 * Math.PI * 2, b = (side + 1) / 5 * Math.PI * 2;
      const p = [.065 * Math.cos(a), .93, .065 * Math.sin(a)];
      const q = [.065 * Math.cos(b), .93, .065 * Math.sin(b)];
      const r = [.04 + .045 * Math.cos(b), 1.29, .045 * Math.sin(b)];
      const s = [.04 + .045 * Math.cos(a), 1.29, .045 * Math.sin(a)];
      shape.triangle(p, r, q, bark); shape.triangle(p, s, r, bark);
    }
    shape.triangle([.03, 1.19, 0], [.54, 1.22, .03], [.32, 1.27, -.12], leaf);
    shape.triangle([.03, 1.19, 0], [.27, 1.13, .15], [.54, 1.22, .03], leaf);
  }
  return shape.geometry();
}

function ringGeometry(): Hilo3d.Geometry {
  const shape = new Shape(), white = color(0xffffff);
  for (let i = 0; i < 28; i++) {
    const a = i / 28 * Math.PI * 2, b = (i + 1) / 28 * Math.PI * 2;
    const p = [Math.cos(a), 0, Math.sin(a)], q = [Math.cos(b), 0, Math.sin(b)];
    const r = [.88 * Math.cos(b), 0, .88 * Math.sin(b)], s = [.88 * Math.cos(a), 0, .88 * Math.sin(a)];
    shape.triangle(p, r, q, white); shape.triangle(p, s, r, white);
  }
  return shape.geometry();
}

function flameGeometry(): Hilo3d.Geometry {
  const shape = new Shape(), white = color(0xffffff);
  const radii = [.25, .46, .33, .20, .075, 0], heights = [0, .18, .48, .78, 1.03, 1.24];
  for (let row = 0; row < radii.length - 1; row++) for (let side = 0; side < 9; side++) {
    const point = (ring: number, index: number): number[] => {
      const angle = index / 9 * Math.PI * 2 + ring * .13;
      return [Math.cos(angle) * radii[ring]! + .11 * Math.sin(ring * .62), heights[ring]!, Math.sin(angle) * radii[ring]!];
    };
    const a = point(row, side), b = point(row, side + 1), c = point(row + 1, side + 1), d = point(row + 1, side);
    shape.triangle(a, c, b, white); shape.triangle(a, d, c, white);
  }
  return shape.geometry();
}

function glowGeometry(): Hilo3d.Geometry {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  for (let i = 0; i < 32; i++) {
    const a = i / 32 * Math.PI * 2, b = (i + 1) / 32 * Math.PI * 2;
    for (const [x, z, alpha] of [[0, 0, 1], [Math.cos(b), Math.sin(b), 0], [Math.cos(a), Math.sin(a), 0]]) {
      positions.push(x!, 0, z!); normals.push(0, 1, 0); colors.push(1, 1, 1, alpha!);
    }
  }
  return new Hilo3d.Geometry({ vertices: new Hilo3d.GeometryData(new Float32Array(positions), 3),
    normals: new Hilo3d.GeometryData(new Float32Array(normals), 3), colors: new Hilo3d.GeometryData(new Float32Array(colors), 4) });
}

interface FruitView {
  mesh: Hilo3d.Mesh; id: number | null; origin: Point3; remaining: number;
  seen: boolean; retiring: number; size: number;
}
interface Particle {
  mesh: Hilo3d.Mesh; active: boolean; kind: ParticleKind; age: number; life: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  gravity: number; size: number;
}
interface Ripple { mesh: Hilo3d.Mesh; material: Hilo3d.PBRMaterial; age: number; life: number; size: number }

/** Disposable view state only. This class never advances actions or discoveries. */
export class LivingEffects {
  private readonly root = new Hilo3d.Node({ name: 'living / pooled effects', pointerEnabled: false });
  private readonly meshes: Hilo3d.Mesh[] = [];
  private readonly geometries: Hilo3d.Geometry[] = [];
  private readonly materials: Hilo3d.PBRMaterial[] = [];
  private readonly fruitGeometries: Hilo3d.Geometry[] = [];
  private readonly fruitViews: FruitView[] = [];
  private readonly ripe: Hilo3d.Mesh[] = [];
  private readonly particles: Particle[] = [];
  private readonly ripples: Ripple[] = [];
  private readonly flames: Hilo3d.Mesh[] = [];
  private readonly effectKeys = new Map<string, number>();
  private readonly particleMaterials: Record<ParticleKind, Hilo3d.PBRMaterial>;
  private readonly glow: Hilo3d.Mesh;
  private readonly glowMaterial: Hilo3d.PBRMaterial;
  private readonly fireLight: Hilo3d.PointLight;
  private readonly weatherEffects: LivingWeatherEffects;
  private readonly elementalEffects: LivingElementalEffects;
  private readonly emitter = createLivingEmitterFrame();
  private readonly shake = { x: 0, z: 0 };
  private previousMature = 0;
  private lastElapsed = -1;
  private lastWorld: LivingWorld | null = null;
  private emberTime = 0;
  private randomState = 20260908;
  private disposed = false;

  constructor(private readonly stage: Hilo3d.Stage) {
    this.root.addTo(stage);
    const fruitMaterial = this.material({ name: 'living / peach peel and fresh bite', baseColor: color(0xffffff), roughness: .66, metallic: 0, cullMode: 'none' });
    for (const cut of [1.5, .63, .17, -.27]) this.fruitGeometries.push(this.geometry(fruitGeometry(cut)));
    for (let i = 0; i < 6; i++) this.fruitViews.push({
      mesh: this.mesh(`living / fruit ${i}`, this.fruitGeometries[0]!, fruitMaterial, true),
      id: null, origin: { x: 0, y: 0, z: 0 }, remaining: 1, seen: false, retiring: 0, size: .23,
    });
    for (let i = 0; i < 5; i++) this.ripe.push(this.mesh(`living / ripe fruit ${i + 1}`, this.fruitGeometries[0]!, fruitMaterial));
    const sphere = this.geometry(new Hilo3d.SphereGeometry({ radius: 1, widthSegments: 7, heightSegments: 5 }));
    const unlit = (name: string, tint: number, emission = 0): Hilo3d.PBRMaterial => {
      const pigment = color(tint);
      return this.material({
        name: `living / ${name}`, unlit: true, baseColor: pigment, roughness: .75,
        // Constant emission is the colored factor. A neutral gray factor would
        // wash all three RGB channels into a white flame in the native pipeline.
        ...(emission ? { emissionFactor: new Hilo3d.Color(pigment.r * emission, pigment.g * emission, pigment.b * emission) } : {}),
      });
    };
    this.particleMaterials = { water: unlit('water droplets', 0x80d8e2), fire: unlit('orange fire', 0xff9b3d, .7),
      gold: unlit('warm sparks', 0xffdc78, .45), pollen: unlit('fine flower pollen', 0xf5df8d), crumb: unlit('fruit crumbs', 0xffd48b) };
    for (let i = 0; i < 32; i++) this.particles.push({ mesh: this.mesh(`living / particle ${i}`, sphere, this.particleMaterials.water),
      active: false, kind: 'water', age: 0, life: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, gravity: 0, size: .05 });
    const ring = this.geometry(ringGeometry());
    for (let i = 0; i < 4; i++) {
      const material = this.material({ name: `living / ripple ${i}`, unlit: true, baseColor: color(0xb6e7df),
        opacity: 0, compositing: { mode: 'alpha-blend', premultiplied: false }, state: { depthWrite: false }, cullMode: 'none' });
      this.ripples.push({ mesh: this.mesh(`living / water ring ${i}`, ring, material), material, age: 2, life: 1, size: .6 });
    }
    const flame = this.geometry(flameGeometry());
    for (let i = 0; i < 3; i++) this.flames.push(this.mesh(`living / campfire tongue ${i}`, flame,
      i === 1 ? this.particleMaterials.gold : this.particleMaterials.fire));
    this.glowMaterial = this.material({ name: 'living / fire warmth on ground', unlit: true, baseColor: color(0xffb459), opacity: 0,
      compositing: { mode: 'alpha-blend', premultiplied: false }, state: { depthWrite: false }, cullMode: 'none' });
    this.glow = this.mesh('living / fire warmth', this.geometry(glowGeometry()), this.glowMaterial);
    this.fireLight = new Hilo3d.PointLight({ name: 'living / campfire warm light', color: color(0xffb660),
      x: LIVING_POINTS.fire.x, y: terrainBaseHeight(LIVING_POINTS.fire.x, LIVING_POINTS.fire.z) + .75,
      z: LIVING_POINTS.fire.z, amount: 0, range: 5.1, enabled: false }).addTo(this.root);
    this.weatherEffects = new LivingWeatherEffects(stage);
    this.elementalEffects = new LivingElementalEffects(stage);
  }

  registerResidentRig(uid: string, pokemonId: string, rig: Hilo3d.Node): void {
    this.elementalEffects.registerResidentRig(uid, pokemonId, rig);
  }

  unregisterResidentRig(uid: string): void { this.elementalEffects.unregisterResidentRig(uid); }

  update(dt: number, world: LivingWorld, residents: readonly LivingEffectResident[], elapsed: number): void {
    if (this.disposed || !Number.isFinite(elapsed)) return;
    const step = Math.max(0, Math.min(.1, Number.isFinite(dt) ? dt : 0));
    if (elapsed < this.lastElapsed || (elapsed === 0 && world !== this.lastWorld)) this.resetView();
    this.lastElapsed = elapsed;
    this.lastWorld = world;
    livingTreeShakeOffset(elapsed, world.tree.shakeAt, this.shake);
    const mature = Math.max(0, Math.min(5, Math.floor(world.tree.mature)));
    for (let i = 0; i < this.ripe.length; i++) {
      const mesh = this.ripe[i]!, anchor = CROWN_OFFSETS[i]!;
      mesh.visible = i < mature;
      mesh.setPosition(LIVING_POINTS.tree.x + anchor.x + this.shake.x,
        terrainBaseHeight(LIVING_POINTS.tree.x, LIVING_POINTS.tree.z) + anchor.y,
        LIVING_POINTS.tree.z + anchor.z + this.shake.z);
      mesh.setScale(.255); mesh.rotationZ = this.shake.x * 24;
    }
    for (const view of this.fruitViews) view.seen = false;
    let newlyFallen = 0;
    for (const fruit of world.fruits) {
      let view = this.fruitViews.find((item) => item.id === fruit.id);
      if (!view) {
        view = this.fruitViews.find((item) => item.id === null)
          ?? this.fruitViews.find((item) => !world.fruits.some((candidate) => candidate.id === item.id));
        if (!view) continue;
        view.id = fruit.id; view.remaining = fruit.remaining; view.retiring = 0;
        view.mesh.invalidateTransformHistory();
        if (fruit.source === 'tree') {
          const index = Math.min(4, mature + newlyFallen++);
          const anchor = CROWN_OFFSETS[index] ?? CROWN_OFFSETS[Math.max(0, this.previousMature - 1)]!;
          view.origin.x = LIVING_POINTS.tree.x + anchor.x + this.shake.x;
          view.origin.y = terrainBaseHeight(LIVING_POINTS.tree.x, LIVING_POINTS.tree.z) + anchor.y;
          view.origin.z = LIVING_POINTS.tree.z + anchor.z + this.shake.z;
        } else {
          const camera = this.stage.camera;
          const dx = (camera?.x ?? fruit.x + 1) - fruit.x, dz = (camera?.z ?? fruit.z + 3) - fruit.z;
          const length = Math.max(.001, Math.hypot(dx, dz));
          view.origin.x = fruit.x + dx / length * 1.75;
          view.origin.y = groundAt(fruit.x, fruit.z) + 1.45;
          view.origin.z = fruit.z + dz / length * 1.75;
        }
      }
      view.seen = true; view.retiring = 0;
      this.updateFruit(view, fruit, elapsed);
    }
    this.previousMature = mature;
    for (const view of this.fruitViews) if (view.id !== null && !view.seen) {
      view.retiring += step;
      view.mesh.setScale(view.size * Math.max(0, 1 - view.retiring / .22));
      if (view.retiring >= .22) { view.id = null; view.mesh.visible = false; }
    }
    for (const resident of residents) {
      const performance = resident.performance;
      if (!performance?.effect) continue;
      const key = `${resident.uid}|${performance.sequenceId}|${performance.stepId}|${performance.effect}`;
      if (!this.effectKeys.has(key)) {
        this.effectKeys.set(key, elapsed);
        this.residentEffect(resident, performance.effect, performance.target);
      }
    }
    for (const [key, at] of this.effectKeys) if (elapsed - at > 120 || this.effectKeys.size > 160) this.effectKeys.delete(key);
    this.updateFire(step, world, elapsed);
    this.updateParticles(step);
    this.weatherEffects.update(step, world, elapsed);
    this.elementalEffects.update(residents, elapsed);
  }

  private updateFruit(view: FruitView, fruit: LivingFruit, elapsed: number): void {
    const remaining = clamp01(fruit.remaining), radius = .23 * (.55 + .45 * Math.cbrt(remaining));
    const progress = clamp01((elapsed - fruit.bornAt) / Math.max(.05, fruit.landedAt - fruit.bornAt));
    const ground = groundAt(fruit.x, fruit.z), landedAge = elapsed - fruit.landedAt;
    const bounce = landedAge >= 0 && landedAge < .38 ? Math.abs(Math.sin(landedAge / .38 * Math.PI * 2)) * .12 * (1 - landedAge / .38) : 0;
    const y = progress < 1 ? lerp(view.origin.y, ground + radius, progress)
      + Math.sin(progress * Math.PI) * (fruit.source === 'player' ? 1.05 : .18) : ground + radius + bounce;
    view.mesh.visible = remaining > .001 && elapsed >= fruit.bornAt;
    view.mesh.setPosition(lerp(view.origin.x, fruit.x, progress), y, lerp(view.origin.z, fruit.z, progress));
    view.mesh.setScale(radius); view.size = radius;
    view.mesh.rotationY = progress < 1 ? progress * 215 + fruit.id * 37 : fruit.id * 37 + 215;
    view.mesh.rotationZ = progress < 1 ? progress * 120 : Math.sin(Math.min(.38, Math.max(0, landedAge)) * 21) * 5 * Math.max(0, 1 - landedAge / .38);
    const bite = remaining > .84 ? 0 : remaining > .49 ? 1 : remaining > .22 ? 2 : 3;
    view.mesh.geometry = this.fruitGeometries[bite]!;
    if (view.remaining - remaining >= .065 && landedAge >= 0) {
      this.crumbs({ x: fruit.x, y: ground + radius * 1.3, z: fruit.z });
      view.remaining = remaining;
    }
  }

  private residentEffect(resident: LivingEffectResident, effect: LivingEffect, target: EcologyPoint | null): void {
    // Continuous elemental performances have their own bounded geometry batches.
    if (effect === 'ignite' || effect === 'splash' || effect === 'electric') return;
    const forward = target ? { x: target.x - resident.x, z: target.z - resident.z }
      : { x: Math.sin(resident.heading), z: Math.cos(resident.heading) };
    const length = Math.max(.001, Math.hypot(forward.x, forward.z));
    const dx = forward.x / length, dz = forward.z / length;
    this.elementalEffects.readEmitter(resident, this.emitter);
    const mouth = this.emitter.mouth;
    if (effect === 'bite') { this.crumbs(mouth); return; }
    if (effect === 'drink') {
      const point = target ?? { x: mouth.x, z: mouth.z };
      this.ripple(point.x, waterSurfaceHeight(point.z) + .035, point.z, .72);
      this.ripple(point.x + .06, waterSurfaceHeight(point.z) + .038, point.z, .52, .22);
      return;
    }
    const count = effect === 'pollen' ? 10 : 3;
    for (let i = 0; i < count; i++) {
      const speed = .25 + this.random() * .75, spread = .65;
      this.particle(effect === 'pollen' ? 'pollen' : 'gold', mouth,
        dx * speed + (this.random() - .5) * spread, .10 + this.random() * .30,
        dz * speed + (this.random() - .5) * spread,
        .7 + this.random() * .6, .027 + this.random() * .025, -.08, i * .014);
    }
  }

  private updateFire(dt: number, world: LivingWorld, elapsed: number): void {
    const fire = world.campfire;
    const strength = fire.lit ? clamp01(fire.heat) * smooth((elapsed - fire.litAt) / .75) : 0;
    const base = terrainBaseHeight(LIVING_POINTS.fire.x, LIVING_POINTS.fire.z);
    for (let i = 0; i < this.flames.length; i++) {
      const flame = this.flames[i]!, phase = elapsed * (9.3 + i * .7) + i * 2.1;
      flame.visible = strength > .005;
      flame.setPosition(LIVING_POINTS.fire.x + (i - 1) * .18, base + .19, LIVING_POINTS.fire.z + Math.sin(i * 2.4) * .14);
      flame.setScale((i === 1 ? .48 : .67) * strength, (.67 + .09 * Math.sin(phase)) * strength, .60 * strength);
      flame.rotationZ = Math.sin(phase * .71) * 5; flame.rotationY = elapsed * 14 + i * 91;
    }
    this.glow.visible = strength > .005;
    this.glow.setPosition(LIVING_POINTS.fire.x, base + .019, LIVING_POINTS.fire.z);
    this.glow.setScale(2.35 + strength * .4, 1, 2.35 + strength * .4);
    this.glowMaterial.opacity = strength * .20;
    this.fireLight.enabled = fire.lit && strength > .01;
    this.fireLight.amount = strength * (2.4 + Math.sin(elapsed * 12.7) * .17);
    if (!fire.lit) { this.emberTime = 0; return; }
    this.emberTime += dt * strength;
    if (this.emberTime > .22) {
      this.emberTime %= .22;
      this.particle('gold', { x: LIVING_POINTS.fire.x, y: base + .56, z: LIVING_POINTS.fire.z },
        (this.random() - .5) * .22, .65 + this.random() * .3, (this.random() - .5) * .22, .9, .024, .15);
    }
  }

  private crumbs(point: Point3): void {
    for (let i = 0; i < 4; i++) this.particle('crumb', point,
      (this.random() - .5) * .75, .35 + this.random() * .45, (this.random() - .5) * .75, .38, .025 + this.random() * .017, 2.8);
  }

  private particle(kind: ParticleKind, point: Point3, vx: number, vy: number, vz: number,
    life: number, size: number, gravity: number, delay = 0): void {
    const slot = this.particles.find((item) => !item.active);
    if (!slot) return;
    Object.assign(slot, { active: true, kind, x: point.x, y: point.y, z: point.z, vx, vy, vz, life, size, gravity, age: -delay });
    slot.mesh.material = this.particleMaterials[kind]; slot.mesh.visible = false;
    slot.mesh.invalidateTransformHistory();
  }

  private ripple(x: number, y: number, z: number, size: number, delay = 0): void {
    const ripple = this.ripples.find((item) => item.age >= item.life);
    if (!ripple) return;
    ripple.age = -delay; ripple.life = .9; ripple.size = size;
    ripple.mesh.setPosition(x, y, z); ripple.mesh.visible = false;
    ripple.mesh.invalidateTransformHistory();
  }

  private updateParticles(dt: number): void {
    for (const item of this.particles) {
      if (!item.active) continue;
      item.age += dt;
      if (item.age >= item.life) { item.active = false; item.mesh.visible = false; continue; }
      if (item.age < 0) continue;
      const age = item.age, decay = Math.max(.05, 1 - age / item.life);
      item.mesh.visible = true;
      item.mesh.setPosition(item.x + item.vx * age, item.y + item.vy * age - .5 * item.gravity * age * age, item.z + item.vz * age);
      const size = item.size * (item.kind === 'water' ? .70 + .30 * decay : Math.sqrt(decay));
      item.mesh.setScale(size, size * (item.kind === 'water' ? 1.38 : 1), size);
    }
    for (const ripple of this.ripples) {
      ripple.age += dt;
      ripple.mesh.visible = ripple.age >= 0 && ripple.age < ripple.life;
      if (!ripple.mesh.visible) continue;
      const progress = ripple.age / ripple.life;
      ripple.mesh.setScale(ripple.size * (.2 + .8 * progress), 1, ripple.size * (.2 + .8 * progress));
      ripple.material.opacity = (1 - progress) * .56;
    }
  }

  private random(): number { this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0; return this.randomState / 4294967296; }
  private geometry<T extends Hilo3d.Geometry>(geometry: T): T { this.geometries.push(geometry); return geometry; }
  private material(parameters: Hilo3d.PBRMaterialParameters): Hilo3d.PBRMaterial {
    const material = new Hilo3d.PBRMaterial(parameters); this.materials.push(material); return material;
  }
  private mesh(name: string, geometry: Hilo3d.Geometry, material: Hilo3d.PBRMaterial, shadows = false): Hilo3d.Mesh {
    const mesh = new Hilo3d.Mesh({ name, geometry, material, visible: false, pointerEnabled: false,
      castShadows: shadows, receiveShadows: shadows, useInstanced: true }).addTo(this.root);
    this.meshes.push(mesh); return mesh;
  }
  private resetView(): void {
    this.elementalEffects.reset();
    this.effectKeys.clear(); this.previousMature = 0; this.emberTime = 0; this.randomState = 20260908;
    for (const fruit of this.fruitViews) { fruit.id = null; fruit.mesh.visible = false; fruit.retiring = 0; }
    for (const item of this.particles) { item.active = false; item.mesh.visible = false; }
    for (const ripple of this.ripples) { ripple.age = ripple.life; ripple.mesh.visible = false; }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.weatherEffects.destroy();
    this.elementalEffects.destroy();
    this.fireLight.enabled = false; this.fireLight.amount = 0;
    this.fireLight.destroy(this.stage.renderer);
    // Mesh.destroy is the public alpha8 resource boundary: it releases each
    // renderer reference to shared geometry/material bindings before nulling them.
    for (const mesh of this.meshes) mesh.destroy(this.stage.renderer, true);
    this.root.destroy(this.stage.renderer);
    for (const geometry of this.geometries) {
      geometry.vertices = null; geometry.normals = null; geometry.colors = null; geometry.indices = null;
    }
    this.meshes.length = 0; this.materials.length = 0; this.geometries.length = 0;
    this.fruitGeometries.length = 0; this.fruitViews.length = 0; this.ripe.length = 0;
    this.particles.length = 0; this.ripples.length = 0; this.flames.length = 0; this.effectKeys.clear();
    this.lastWorld = null;
  }
}
