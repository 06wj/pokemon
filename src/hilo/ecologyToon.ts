import * as Hilo3d from 'hilo3d';
import { ToonModel, ToonRendering, toonAntialias } from './toonRendering';

function uniqueMeshes(meshes: readonly Hilo3d.Mesh[]): Hilo3d.Mesh[] {
  return [...new Set(meshes)];
}

function sameMeshes(a: readonly Hilo3d.Mesh[], b: readonly Hilo3d.Mesh[]): boolean {
  if (a.length !== b.length) return false;
  const members = new Set(a);
  return b.every((mesh) => members.has(mesh));
}

/**
 * Adapt the gallery's existing cel/ink pipeline to a changing population. Source
 * meshes and materials remain owned by their GLB views; only the auxiliary toon
 * groups belong here. Membership changes rebuild groups, animation frames do not.
 */
export class EcologyToon {
  readonly rendering = new ToonRendering();
  readonly antialias = toonAntialias(this.rendering);
  private landscape: readonly Hilo3d.Mesh[] = [];
  private readonly residents = new Map<string, readonly Hilo3d.Mesh[]>();
  private readonly originalShadowFlags = new Map<Hilo3d.Mesh, boolean>();
  private disposed = false;

  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.rendering.enabled) return;
    if (enabled) {
      this.replaceLandscape();
      this.replaceResidents();
      this.syncShadowFlags();
      this.rendering.enabled = true;
    } else {
      this.rendering.enabled = false;
      this.releaseModels();
      this.restoreShadowFlags();
    }
  }

  setLandscape(meshes: readonly Hilo3d.Mesh[]): void {
    if (this.disposed) return;
    const next = uniqueMeshes(meshes);
    if (sameMeshes(this.landscape, next)) return;
    this.landscape = next;
    if (this.rendering.enabled) {
      this.replaceLandscape();
      this.syncShadowFlags();
    }
  }

  addResident(uid: string, meshes: readonly Hilo3d.Mesh[]): void {
    if (this.disposed) return;
    const next = uniqueMeshes(meshes);
    const previous = this.residents.get(uid);
    if (previous && sameMeshes(previous, next)) return;
    this.residents.set(uid, next);
    if (this.rendering.enabled) {
      this.replaceResidents();
      this.syncShadowFlags();
    }
  }

  removeResident(uid: string): void {
    if (this.disposed || !this.residents.delete(uid)) return;
    if (this.rendering.enabled) {
      this.replaceResidents();
      this.syncShadowFlags();
    }
  }

  clearResidents(): void {
    if (this.disposed || !this.residents.size) return;
    this.residents.clear();
    this.rendering.model?.dispose();
    this.rendering.model = null;
    this.syncShadowFlags();
  }

  setPixelRatio(ratio: number): void {
    if (!this.disposed && Number.isFinite(ratio) && ratio > 0) this.rendering.pixelRatio = ratio;
  }

  private replaceLandscape(): void {
    const next = this.landscape.length ? new ToonModel(this.landscape) : null;
    this.rendering.habitat?.dispose();
    this.rendering.habitat = next;
  }

  private replaceResidents(): void {
    const meshes = new Set<Hilo3d.Mesh>();
    for (const resident of this.residents.values()) for (const mesh of resident) meshes.add(mesh);
    const next = meshes.size ? new ToonModel([...meshes]) : null;
    this.rendering.model?.dispose();
    this.rendering.model = next;
  }

  private syncShadowFlags(): void {
    // The shared ToonRendering pigment pass selects castShadowsOnly meshes.
    // Opt eligible solid terrain into that pass while active, then restore each
    // source flag on disable/removal. Water, fire and transparent effects stay out.
    const selected = new Set<Hilo3d.Mesh>([
      ...this.rendering.model?.meshes ?? [], ...this.rendering.habitat?.meshes ?? [],
    ]);
    for (const [mesh, flag] of this.originalShadowFlags) if (!selected.has(mesh)) {
      mesh.castShadows = flag;
      this.originalShadowFlags.delete(mesh);
    }
    for (const mesh of selected) if (!mesh.castShadows) {
      if (!this.originalShadowFlags.has(mesh)) this.originalShadowFlags.set(mesh, false);
      mesh.castShadows = true;
    }
  }

  private restoreShadowFlags(): void {
    for (const [mesh, flag] of this.originalShadowFlags) mesh.castShadows = flag;
    this.originalShadowFlags.clear();
  }

  private releaseModels(): void {
    this.rendering.model?.dispose();
    this.rendering.habitat?.dispose();
    this.rendering.model = null;
    this.rendering.habitat = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rendering.enabled = false;
    this.releaseModels();
    this.restoreShadowFlags();
    this.residents.clear();
    this.landscape = [];
  }
}
