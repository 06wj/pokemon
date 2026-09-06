import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as Hilo3d from 'hilo3d';

const server = await createServer({ configFile: false,
  server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
try {
  const { EcologyToon } = await server.ssrLoadModule('/src/hilo/ecologyToon.ts');
  const { ToonMeshSelection } = await server.ssrLoadModule('/src/hilo/toonMeshSelection.ts');
  const scene = new Hilo3d.Node();
  const makeMesh = (name, options = {}) => new Hilo3d.Mesh({ name,
    geometry: new Hilo3d.BoxGeometry(), material: new Hilo3d.PBRMaterial(),
    useInstanced: false, castShadows: true, ...options }).addTo(scene);
  const ground = makeMesh('ground', { castShadows: false });
  const tree = makeMesh('tree');
  const a = makeMesh('Bulbasaur');
  const b = makeMesh('Squirtle');
  const c = makeMesh('Eevee');
  const flame = makeMesh('authored flame', { castShadows: false });
  const bubble = makeMesh('authored bubble', { material: new Hilo3d.PBRMaterial({ opacity: .5 }), castShadows: false });
  const water = makeMesh('custom water', { material: new Hilo3d.BasicMaterial(), castShadows: false });
  const sourceMaterial = a.material;
  const sourceGeometry = a.geometry;
  let textureDestroyCount = 0;
  sourceMaterial.destroyTextures = () => { textureDestroyCount++; };

  const toon = new EcologyToon();
  toon.setLandscape([ground, tree]);
  toon.addResident('a', [a, flame, bubble]);
  toon.addResident('b', [b]);
  assert.equal(toon.rendering.enabled, false);
  assert.equal(toon.rendering.model, null, 'Original rendering allocates no auxiliary population model');
  assert.equal(toon.rendering.habitat, null, 'The solid landscape is lazy too');
  assert.equal(ground.castShadows, false);
  assert.equal(toon.antialias.injectionPoint, 'before-output');

  toon.setEnabled(true);
  assert.deepEqual([...toon.rendering.model.meshes], [a, b], 'Every resident joins the aggregate; authored optical effects are excluded');
  assert.deepEqual([...toon.rendering.habitat.meshes], [ground, tree]);
  assert.equal(ground.castShadows, true, 'Solid terrain participates in the shared pigment pass');
  assert.equal(flame.castShadows, false);
  assert.equal(bubble.castShadows, false);
  assert.equal(water.castShadows, false);
  const initialPopulation = toon.rendering.model;
  const initialLandscape = toon.rendering.habitat;
  toon.addResident('a', [bubble, flame, a, a]);
  toon.setLandscape([tree, ground, tree]);
  toon.setEnabled(true);
  toon.removeResident('absent');
  assert.equal(toon.rendering.model, initialPopulation, 'Repeated membership and toggles preserve the cached model');
  assert.equal(toon.rendering.habitat, initialLandscape);

  const selection = new ToonMeshSelection();
  let traversals = 0;
  const traverse = scene.traverse;
  scene.traverse = function (...args) { traversals++; return traverse.apply(this, args); };
  for (let i = 0; i < 90; i++) {
    a.x += .01; b.rotationY += .5; c.visible = i % 3 !== 0;
    selection.update(scene, toon.rendering.model, toon.rendering.habitat);
  }
  assert.equal(traversals, 1, 'Walking and animation do not rebuild mesh membership per frame');
  assert.ok(selection.excluded.includes(water));
  assert.ok(selection.excluded.includes(flame));
  assert.ok(selection.excluded.includes(bubble));

  toon.addResident('c', [c]);
  assert.deepEqual([...toon.rendering.model.meshes], [a, b, c]);
  assert.equal(initialPopulation.meshes.size, 0, 'Population mutations release old aggregate mesh references');
  assert.equal(toon.rendering.habitat, initialLandscape, 'Population changes retain the independent static landscape');
  const withThree = toon.rendering.model;
  toon.removeResident('b');
  assert.deepEqual([...toon.rendering.model.meshes], [a, c]);
  assert.equal(withThree.surfaces.length, 0);
  toon.setPixelRatio(1.5);
  toon.setPixelRatio(NaN);
  assert.equal(toon.rendering.pixelRatio, 1.5);

  const selectedPopulation = toon.rendering.model;
  toon.setEnabled(false);
  assert.equal(selectedPopulation.meshes.size, 0);
  assert.equal(initialLandscape.meshes.size, 0);
  assert.equal(toon.rendering.model, null);
  assert.equal(toon.rendering.habitat, null);
  assert.equal(ground.castShadows, false, 'Turning toon off restores the original shadow flags');
  assert.equal(a.material, sourceMaterial, 'Toggles never replace resident materials');
  assert.equal(a.geometry, sourceGeometry, 'Toggles never replace animated geometry');
  assert.equal(textureDestroyCount, 0, 'Shared source texture ownership stays with the GLB');
  toon.addResident('b', [b]);
  assert.equal(toon.rendering.model, null, 'Population mutations remain lazy while disabled');
  toon.setEnabled(true);
  assert.equal(toon.rendering.model.meshes.size, 3);
  toon.clearResidents();
  assert.equal(toon.rendering.model, null, 'Reset clears the entire auxiliary population');
  assert.equal(toon.rendering.habitat.meshes.size, 2, 'Reset preserves the toon landscape');
  assert.equal(toon.rendering.enabled, true, 'Reset preserves the chosen visual style');
  const beforeDispose = toon.rendering.habitat;
  toon.dispose();
  toon.dispose();
  toon.addResident('late', [a]);
  toon.setEnabled(true);
  assert.equal(beforeDispose.meshes.size, 0);
  assert.equal(toon.rendering.enabled, false);
  assert.equal(toon.rendering.habitat, null);
  assert.equal(ground.castShadows, false);
  assert.equal(a.isDestroyed, false, 'Disposing the adapter never destroys source models');
  assert.equal(textureDestroyCount, 0);
  selection.clear();
  console.log('Ecology toon: lazy aggregate population, cached frame membership, optical exclusions, reversible toggle and reset/disposal passed.');
} finally { await server.close(); }
