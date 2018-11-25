import type { PokemonType } from './pokemonTypes';

export interface TypeTheme {
  label: string;
  accent: string;
}

export const typeThemes: Record<PokemonType, TypeTheme> = {
  normal: { label: '一般', accent: '#c9c3ae' },
  grass: { label: '草', accent: '#8fcf72' },
  fire: { label: '火', accent: '#ef8a4b' },
  water: { label: '水', accent: '#65bfe4' },
  electric: { label: '电', accent: '#e9cf52' },
  bug: { label: '虫', accent: '#a8c85e' },
  flying: { label: '飞行', accent: '#9bc5db' },
  rock: { label: '岩石', accent: '#b8a36d' },
  poison: { label: '毒', accent: '#b477c6' },
  ground: { label: '地面', accent: '#c8945f' },
  ice: { label: '冰', accent: '#98dce3' },
  fighting: { label: '格斗', accent: '#d16f5e' },
  psychic: { label: '超能力', accent: '#dc79a9' },
  ghost: { label: '幽灵', accent: '#8f83c5' },
  dragon: { label: '龙', accent: '#7f91d7' },
  steel: { label: '钢', accent: '#aabcc4' },
  fairy: { label: '妖精', accent: '#e7a7c4' },
};
