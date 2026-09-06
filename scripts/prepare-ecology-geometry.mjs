/** Prepare deterministic topology for Blender's mesh authoring step. */
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createServer } from 'vite';
import * as Hilo3d from 'hilo3d';

const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
try {
  const { EcologyGeometryRecipe } = await server.ssrLoadModule('/scripts/ecologyGeometryRecipe.ts');
  const stage = new Hilo3d.Node();
  stage.camera = null;
  new EcologyGeometryRecipe(stage);
  const meshes = [];
  stage.traverse((node) => {
    if (!(node instanceof Hilo3d.Mesh) || !node.geometry?.vertices) return;
    const material = node.material;
    const base = material instanceof Hilo3d.PBRMaterial ? material.baseColor : new Hilo3d.Color(.045, .32, .30);
    meshes.push({ name: node.name, positions: [...node.geometry.vertices.data], color: [base.r, base.g, base.b, 1], metallic: material instanceof Hilo3d.PBRMaterial ? material.metallic : 0, roughness: .94 });
  });
  const output = process.argv[2] ?? '/tmp/pokemon-ecology-geometry.json.gz';
  await writeFile(output, gzipSync(JSON.stringify({ coordinateSystem: 'Y_UP', generator: 'EcologyGeometryRecipe / deterministic topology', meshes })));
  console.log(JSON.stringify({ output, meshCount: meshes.length, triangles: meshes.reduce((count, mesh) => count + mesh.positions.length / 9, 0) }));
} finally { await server.close(); }
