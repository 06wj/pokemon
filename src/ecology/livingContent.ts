import { BRIDGE, COASTAL_LAYOUT, riverCenterX, riverHalfWidth, type EcologyPoint } from './layout.ts';

const tree = COASTAL_LAYOUT.obstacles.find((item) => item.id === 'hero-fruit-tree')!;
const fire = COASTAL_LAYOUT.obstacles.find((item) => item.id === 'campfire')!;
const flowerBed = COASTAL_LAYOUT.landmarks.flowerBeds.find((item) => item.id === 'west')!;
const river = { x: riverCenterX(-4.4), z: -4.4 };
const garden = { x: river.x + riverHalfWidth + 0.55, z: river.z };

/** One set of world X/Z positions for behavior and effects. Ground/water Y is
 * sampled by the renderer; all event timestamps use simulation.elapsed. */
export const LIVING_POINTS = {
  tree: { x: tree.x, z: tree.z, radius: tree.radius },
  fire: { x: fire.x, z: fire.z, radius: fire.radius },
  flowers: { x: flowerBed.x, z: flowerBed.z, radius: 0.65 },
  river,
  garden: { ...garden, radius: 0.45 },
} as const;

export const LIVING_TUNING = {
  maxFruits: 6, ripeFruitLimit: 4, fruitLifetime: 140, fruitFallSeconds: 0.8,
  naturalDropSeconds: 19, ripenSeconds: 30, fruitSatietySeconds: 55,
  fireSeconds: 125, maxFireGuests: 3, maxMainActions: 2,
  perceptionSeconds: 2.8, fruitPerception: 8.5, firePerception: 13,
  flowerPerception: 8.5, sneezePerception: 3.5,
  actionTimeout: 65, repeatFireSeconds: 52, repeatWaterSeconds: 58, repeatFlowerSeconds: 38,
  snowAccumulateSeconds: 55, rainMeltSeconds: 40, sunnyMeltSeconds: 100,
  rainWetSeconds: 22, sunnyDrySeconds: 80, snowDrySeconds: 120,
  weatherReactionSeconds: 48, maxWeatherResponders: 3, snowDiscoveryCoverage: .6,
} as const;

export interface LivingNature {
  curiosity: number;
  caution: number;
  playfulness: number;
  appetite: number;
  restBias: number;
  waterBound: boolean;
  interests: { fruit: number; warmth: number; flowers: number; water: number };
  abilities: { ignite: boolean; waterFlowers: boolean; smellFlowers: boolean };
  home: EcologyPoint;
}

const authored: Record<string, Partial<Omit<LivingNature, 'interests' | 'abilities'>> & {
  interests?: Partial<LivingNature['interests']>;
  abilities?: Partial<LivingNature['abilities']>;
}> = {
  '004': { home: { x: -3.1, z: -3.8 }, curiosity: .9, interests: { warmth: 1, fruit: .6 }, abilities: { ignite: true } },
  '007': { home: { x: river.x + .2, z: -6.3 }, playfulness: .95, interests: { water: 1, flowers: .6 }, abilities: { waterFlowers: true } },
  '025': { home: { x: -8.2, z: 3.3 }, curiosity: 1, playfulness: .9, interests: { flowers: 1, warmth: .85 }, abilities: { smellFlowers: true } },
  '001': { home: { x: garden.x + 1.8, z: -4.1 }, restBias: .65, interests: { flowers: 1, fruit: .8, warmth: .45 } },
  '012': { home: { x: garden.x + 1.1, z: -1.8 }, caution: .65, interests: { flowers: 1, fruit: .2, warmth: .35 } },
  '143': { home: { x: -7.3, z: -5.1 }, restBias: 1, appetite: .9, curiosity: .25, interests: { warmth: .8, fruit: .95 } },
  '016': { home: { x: BRIDGE.x - 1.6, z: BRIDGE.z + 2.5 }, caution: .6, interests: { fruit: .65, flowers: .6 } },
  '035': { home: { x: -9.6, z: -2.4 }, restBias: .7, interests: { warmth: .6 } },
  '037': { home: { x: -2.4, z: 1 }, caution: .5, interests: { warmth: .95 } },
  '039': { home: { x: -6.5, z: -5.8 }, restBias: .85, interests: { warmth: .55 } },
  '043': { home: { x: -6.1, z: 5.7 }, restBias: .75, interests: { flowers: .95 } },
  '052': { home: { x: 6.8, z: -5.8 }, caution: .6, restBias: .7, interests: { warmth: .7, fruit: .7 } },
  '054': { home: { x: river.x + 1.8, z: -6.7 }, restBias: .75, interests: { water: .8 } },
  '058': { home: { x: -.8, z: -3.8 }, playfulness: .85, interests: { warmth: .8, fruit: .8 } },
  '060': { home: { x: riverCenterX(4.3), z: 4.3 }, waterBound: true, interests: { water: 1, fruit: .4 } },
  '079': { home: { x: 5.6, z: 5.9 }, restBias: 1, curiosity: .25, interests: { water: .8, fruit: .45 } },
  '092': { home: { x: -4.1, z: -5.9 }, interests: { fruit: 0, warmth: .15, flowers: .2 }, curiosity: .75 },
  '118': { home: { x: riverCenterX(5.6), z: 5.6 }, interests: { fruit: .35, water: 1 } },
  '129': { home: { x: riverCenterX(-6.5), z: -6.5 }, interests: { fruit: .3, water: 1 } },
  '133': { home: { x: -6.8, z: -2.2 }, caution: .85, curiosity: .8, interests: { fruit: .8, warmth: .7, flowers: .6 } },
};

export function livingNature(id: string, types: readonly string[]): LivingNature {
  const row = authored[id];
  return {
    curiosity: .65, caution: .35, playfulness: .5, appetite: .65, restBias: .45, waterBound: false,
    home: COASTAL_LAYOUT.zones.meadow, ...row,
    interests: { fruit: .6, warmth: types.includes('water') ? .2 : .55,
      flowers: types.includes('grass') || types.includes('bug') ? .85 : .35,
      water: types.includes('water') ? .8 : .15, ...row?.interests },
    abilities: { ignite: false, waterFlowers: false, smellFlowers: false, ...row?.abilities },
  };
}
