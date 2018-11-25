import assert from 'node:assert/strict';
import { alternateBackend, backendSwitchUrl, materialFromUrl } from '../src/app/viewerLocation.ts';

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
console.log('Viewer location: backend switching, recovery, subpaths and material links passed.');
