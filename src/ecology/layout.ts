export interface EcologyPoint { x: number; z: number }
export type EcologyZone = 'meadow' | 'grove' | 'warm-rock' | 'river';
export const WORLD_BOUNDS = { x: 13, z: 10 } as const;
export const riverHalfWidth = 1.25;
export const riverCenterX = (z: number): number => 3.2 + Math.sin(z * 0.3) * 1.25;
export const BRIDGE = { x: 3.2, z: 0, halfLength: 2.2, halfWidth: 1.2 } as const;
export const ECOLOGY_ZONES = {
  meadow: { x: -4, z: 3, radius: 4.2, label: '花间草甸' },
  grove: { x: -6, z: -5, radius: 3.0, label: '林荫果园' },
  'warm-rock': { x: 8, z: 4, radius: 2.4, label: '暖石坡' },
  river: { x: 3.2, z: -4, radius: 1.25, label: '蜿蜒溪流' },
} as const;

// Rendering and navigation share the same trunk/boulder positions and footprints.
export const ECOLOGY_OBSTACLES: readonly (EcologyPoint & { radius: number; kind: 'tree' | 'rock' })[] = [
  { x: -9, z: -3, radius: 0.5, kind: 'tree' },
  { x: -8, z: -6, radius: 0.55, kind: 'tree' },
  { x: -5.5, z: -6.9, radius: 0.6, kind: 'tree' },
  { x: -3.1, z: -6, radius: 0.5, kind: 'tree' },
  { x: -10, z: 1, radius: 0.45, kind: 'tree' },
  { x: -10.5, z: 4, radius: 0.45, kind: 'tree' },
  { x: 7.3, z: -5.9, radius: 0.5, kind: 'tree' },
  { x: 9.6, z: -3.8, radius: 0.45, kind: 'tree' },
  { x: 10.3, z: 0.3, radius: 0.5, kind: 'tree' },
  { x: 8.1, z: 4.5, radius: 1, kind: 'rock' },
  { x: 9.7, z: 5.1, radius: 0.7, kind: 'rock' },
  { x: 8.8, z: 3.2, radius: 0.6, kind: 'rock' },
];

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
