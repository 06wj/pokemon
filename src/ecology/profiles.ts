import type { PokemonEntry } from '../content/pokemon.ts';
import type { EcologyZone } from './layout.ts';
import { speciesFamilies } from './speciesFamilies.ts';

export type Locomotion = 'land' | 'amphibious' | 'aquatic' | 'flying';
export interface EcologyProfile {
  modelHeight: number;
  familyId: number;
  locomotion: Locomotion;
  preferredZone: EcologyZone;
  moveSpeed: number;
  runSpeed: number;
  sociability: number;
  nocturnal: boolean;
}

const families = new Map(speciesFamilies.map((row) => [String(row.id), row]));
const aquatic = new Set(['072', '073', '090', '091', '116', '117', '118', '119', '120', '121', '129', '130', '131']);
const hovering = new Set(['012', '015', '041', '042', '049', '081', '082', '092', '093', '109', '110', '151']);
const groundedBirds = new Set(['083', '084', '085']);
const stationary = new Set(['011', '014', '050', '051']);
const nocturnalSpecies = new Set(['035', '036', '039', '040', '041', '042', '043', '044', '045', '092', '093', '094']);

/** Family IDs are sourced data; movement and habitat preferences are game design.
 * The authored GLB supplies size. This profile never rescales a model. */
export function getEcologyProfile(pokemon: Pick<PokemonEntry, 'id' | 'types'> & Partial<Pick<PokemonEntry, 'animations'>>, authoredHeight = 1): EcologyProfile {
  const row = families.get(pokemon.id);
  const water = pokemon.types.includes('water');
  const flies = hovering.has(pokemon.id) || (pokemon.types.includes('flying') && !groundedBirds.has(pokemon.id));
  const locomotion: Locomotion = aquatic.has(pokemon.id) ? 'aquatic' : flies ? 'flying' : water ? 'amphibious' : 'land';
  const preferredZone: EcologyZone = water ? 'river'
    : pokemon.types.some((type) => type === 'fire' || type === 'rock' || type === 'ground') ? 'warm-rock'
    : pokemon.types.some((type) => type === 'grass' || type === 'bug' || type === 'ghost') ? 'grove' : 'meadow';
  const modelHeight = Number.isFinite(authoredHeight) && authoredHeight > 0 ? authoredHeight : 1;
  const moveSpeed = stationary.has(pokemon.id) ? 0.28 : pokemon.id === '143' ? 0.42
    : Math.min(1.5, 0.75 + Math.sqrt(modelHeight) * 0.23) * (flies ? 1.12 : 1);
  const canRun = !stationary.has(pokemon.id) && pokemon.animations?.some((clip) => clip.name === 'run');
  return {
    modelHeight,
    familyId: row?.familyId ?? Number(pokemon.id),
    locomotion,
    preferredZone,
    moveSpeed,
    runSpeed: canRun ? moveSpeed * (locomotion === 'aquatic' ? 1.55 : 1.85) : moveSpeed,
    sociability: pokemon.id === '150' ? 0.42 : pokemon.id === '132' || pokemon.id === '133' ? 0.95 : 0.72,
    nocturnal: nocturnalSpecies.has(pokemon.id),
  };
}

export function socialAffinity(a: { pokemonId: string; profile: EcologyProfile }, b: { pokemonId: string; profile: EcologyProfile }): number {
  return a.pokemonId === b.pokemonId ? 1 : a.profile.familyId === b.profile.familyId ? 0.9 : 0.23;
}
