import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_HILO_VERSION = '2.0.0-alpha.5';

const REGION = '//#region src/render/renderer/ShadowAtlasPageResidency.ts';
const ORIGINAL = 'f = d === "allocation" || d === "layout" || d === "light"';
const PATCHED = 'f = !0 /* pokemon: update dirty shadow slices atomically */';
const ELIGIBILITY = 'if (t.dirtySlices[r] !== !0 || n[r] !== !0) continue;';

function failStructure(detail) {
  throw new Error(`Unexpected Hilo3D shadow scheduler structure: ${detail}. Review this compatibility patch before installing.`);
}

function uniqueIndex(source, needle, label) {
  const index = source.indexOf(needle);
  if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
    failStructure(`expected exactly one ${label}`);
  }
  return index;
}

function assertSupportedVersion(version) {
  if (version !== SUPPORTED_HILO_VERSION) {
    throw new Error(`Hilo3D shadow compatibility patch supports only ${SUPPORTED_HILO_VERSION}; found ${version}. Review whether the new version still needs this patch.`);
  }
}

/** Patch one predicate, retaining the engine's cache, slice selection and transaction logic. */
export function patchShadowUpdatesSource(source, version) {
  assertSupportedVersion(version);
  const start = uniqueIndex(source, REGION, 'ShadowAtlasPageResidency region');
  const end = source.indexOf('\n//#endregion', start + REGION.length);
  if (end < 0) failStructure('missing ShadowAtlasPageResidency region terminator');
  const region = source.slice(start, end);
  uniqueIndex(region, ELIGIBILITY, 'dirty and scheduled slice guard');
  uniqueIndex(region, '"Mandatory shadow page scheduling made no progress"', 'complete-slice scheduling path');

  const originalCount = source.split(ORIGINAL).length - 1;
  const patchedCount = source.split(PATCHED).length - 1;
  if (!((originalCount === 1 && patchedCount === 0) || (originalCount === 0 && patchedCount === 1))) {
    failStructure('expected exactly one original or patched force-complete predicate');
  }
  const current = originalCount === 1 ? ORIGINAL : PATCHED;
  const index = source.indexOf(current);
  if (index < start || index + current.length > end) failStructure('force-complete predicate is outside the expected region');
  if (patchedCount === 1) return { source, changed: false };

  // alpha.5 updates only 16 of a 2048px map's 256 pages per frame on the portable
  // profile. Animated casters then leave multiple poses in the live shadow map.
  // Complete every dirty, scheduled slice before sampling it, without lowering
  // resolution. Cache hits and the separate slice-update budget remain intact.
  return { source: source.slice(0, index) + PATCHED + source.slice(index + ORIGINAL.length), changed: true };
}

export async function patchInstalledHilo3d(packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/hilo3d')) {
  const metadata = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'));
  if (metadata.name !== 'hilo3d') throw new Error(`Expected the hilo3d package; found ${metadata.name}.`);
  assertSupportedVersion(metadata.version);
  const bundlePath = resolve(packageDirectory, 'dist/Hilo3d.js');
  const original = await readFile(bundlePath, 'utf8');
  const result = patchShadowUpdatesSource(original, metadata.version);
  if (result.changed) await writeFile(bundlePath, result.source, 'utf8');
  return { changed: result.changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { changed } = await patchInstalledHilo3d();
    console.log(`Hilo3D ${SUPPORTED_HILO_VERSION}: atomic shadow updates ${changed ? 'applied' : 'already applied'}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
