import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Keep authoring metadata available to asset tests without shipping it to the browser. */
export function runtimeModelManifest(): Plugin {
  return {
    name: 'runtime-model-manifest',
    enforce: 'pre',
    load(id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/content/animatedModels.json')) return;
      const source = JSON.parse(readFileSync(id, 'utf8')) as Record<string, {
        model: string; idleAnimation: string; animations: { name: string; label: string }[];
      }>;
      return JSON.stringify(Object.fromEntries(Object.entries(source).map(([id, model]) => [id, {
        model: model.model,
        idleAnimation: model.idleAnimation,
        animations: model.animations.map(({ name, label }) => ({ name, label })),
      }])));
    },
  };
}

/** Extract the dependency's embedded compiler bytes without modifying engine code or behavior. */
export function externalCompilerWasm(): Plugin {
  return {
    name: 'external-compiler-wasm',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/hilo3d\/dist\/web_naga-[^/]+\.js$/.test(id.replaceAll('\\', '/'))) return;
      const pattern = /new URL\("data:application\/wasm;base64,([A-Za-z0-9+/=]+)",\s*(?:""\s*\+\s*)?import\.meta\.url\)/g;
      let count = 0;
      const transformed = code.replace(pattern, (_match, encoded: string) => {
        const source = Buffer.from(encoded, 'base64');
        if (source.subarray(0, 8).toString('hex') !== '0061736d01000000') {
          this.error('Invalid embedded WebGPU compiler WASM');
        }
        const reference = this.emitFile({ type: 'asset', name: 'web-naga.wasm', source });
        count++;
        return `new URL(import.meta.ROLLUP_FILE_URL_${reference}, import.meta.url)`;
      });
      if (count !== 1) this.error('Hilo3D compiler packaging changed; review the WASM extraction adapter.');
      return { code: transformed, map: null };
    },
  };
}
