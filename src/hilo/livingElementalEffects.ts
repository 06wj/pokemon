import * as Hilo3d from 'hilo3d';
import { LIVING_POINTS } from '../ecology/livingContent.ts';
import { isInRiver, terrainBaseHeight, waterSurfaceHeight, type EcologyPoint } from '../ecology/layout.ts';
import type { LivingEffectResident } from '../ecology/livingTypes.ts';

type Kind = 'ignite' | 'splash' | 'electric';
type Vec = { x: number; y: number; z: number };
type Tint = { r: number; g: number; b: number };
export interface LivingEmitterFrame { mouth: Vec; leftCheek: Vec; rightCheek: Vec; forward: Vec; right: Vec }
const vector = (): Vec => ({ x: 0, y: 0, z: 0 });
export const createLivingEmitterFrame = (): LivingEmitterFrame => ({ mouth: vector(), leftCheek: vector(), rightCheek: vector(), forward: vector(), right: vector() });
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const smooth = (n: number): number => { const p = clamp(n); return p * p * (3 - 2 * p); };
const fract = (n: number): number => n - Math.floor(n);
const surface = (p: EcologyPoint): number => isInRiver(p.x, p.z) ? waterSurfaceHeight(p.z) : terrainBaseHeight(p.x, p.z);
const FIRE: Tint = { r: 1.22, g: .235, b: .024 }, HEART: Tint = { r: 1.35, g: .93, b: .30 };
const WATER: Tint = { r: .055, g: .43, b: .78 }, FOAM: Tint = { r: .58, g: .95, b: 1.08 };
const ELECTRIC: Tint = { r: 1.10, g: .66, b: .025 }, WHITE: Tint = { r: 1.20, g: 1.16, b: .73 };

Hilo3d.registerUniformBlockBinding('LivingElementalView');
const viewLayout = Hilo3d.createStd140Layout({ uViewProjection: 'mat4' });
const vertexShader = `#version 300 es
precision highp float;
in vec3 a_position; in vec4 a_color;
out vec4 vTint;
layout(std140) uniform LivingElementalView { mat4 uViewProjection; };
void main(){vTint=a_color;gl_Position=uViewProjection*vec4(a_position,1.0);}`;
const fragmentShader = `#version 300 es
precision highp float;
in vec4 vTint;out vec4 fragColor;
void main(){if(vTint.a<.003)discard;fragColor=vec4(vTint.rgb,clamp(vTint.a,0.0,1.0));}`;

/** Fixed-capacity world-space triangle batch; inactive tail is collapsed. */
class Batch {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly geometry: Hilo3d.Geometry;
  readonly mesh: Hilo3d.Mesh;
  private count = 0;
  private previousCount = 0;
  private readonly ringA = Array.from({ length: 6 }, vector);
  private readonly ringB = Array.from({ length: 6 }, vector);
  private readonly disc = Array.from({ length: 24 }, vector);

  constructor(root: Hilo3d.Node, material: Hilo3d.ShaderMaterial, name: string, private readonly capacity: number, order: number) {
    this.positions = new Float32Array(capacity * 3); this.colors = new Float32Array(capacity * 4);
    this.geometry = new Hilo3d.Geometry({ isStatic: false,
      vertices: new Hilo3d.GeometryData(this.positions, 3), colors: new Hilo3d.GeometryData(this.colors, 4) });
    this.mesh = new Hilo3d.Mesh({ name: `living / elemental ${name}`, geometry: this.geometry, material,
      visible: false, useInstanced: false, frustumTest: false, pointerEnabled: false,
      castShadows: false, receiveShadows: false, renderOrder: order }).addTo(root);
  }

  begin(): void { this.count = 0; }
  private vertex(point: Vec, tint: Tint, alpha: number): void {
    const i = this.count++;
    this.positions[i * 3] = point.x; this.positions[i * 3 + 1] = point.y; this.positions[i * 3 + 2] = point.z;
    this.colors[i * 4] = tint.r; this.colors[i * 4 + 1] = tint.g; this.colors[i * 4 + 2] = tint.b; this.colors[i * 4 + 3] = alpha;
  }
  triangle(a: Vec, b: Vec, c: Vec, tint: Tint, alpha: number, alphaB = alpha, alphaC = alpha): void {
    if (this.count + 3 > this.capacity) return;
    this.vertex(a, tint, alpha); this.vertex(b, tint, alphaB); this.vertex(c, tint, alphaC);
  }

  private ring(path: readonly Vec[], index: number, radius: number, out: Vec[]): void {
    const point = path[index]!, a = path[Math.max(0, index - 1)]!, b = path[Math.min(path.length - 1, index + 1)]!;
    let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
    const length = Math.max(1e-7, Math.hypot(tx, ty, tz)); tx /= length; ty /= length; tz /= length;
    const flat = Math.hypot(tx, tz), sx = flat > 1e-5 ? tz / flat : 1, sz = flat > 1e-5 ? -tx / flat : 0;
    const ux = ty * sz, uy = tz * sx - tx * sz, uz = -ty * sx;
    for (let side = 0; side < 6; side++) {
      const angle = side / 6 * Math.PI * 2, c = Math.cos(angle) * radius, s = Math.sin(angle) * radius;
      out[side]!.x = point.x + sx * c + ux * s;
      out[side]!.y = point.y + uy * s;
      out[side]!.z = point.z + sz * c + uz * s;
    }
  }

  tube(path: readonly Vec[], radii: ArrayLike<number>, tint: Tint, alpha: number, scale = 1): void {
    if (alpha < .003) return;
    for (let i = 0; i < path.length - 1; i++) {
      this.ring(path, i, radii[i]! * scale, this.ringA);
      this.ring(path, i + 1, radii[i + 1]! * scale, this.ringB);
      for (let side = 0; side < 6; side++) {
        const next = (side + 1) % 6;
        this.triangle(this.ringA[side]!, this.ringB[side]!, this.ringB[next]!, tint, alpha);
        this.triangle(this.ringA[side]!, this.ringB[next]!, this.ringA[next]!, tint, alpha);
      }
    }
  }

  dot(point: Vec, radius: number, tint: Tint, alpha: number, camera: Hilo3d.Camera): void {
    if (alpha < .003 || radius < .001) return;
    const m = camera.worldMatrix.elements;
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * Math.PI * 2, x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
      this.disc[i]!.x = point.x + m[0]! * x + m[4]! * y;
      this.disc[i]!.y = point.y + m[1]! * x + m[5]! * y;
      this.disc[i]!.z = point.z + m[2]! * x + m[6]! * y;
    }
    for (let i = 0; i < 8; i++) this.triangle(point, this.disc[i]!, this.disc[(i + 1) % 8]!, tint, alpha, 0, 0);
  }

  ripple(point: Vec, radius: number, tint: Tint, alpha: number): void {
    if (alpha < .003) return;
    for (let i = 0; i < 12; i++) for (let edge = 0; edge < 2; edge++) {
      const angle = i / 12 * Math.PI * 2, r = radius * (edge ? .84 : 1), out = this.disc[i * 2 + edge]!;
      out.x = point.x + Math.cos(angle) * r; out.y = point.y; out.z = point.z + Math.sin(angle) * r;
    }
    for (let i = 0; i < 12; i++) {
      const a = i * 2, b = (i + 1) % 12 * 2;
      this.triangle(this.disc[a]!, this.disc[a + 1]!, this.disc[b]!, tint, alpha);
      this.triangle(this.disc[a + 1]!, this.disc[b + 1]!, this.disc[b]!, tint, alpha);
    }
  }

  finish(): void {
    if (this.count < this.previousCount) {
      this.positions.fill(0, this.count * 3, this.previousCount * 3);
      this.colors.fill(0, this.count * 4, this.previousCount * 4);
    }
    this.mesh.visible = this.count > 0;
    if (this.count > 0 || this.previousCount > 0) {
      this.geometry.vertices!.isDirty = true; this.geometry.colors!.isDirty = true; this.geometry.isDirty = true;
    }
    this.previousCount = this.count;
  }

  destroy(renderer: Hilo3d.Renderer): void {
    this.mesh.destroy(renderer, true); this.geometry.vertices = null; this.geometry.colors = null;
  }
}

interface RigBinding { rig: Hilo3d.Node; head: Hilo3d.Node | null; mouth: Hilo3d.Node | null; left: Hilo3d.Node | null; right: Hilo3d.Node | null }
interface Burst {
  key: string; uid: string; kind: Kind; seen: boolean; startedAt: number; releaseAt: number;
  duration: number; progress: number; strength: number; height: number; seed: number;
  emitter: LivingEmitterFrame; goal: Vec; path: Vec[]; radii: Float32Array;
  arcs: Vec[][]; arcRadii: Float32Array; scratch: Vec;
}

/** Short local elemental performances. Geometry is pooled and shared by type. */
export class LivingElementalEffects {
  private readonly root = new Hilo3d.Node({ name: 'living / elemental performances', pointerEnabled: false,
    onUpdate: () => this.syncCamera() });
  private readonly view = new Hilo3d.UniformBuffer(viewLayout);
  private readonly material: Hilo3d.ShaderMaterial;
  private readonly batches: Batch[];
  private readonly fireOuter: Batch;
  private readonly fireCore: Batch;
  private readonly waterOuter: Batch;
  private readonly waterCore: Batch;
  private readonly electricOuter: Batch;
  private readonly electricCore: Batch;
  private readonly motes: Batch;
  private readonly ripples: Batch;
  private readonly slots: Burst[] = [];
  private readonly bindings = new Map<string, RigBinding>();
  private readonly triggered = new Map<string, number>();
  private lastElapsed = -1;
  private disposed = false;

  constructor(private readonly stage: Hilo3d.Stage) {
    this.root.addTo(stage);
    this.material = new Hilo3d.ShaderMaterial({ name: 'living / soft elemental colors', vs: vertexShader, fs: fragmentShader,
      attributes: { a_position: Hilo3d.MaterialAttributeSemantic.POSITION, a_color: Hilo3d.MaterialAttributeSemantic.COLOR_0 },
      uniformBlocks: { LivingElementalView: this.view }, cullMode: 'none',
      compositing: { mode: 'alpha-blend', premultiplied: false }, state: { depthWrite: false } });
    const batch = (name: string, capacity: number, order: number): Batch => new Batch(this.root, this.material, name, capacity, order);
    this.fireOuter = batch('warm orange flame', 2160, 30); this.fireCore = batch('gold flame heart', 2160, 31);
    this.waterOuter = batch('continuous water arc', 2592, 30); this.waterCore = batch('water highlight', 2592, 31);
    this.electricOuter = batch('soft yellow fork glow', 7200, 30); this.electricCore = batch('fine yellow-white forks', 7200, 31);
    this.motes = batch('tail sparks and impact droplets', 3072, 32); this.ripples = batch('water landing rings', 2160, 29);
    this.batches = [this.fireOuter, this.fireCore, this.waterOuter, this.waterCore, this.electricOuter, this.electricCore, this.motes, this.ripples];
    for (let i = 0; i < 3; i++) this.slots.push({ key: '', uid: '', kind: 'ignite', seen: false, startedAt: 0,
      releaseAt: Infinity, duration: 1, progress: 0, strength: 0, height: .5, seed: i,
      emitter: createLivingEmitterFrame(), goal: vector(), path: Array.from({ length: 19 }, vector), radii: new Float32Array(19),
      arcs: Array.from({ length: 8 }, () => Array.from({ length: 9 }, vector)), arcRadii: new Float32Array(9), scratch: vector() });
  }

  registerResidentRig(uid: string, pokemonId: string, rig: Hilo3d.Node): void {
    const find = (name: string): Hilo3d.Node | null => rig.getChildByFnBFS((node) => node.name === name || node.jointName === name);
    this.bindings.set(uid, { rig, head: find('head'), mouth: find(pokemonId === '025' ? 'nose' : 'jaw'),
      left: find('left_upper_jaw_b'), right: find('right_upper_jaw_b') });
  }

  unregisterResidentRig(uid: string): void { this.bindings.delete(uid); }

  /** Reads current bone matrices; never edits an animation or skins a vertex. */
  readEmitter(resident: LivingEffectResident, out: LivingEmitterFrame): void {
    const h = Math.max(.15, resident.height), f = out.forward, r = out.right;
    f.x = Math.sin(resident.heading); f.y = 0; f.z = Math.cos(resident.heading);
    r.x = Math.cos(resident.heading); r.y = 0; r.z = -Math.sin(resident.heading);
    const binding = this.bindings.get(resident.uid);
    const calibrated = resident.pokemonId === '004' || resident.pokemonId === '007' || resident.pokemonId === '025';
    if (binding?.mouth && calibrated) {
      binding.rig.updateMatrixWorld(true);
      const m = binding.mouth.worldMatrix.elements;
      out.mouth.x = m[12]!; out.mouth.y = m[13]!; out.mouth.z = m[14]!;
      if (binding.head) {
        const head = binding.head.worldMatrix.elements;
        const dx = m[12]! - head[12]!, dy = m[13]! - head[13]!, dz = m[14]! - head[14]!;
        const length = Math.hypot(dx, dy, dz);
        if (length > .005) { f.x = dx / length; f.y = dy / length; f.z = dz / length; }
      }
      if (binding.left && binding.right) {
        const left = binding.left.worldMatrix.elements, right = binding.right.worldMatrix.elements;
        const dx = left[12]! - right[12]!, dy = left[13]! - right[13]!, dz = left[14]! - right[14]!;
        const length = Math.hypot(dx, dy, dz);
        if (length > .005) { r.x = dx / length; r.y = dy / length; r.z = dz / length; }
      }
      // These GLB jaw/nose joints are already in game world units after rig .9
      // scaling and bounds-centering. Only a small lip offset is added.
      out.mouth.x += f.x * h * .055; out.mouth.y += f.y * h * .055; out.mouth.z += f.z * h * .055;
    } else {
      const mouthLevel = resident.pokemonId === '004' ? .58 : resident.pokemonId === '007' ? .72 : resident.pokemonId === '025' ? .54 : .60;
      const forward = resident.pokemonId === '004' ? h * .60 : resident.pokemonId === '007' ? h * .42 : resident.radius * .8;
      out.mouth.x = resident.x + f.x * forward; out.mouth.y = resident.y + h * mouthLevel; out.mouth.z = resident.z + f.z * forward;
    }
    const upX = f.y * r.z - f.z * r.y, upY = f.z * r.x - f.x * r.z, upZ = f.x * r.y - f.y * r.x;
    if (binding?.mouth && calibrated && resident.pokemonId !== '025') {
      // The authored jaw pivots sit above/behind the visible lower lip, rather
      // than on the mouth surface. A face-local downward offset was checked in
      // the actual Charmander/Squirtle Attack poses, including Squirtle's hop.
      const lip = h * (resident.pokemonId === '004' ? .125 : .14);
      out.mouth.x -= upX * lip; out.mouth.y -= upY * lip; out.mouth.z -= upZ * lip;
    }
    const cheek = h * .19 + .008;
    for (const [point, sign] of [[out.leftCheek, 1], [out.rightCheek, -1]] as const) {
      point.x = out.mouth.x - f.x * h * .07 - upX * h * .035 + r.x * cheek * sign;
      point.y = out.mouth.y - f.y * h * .07 - upY * h * .035 + r.y * cheek * sign;
      point.z = out.mouth.z - f.z * h * .07 - upZ * h * .035 + r.z * cheek * sign;
    }
  }

  update(residents: readonly LivingEffectResident[], elapsed: number): void {
    if (this.disposed) return;
    if (elapsed < this.lastElapsed) this.reset();
    this.lastElapsed = elapsed;
    for (const slot of this.slots) slot.seen = false;
    for (const resident of residents) {
      const p = resident.performance, kind = p?.effect;
      if (!p || (kind !== 'ignite' && kind !== 'splash' && kind !== 'electric')) continue;
      const key = `${resident.uid}|${p.sequenceId}|${p.stepId}|${kind}`;
      let slot = this.slots.find((item) => item.key === key);
      if (!slot) {
        if (this.triggered.has(key)) continue;
        slot = this.slots.find((item) => !item.key || elapsed - item.releaseAt >= .18);
        if (!slot) continue;
        const progress = clamp(p.effectProgress ?? 0);
        const fallback = p.duration * (kind === 'electric' ? .6 : .5);
        const duration = progress < .98 && p.effectProgress !== undefined
          ? p.duration * (1 - p.progress) / Math.max(.02, 1 - progress) : fallback;
        slot.key = key; slot.uid = resident.uid; slot.kind = kind; slot.duration = Math.max(.2, Math.min(2.5, duration));
        slot.startedAt = elapsed - progress * slot.duration; slot.releaseAt = Infinity;
        slot.seed = [...key].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % 997;
        this.triggered.set(key, elapsed);
      }
      slot.seen = true; slot.releaseAt = Infinity; slot.height = resident.height;
      slot.progress = clamp(p.effectProgress ?? (elapsed - slot.startedAt) / slot.duration);
      this.readEmitter(resident, slot.emitter);
      const target = p.target ?? (kind === 'ignite' ? LIVING_POINTS.fire : kind === 'splash' ? LIVING_POINTS.garden
        : { x: resident.x + Math.sin(resident.heading) * .8, z: resident.z + Math.cos(resident.heading) * .8 });
      slot.goal.x = target.x; slot.goal.z = target.z;
      slot.goal.y = surface(target) + (kind === 'ignite' ? .24 : kind === 'splash' ? .12 : .11);
    }
    for (const batch of this.batches) batch.begin();
    const camera = this.stage.camera;
    if (camera) for (const slot of this.slots) {
      if (!slot.key) continue;
      if (!slot.seen && !Number.isFinite(slot.releaseAt)) slot.releaseAt = elapsed;
      const tail = Number.isFinite(slot.releaseAt) ? clamp(1 - (elapsed - slot.releaseAt) / .18) : 1;
      if (tail <= 0) { slot.key = ''; continue; }
      if (slot.seen) slot.strength = smooth(slot.progress / .13) * (1 - smooth((slot.progress - .78) / .22));
      if (slot.kind === 'electric') this.electric(slot, camera, elapsed, tail);
      else this.stream(slot, camera, elapsed, tail);
    }
    for (const batch of this.batches) batch.finish();
    for (const [key, at] of this.triggered) if (elapsed - at > 120 || this.triggered.size > 100) this.triggered.delete(key);
    this.syncCamera();
  }

  private stream(slot: Burst, camera: Hilo3d.Camera, elapsed: number, tail: number): void {
    const fire = slot.kind === 'ignite', { mouth, right } = slot.emitter, p = slot.progress;
    const head = smooth(p / .17), start = smooth((p - .79) / .21), strength = slot.strength;
    const distance = Math.hypot(slot.goal.x - mouth.x, slot.goal.z - mouth.z);
    for (let i = 0; i < slot.path.length; i++) {
      const fraction = i / (slot.path.length - 1), t = start + (head - start) * fraction, wave = Math.sin(t * Math.PI);
      const wobble = Math.sin(t * 15 - elapsed * (fire ? 11 : 7) + slot.seed) * (fire ? .025 : .008) * wave;
      const out = slot.path[i]!;
      out.x = mouth.x + (slot.goal.x - mouth.x) * t + right.x * wobble;
      out.y = mouth.y + (slot.goal.y - mouth.y) * t + wave * (fire ? .08 : .16 + distance * .14);
      out.z = mouth.z + (slot.goal.z - mouth.z) * t + right.z * wobble;
      slot.radii[i] = (fire ? (.023 + Math.sin(fraction * Math.PI) * (.055 + slot.height * .13))
        : (.024 + slot.height * .032) * (1 - fraction * .18)) * Math.max(.05, strength);
      if (fire && i === slot.path.length - 1) slot.radii[i] = .003;
    }
    if (slot.seen && strength > .003 && head - start > .01) {
      (fire ? this.fireOuter : this.waterOuter).tube(slot.path, slot.radii, fire ? FIRE : WATER, fire ? strength * .34 : strength * .62);
      (fire ? this.fireCore : this.waterCore).tube(slot.path, slot.radii, fire ? HEART : FOAM, strength * .82, fire ? .45 : .34);
    }
    const particleStrength = strength * tail;
    if (head < .9 || particleStrength < .003) return;
    const count = fire ? 11 : 17;
    for (let i = 0; i < count; i++) {
      const phase = fract((elapsed - slot.startedAt) * (fire ? 4.8 : 3.9) + i / count), angle = i * 2.3999 + slot.seed;
      const radius = phase * (fire ? .15 : .27), point = slot.scratch;
      point.x = slot.goal.x + Math.cos(angle) * radius;
      point.z = slot.goal.z + Math.sin(angle) * radius;
      point.y = slot.goal.y + (fire ? phase * .29 : Math.sin(phase * Math.PI) * .26);
      this.motes.dot(point, (fire ? .043 : .025) * (1 - phase * .55), fire ? (i % 3 ? FIRE : HEART) : FOAM,
        particleStrength * (1 - phase) * .78, camera);
    }
    if (!fire) for (let i = 0; i < 3; i++) {
      const phase = fract((elapsed - slot.startedAt) * 1.8 + i / 3);
      slot.scratch.x = slot.goal.x; slot.scratch.y = surface(slot.goal) + .024 + i * .001; slot.scratch.z = slot.goal.z;
      this.ripples.ripple(slot.scratch, .06 + phase * .40, FOAM, particleStrength * (1 - phase) * .36);
    }
  }

  private electric(slot: Burst, camera: Hilo3d.Camera, elapsed: number, tail: number): void {
    const { mouth, leftCheek, rightCheek, right } = slot.emitter;
    // Local, smoothly varying brightness (1.35Hz), never a scene-wide flash.
    const strength = slot.strength * (.82 + .12 * Math.sin((elapsed - slot.startedAt) * Math.PI * 2 * 1.35)) * tail;
    if (strength < .003) return;
    if (slot.seen) {
      const growth = smooth(slot.progress / .18);
      for (let arc = 0; arc < slot.arcs.length; arc++) {
        const path = slot.arcs[arc]!, side = arc % 2 ? -1 : 1;
        const origin = arc < 2 ? (side > 0 ? leftCheek : rightCheek)
          : slot.arcs[arc % 2]![2 + arc % 3]!;
        const reach = arc < 2 ? .72 : .24 + (arc % 3) * .10;
        const endX = origin.x + (slot.goal.x - mouth.x) * reach + right.x * side * (arc < 2 ? .025 : .13);
        const endY = arc < 2 ? slot.goal.y + .07 : mouth.y + ((arc % 3) - .4) * .075;
        const endZ = origin.z + (slot.goal.z - mouth.z) * reach + right.z * side * (arc < 2 ? .025 : .13);
        for (let i = 0; i < path.length; i++) {
          const t = i / (path.length - 1), u = t * growth, taper = Math.sin(u * Math.PI);
          const zig = (i % 2 ? 1 : -1) * (.022 + slot.height * .045) * taper;
          const drift = Math.sin(elapsed * 3.1 + i * 2.8 + slot.seed + arc) * .008 * taper;
          path[i]!.x = origin.x + (endX - origin.x) * u + right.x * (zig + drift);
          path[i]!.y = origin.y + (endY - origin.y) * u + Math.sin(i * 2.2 + arc) * .025 * taper;
          path[i]!.z = origin.z + (endZ - origin.z) * u + right.z * (zig + drift);
          slot.arcRadii[i] = (.0045 + slot.height * .009) * (arc < 2 ? 1 : .65) * (1 - t * .55);
        }
        this.electricOuter.tube(path, slot.arcRadii, ELECTRIC, strength * .22, 2.8);
        this.electricCore.tube(path, slot.arcRadii, WHITE, strength * .82);
      }
    }
    this.motes.dot(leftCheek, slot.height * .105, ELECTRIC, strength * .36, camera);
    this.motes.dot(rightCheek, slot.height * .105, ELECTRIC, strength * .36, camera);
  }

  reset(): void {
    this.triggered.clear(); this.lastElapsed = -1;
    for (const slot of this.slots) { slot.key = ''; slot.releaseAt = 0; slot.strength = 0; }
    for (const batch of this.batches) { batch.begin(); batch.finish(); }
  }

  private syncCamera(): void {
    const camera = this.stage.camera;
    if (this.disposed || !camera) return;
    camera.updateViewProjectionMatrix(); this.view.set('uViewProjection', camera.viewProjectionMatrix.elements);
    this.material.invalidateData();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; this.root.onUpdate = null;
    for (const batch of this.batches) batch.destroy(this.stage.renderer);
    this.root.destroy(this.stage.renderer); this.slots.length = 0; this.triggered.clear(); this.bindings.clear();
  }
}
