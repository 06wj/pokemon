/** Offline mesh recipe consumed by create-ecology-landscape.py through Blender MCP. Never imported by the application. */
import * as Hilo3d from 'hilo3d';
import { BRIDGE, ECOLOGY_OBSTACLES, WORLD_BOUNDS, isInWorld, riverCenterX, riverHalfWidth } from '../src/ecology/layout';

type Point = readonly [number, number, number];
type PaletteKey = keyof typeof PALETTE;

// This palette is intentionally quiet: habitat landmarks frame the creatures,
// while little warm flowers and turquoise water give the landscape its identity.
const PALETTE = {
  turf: '#739965', turfLight: '#779b66', turfShade: '#709663', moss: '#497750',
  cliff: '#797b70', cliffLight: '#929183', cliffDark: '#5a665e', earth: '#aca38a',
  sand: '#c5ba92', sandLight: '#d7c79f', path: '#b6b08a', pathLight: '#c4bc96',
  stone: '#a8aaa0', stoneLight: '#c4c4af', stoneDark: '#7e9083',
  warmStone: '#b59b7a', warmLight: '#d2b68b', warmShade: '#8f7b64',
  bark: '#665442', barkLight: '#907356', timber: '#a68a60', timberLight: '#c4a575',
  timberDark: '#716348', iron: '#536861', rope: '#d9caa2',
  leaf: '#4b8052', leafLight: '#659558', leafSun: '#80a768', leafDark: '#346b4b',
  grass: '#5f9257', grassLight: '#94ad68', reed: '#779756', reedTip: '#9c7650',
  cream: '#f0e4ae', lilac: '#b99bc6', coral: '#da8b80', yellow: '#e6be6d', fruit: '#d49a57',
} as const;

function color(hex: string): Hilo3d.Color {
  const n = Number.parseInt(hex.slice(1), 16);
  // Hilo PBR colors, like glTF factors, are specified in linear light.
  const linear = (value: number): number => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return new Hilo3d.Color(linear((n >> 16) / 255), linear(((n >> 8) & 255) / 255), linear((n & 255) / 255));
}

function randomFactory(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let n = Math.imul(seed ^ seed >>> 15, 1 | seed);
    n ^= n + Math.imul(n ^ n >>> 7, 61 | n);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}

/** A material bucket packs thousands of small authored details into one draw. */
class ShapeBatch {
  readonly positions: number[] = [];
  readonly normals: number[] = [];

  triangle(a: Point, b: Point, c: Point, up = false): void {
    const ab: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Point = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = ab[1] * ac[2] - ab[2] * ac[1];
    let ny = ab[2] * ac[0] - ab[0] * ac[2];
    let nz = ab[0] * ac[1] - ab[1] * ac[0];
    if (up && ny < 0) { const swap = b; b = c; c = swap; nx = -nx; ny = -ny; nz = -nz; }
    const length = Math.hypot(nx, ny, nz) || 1;
    this.positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.normals.push(nx / length, ny / length, nz / length);
  }

  quad(a: Point, b: Point, c: Point, d: Point, up = false): void {
    this.triangle(a, b, c, up);
    this.triangle(a, c, d, up);
  }

  box(x: number, y: number, z: number, width: number, height: number, depth: number, angle = 0): void {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const p = (a: number, b: number, c: number): Point => [x + a * ca + c * sa, y + b, z - a * sa + c * ca];
    const w = width / 2, h = height / 2, d = depth / 2;
    this.quad(p(-w, h, -d), p(-w, h, d), p(w, h, d), p(w, h, -d));
    this.quad(p(-w, -h, -d), p(w, -h, -d), p(w, -h, d), p(-w, -h, d));
    this.quad(p(-w, -h, d), p(w, -h, d), p(w, h, d), p(-w, h, d));
    this.quad(p(w, -h, -d), p(-w, -h, -d), p(-w, h, -d), p(w, h, -d));
    this.quad(p(w, -h, d), p(w, -h, -d), p(w, h, -d), p(w, h, d));
    this.quad(p(-w, -h, -d), p(-w, -h, d), p(-w, h, d), p(-w, h, -d));
  }

  beam(a: Point, b: Point, radius: number, topRadius = radius, sides = 7): void {
    const delta: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(...delta) || 1;
    const v: Point = [delta[0] / length, delta[1] / length, delta[2] / length];
    const temp: Point = Math.abs(v[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const ux = v[1] * temp[2] - v[2] * temp[1], uy = v[2] * temp[0] - v[0] * temp[2], uz = v[0] * temp[1] - v[1] * temp[0];
    const ul = Math.hypot(ux, uy, uz);
    const u: Point = [ux / ul, uy / ul, uz / ul];
    const w: Point = [v[1] * u[2] - v[2] * u[1], v[2] * u[0] - v[0] * u[2], v[0] * u[1] - v[1] * u[0]];
    const point = (center: Point, r: number, n: number): Point => {
      const t = n / sides * Math.PI * 2;
      return [center[0] + r * (u[0] * Math.cos(t) + w[0] * Math.sin(t)), center[1] + r * (u[1] * Math.cos(t) + w[1] * Math.sin(t)), center[2] + r * (u[2] * Math.cos(t) + w[2] * Math.sin(t))];
    };
    for (let i = 0; i < sides; i++) {
      this.quad(point(a, radius, i), point(a, radius, i + 1), point(b, topRadius, i + 1), point(b, topRadius, i));
      this.triangle(b, point(b, topRadius, i), point(b, topRadius, i + 1));
    }
  }

  ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number, phase = 0, segments = 9, rings = 5): void {
    const point = (ring: number, side: number): Point => {
      const lat = ring / rings * Math.PI, lon = side / segments * Math.PI * 2 + phase;
      const wobble = 1 + Math.sin(lon * 3 + lat * 5 + phase * 2) * 0.045;
      return [x + Math.sin(lat) * Math.cos(lon) * rx * wobble, y + Math.cos(lat) * ry, z + Math.sin(lat) * Math.sin(lon) * rz * wobble];
    };
    for (let ring = 0; ring < rings; ring++) for (let side = 0; side < segments; side++) {
      this.quad(point(ring, side), point(ring, side + 1), point(ring + 1, side + 1), point(ring + 1, side));
    }
  }

  geometry(): Hilo3d.Geometry {
    return new Hilo3d.Geometry({ vertices: new Hilo3d.GeometryData(new Float32Array(this.positions), 3), normals: new Hilo3d.GeometryData(new Float32Array(this.normals), 3) });
  }
}

Hilo3d.registerUniformBlockBinding('EcologyStreamParams');
const waterLayout = Hilo3d.createStd140Layout({ uModel: 'mat4', uViewProjection: 'mat4', uTimeMood: 'vec4' });
const waterBlock = `layout(std140) uniform EcologyStreamParams { mat4 uModel; mat4 uViewProjection; vec4 uTimeMood; };`;
const waterVertex = `#version 300 es
precision highp float;
in vec3 a_position;
out vec3 vPosition;
${waterBlock}
void main() { vPosition = a_position; gl_Position = uViewProjection * uModel * vec4(a_position, 1.0); }`;
const waterFragment = `#version 300 es
precision highp float;
in vec3 vPosition;
${waterBlock}
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
void main() {
  float time = uTimeMood.x, dusk = uTimeMood.y;
  vec2 p = vPosition.xz;
  float center = 3.2 + sin(p.y * 0.3) * 1.25;
  float edge = abs(p.x-center)/1.25;
  float shallow = smoothstep(0.42, 1.0, edge);
  float waviness = noise(p*1.7 + vec2(0.0,-time*.15));
  vec3 deep = mix(vec3(.025,.26,.27),vec3(.045,.16,.21),dusk);
  vec3 clear = mix(vec3(.18,.47,.39),vec3(.19,.31,.31),dusk);
  vec3 water = mix(deep,clear, shallow*.78+waviness*.13);
  float wave = abs(sin(p.y*8.0 + sin(p.x*9.0)*.28 + noise(p*4.0)*3.0 - time*1.55));
  float streak = (1.0-smoothstep(.02,.095,wave))*smoothstep(.48,.68,noise(p*3.0+vec2(0,-time*.16)));
  float glint = pow(max(0.0,1.0-abs(p.x-center+.28)),6.0)*streak;
  water += mix(vec3(.17,.25,.18),vec3(.30,.18,.10),dusk)*streak*.36;
  water += vec3(.26,.34,.28)*glint*.4;
  float foam = smoothstep(.92,1.0,edge)*smoothstep(.38,.63,noise(p*7.0-vec2(0,time*.25)));
  water = mix(water,vec3(.46,.65,.55),foam*.66);
  // Cliff-edge curtains are continuous with the stream, with vertical ribbons.
  if (vPosition.y < -.09) {
    float fall = .5 + .5*sin(p.x*32.0 + noise(p*7.0)*3.0 + vPosition.y*5.0 + time*3.5);
    water = mix(vec3(.035,.24,.24),vec3(.30,.52,.44),pow(fall,5.0)*.75);
  }
  fragColor = vec4(water,1.0);
}`;

/**
 * A hand-composed, deterministic little river sanctuary. Landscape footprints
 * come from the same layout as navigation; detail is batched by material, so the
 * hundreds of flowers, reeds and leaves do not become hundreds of draw calls.
 */
export class EcologyGeometryRecipe {
  private readonly root = new Hilo3d.Node({ name: 'ecology / river sanctuary' });
  private readonly batches = new Map<PaletteKey, ShapeBatch>();
  private readonly meshes: Hilo3d.Mesh[] = [];
  private readonly rng = randomFactory(82741);
  private readonly waterBuffer = new Hilo3d.UniformBuffer(waterLayout);
  private readonly waterMaterial: Hilo3d.ShaderMaterial;
  private readonly waterMesh: Hilo3d.Mesh;
  private readonly motes: Hilo3d.Mesh;
  private readonly timeMood = new Float32Array(4);
  private pathIndex = 0;
  private time = 0;
  private dusk = false;
  private disposed = false;

  constructor(private readonly stage: Hilo3d.Stage) {
    this.root.addTo(stage);
    const water = new ShapeBatch();
    this.buildIsland(water);
    this.buildPaths();
    this.buildBridge();
    this.buildPlanting();
    this.buildRiverDetails();
    this.buildWarmRocks();
    this.buildSmallDetails();
    // Append coastal authoring last, so the planted playable island retains its
    // exact deterministic geometry and random sequence when the coast evolves.
    this.buildCoast();
    for (const [key, batch] of this.batches) {
      if (!batch.positions.length) continue;
      const material = new Hilo3d.PBRMaterial({ name: `ecology / ${key}`, baseColor: color(PALETTE[key]), metallic: key === 'iron' ? 0.45 : 0, roughness: 0.94, cullMode: 'none' });
      this.meshes.push(new Hilo3d.Mesh({ name: `ecology / ${key}`, geometry: batch.geometry(), material, castShadows: !['turf', 'turfLight', 'turfShade', 'path', 'pathLight', 'sand', 'sandLight'].includes(key), receiveShadows: true, useInstanced: false }).addTo(this.root));
    }
    this.batches.clear();
    this.waterMaterial = new Hilo3d.ShaderMaterial({ name: 'ecology / moving turquoise river', vs: waterVertex, fs: waterFragment, attributes: { a_position: Hilo3d.MaterialAttributeSemantic.POSITION }, uniformBlocks: { EcologyStreamParams: this.waterBuffer }, cullMode: 'none' });
    this.waterMesh = new Hilo3d.Mesh({ name: 'ecology / stream and waterfalls', geometry: water.geometry(), material: this.waterMaterial, useInstanced: false, castShadows: false, receiveShadows: false }).addTo(this.root);
    this.meshes.push(this.waterMesh);
    this.motes = this.buildMotes();
    this.update(0);
  }

  private batch(key: PaletteKey): ShapeBatch {
    let batch = this.batches.get(key);
    if (!batch) { batch = new ShapeBatch(); this.batches.set(key, batch); }
    return batch;
  }

  private buildIsland(water: ShapeBatch): void {
    // Cross-sections follow the exact navigable ellipse and cut the stream out
    // of the grass mesh, rather than burying water beneath a solid green plane.
    const steps = 116;
    for (let i = 0; i < steps; i++) {
      const z0 = -WORLD_BOUNDS.z + i / steps * WORLD_BOUNDS.z * 2;
      const z1 = -WORLD_BOUNDS.z + (i + 1) / steps * WORLD_BOUNDS.z * 2;
      const edge0 = WORLD_BOUNDS.x * Math.sqrt(Math.max(0, 1 - (z0 / WORLD_BOUNDS.z) ** 2));
      const edge1 = WORLD_BOUNDS.x * Math.sqrt(Math.max(0, 1 - (z1 / WORLD_BOUNDS.z) ** 2));
      const c0 = riverCenterX(z0), c1 = riverCenterX(z1);
      const clamp0 = (x: number): number => Math.max(-edge0, Math.min(edge0, x));
      const clamp1 = (x: number): number => Math.max(-edge1, Math.min(edge1, x));
      for (const side of [-1, 1]) {
        const a0 = side < 0 ? -edge0 : clamp0(c0 + riverHalfWidth + 0.25);
        const b0 = side < 0 ? clamp0(c0 - riverHalfWidth - 0.25) : edge0;
        const a1 = side < 0 ? -edge1 : clamp1(c1 + riverHalfWidth + 0.25);
        const b1 = side < 0 ? clamp1(c1 - riverHalfWidth - 0.25) : edge1;
        const columns = 18;
        for (let j = 0; j < columns; j++) {
          const t0 = j / columns, t1 = (j + 1) / columns;
          const sample = Math.sin((a0 + (b0 - a0) * t0) * 0.71 + z0 * 0.37) + Math.sin(z0 * 0.8) * 0.42;
          const key: PaletteKey = sample > 0.52 ? 'turfLight' : sample < -0.6 ? 'turfShade' : 'turf';
          this.batch(key).quad([a0 + (b0 - a0) * t0, 0, z0], [a0 + (b0 - a0) * t1, 0, z0], [a1 + (b1 - a1) * t1, 0, z1], [a1 + (b1 - a1) * t0, 0, z1], true);
        }
        this.batch('sand').quad([clamp0(c0 + side * riverHalfWidth), -.045, z0], [clamp0(c0 + side * (riverHalfWidth + .25)), .006, z0], [clamp1(c1 + side * (riverHalfWidth + .25)), .006, z1], [clamp1(c1 + side * riverHalfWidth), -.045, z1], true);
      }
      water.quad([clamp0(c0 - riverHalfWidth), -.04, z0], [clamp0(c0 + riverHalfWidth), -.04, z0], [clamp1(c1 + riverHalfWidth), -.04, z1], [clamp1(c1 - riverHalfWidth), -.04, z1], true);
    }
    // Sculpted strata. The turf stays perfectly level for natural foot contact.
    const segments = 132;
    const edgePoint = (i: number, ring: number): Point => {
      const angle = i / segments * Math.PI * 2;
      const n = Math.sin(angle * 13) * .035 + Math.sin(angle * 29 + .6) * .018;
      const scale = [1, 1.006, .989, .97, .934][ring]! + (ring ? n * .4 : 0);
      const ys = [0, -.17, -.58, -1.15, -1.52];
      return [Math.cos(angle) * WORLD_BOUNDS.x * scale, ys[ring]! + (ring > 1 ? Math.sin(angle * 17 + ring) * .09 : 0), Math.sin(angle) * WORLD_BOUNDS.z * scale];
    };
    for (let i = 0; i < segments; i++) {
      const a = edgePoint(i, 0), b = edgePoint(i + 1, 0);
      const middleX = (a[0] + b[0]) / 2, middleZ = (a[2] + b[2]) / 2;
      const isFall = Math.abs(middleX - riverCenterX(middleZ)) < riverHalfWidth;
      for (let ring = 0; ring < 4; ring++) {
        const p = edgePoint(i, ring), q = edgePoint(i + 1, ring), r = edgePoint(i + 1, ring + 1), s = edgePoint(i, ring + 1);
        if (isFall) { water.quad([p[0], Math.min(-.04, p[1]), p[2]], [q[0], Math.min(-.04, q[1]), q[2]], r, s); continue; }
        const key: PaletteKey = ring === 0 ? 'moss' : ring === 1 ? (i % 4 === 0 ? 'earth' : 'cliffLight') : ring === 2 ? (i % 3 === 0 ? 'cliffLight' : 'cliff') : 'cliffDark';
        this.batch(key).quad(p, q, r, s);
      }
      if (!isFall && i % 2 === 0) {
        const angle = i / segments * Math.PI * 2;
        const drop = .12 + this.rng() * .24;
        this.batch('moss').ellipsoid(a[0] * .997, -.08 - drop / 2, a[2] * .997, .15, drop, .17, angle, 6, 3);
      }
    }
  }

  private path(points: readonly (readonly [number, number])[], width: number): void {
    const samples: [number, number][] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)]!, p1 = points[i]!, p2 = points[i + 1]!, p3 = points[Math.min(points.length - 1, i + 2)]!;
      for (let j = 0; j < 12; j++) {
        const t = j / 12;
        const v = (axis: 0 | 1): number => .5 * ((2 * p1[axis]) + (-p0[axis] + p2[axis]) * t + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t * t + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t * t * t);
        samples.push([v(0), v(1)]);
      }
    }
    samples.push([...points[points.length - 1]!]);
    const height = .014 + this.pathIndex++ * .004;
    const edges = samples.map((point, i) => {
      const before = samples[Math.max(0, i - 1)]!, after = samples[Math.min(samples.length - 1, i + 1)]!;
      const dx = after[0] - before[0], dz = after[1] - before[1], len = Math.hypot(dx, dz) || 1;
      const w = width * (.98 + Math.sin(i * .53) * .02) / 2;
      return { point, px: -dz / len * w, pz: dx / len * w };
    });
    for (let i = 0; i < edges.length - 1; i++) {
      const a = edges[i]!, b = edges[i + 1]!;
      this.batch('path').quad([a.point[0] - a.px, height, a.point[1] - a.pz], [a.point[0] + a.px, height, a.point[1] + a.pz], [b.point[0] + b.px, height, b.point[1] + b.pz], [b.point[0] - b.px, height, b.point[1] - b.pz], true);
      this.batch('pathLight').quad([a.point[0] - a.px * .62, height + .001, a.point[1] - a.pz * .62], [a.point[0] + a.px * .62, height + .001, a.point[1] + a.pz * .62], [b.point[0] + b.px * .62, height + .001, b.point[1] + b.pz * .62], [b.point[0] - b.px * .62, height + .001, b.point[1] - b.pz * .62], true);
    }
  }

  private buildPaths(): void {
    this.path([[-11, 2.8], [-7.8, 2.0], [-4.2, .8], [-1.5, -.05], [1.05, 0]], 1.24);
    this.path([[5.35, 0], [7.1, .5], [7.6, 2.5], [7.1, 5.9]], 1.02);
    this.path([[-4.2, .8], [-5.1, -1.5], [-5.2, -3.5], [-5.8, -5.4]], .72);
    this.path([[-7.8, 2], [-7.2, 4.1], [-5.5, 5.8], [-2.5, 6.3], [.8, 5.8]], .66);
  }

  private buildBridge(): void {
    const { x, halfLength, halfWidth } = BRIDGE;
    for (let i = 0; i < 25; i++) {
      const px = x - halfLength + (i + .5) / 25 * halfLength * 2;
      this.batch(i % 4 === 0 ? 'timberLight' : 'timber').box(px, .02, 0, .167, .12, halfWidth * 2 + (i % 3 - 1) * .035);
      for (const side of [-1, 1]) {
        this.batch('iron').ellipsoid(px, .085, side * .86, .015, .004, .015, 0, 5, 2);
        if (i % 2 === 0) this.batch('timberDark').box(px + .055, .081, side * .56, .01, .002, .27);
      }
    }
    for (const side of [-1, 1]) {
      this.batch('timberDark').box(x, -.13, side * .82, halfLength * 2 + .15, .25, .2);
      for (let i = 0; i < 5; i++) {
        const px = x - halfLength + i / 4 * halfLength * 2;
        this.batch('bark').box(px, .40, side * halfWidth, .115, 1.08, .115);
        this.batch('timberLight').box(px, .96, side * halfWidth, .17, .075, .17);
        this.batch('iron').box(px, .25, side * (halfWidth + .061), .1, .105, .016);
        if (i < 4) {
          const next = px + halfLength / 2;
          for (const height of [.52, .88]) {
            let previous: Point = [px, height, side * halfWidth];
            for (let j = 1; j <= 8; j++) {
              const t = j / 8;
              const p: Point = [px + (next - px) * t, height - Math.sin(t * Math.PI) * .12, side * halfWidth];
              this.batch('rope').beam(previous, p, .024, .024, 5);
              previous = p;
            }
          }
        }
      }
      // Bank abutments give the timber a convincing load-bearing foundation.
      for (const end of [-1, 1]) this.batch('stoneDark').box(x + end * (halfLength - .06), -.12, side * .8, .35, .31, .52);
    }
  }

  private tree(x: number, z: number, radius: number, index: number): void {
    const h = 2.5 + radius * 1.2 + (index % 3) * .2;
    const tilt: Point = [x + .14 * Math.sin(index), h * .66, z - .1];
    this.batch('bark').beam([x, -.015, z], tilt, radius * .46, radius * .27, 9);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + index;
      this.batch(i % 2 ? 'bark' : 'barkLight').beam([x + Math.cos(a) * radius * .88, .015, z + Math.sin(a) * radius * .88], [x + Math.cos(a) * .09, .49, z + Math.sin(a) * .09], .065, .045, 5);
    }
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2 + index * .8;
      const reach = .77 + this.rng() * .25;
      const tip: Point = [x + Math.cos(a) * reach, h - .34 + this.rng() * .38, z + Math.sin(a) * reach];
      this.batch('bark').beam([tilt[0], h * .49, tilt[2]], tip, .10, .037, 6);
      this.batch('barkLight').beam([x - .08, h * .32, z + .12], [tilt[0] - .055, h * .63, tilt[2] + .11], .019, .013, 4);
    }
    // Overlapping irregular lobes have a leafy silhouette, with small bright
    // leaf sprays along the crown instead of a single low-detail green sphere.
    for (let i = 0; i < 12; i++) {
      const a = i * 2.399963 + index;
      const ring = i < 7 ? 1 : .46;
      const crownY = h + (i < 7 ? -.28 : .39) + this.rng() * .23;
      const cx = x + Math.cos(a) * ring, cz = z + Math.sin(a) * ring;
      const rx = .64 + this.rng() * .24;
      const key: PaletteKey = i % 5 === 0 ? 'leafSun' : i % 3 === 0 ? 'leafLight' : i % 2 === 0 ? 'leaf' : 'leafDark';
      this.batch(key).ellipsoid(cx, crownY, cz, rx, .57 + this.rng() * .2, rx * .95, a, 9, 5);
      for (let j = 0; j < 4; j++) {
        const la = a + j * 1.7;
        this.batch(j % 3 ? 'leafLight' : 'leafSun').ellipsoid(cx + Math.cos(la) * rx * .65, crownY + .35 + this.rng() * .15, cz + Math.sin(la) * rx * .65, .15, .10, .24, la, 5, 3);
      }
      if (index < 4 && i % 2 === 0) {
        const fx = cx + Math.cos(a) * rx * .65, fz = cz + Math.sin(a) * rx * .65;
        this.batch('fruit').ellipsoid(fx, crownY - .45, fz, .075, .09, .075, a, 7, 4);
        this.batch('cream').ellipsoid(fx - .025, crownY - .425, fz + .055, .019, .028, .014, a, 5, 3);
      }
    }
    // Soft visual root bed; only the common navigation trunk circle blocks AI.
    this.disk('moss', x, .012, z, radius * 1.35, radius * 1.13, 16);
  }

  private disk(key: PaletteKey, x: number, y: number, z: number, rx: number, rz: number, segments = 12, gap = 0): void {
    const limit = segments - gap;
    for (let i = 0; i < limit; i++) {
      const a = i / segments * Math.PI * 2, b = (i + 1) / segments * Math.PI * 2;
      this.batch(key).triangle([x, y, z], [x + Math.cos(a) * rx, y, z + Math.sin(a) * rz], [x + Math.cos(b) * rx, y, z + Math.sin(b) * rz], true);
    }
  }

  private grass(x: number, z: number, height: number, reeds = false): void {
    for (let i = 0; i < (reeds ? 5 : 4); i++) {
      const a = this.rng() * Math.PI * 2, w = reeds ? .026 : .028 + this.rng() * .018;
      const h = height * (.65 + this.rng() * .6);
      const dx = Math.cos(a) * .10, dz = Math.sin(a) * .10;
      const tip: Point = [x + dx * 1.5, h, z + dz * 1.5];
      this.batch(reeds ? 'reed' : i % 3 ? 'grass' : 'grassLight').triangle([x - dz * w / .1, .012, z + dx * w / .1], [x + dz * w / .1, .012, z - dx * w / .1], tip);
      if (reeds && i < 2) {
        this.batch('reed').beam([x + dx * .5, .01, z + dz * .5], tip, .009, .005, 4);
        this.batch('reedTip').ellipsoid(tip[0], h + .05, tip[2], .032, .10, .032, a, 5, 3);
      }
    }
  }

  private flower(x: number, z: number, key: 'cream' | 'lilac' | 'coral' | 'yellow', height: number): void {
    this.batch('grass').beam([x, .015, z], [x + .018, height, z], .007, .005, 4);
    this.batch('grass').triangle([x, height * .3, z], [x + .11, height * .58, z + .035], [x + .023, height * .65, z]);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      this.batch(key).ellipsoid(x + Math.cos(a) * .034, height, z + Math.sin(a) * .034, .033, .013, .033, a, 5, 2);
    }
    this.batch(key === 'yellow' ? 'cream' : 'yellow').ellipsoid(x, height + .012, z, .02, .013, .02, 0, 5, 2);
  }

  private buildPlanting(): void {
    let index = 0;
    for (const obstacle of ECOLOGY_OBSTACLES) if (obstacle.kind === 'tree') this.tree(obstacle.x, obstacle.z, obstacle.radius, index++);
    // Plant in designed drifts with breathing space across the central meadow.
    const drifts = [[-8, 3.2, 1.1], [-6, 4.8, 1.3], [-3.1, 4.9, 1.1], [-1.4, 2.8, .7], [-7.8, -4.2, 1.2], [-3.8, -4.8, .9], [7.2, -3.1, .7], [9.8, 2.2, .7], [-2.2, 7.2, 1.0]] as const;
    for (let j = 0; j < drifts.length; j++) {
      const [cx, cz, r] = drifts[j]!;
      for (let i = 0; i < 35; i++) {
        const a = this.rng() * Math.PI * 2, distance = Math.sqrt(this.rng()) * r;
        const x = cx + Math.cos(a) * distance, z = cz + Math.sin(a) * distance;
        this.grass(x, z, .12 + this.rng() * .14);
        if (i % 2 === 0) this.flower(x + .035, z - .02, j % 3 === 0 ? 'cream' : j % 3 === 1 ? 'lilac' : 'coral', .17 + this.rng() * .14);
      }
    }
    for (let i = 0; i < 160; i++) {
      const x = (this.rng() - .5) * 24.5, z = (this.rng() - .5) * 18.5;
      if (!isInWorld(x, z, .6) || Math.abs(x - riverCenterX(z)) < 1.75 || Math.abs(z) < 1) continue;
      this.grass(x, z, .11 + this.rng() * .10);
    }
  }

  private buildRiverDetails(): void {
    for (let i = 0; i < 126; i++) {
      const z = -8.9 + this.rng() * 17.8;
      if (Math.abs(z) < 1.6) continue;
      const side = i % 2 ? 1 : -1;
      const x = riverCenterX(z) + side * (riverHalfWidth + .10 + this.rng() * .27);
      if (!isInWorld(x, z, .45)) continue;
      if (i % 3 === 0) this.grass(x, z, .44 + this.rng() * .21, true);
      else this.batch(i % 3 === 1 ? 'stoneLight' : 'stone').ellipsoid(x, .008, z, .07 + this.rng() * .10, .05 + this.rng() * .04, .08 + this.rng() * .12, this.rng() * 6, 7, 3);
      if (i % 7 === 0) this.batch('sandLight').ellipsoid(x + .12, .012, z - .06, .025, .008, .04, 1, 5, 2);
    }
    for (let i = 0; i < 9; i++) {
      const z = -6.8 + i * .34, x = riverCenterX(z) + .5 + Math.sin(i * 2) * .2;
      const r = .12 + this.rng() * .08;
      this.disk(i % 2 ? 'leaf' : 'leafLight', x, -.032, z, r, r * .88, 14, 1);
      if (i % 3 === 0) {
        for (let j = 0; j < 5; j++) {
          const a = j / 5 * Math.PI * 2;
          this.batch('cream').ellipsoid(x + Math.cos(a) * .037, .0, z + Math.sin(a) * .037, .035, .034, .026, a, 5, 3);
        }
        this.batch('yellow').ellipsoid(x, .015, z, .024, .03, .024, 0, 5, 3);
      }
    }
  }

  private buildWarmRocks(): void {
    this.disk('sand', 8.45, .012, 4.15, 2.13, 2.02, 25);
    this.disk('sandLight', 8.4, .013, 4.22, 1.87, 1.77, 25);
    let index = 0;
    for (const obstacle of ECOLOGY_OBSTACLES) if (obstacle.kind === 'rock') {
      const { x, z, radius: r } = obstacle;
      this.batch('warmShade').ellipsoid(x, .2 * r, z, r, .44 * r, r * .89, index, 7, 3);
      this.batch('warmStone').ellipsoid(x - .045, .39 * r, z, r * .95, .51 * r, r * .85, index, 7, 3);
      this.batch('warmLight').ellipsoid(x - .07, .66 * r, z - .015, r * .71, .26 * r, r * .62, index, 7, 3);
      index++;
    }
    for (let i = 0; i < 25; i++) {
      const a = this.rng() * Math.PI * 2, r = 1.45 + this.rng() * .67;
      const x = 8.4 + Math.cos(a) * r, z = 4.2 + Math.sin(a) * r;
      this.batch(i % 2 ? 'warmStone' : 'warmLight').ellipsoid(x, .016, z, .06 + this.rng() * .05, .035, .04 + this.rng() * .06, a, 5, 3);
      if (i % 3 === 0) this.grass(x, z, .13);
    }
  }

  private buildSmallDetails(): void {
    // A little trail marker with inlaid leaf symbol beside the west path.
    const x = -8.4, z = 1.14;
    this.batch('bark').box(x, .38, z, .085, .77, .085);
    this.batch('timber').box(x, .79, z, .53, .31, .075, -.1);
    this.batch('timberLight').box(x, .94, z, .60, .055, .13, -.1);
    this.batch('cream').ellipsoid(x, .79, z + .047, .082, .075, .008, 0, 7, 3);
    this.batch('leaf').beam([x - .035, .75, z + .057], [x + .035, .83, z + .057], .009, .007, 4);
    // Grove mushrooms and rounded ground pebbles are small enough to step over.
    for (let i = 0; i < 17; i++) {
      const x1 = -8.6 + this.rng() * 5.8, z1 = -6.7 + this.rng() * 2;
      this.batch('cream').beam([x1, 0, z1], [x1, .11, z1], .016, .021, 5);
      this.batch(i % 3 ? 'warmLight' : 'coral').ellipsoid(x1, .13, z1, .07, .035, .065, i, 7, 3);
      if (i % 3 === 0) this.batch('cream').ellipsoid(x1 + .025, .154, z1, .012, .008, .011, 0, 4, 2);
    }
    // Decorative gravel follows the path edges, not the navigable center line.
    for (let i = 0; i < 48; i++) {
      const px = -9 + this.rng() * 9, pz = .65 + Math.sin((px + 5) * .4) * -.8 + (i % 2 ? -.8 : .65);
      this.batch(i % 2 ? 'sandLight' : 'stone').ellipsoid(px, .013, pz, .025 + this.rng() * .025, .013, .025 + this.rng() * .025, i, 5, 2);
    }
  }

  private buildCoast(): void {
    const random = randomFactory(583020);
    const steps = 192;
    const fractions = [0, .18, .62, .83, 1];
    const heights = [-.62, -.69, -.82, -.97, -1.07];
    // Keep this exact contour in sync with the atmospheric sea's shallow-water
    // mask. The lip is submerged by .02 m, making a soft shoreline rather than
    // another sharp floating disc below the existing island.
    const outer = (a: number): readonly [number, number] => {
      const wobble = .65 * Math.sin(3 * a + .4) + .40 * Math.cos(5 * a - .7) + .18 * Math.sin(11 * a);
      return [Math.cos(a) * (15.65 + wobble), Math.sin(a) * (12.55 + wobble * .8)];
    };
    const position = (a: number, ring: number): Point => {
      const ix = Math.cos(a) * WORLD_BOUNDS.x * .973, iz = Math.sin(a) * WORLD_BOUNDS.z * .973;
      const o = outer(a), f = fractions[ring]!;
      let height = heights[ring]! + (ring > 0 && ring < 4 ? Math.sin(a * 8 + .5) * .014 : 0);
      const x = ix + (o[0] - ix) * f, z = iz + (o[1] - iz) * f;
      if (Math.abs(z) > 8) {
        const bank = Math.max(0, Math.min(1, (Math.abs(x - riverCenterX(z)) - 1.30) / .72));
        height = -1.07 + (height + 1.07) * bank * bank * (3 - 2 * bank);
      }
      return [x, height, z];
    };
    const isEstuary = (a: number): boolean => {
      const x = Math.cos(a) * WORLD_BOUNDS.x * .973, z = Math.sin(a) * WORLD_BOUNDS.z * .973;
      return Math.abs(z) > 8 && Math.abs(x - riverCenterX(z)) < 1.34;
    };
    const clipBank = (points: readonly Point[], side: number): Point[] => {
      const clipped: Point[] = [];
      let previous = points[points.length - 1]!;
      let previousDistance = (previous[0] - riverCenterX(previous[2])) * side - 1.30;
      for (const point of points) {
        const distance = (point[0] - riverCenterX(point[2])) * side - 1.30;
        if ((distance >= 0) !== (previousDistance >= 0)) {
          const t = previousDistance / (previousDistance - distance);
          clipped.push([previous[0] + (point[0] - previous[0]) * t, -1.07, previous[2] + (point[2] - previous[2]) * t]);
        }
        if (distance >= 0) clipped.push(point);
        previous = point;
        previousDistance = distance;
      }
      return clipped;
    };
    for (let i = 0; i < steps; i++) {
      const a = i / steps * Math.PI * 2, b = (i + 1) / steps * Math.PI * 2;
      for (let ring = 0; ring < fractions.length - 1; ring++) {
        const key: PaletteKey = ring === 3 ? 'sand' : 'sandLight';
        const quad = [position(a, ring), position(b, ring), position(b, ring + 1), position(a, ring + 1)];
        // Smooth submerged banks follow the real river curve. The ocean plane
        // fills each inlet, so the old falls reach the sea without a second water
        // sheet or rigid elevated slots cut through the beach.
        const polygons = Math.abs(Math.sin((a + b) / 2) * WORLD_BOUNDS.z) > 7.8 ? [clipBank(quad, -1), clipBank(quad, 1)] : [quad];
        for (const polygon of polygons) for (let j = 1; j < polygon.length - 1; j++) this.batch(key).triangle(polygon[0]!, polygon[j]!, polygon[j + 1]!, true);
      }
    }

    // Weathered outcrops make the small cliff read as a living coastline, with
    // a few separate tidal rocks continuing naturally out into the water.
    for (const [index, angle] of [.28, .97, 2.25, 2.86, 3.62, 4.6, 5.64].entries()) {
      if (isEstuary(angle)) continue;
      const c = Math.cos(angle), s = Math.sin(angle);
      const scale = index % 3 === 0 ? 1.13 : 1.035;
      const x = c * 13 * scale, z = s * 10 * scale;
      const radius = .43 + random() * .28;
      this.batch('cliffDark').ellipsoid(x, -.68, z, radius * 1.06, .32, radius * .80, angle, 8, 4);
      this.batch('cliffLight').ellipsoid(x - .08 * c, -.56, z - .08 * s, radius * .84, .31, radius * .64, angle + .4, 8, 4);
      if (index % 3 !== 0) this.batch('moss').ellipsoid(x - .13 * c, -.33, z - .13 * s, radius * .63, .082, radius * .54, angle, 8, 3);
      this.batch('stone').ellipsoid(x + s * .43, -.71, z - c * .43, radius * .48, .20, radius * .45, angle + 1, 7, 4);
      if (index % 2 === 0) {
        const o = outer(angle + .04);
        this.batch('stoneDark').ellipsoid(o[0] + c * .25, -1.03, o[1] + s * .25, .36, .27, .30, angle, 8, 4);
        this.batch('stone').ellipsoid(o[0] + c * .19, -.91, o[1] + s * .19, .24, .14, .22, angle, 7, 3);
        this.batch('stoneDark').ellipsoid(o[0] + c * .58 + s * .35, -1.04, o[1] + s * .58 - c * .35, .15, .11, .18, angle, 6, 3);
      }
    }

    for (let i = 0; i < 112; i++) {
      const a = random() * Math.PI * 2;
      if (isEstuary(a)) continue;
      const inner = position(a, 0), o = outer(a);
      const t = .11 + random() * .66;
      const x = inner[0] + (o[0] - inner[0]) * t, z = inner[2] + (o[1] - inner[2]) * t;
      const ring = t < .18 ? 0 : t < .62 ? 1 : 2;
      const h0 = position(a, ring)[1], h1 = position(a, ring + 1)[1];
      const y = h0 + (h1 - h0) * (t - fractions[ring]!) / (fractions[ring + 1]! - fractions[ring]!);
      const r = .028 + random() * .054;
      this.batch(i % 3 === 0 ? 'stoneLight' : i % 3 === 1 ? 'sand' : 'stone').ellipsoid(x, y + .008, z, r, r * .36, r * .73, a, 6, 3);
      if (i % 9 === 0) {
        this.batch('cream').ellipsoid(x + .10, y + .014, z - .05, .035, .012, .026, a, 7, 3);
        this.batch('sandLight').beam([x + .075, y + .021, z - .05], [x + .115, y + .021, z - .05], .005, .005, 4);
      }
    }
  }

  private buildMotes(): Hilo3d.Mesh {
    const batch = new ShapeBatch();
    for (let i = 0; i < 38; i++) {
      const x = -8.5 + this.rng() * 15, z = -7 + this.rng() * 14;
      batch.ellipsoid(x, .6 + this.rng() * 1.65, z, .018, .018, .018, i, 5, 3);
    }
    const material = new Hilo3d.PBRMaterial({ name: 'ecology / fireflies', unlit: true, baseColor: new Hilo3d.Color(.75, .69, .29), emissionFactor: new Hilo3d.Color(.35, .28, .055) });
    const mesh = new Hilo3d.Mesh({ name: 'ecology / evening fireflies', geometry: batch.geometry(), material, castShadows: false, receiveShadows: false, useInstanced: false, visible: false }).addTo(this.root);
    this.meshes.push(mesh);
    return mesh;
  }

  setTimeOfDay(timeOfDay: 'dawn' | 'dusk'): void {
    this.dusk = timeOfDay === 'dusk';
    this.motes.visible = this.dusk;
  }

  update(dtSeconds: number): void {
    if (this.disposed) return;
    this.time += Math.min(.1, Math.max(0, dtSeconds));
    const camera = this.stage.camera;
    if (!camera) return;
    camera.updateViewProjectionMatrix();
    this.waterMesh.updateMatrix();
    this.timeMood[0] = this.time;
    this.timeMood[1] = this.timeMood[1]! + ((this.dusk ? 1 : 0) - this.timeMood[1]!) * Math.min(1, dtSeconds * 2);
    this.waterBuffer.set('uModel', this.waterMesh.worldMatrix.elements);
    this.waterBuffer.set('uViewProjection', camera.viewProjectionMatrix.elements);
    this.waterBuffer.set('uTimeMood', this.timeMood);
    this.waterMaterial.invalidateData();
    this.motes.y = Math.sin(this.time * .34) * .11;
    this.motes.x = Math.sin(this.time * .17) * .11;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const mesh of this.meshes) mesh.destroy(this.stage.renderer);
    this.meshes.length = 0;
  }
}
