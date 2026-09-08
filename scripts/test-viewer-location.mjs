import assert from 'node:assert/strict';
import { alternateBackend, backendSwitchUrl, materialFromUrl, sceneFromUrl, sceneSwitchUrl } from '../src/app/viewerLocation.ts';

const href = 'https://example.test/pokemon/?backend=webgpu&debug=1#001';
const switched = new URL(backendSwitchUrl(href, 'webgpu', '003', 'toon'));
assert.equal(switched.pathname, '/pokemon/');
assert.equal(switched.searchParams.get('debug'), '1');
assert.equal(switched.searchParams.get('backend'), 'webgl2');
assert.equal(switched.hash, '#003');
assert.equal(materialFromUrl(switched.href), 'toon');
assert.equal(alternateBackend('webgl2', href), 'webgpu', 'Actual backend takes precedence over the URL');
assert.equal(alternateBackend('initializing', href), 'webgl2', 'Failed WebGPU can switch to WebGL2');
assert.equal(alternateBackend('initializing', 'https://example.test/'), 'webgl2', 'Failed auto initialization offers compatibility');
assert.equal(alternateBackend('initializing', 'https://example.test/?backend=webgl2'), 'webgpu');
for (const key of ['original', 'toon', 'glass', 'gold', 'silver', 'iridescent']) {
  assert.equal(materialFromUrl(`https://example.test/?material=${key}`), key);
}
assert.equal(materialFromUrl('https://example.test/?material=invalid'), 'original');
assert.equal(materialFromUrl('https://example.test/'), 'original');
assert.equal(sceneFromUrl('https://example.test/pokemon/'), 'ecology', 'First visit opens the living world');
assert.equal(sceneFromUrl('https://example.test/pokemon/?backend=webgl2'), 'ecology');
assert.equal(sceneFromUrl('https://example.test/pokemon/#003'), 'gallery', 'Existing Pokémon deep links remain in the gallery');
assert.equal(sceneFromUrl('https://example.test/pokemon/?scene=gallery'), 'gallery');
assert.equal(sceneFromUrl('https://example.test/pokemon/?scene=ecology#003'), 'ecology', 'An explicit scene wins over a preserved model hash');
assert.equal(sceneFromUrl('https://example.test/pokemon/?scene=unknown#003'), 'gallery');
assert.equal(sceneFromUrl('https://example.test/pokemon/?scene=unknown'), 'ecology');
const gallery = new URL(sceneSwitchUrl('https://example.test/pokemon/?scene=ecology&backend=webgl2&material=toon#003', 'gallery'));
assert.equal(sceneFromUrl(gallery.href), 'gallery', 'Leaving the game does not immediately route back to the default game');
assert.equal(gallery.searchParams.get('scene'), 'gallery');
assert.equal(gallery.searchParams.get('backend'), 'webgl2');
assert.equal(gallery.searchParams.get('material'), 'toon');
assert.equal(gallery.pathname, '/pokemon/');
assert.equal(gallery.hash, '#003');
assert.equal(sceneFromUrl(sceneSwitchUrl(gallery.href, 'ecology')), 'ecology');
console.log('Viewer location: default ecology, explicit gallery/deep links, scene return, backend recovery and material links passed.');
