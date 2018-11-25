export type MaterialKey = 'original' | 'toon' | 'glass' | 'gold' | 'silver' | 'iridescent';

export interface MaterialTheme {
  key: MaterialKey;
  name: string;
  en: string;
  description: string;
}

export const materialThemes: readonly MaterialTheme[] = [
  { key: 'original', name: '原生', en: 'ORIGINAL', description: '忠于原作的色彩、纹理与细腻表面' },
  { key: 'toon', name: '卡通', en: 'ANIME', description: '伙伴与风景共同入画，赛璐璐色彩与细墨线' },
  { key: 'glass', name: '玻璃', en: 'GLASS', description: '清澈玻璃折射眼前景色，厚处泛起微微冷光' },
  { key: 'gold', name: '黄金', en: 'GOLD', description: '丰润金色与流动高光，如精铸收藏品' },
  { key: 'silver', name: '白银', en: 'SILVER', description: '冷白银光铺展，细腻拉丝勾勒轮廓' },
  { key: 'iridescent', name: '幻彩', en: 'BUBBLE', description: '五彩薄膜包裹透明泡沫，光与景色在表面流转' },
] as const;
