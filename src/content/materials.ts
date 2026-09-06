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
  { key: 'glass', name: '像素', en: 'PIXEL', description: '原色化作复古像素，阶梯明暗与点阵阴影勾勒伙伴' },
  { key: 'gold', name: '黄金', en: 'GOLD', description: '丰润金色与流动高光，如精铸收藏品' },
  { key: 'silver', name: '晶釉', en: 'GLAZE', description: '原色之上覆一层透亮晶釉，镜面亮斑沿曲面流动' },
  { key: 'iridescent', name: '幻彩', en: 'BUBBLE', description: '轻盈皂膜透出景色，柔和彩虹沿轮廓流动' },
] as const;
