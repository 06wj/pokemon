import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as Hilo3d from 'hilo3d';

// Use actual materials, texture bindings and scene nodes; only graph recording is mocked.
// Material variants and shader assembly run on the CPU; driver compilation and raster output belong to browser QA.
const server = await createServer({
  configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom',
  plugins: [{
    name: 'toon-incompatible-version-fixture',
    enforce: 'pre',
    resolveId(id) { if (id === 'virtual:toon-future-hilo') return `\0${id}`; },
    load(id) {
      if (id === '\0virtual:toon-future-hilo') return "export * from 'hilo3d'; export const version = '2.0.0-alpha.999';";
    },
    transform(code, id) {
      if (id.endsWith('/toonGeometry.ts?incompatible-version')) {
        return code.replace("from 'hilo3d'", "from 'virtual:toon-future-hilo'");
      }
    },
  }],
});

try {
  const { ToonModel, ToonRendering, toonAntialias } = await server.ssrLoadModule('/src/hilo/toonRendering.ts');
  const { ToonGeometryMaterial, createToonGeometryMaterial, getToonGeometryUnsupportedReason } =
    await server.ssrLoadModule('/src/hilo/toonGeometry.ts');
  const geometry = new Hilo3d.BoxGeometry();
  const texture = new Hilo3d.Texture({ width: 1, height: 1, image: new Uint8Array([90, 170, 230, 200]) });
  const transform = new Hilo3d.Matrix3();
  transform.elements[0] = 0.75;
  transform.elements[6] = 0.25;
  const shifted = new Hilo3d.Matrix3();
  shifted.elements[6] = 0.5;
  const authored = {
    baseColor: new Hilo3d.Color(0.2, 0.4, 0.6, 0.72),
    baseColorMap: { texture, uvSet: 1, transform, encoding: 'srgb', channels: ['b', 'g', 'r', 'a'] },
    opacity: 0.97,
    opacityMap: { texture, uvSet: 0, encoding: 'data', channels: ['a', 'r', 'g', 'b'] },
    coverage: { mode: 'mask', cutoff: 0.4 }, compositing: { mode: 'opaque' },
    frontFace: 'cw', cullMode: 'none',
  };
  const mesh = (name, material) => new Hilo3d.Mesh({ name, geometry, material });
  const paint = (overrides = {}) => new Hilo3d.PBRMaterial({ ...authored, ...overrides });
  const original = paint({ metallic: 0.25, roughness: 0.3 });
  const body = mesh('body', original);
  const sibling = mesh('petal', original);
  const solids = [body, sibling,
    mesh('other metallic', paint({ metallic: 0.8, roughness: 0.3 })),
    mesh('other roughness', paint({ metallic: 0.25, roughness: 0.9 })),
    mesh('other normal map', paint({ metallic: 0.25, roughness: 0.3, normalMap: texture })),
    mesh('equal values, separate material', paint({ metallic: 0.25, roughness: 0.3 })),
    mesh('other pigment', paint({ baseColor: new Hilo3d.Color(0.7, 0.3, 0.1, 0.72) })),
    mesh('shifted UV', paint({ baseColorMap: { ...authored.baseColorMap, transform: shifted } })),
    mesh('other cutout', paint({ coverage: { mode: 'mask', cutoff: 0.6 } })),
    mesh('culled back', paint({ cullMode: 'back' })),
    mesh('other opacity', paint({ opacity: 0.96 })),
  ];
  const optical = [
    mesh('glass', paint({ compositing: { mode: 'alpha-blend', premultiplied: false } })),
    mesh('faint solid', paint({ opacity: 0.94 })),
    mesh('tail fire', paint()),
    mesh('tail effect', paint({ name: 'authored flame' })),
    mesh('basic surface', new Hilo3d.BasicMaterial()),
  ];
  const sourceMaterials = [...solids, ...optical].map((item) => item.material);
  const model = new ToonModel([...solids, ...optical]);
  assert.equal(model.surfaces.length, solids.length - 1, 'Only the same source material shares MRT state; equal pigment cannot merge different normal/metallic/roughness semantics');
  assert.deepEqual([...model.surfaces[0].meshes], [body, sibling], 'Separate meshes using the same source share one auxiliary material');
  for (const surface of model.surfaces) {
    assert.ok(surface.geometryMaterial instanceof ToonGeometryMaterial);
    for (const item of surface.meshes) {
      assert.equal(surface.geometryMaterial.source, item.material, 'Every MRT group retains its exact original material');
      assert.equal(getToonGeometryUnsupportedReason(item), null, 'Ordinary meshes are not implicitly instanced');
    }
  }
  assert.deepEqual(model.meshes, new Set(solids), 'Transparent, faint, fire and non-PBR surfaces keep their authored rendering');

  const pigment = model.surfaces[0].material;
  // Regression: unlit clip positions can round differently from the normal pass,
  // producing equal-depth holes and broken ink at oblique views (world.rotationY = 120).
  // Matching source formulas alone does not prove bit-identical raster depth.
  assert.equal(Hilo3d.resolveMaterialPassState(original, 'material-attributes').depthCompare, 'equal');
  assert.equal(pigment.lightType, 'PBR', 'Equal-depth normal rendering retains the browser-verified lit vertex path');
  assert.equal(pigment.getRenderOption().HAS_LIGHT, 1);
  assert.equal(pigment.getRenderOption().HAS_NORMAL, original.getRenderOption().HAS_NORMAL);
  assert.deepEqual([...pigment.baseColor.elements], [0, 0, 0, original.baseColor.a], 'Black conductor preserves authored alpha');
  assert.deepEqual([...pigment.emissionFactor.elements], [...original.baseColor.elements], 'Emission preserves the original pigment factor');
  assert.equal(pigment.metallic, 1);
  assert.equal(pigment.roughness, 1);
  assert.equal(pigment.diffuseEnvIntensity, 0);
  assert.equal(pigment.specularEnvIntensity, 0);
  assert.equal(pigment.opacity, original.opacity);
  assert.deepEqual(pigment.coverage, original.coverage);
  assert.deepEqual(pigment.compositing, original.compositing);
  assert.deepEqual(Hilo3d.resolveMaterialPassState(pigment, 'forward'), Hilo3d.resolveMaterialPassState(original, 'forward'),
    'Front face, culling, depth and alpha coverage remain unchanged');
  for (const [slotName, sourceSlot] of [['baseColor', 'baseColor'], ['opacity', 'opacity'], ['emission', 'baseColor']]) {
    const actual = pigment.getTextureSlot(slotName);
    const expected = original.getTextureSlot(sourceSlot);
    assert.equal(actual.texture, expected.texture, `${slotName}: texture identity is retained`);
    assert.equal(actual.uvSet, expected.uvSet, `${slotName}: UV set is retained`);
    assert.equal(actual.encoding, expected.encoding, `${slotName}: color encoding is retained`);
    assert.deepEqual(actual.channels, expected.channels, `${slotName}: channel mapping is retained`);
    assert.deepEqual(actual.transform && [...actual.transform.elements], expected.transform && [...expected.transform.elements],
      `${slotName}: UV transform is retained`);
  }
  [...solids, ...optical].forEach((item, index) => assert.equal(item.material, sourceMaterials[index], 'Original materials stay attached'));
  assert.equal(original.metallic, 0.25);
  assert.equal(original.roughness, 0.3);

  // Verify real material bindings rather than duplicating pigment/normal GLSL formulas.
  const live = paint({ normalMap: { texture, uvSet: 1, transform }, normalScale: 0.7,
    metallicRoughnessMap: texture, metallic: 0.2, roughness: 0.3 });
  const liveGeometry = createToonGeometryMaterial(live);
  assert.equal(liveGeometry.isShaderMaterial, true, 'The public custom-material marker permits general MRT output validation');
  assert.deepEqual(Hilo3d.resolveMaterialPassState(liveGeometry, 'forward'), Hilo3d.resolveMaterialPassState(live, 'forward'),
    'The dual-output pass retains raster state and writes its own depth');
  for (const name of ['baseColor', 'normal', 'opacity', 'metallicRoughness']) {
    assert.deepEqual(liveGeometry.getTextureSlot(name), live.getTextureSlot(name), `${name}: full native slot data is retained`);
  }
  const unchangedRevision = liveGeometry.revision;
  liveGeometry.sync();
  assert.equal(liveGeometry.revision, unchangedRevision, 'A static material needs no repeated data invalidation');
  live.metallic = 0.73;
  live.roughness = 0.82;
  live.normalScale = 0.6;
  live.opacity = 0.96;
  liveGeometry.sync();
  for (const [uniform, value] of [['u_metallic', 0.73], ['u_roughness', 0.82], ['u_normalMapScale', 0.6]]) {
    assert.equal(liveGeometry.getUniformData(uniform, body, {}), value, `${uniform}: updated source values reach the auxiliary UBO`);
  }
  assert.equal(liveGeometry.opacity, 0.96, 'The native UBO opacity shortcut reads the source');
  assert.equal(liveGeometry.specular, live.specular);
  assert.equal(liveGeometry.emission, live.emission);
  const updatedTransform = new Hilo3d.Matrix3();
  updatedTransform.elements[6] = 0.6;
  const replacementTexture = new Hilo3d.Texture({ width: 1, height: 1, image: new Uint8Array([10, 20, 30, 255]) });
  live.setTextureSlot('baseColor', { ...live.getTextureSlot('baseColor'), texture: replacementTexture, transform: updatedTransform,
    encoding: 'linear', channels: ['g', 'b', 'r', 'a'] });
  live.baseColor.r = 0.35;
  live.invalidateData();
  liveGeometry.sync();
  assert.equal(liveGeometry.getTextureSlot('baseColor').texture, replacementTexture, 'A texture replacement reaches MRT');
  assert.deepEqual([...liveGeometry.getTextureSlot('baseColor').transform.elements], [...updatedTransform.elements], 'UV transform changes reach MRT');
  assert.equal(liveGeometry.getTextureSlot('baseColor').encoding, 'linear');
  assert.deepEqual(liveGeometry.getTextureSlot('baseColor').channels, ['g', 'b', 'r', 'a']);
  assert.deepEqual([...liveGeometry.getUniformData('u_baseColor', body, {})], [...live.baseColor.elements], 'Referenced base-color edits reach MRT after source invalidation');
  updatedTransform.elements[6] = 0.9;
  live.invalidateData();
  liveGeometry.sync();
  assert.equal(liveGeometry.getTextureSlot('baseColor').transform.elements[6], updatedTransform.elements[6], 'In-place UV edits follow the native invalidation contract');
  for (const uniform of ['u_materialTextureTransforms', 'u_materialTextureInfo', 'u_materialTextureChannels']) {
    // The semantic API reuses scratch arrays; snapshot before the next binding read.
    const sourceData = Array.from(live.getUniformData(uniform, body, {}));
    const geometryData = Array.from(liveGeometry.getUniformData(uniform, body, {}));
    assert.deepEqual(geometryData, sourceData, `${uniform}: the original slot metadata reaches the UBO`);
  }
  const syncedRevision = liveGeometry.revision;
  liveGeometry.sync();
  assert.equal(liveGeometry.revision, syncedRevision);
  for (const uniform of ['u_modelViewProjectionMatrix', 'u_jointMat']) {
    const binding = liveGeometry.getUniformInfo(uniform);
    const sourceBinding = live.getUniformInfo(uniform);
    assert.equal(binding.isDependMesh, sourceBinding.isDependMesh);
    assert.equal(binding.notSupportInstanced, sourceBinding.notSupportInstanced);
  }
  assert.equal(liveGeometry.getAttributeData('a_position', body, {}), live.getAttributeData('a_position', body, {}),
    'Geometry bindings still use the original mesh');

  const compiler = new Hilo3d.MaterialCompiler();
  for (const backend of ['webgl2', 'webgpu']) {
    const variant = compiler.compile({ instance: liveGeometry, role: 'forward',
      target: { colorFormats: ['rgba8unorm-srgb', 'rgba8unorm'], depthStencilFormat: 'depth32float', sampleCount: 1 },
      vertexLayoutClass: 'skinned', renderingProfile: 'portable', backend });
    assert.ok(variant, `${backend}: the public compiler accepts pigment plus native attributes`);
    assert.equal(variant.state.depthWrite, true);
    assert.equal(variant.state.depthCompare, 'less-equal', 'MRT does not depend on equality between separately compiled vertex shaders');
  }
  const skinGeometry = new Hilo3d.BoxGeometry();
  skinGeometry.uvs1 = skinGeometry.uvs;
  skinGeometry.colors = new Hilo3d.GeometryData(new Float32Array(skinGeometry.vertices.count * 4).fill(1), 4);
  skinGeometry.skinIndices = new Hilo3d.GeometryData(new Uint8Array(skinGeometry.vertices.count * 4), 4);
  skinGeometry.skinWeights = new Hilo3d.GeometryData(new Float32Array(skinGeometry.vertices.count * 4), 4);
  const skinned = new Hilo3d.SkinnedMesh({ geometry: skinGeometry, material: live,
    skeleton: new Hilo3d.Skeleton({ jointNodeList: [new Hilo3d.Node()], inverseBindMatrices: [new Hilo3d.Matrix4()] }) });
  assert.equal(getToonGeometryUnsupportedReason(skinned), null, 'Native non-instanced skinned meshes support MRT');
  const lights = new Hilo3d.LightManager();
  lights.addLight(new Hilo3d.DirectionalLight());
  for (const mode of ['LINEAR', 'EXP', 'EXP2']) {
    const fog = new Hilo3d.Fog({ mode });
    const shader = Hilo3d.Shader.getShader(skinned, liveGeometry, false, lights, fog, false, undefined, true, 'forward');
    assert.ok(shader, `The public shader assembler accepts native skinning with ${mode} fog`);
    // Header parity checks feature selection, not the implementation of the engine GLSL.
    const features = (material) => Hilo3d.Shader.getHeader(skinned, material, lights, fog, false, 'forward')
      .split('\n').filter((line) => !line.startsWith('#define SHADER_NAME '));
    assert.deepEqual(features(liveGeometry), features(live),
      'Skinning, vertex color, normal-map UVs, cutout and fog use the original feature selection');
  }
  const futureModule = await server.ssrLoadModule('/src/hilo/toonGeometry.ts?incompatible-version');
  assert.throws(() => futureModule.createToonGeometryMaterial(new Hilo3d.PBRMaterial()), /requires hilo3d 2\.0\.0-alpha\.8; found 2\.0\.0-alpha\.999/,
    'An unreviewed dependency version fails explicitly before shader adaptation');
  const missingSourceModule = await server.ssrLoadModule('/src/hilo/toonGeometry.ts?missing-source-fixture');
  const nativePbrSource = Hilo3d.Shader.shaders['pbr.frag'];
  try {
    Hilo3d.Shader.shaders['pbr.frag'] = 'void main() {}';
    assert.throws(() => missingSourceModule.createToonGeometryMaterial(new Hilo3d.PBRMaterial()), /shader structure has changed/,
      'Unexpected public shader structure fails explicitly instead of silently omitting an output');
  } finally { Hilo3d.Shader.shaders['pbr.frag'] = nativePbrSource; }

  const rock = mesh('habitat rock', new Hilo3d.PBRMaterial({ baseColor: new Hilo3d.Color(0.1, 0.2, 0.3) }));
  const habitat = new ToonModel([rock]);
  assert.equal(habitat.surfaces[0].material.getTextureSlot('emission'), null, 'Constant pigment needs no emission texture');
  assert.deepEqual([...habitat.surfaces[0].material.emissionFactor.elements], [...rock.material.baseColor.elements],
    'Constant pigment retains its linear color factor without squaring it');
  const replacementMesh = mesh('replacement creature', new Hilo3d.PBRMaterial());
  const replacement = new ToonModel([replacementMesh]);
  const instancedMesh = mesh('explicitly instanced creature', new Hilo3d.PBRMaterial());
  instancedMesh.useInstanced = true;
  const instanced = new ToonModel([instancedMesh]);
  assert.equal(instanced.surfaces[0].geometryMaterial, null, 'An initially instanced mesh preserves the established fallback');
  const scene = new Hilo3d.Node();
  for (const item of [...solids, ...optical, rock, replacementMesh, instancedMesh]) item.addTo(scene);
  const camera = new Hilo3d.PerspectiveCamera({ near: 0.1, far: 120 });
  const feature = new ToonRendering();
  const runtime = feature.create();
  let nextHandle = 100;

  function record(recording = runtime) {
    const frame = { passes: [], lists: new Map(), textures: new Map(), replacement: null };
    const context = {
      cullingResults: 1,
      resources: { color: 2, colorEncoding: 'linear', replaceColor: (texture, encoding) => { frame.replacement = { texture, encoding }; } },
      pipeline: {
        camera, scene, output: { width: 640, height: 480 },
        // Engine-owned pool allocation is outside this CPU fixture.
        acquirePassParameters(pool) {
          assert.ok(pool instanceof Hilo3d.RenderPassParameterPool);
          return { rendererLists: [], colorAttachments: [], inputTextures: [] };
        },
        createRendererList(descriptor) {
          const handle = nextHandle++;
          frame.lists.set(handle, { ...descriptor, excludeMeshes: [...descriptor.excludeMeshes] });
          return handle;
        },
        graph: {
          createTexture(name, descriptor) {
            const handle = nextHandle++;
            frame.textures.set(handle, { name, ...descriptor });
            return handle;
          },
          addPass(pass, parameters) {
            const captured = { pass, parameters, colors: [], depths: [], declared: [], drawn: [] };
            frame.passes.push(captured);
            if (pass instanceof Hilo3d.FullscreenRenderPass) return;
            pass.setup({
              useColorAttachment: (attachment) => captured.colors.push(attachment),
              useDepthStencilAttachment: (attachment) => captured.depths.push(attachment),
              useRendererList(handle) {
                assert.ok(frame.lists.has(handle), 'Scene passes declare existing lists');
                assert.ok(!captured.declared.includes(handle), 'Each list is declared once');
                captured.declared.push(handle);
              },
            }, parameters);
            pass.execute({ commands: {
              drawRendererList(handle) {
                assert.ok(captured.declared.includes(handle), 'Only declared lists can execute');
                captured.drawn.push(handle);
              },
            } }, parameters);
          },
        },
      },
    };
    recording.record(context);
    return frame;
  }

  function assertFrame(frame, expectedGroups, expectedMeshes, clearDepth = 1, mrt = true, pixelated = false) {
    const pigmentPasses = frame.passes.filter((entry) => entry.declared.some((handle) => frame.lists.get(handle).overrideMaterial));
    assert.equal(pigmentPasses.length, 1, 'All pigment groups use exactly one render pass');
    const [pigmentPass] = pigmentPasses;
    assert.equal(pigmentPass.colors.length, mrt ? 2 : 1, 'MRT declares pigment and surface data together; fallback declares only pigment');
    for (const attachment of pigmentPass.colors) {
      assert.equal(attachment.loadOp, 'clear');
      assert.deepEqual(attachment.clearValue, { r: 0, g: 0, b: 0, a: 0 }, 'Each attachment clears once, regardless of material count');
    }
    assert.equal(frame.textures.get(pigmentPass.colors[0].texture).format, 'rgba8unorm-srgb', 'Pigment storage preserves dark-color precision with four bytes per pixel');
    assert.equal(pigmentPass.depths.length, 1);
    assert.equal(pigmentPass.depths[0].depthLoadOp, 'clear');
    assert.equal(pigmentPass.depths[0].depthClearValue, clearDepth);
    assert.deepEqual(pigmentPass.drawn, pigmentPass.declared, 'List draw order matches setup order');
    assert.deepEqual(pigmentPass.drawn.map((handle) => frame.lists.get(handle).overrideMaterial),
      expectedGroups.map((group) => mrt ? group.geometryMaterial : group.material),
      'Every current color group draws once in model/habitat order');
    const allMeshes = [];
    scene.traverse((node) => { if (node instanceof Hilo3d.Mesh) allMeshes.push(node); });
    pigmentPass.drawn.forEach((handle, index) => {
      const list = frame.lists.get(handle);
      assert.equal(list.cullingResults, 1, 'Pigment reuses the scene culling result');
      assert.deepEqual(new Set(allMeshes.filter((item) => !list.excludeMeshes.includes(item))), expectedGroups[index].meshes,
        'Each override material targets exactly its current meshes');
    });
    const normalPass = frame.passes.find((entry) => entry.declared.some((handle) => frame.lists.get(handle).materialPass === 'material-attributes'));
    let normalTexture;
    if (mrt) {
      assert.equal(normalPass, undefined, 'The MRT path needs no second geometry traversal for normals');
      normalTexture = pigmentPass.colors[1].texture;
      assert.deepEqual(new Set(expectedGroups.flatMap((group) => [...group.meshes])), new Set(expectedMeshes),
        'The two outputs cover the same complete set of current meshes');
      assert.equal(frame.lists.size, expectedGroups.length, 'MRT records one list per original material, with no hidden normal list');
    } else {
      assert.ok(normalPass);
      assert.deepEqual(normalPass.drawn, normalPass.declared);
      assert.equal(normalPass.drawn.length, 1);
      assert.deepEqual(normalPass.depths, [{ texture: pigmentPass.depths[0].texture, depthReadOnly: true }],
        'Fallback normals reuse pigment depth without a second clear or depth store');
      const normalList = frame.lists.get(normalPass.drawn[0]);
      assert.deepEqual(new Set(allMeshes.filter((item) => !normalList.excludeMeshes.includes(item))), new Set(expectedMeshes),
        'Fallback normals contain only the current model and habitat');
      normalTexture = normalPass.colors[0].texture;
      assert.equal(frame.lists.size, expectedGroups.length + 1);
    }
    assert.equal(frame.textures.get(normalTexture).format, 'rgba8unorm', 'Encoded surface data remains linear unsigned-normalized');
    const screenPass = frame.passes.find((entry) => entry.pass instanceof Hilo3d.FullscreenRenderPass);
    assert.deepEqual(screenPass.parameters.inputTextures, [2, pigmentPass.colors[0].texture, normalTexture, pigmentPass.depths[0].texture],
      'Cel shading samples the matching current color, pigment, normal and depth textures');
    let painted = screenPass.parameters.colorAttachments[0].texture;
    if (pixelated) {
      const expand = frame.passes.at(-1);
      assert.deepEqual(frame.textures.get(painted).extent, { width: 214, height: 160 },
        'Filtering runs at logical pixel resolution, rounding up partial viewport cells');
      assert.deepEqual(expand.parameters.inputTextures, [painted], 'Expansion reads the filtered grid, not the original scene');
      painted = expand.parameters.colorAttachments[0].texture;
      assert.deepEqual(frame.textures.get(painted).extent, { width: 640, height: 480 },
        'The expanded color returns to full resolution before post processing');
    }
    assert.deepEqual(frame.replacement, { texture: painted, encoding: 'linear' });
    assert.equal(frame.passes.length, (mrt ? 2 : 3) + Number(pixelated), 'Pixel filtering adds only one expansion pass');
    assert.equal(frame.textures.size, 4 + Number(pixelated), 'Only pixel mode allocates a small filtered grid');
  }

  try {
    feature.model = model;
    feature.habitat = habitat;
    const disabled = record();
    assert.equal(disabled.passes.length, 0);
    assert.equal(disabled.textures.size, 0, 'Disabled toon allocates no graph textures');
    feature.enabled = true;
    assertFrame(record(), [...model.surfaces, ...habitat.surfaces], [...solids, rock]);
    const geometryRevisions = [...model.surfaces, ...habitat.surfaces].map((surface) => surface.geometryMaterial.revision);
    const toonPaint = record().passes.find((entry) => entry.pass instanceof Hilo3d.FullscreenRenderPass).pass;
    feature.pixelRatio = 1.6;
    feature.style = 'pixel';
    const pixelFrame = record();
    assertFrame(pixelFrame, [...model.surfaces, ...habitat.surfaces], [...solids, rock], 1, true, true);
    const pixelPaint = pixelFrame.passes.find((entry) => entry.pass instanceof Hilo3d.FullscreenRenderPass).pass;
    assert.notEqual(pixelPaint, toonPaint, 'Pixel selects its own paint shader without a second geometry pipeline');
    assert.deepEqual([...model.surfaces, ...habitat.surfaces].map((surface) => surface.geometryMaterial.revision), geometryRevisions,
      'Changing paint style reuses the same source bindings and geometry data');
    feature.style = 'toon';
    feature.pixelRatio = 1;
    assert.equal(record().passes.find((entry) => entry.pass instanceof Hilo3d.FullscreenRenderPass).pass, toonPaint,
      'Switching back restores the existing toon pass');
    const resolve = toonAntialias(feature).create();
    try {
      const smoothFrame = record(resolve);
      feature.style = 'pixel';
      const nearestFrame = record(resolve);
      assert.equal(nearestFrame.passes.length, 1, 'Pixel resolve replaces, rather than follows, the smoothing pass');
      assert.notEqual(nearestFrame.passes[0].pass, smoothFrame.passes[0].pass, 'Pixel mode cannot accidentally run contour smoothing');
      assert.equal(nearestFrame.lists.size, 0, 'Final pixel resolve needs no geometry draws');
      assert.deepEqual(nearestFrame.passes[0].parameters.inputTextures, [2]);
      assert.equal(nearestFrame.replacement.encoding, 'linear', 'Nearest sampling preserves the pipeline color encoding');
      feature.enabled = false;
      assert.equal(record(resolve).textures.size, 0, 'Leaving stylized modes allocates no resolve targets');
    } finally { resolve.destroy(); feature.enabled = true; feature.style = 'toon'; }
    assertFrame(record(), [...model.surfaces, ...habitat.surfaces], [...solids, rock]);
    assert.deepEqual([...model.surfaces, ...habitat.surfaces].map((surface) => surface.geometryMaterial.revision), geometryRevisions,
      'Unchanged frames preserve every MRT material revision');
    // The later mesh in a shared group must be checked too, not only its first mesh.
    sibling.useInstanced = true;
    assertFrame(record(), [...model.surfaces, ...habitat.surfaces], [...solids, rock], 1, false);
    sibling.useInstanced = false;
    assertFrame(record(), [...model.surfaces, ...habitat.surfaces], [...solids, rock]);
    [...solids, ...optical].forEach((item, index) => assert.equal(item.material, sourceMaterials[index], 'MRT/fallback transitions never replace original materials'));
    feature.enabled = false;
    assert.equal(record().lists.size, 0, 'Disabling after an active frame records no stale geometry');
    feature.enabled = true;
    feature.model = instanced;
    feature.habitat = null;
    assertFrame(record(), instanced.surfaces, [instancedMesh], 1, false);
    feature.model = replacement;
    feature.habitat = null;
    camera.depthMode = 'reversed';
    assertFrame(record(), replacement.surfaces, [replacementMesh], 0);
    feature.model = null;
    assert.equal(record().passes.length, 0, 'Removing the final model records no stale passes');
    feature.habitat = habitat;
    assertFrame(record(), habitat.surfaces, [rock], 0);
    for (const group of [model, habitat, replacement, instanced]) {
      const surfaces = [...group.surfaces];
      group.dispose();
      assert.equal(group.meshes.size, 0);
      assert.equal(group.surfaces.length, 0);
      surfaces.forEach((surface) => {
        assert.equal(surface.meshes.size, 0);
        assert.equal(surface.excluded.length, 0);
      });
    }
    assert.equal(record().passes.length, 0, 'Disposed models cannot leak retained draw lists');
  } finally { runtime.destroy(); }
  console.log('Toon MRT source grouping, pigment/UV preservation, live bindings, CPU material variants, version guards, two-pass recording, instancing fallback, mode/model switching and disposal passed.');
} finally { await server.close(); }
