import coastalLayout from './coastalLayout.json' with { type: 'json' };

export interface EcologyPoint { x: number; z: number }
export type EcologyZone = 'meadow' | 'grove' | 'warm-rock' | 'river';
/** Shared with Blender. The outer beach remains scenery; navigation considers
 * the core ellipse and rejects its submerged southern estuary lip. */
export const COASTAL_LAYOUT = coastalLayout;
export const WORLD_BOUNDS = { x: coastalLayout.core.x, z: coastalLayout.core.z } as const;
export const SEA_LEVEL = coastalLayout.coast.seaLevel;
export const riverHalfWidth = coastalLayout.river.halfWidth;
const riverPoints = coastalLayout.river.centerline.map(([x, z]) => ({ x: x!, z: z! }));
const riverSpans = riverPoints.slice(1).map((point, i) => point.z - riverPoints[i]!.z);
const riverSecants = riverPoints.slice(1).map((point, i) => (point.x - riverPoints[i]!.x) / riverSpans[i]!);
const riverTangents = riverPoints.map((_point, i) => {
  if (i === 0) return riverSecants[0]!;
  if (i === riverPoints.length - 1) return riverSecants[i - 1]!;
  const previous = riverSecants[i - 1]!, next = riverSecants[i]!;
  if (previous * next <= 0) return 0;
  const w1 = 2 * riverSpans[i]! + riverSpans[i - 1]!;
  const w2 = riverSpans[i]! + 2 * riverSpans[i - 1]!;
  return (w1 + w2) / (w1 / previous + w2 / next);
});

/** Monotone cubic Hermite segments, shared by navigation and generated GLSL.
 * Blender computes the same weighted harmonic tangents from the JSON points. */
export const RIVER_SEGMENTS = riverPoints.slice(1).map((end, i) => {
  const start = riverPoints[i]!, h = riverSpans[i]!, m0 = riverTangents[i]!, m1 = riverTangents[i + 1]!;
  return { z0: start.z, z1: end.z,
    a: 2 * start.x - 2 * end.x + h * (m0 + m1),
    b: -3 * start.x + 3 * end.x - h * (2 * m0 + m1),
    c: h * m0, d: start.x };
});

export function riverCenterX(z: number): number {
  if (z <= riverPoints[0]!.z) return riverPoints[0]!.x;
  const segment = RIVER_SEGMENTS.find((item) => z <= item.z1);
  if (!segment) return riverPoints[riverPoints.length - 1]!.x;
  const t = (z - segment.z0) / (segment.z1 - segment.z0);
  return ((segment.a * t + segment.b) * t + segment.c) * t + segment.d;
}

const smoothStep01 = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** Matches radial_bounds / terrain_base in the Blender coastal authoring file.
 * This is the ground outside the carved riverbed, including the southern notch. */
export function terrainBaseHeight(x: number, z: number): number {
  const coast = coastalLayout.coast;
  const r = Math.hypot(x, z);
  let core: number = WORLD_BOUNDS.x;
  let shore: number = coast.baseRadii.x;
  if (r >= 1e-8) {
    const angle = Math.atan2(z / coast.baseRadii.z, x / coast.baseRadii.x);
    const wobble = coast.waves.reduce((sum, wave) => sum + wave.amplitude
      * (wave.function === 'sin' ? Math.sin : Math.cos)(angle * wave.frequency + wave.phase), 0);
    const a = coast.baseRadii.x + wobble, b = coast.baseRadii.z + wobble * coast.zWobbleScale;
    const dx = x / r, dz = z / r;
    core = 1 / Math.hypot(dx / WORLD_BOUNDS.x, dz / WORLD_BOUNDS.z);
    shore = 1 / Math.hypot(dx / a, dz / b);
  }
  const grassEdge = core + coast.beachStartOffset;
  let base = coastalLayout.core.groundY;
  if (r > grassEdge && r <= shore) {
    const t = (r - grassEdge) / (shore - grassEdge);
    base = SEA_LEVEL * (0.3 * t + 0.7 * smoothStep01(t));
  } else if (r > shore) {
    const t = (r - shore) / coast.submergedShelfWidth;
    base = Math.max(-5.5, SEA_LEVEL - 0.62 * smoothStep01(t) - Math.max(0, t - 1) * 3);
  }
  if (z > coast.estuary.startZ) {
    const estuary = coast.estuary;
    const cross = (x - riverCenterX(z)) / estuary.spread;
    const notch = -estuary.depth * smoothStep01((z - estuary.startZ) / estuary.length) * Math.exp(-cross * cross);
    base = Math.min(base, notch);
  }
  return base;
}

export function waterSurfaceHeight(z: number): number {
  return Math.max(SEA_LEVEL, coastalLayout.river.surfaceY + terrainBaseHeight(riverCenterX(z), z));
}

/** Maximum |dx/dz| over a finite stretch, including the quadratic derivative's
 * interior extrema. Local bounds avoid penalizing straight reaches for bends
 * far away while still protecting the entire resident body near each bank. */
export function riverMaxSlope(fromZ = -Infinity, toZ = Infinity): number {
  let maximum = 0;
  for (const segment of RIVER_SEGMENTS) {
    if (segment.z1 < fromZ || segment.z0 > toZ) continue;
    const h = segment.z1 - segment.z0;
    const lo = Math.max(0, (fromZ - segment.z0) / h);
    const hi = Math.min(1, (toZ - segment.z0) / h);
    const derivative = (t: number): number => Math.abs((3 * segment.a * t * t + 2 * segment.b * t + segment.c) / h);
    maximum = Math.max(maximum, derivative(lo), derivative(hi));
    if (Math.abs(segment.a) > 1e-12) {
      const extremum = -segment.b / (3 * segment.a);
      if (extremum > lo && extremum < hi) maximum = Math.max(maximum, derivative(extremum));
    }
  }
  return maximum;
}

export function riverBankClearance(z: number, radius: number): number {
  const body = radius + 0.04;
  return body * Math.hypot(1, riverMaxSlope(z - body, z + body));
}
export const BRIDGE = coastalLayout.bridge;
export const ECOLOGY_ZONES = coastalLayout.zones;

// Rendering and navigation share the same trunk/boulder positions and footprints.
export const ECOLOGY_OBSTACLES: readonly (EcologyPoint & { id: string; radius: number; kind: 'tree' | 'rock' })[] =
  coastalLayout.obstacles.map((obstacle) => ({ ...obstacle, kind: obstacle.kind === 'tree' ? 'tree' : 'rock' }));

export function isInWorld(x: number, z: number, radius = 0): boolean {
  return (x / (WORLD_BOUNDS.x - radius)) ** 2 + (z / (WORLD_BOUNDS.z - radius)) ** 2 < 1;
}

export function isInRiver(x: number, z: number): boolean {
  return Math.abs(x - riverCenterX(z)) < riverHalfWidth;
}

export function isOnBridge(x: number, z: number, radius = 0): boolean {
  return Math.abs(z - BRIDGE.z) <= BRIDGE.halfWidth - radius &&
    Math.abs(x - BRIDGE.x) <= BRIDGE.halfLength + radius;
}
