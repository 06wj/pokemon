import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';
import * as Hilo3d from 'hilo3d';

const server = await createServer({
  configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom',
});

try {
  const { ToonMeshSelection } = await server.ssrLoadModule('/src/hilo/toonMeshSelection.ts');
  const makeMesh = (name) => new Hilo3d.Mesh({ name });
  const makeSurface = (...meshes) => ({ meshes: new Set(meshes), excluded: [] });
  const makeSource = (...surfaces) => ({ surfaces, meshes: new Set(surfaces.flatMap((surface) => [...surface.meshes])) });
  const scene = new Hilo3d.Node();
  const rig = new Hilo3d.Node().addTo(scene);
  const skeleton = new Hilo3d.Node().addTo(rig);
  const body = makeMesh('body').addTo(skeleton);
  const petal = makeMesh('petal').addTo(skeleton);
  const rock = makeMesh('rock').addTo(scene);
  const backdrop = makeMesh('backdrop').addTo(scene);
  const water = makeMesh('water').addTo(scene);
  const particles = new Hilo3d.Node().addTo(scene);
  const bodySurface = makeSurface(body, petal);
  const model = makeSource(bodySurface);
  const habitat = makeSource(makeSurface(rock));
  const cache = new ToonMeshSelection();
  let traversals = 0;
  const originalTraverse = scene.traverse;
  scene.traverse = function (...args) {
    traversals++;
    return originalTraverse.apply(this, args);
  };

  function verify(root = scene, selectedModel = model, selectedHabitat = habitat) {
    const allMeshes = [];
    const visit = (node) => {
      if (node instanceof Hilo3d.Mesh) allMeshes.push(node);
      for (const child of node.children) visit(child);
    };
    visit(root);
    cache.update(root, selectedModel, selectedHabitat);
    const surfaces = [...(selectedModel?.surfaces ?? []), ...(selectedHabitat?.surfaces ?? [])];
    assert.equal(cache.surfaces.length, surfaces.length);
    assert.deepEqual(cache.excluded, allMeshes.filter((mesh) => !selectedModel?.meshes.has(mesh) && !selectedHabitat?.meshes.has(mesh)));
    for (const [index, surface] of surfaces.entries()) {
      const selected = cache.surfaces[index];
      assert.equal(selected.meshes, surface.meshes);
      assert.notEqual(selected.excluded, surface.excluded, 'Exclusion lists belong to the selection cache');
      assert.deepEqual(selected.excluded, allMeshes.filter((mesh) => !surface.meshes.has(mesh)));
    }
  }

  verify();
  assert.equal(traversals, 1);
  assert.ok(cache.excluded.includes(backdrop));
  assert.ok(cache.excluded.includes(water));
  for (let frame = 0; frame < 120; frame++) {
    rig.rotationY += 1;
    body.y += 0.001;
    petal.visible = !petal.visible;
    verify();
  }
  assert.equal(traversals, 1, 'Animation and visibility changes reuse the identity lists for current-frame culling');

  const backing = makeMesh('late facial backing').addTo(skeleton);
  backing.visible = false;
  verify();
  assert.equal(traversals, 2, 'A late descendant invalidates the cache even while invisible');
  const replacement = makeMesh('replacement backing');
  backing.removeFromParent();
  replacement.addTo(skeleton);
  verify();
  assert.equal(traversals, 3, 'Same-size child replacement invalidates the cache');

  petal.addTo(rig);
  verify();
  assert.equal(traversals, 4, 'Reparenting keeps the new traversal order');
  makeMesh('late CPU particle writer').addTo(particles);
  verify();
  assert.equal(traversals, 5, 'A particle addon may add writer meshes after its system was mounted');
  particles.removeFromParent();
  verify();
  assert.equal(traversals, 6, 'Removing a subtree drops all of its excluded meshes');

  // Node exposes its child array publicly; do not rely on add/remove hooks alone.
  const direct = makeMesh('direct child');
  direct.parent = rig;
  rig.children.push(direct);
  verify();
  assert.equal(traversals, 7);
  rig.children = rig.children.slice();
  verify();
  assert.equal(traversals, 7, 'Replacing an array with identical child identities needs no rebuild');

  bodySurface.meshes.delete(petal);
  bodySurface.meshes.add(direct);
  verify();
  assert.equal(traversals, 8, 'Same-size surface membership edits cannot leave a stale exclusion list');
  model.meshes.delete(petal);
  model.meshes.add(direct);
  verify();
  assert.equal(traversals, 9, 'The combined selected set is tracked independently');
  model.surfaces[0] = makeSurface(body, direct);
  verify();
  assert.equal(traversals, 10, 'Replacing a material group invalidates even if its members match');

  verify(scene, null, null);
  assert.equal(cache.surfaces.length, 0);
  assert.equal(traversals, 11);
  verify();
  assert.equal(traversals, 12, 'Returning to toon mode restores the selected groups');
  model.surfaces.length = 0;
  model.meshes.clear();
  verify();
  assert.equal(traversals, 13, 'Disposing a source with the same object identity invalidates selection');
  const secondScene = new Hilo3d.Node();
  makeMesh('second scene').addTo(secondScene);
  verify(secondScene);
  cache.clear();
  assert.equal(cache.surfaces.length, 0);
  assert.equal(cache.excluded.length, 0);
  assert.equal(habitat.surfaces[0].excluded.length, 0);
  verify();

  const sharedScene = new Hilo3d.Node();
  const sharedSubtree = new Hilo3d.Node().addTo(sharedScene);
  const sharedMesh = makeMesh('shared toon mesh').addTo(sharedSubtree);
  const inside = makeMesh('inside exclusion').addTo(sharedSubtree);
  const outside = makeMesh('outside exclusion').addTo(sharedScene);
  const authoredExclusion = makeMesh('source-owned exclusion sentinel');
  const material = new Hilo3d.PBRMaterial();
  const sharedSurface = { ...makeSurface(sharedMesh), material, excluded: [authoredExclusion] };
  const sharedSource = makeSource(sharedSurface);
  const firstCache = new ToonMeshSelection();
  const secondCache = new ToonMeshSelection();
  firstCache.update(sharedScene, sharedSource, null);
  secondCache.update(sharedSubtree, sharedSource, null);
  assert.equal(firstCache.surfaces[0].material, material, 'Selection copies retain the original material reference');
  assert.deepEqual(firstCache.surfaces[0].excluded, [inside, outside]);
  assert.deepEqual(secondCache.surfaces[0].excluded, [inside]);
  assert.notEqual(firstCache.surfaces[0].excluded, secondCache.surfaces[0].excluded);
  const secondList = secondCache.surfaces[0].excluded;
  firstCache.clear();
  secondCache.update(sharedSubtree, sharedSource, null);
  assert.equal(secondCache.surfaces[0].excluded, secondList, 'Another runtime clearing must preserve the cache hit');
  assert.deepEqual(secondList, [inside], 'Another runtime clearing cannot empty this runtime\'s selection');
  firstCache.update(sharedScene, sharedSource, null);
  const lateOutside = makeMesh('late outside exclusion').addTo(sharedScene);
  firstCache.update(sharedScene, sharedSource, null);
  assert.deepEqual(firstCache.surfaces[0].excluded, [inside, outside, lateOutside]);
  secondCache.update(sharedSubtree, sharedSource, null);
  assert.equal(secondCache.surfaces[0].excluded, secondList, 'Another scene rebuilding cannot replace this runtime\'s list');
  assert.deepEqual(secondList, [inside]);
  secondCache.clear();
  assert.deepEqual(firstCache.surfaces[0].excluded, [inside, outside, lateOutside], 'Ownership is independent in both directions');
  assert.deepEqual(sharedSurface.excluded, [authoredExclusion], 'Selection never changes a source-owned exclusion array');
  firstCache.clear();
  assert.deepEqual(sharedSurface.excluded, [authoredExclusion]);

  if (process.argv.includes('--benchmark')) {
    const benchmarkScene = new Hilo3d.Node();
    const parents = [];
    for (let index = 0; index < 400; index++) parents.push(new Hilo3d.Node().addTo(index % 5 === 0 ? benchmarkScene : parents[index - 1]));
    const benchmarkSurfaces = [];
    for (let index = 0; index < 40; index++) {
      benchmarkSurfaces.push(makeSurface(...Array.from({ length: 3 }, (_, child) => makeMesh(`mesh-${index}-${child}`).addTo(parents[index * 10]))));
    }
    const benchmarkSource = makeSource(...benchmarkSurfaces);
    for (let index = 0; index < 12; index++) makeMesh(`optical-${index}`).addTo(benchmarkScene);
    const benchmarkCache = new ToonMeshSelection();
    const allMeshes = [];
    const excluded = [];
    const previousFrameSelection = () => {
      allMeshes.length = 0;
      excluded.length = 0;
      benchmarkScene.traverse((node) => {
        if (node instanceof Hilo3d.Mesh) {
          allMeshes.push(node);
          if (!benchmarkSource.meshes.has(node)) excluded.push(node);
        }
      });
      for (const surface of benchmarkSurfaces) {
        surface.excluded.length = 0;
        for (const mesh of allMeshes) if (!surface.meshes.has(mesh)) surface.excluded.push(mesh);
      }
    };
    const cachedFrameSelection = () => benchmarkCache.update(benchmarkScene, benchmarkSource, null);
    const measure = (run, frames) => {
      const start = performance.now();
      for (let frame = 0; frame < frames; frame++) run();
      return (performance.now() - start) / frames;
    };
    measure(previousFrameSelection, 1000);
    measure(cachedFrameSelection, 1000);
    const before = [];
    const after = [];
    for (let round = 0; round < 5; round++) {
      before.push(measure(previousFrameSelection, 5000));
      after.push(measure(cachedFrameSelection, 5000));
    }
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ scope: 'CPU mesh-selection microbenchmark, not frame time', nodes: 533, meshes: 132, surfaces: 40,
      previousMedianMs: median(before), cachedMedianMs: median(after), before, after }, null, 2));
  }
  console.log('Toon mesh-selection cache: hierarchy, late meshes, membership, lifecycle and unchanged-frame checks passed.');
} finally {
  await server.close();
}
