import type { EcologyPoint } from './layout.ts';

export type LivingTool = 'observe' | 'fruit' | 'shake-tree' | 'prepare-fire' | 'rustle-flowers';
export type LivingWeather = 'sunny' | 'rain' | 'snow';
export type LivingAnimation = 'idle' | 'walk' | 'run' | 'attack' | 'happy' | 'sleep';
export type LivingBubble = 'curious' | 'fruit' | 'eating' | 'water' | 'flower' | 'warm' | 'music' | 'happy' | 'surprised' | 'sleepy';
export type LivingEffect = 'ignite' | 'drink' | 'splash' | 'pollen' | 'bite' | 'invite';

/** Pure simulation output; presentation must not advance or complete actions. */
export interface LivingPerformance {
  sequenceId: string;
  stepId: string;
  label: string;
  animation: LivingAnimation;
  bubble: LivingBubble | null;
  effect: LivingEffect | null;
  progress: number;
  duration: number;
  target: EcologyPoint | null;
}

export interface LivingFruit extends EcologyPoint {
  id: number;
  source: 'player' | 'tree';
  bornAt: number;
  landedAt: number;
  remaining: number;
  eaterUid: string | null;
}

export interface LivingWorld {
  weather: { kind: LivingWeather; wetness: number; snow: number; changedAt: number };
  fruits: LivingFruit[];
  tree: { mature: number; shakeAt: number };
  campfire: { prepared: boolean; lit: boolean; heat: number; litAt: number };
  flowers: { moisture: number; bloom: number; rustleAt: number };
}

export type DiscoveryCategory = 'species' | 'behavior' | 'moment';
export interface DiscoveryCandidate {
  id: string;
  category: DiscoveryCategory;
  title: string;
  description: string;
  speciesIds: string[];
  participantUids: string[];
  at: number;
}
export interface DiscoveryRecord extends DiscoveryCandidate {
  discoveredAt: string;
}
export interface LivingPhoto {
  id: string;
  capturedAt: string;
  title: string;
  timeOfDay: 'dawn' | 'dusk';
  weather?: LivingWeather;
  snow?: number;
  image: string;
  speciesIds: string[];
  discoveryIds: string[];
  labels: string[];
}

export interface LivingEffectResident extends EcologyPoint {
  uid: string;
  pokemonId: string;
  y: number;
  height: number;
  radius: number;
  heading: number;
  performance: LivingPerformance | null;
}

export const LIVING_CAST = ['004', '007', '025', '001', '012', '143', '016', '035', '037', '039',
  '043', '052', '054', '058', '060', '079', '092', '118', '129', '133'] as const;

export const LIVING_BUBBLES: Record<LivingBubble, string> = {
  curious: '?', fruit: '🍑', eating: '♥', water: '💧', flower: '✿', warm: '☀',
  music: '♪', happy: '♥', surprised: '!', sleepy: 'zZ',
};

export function createLivingWorld(): LivingWorld {
  return {
    weather: { kind: 'sunny', wetness: 0, snow: 0, changedAt: 0 },
    fruits: [], tree: { mature: 4, shakeAt: -100 },
    campfire: { prepared: true, lit: false, heat: 0, litAt: -100 },
    flowers: { moisture: .24, bloom: .4, rustleAt: -100 },
  };
}
