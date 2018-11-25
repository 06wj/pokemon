import { materialThemes, type MaterialKey } from '../content/materials.ts';

export function materialFromUrl(href: string): MaterialKey {
  const value = new URL(href).searchParams.get('material');
  return materialThemes.find((theme) => theme.key === value)?.key ?? 'original';
}

export function alternateBackend(backend: string, href: string): 'webgpu' | 'webgl2' {
  const current = backend === 'webgpu' || backend === 'webgl2'
    ? backend : new URL(href).searchParams.get('backend');
  // A failed automatic initialization must still offer the compatibility backend.
  return current === 'webgl2' ? 'webgpu' : 'webgl2';
}

export function backendSwitchUrl(href: string, backend: string, pokemonId: string, material: MaterialKey): string {
  const url = new URL(href);
  url.searchParams.set('backend', alternateBackend(backend, href));
  url.searchParams.set('material', material);
  url.hash = pokemonId;
  return url.href;
}
