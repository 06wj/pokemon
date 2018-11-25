import type { PokemonEntry } from './pokemon';

export type HabitatKey = 'grove' | 'lagoon' | 'caldera' | 'glacier' | 'storm' | 'astral';

export interface HabitatTheme {
  key: HabitatKey;
  name: string;
  en: string;
  description: string;
  background: number;
  keyLight: number;
  fillLight: number;
  accent: string;
  environment: 'forest' | 'studio';
}

export const habitatThemes: Record<HabitatKey, HabitatTheme> = {
  grove: {
    key: 'grove', name: '森间秘境', en: 'VERDANT GROVE',
    description: '苔石、蕨叶与林间微光，收藏一小片生机。',
    background: 0x101d1c, keyLight: 0xffeccf,
    fillLight: 0xd8edf0, accent: '#718c48', environment: 'forest',
  },
  lagoon: {
    key: 'lagoon', name: '潮汐浅湾', en: 'TIDAL LAGOON',
    description: '海光穿过碧色水体，珊瑚与礁影隐入远处。',
    background: 0x10232c, keyLight: 0xfff0db,
    fillLight: 0xb4e5fa, accent: '#3f979f', environment: 'studio',
  },
  caldera: {
    key: 'caldera', name: '熔火遗境', en: 'EMBER CALDERA',
    description: '玄武岩的裂隙透出余温，群峰沉静而有力。',
    background: 0x211817, keyLight: 0xffdeb6,
    fillLight: 0xc6d6e3, accent: '#b7734f', environment: 'studio',
  },
  glacier: {
    key: 'glacier', name: '极光冰原', en: 'CRYSTAL GLACIER',
    description: '冰晶簇拥雪白台地，折射澄澈的极地天光。',
    background: 0x182833, keyLight: 0xf4f5ff,
    fillLight: 0xc0e8f7, accent: '#6d9fb6', environment: 'studio',
  },
  storm: {
    key: 'storm', name: '雷鸣高地', en: 'THUNDER MESA',
    description: '风蚀砂岩与琥珀矿脉，凝住雷雨前的金色瞬间。',
    background: 0x242119, keyLight: 0xffefcb,
    fillLight: 0xc7dcef, accent: '#b3903f', environment: 'studio',
  },
  astral: {
    key: 'astral', name: '星辉遗迹', en: 'ASTRAL GARDEN',
    description: '紫晶与弧形遗迹相依，在静谧中闪烁星辉。',
    background: 0x1d192b, keyLight: 0xffe4f2,
    fillLight: 0xced4fb, accent: '#9680b2', environment: 'studio',
  },
};

/** Primary typing sets the biome; ice and ghost retain their distinctive habitats. */
export function getHabitat(pokemon: PokemonEntry): HabitatTheme {
  if (pokemon.types.includes('ice')) return habitatThemes.glacier;
  if (pokemon.types.includes('ghost')) return habitatThemes.astral;
  const primary = pokemon.types[0];
  if (primary === 'water') return habitatThemes.lagoon;
  if (primary === 'fire' || primary === 'rock' || primary === 'ground' || primary === 'fighting') {
    return habitatThemes.caldera;
  }
  if (primary === 'electric' || primary === 'steel' || primary === 'flying') return habitatThemes.storm;
  if (primary === 'psychic' || primary === 'poison' || primary === 'dragon') return habitatThemes.astral;
  if (primary === 'normal' && pokemon.types.includes('flying')) return habitatThemes.storm;
  return habitatThemes.grove;
}
