import * as Hilo3d from 'hilo3d';

export interface ToonMeshSurface {
  readonly meshes: ReadonlySet<Hilo3d.Mesh>;
  readonly excluded: Hilo3d.Mesh[];
}

export interface ToonMeshSource<Surface extends ToonMeshSurface> {
  readonly meshes: ReadonlySet<Hilo3d.Mesh>;
  readonly surfaces: readonly Surface[];
}

function sameMembers(meshes: ReadonlySet<Hilo3d.Mesh>, previous: readonly Hilo3d.Mesh[]): boolean {
  if (meshes.size !== previous.length) return false;
  for (const mesh of previous) if (!meshes.has(mesh)) return false;
  return true;
}

/** Cache mesh identities, leaving visibility, camera culling and sorting to each frame's renderer lists. */
export class ToonMeshSelection<Surface extends ToonMeshSurface> {
  readonly surfaces: Surface[] = [];
  readonly excluded: Hilo3d.Mesh[] = [];
  private scene: Hilo3d.Node | null = null;
  private model: ToonMeshSource<Surface> | null = null;
  private habitat: ToonMeshSource<Surface> | null = null;
  private readonly nodes: Hilo3d.Node[] = [];
  private readonly children: Hilo3d.Node[][] = [];
  private readonly modelMeshes: Hilo3d.Mesh[] = [];
  private readonly habitatMeshes: Hilo3d.Mesh[] = [];
  private readonly sourceSurfaces: Surface[] = [];
  private readonly surfaceMeshes: Hilo3d.Mesh[][] = [];

  update(scene: Hilo3d.Node, model: ToonMeshSource<Surface> | null,
    habitat: ToonMeshSource<Surface> | null): this {
    if (scene === this.scene && model === this.model && habitat === this.habitat
      && this.sameSelection(model, habitat) && this.sameHierarchy()) return this;

    this.clear();
    this.scene = scene;
    this.model = model;
    this.habitat = habitat;
    if (model) {
      this.sourceSurfaces.push(...model.surfaces);
      this.modelMeshes.push(...model.meshes);
    }
    if (habitat) {
      this.sourceSurfaces.push(...habitat.surfaces);
      this.habitatMeshes.push(...habitat.meshes);
    }
    const allMeshes: Hilo3d.Mesh[] = [];
    scene.traverse((node) => {
      this.nodes.push(node);
      this.children.push(node.children.slice());
      if (node instanceof Hilo3d.Mesh) {
        allMeshes.push(node);
        if (!model?.meshes.has(node) && !habitat?.meshes.has(node)) this.excluded.push(node);
      }
    });
    for (const source of this.sourceSurfaces) {
      // A ToonModel may feed multiple runtimes/scenes. Keep their exclusion arrays
      // independent so clearing or rebuilding one cannot change another's cache.
      const surface = { ...source, excluded: [] };
      this.surfaces.push(surface);
      this.surfaceMeshes.push([...surface.meshes]);
      for (const mesh of allMeshes) if (!surface.meshes.has(mesh)) surface.excluded.push(mesh);
    }
    return this;
  }

  private sameSelection(model: ToonMeshSource<Surface> | null, habitat: ToonMeshSource<Surface> | null): boolean {
    const modelCount = model?.surfaces.length ?? 0;
    if (this.surfaces.length !== modelCount + (habitat?.surfaces.length ?? 0)) return false;
    if (model && !sameMembers(model.meshes, this.modelMeshes)) return false;
    if (habitat && !sameMembers(habitat.meshes, this.habitatMeshes)) return false;
    for (let index = 0; index < this.surfaces.length; index++) {
      const surface = (index < modelCount ? model!.surfaces[index] : habitat!.surfaces[index - modelCount])!;
      if (surface !== this.sourceSurfaces[index] || !sameMembers(surface.meshes, this.surfaceMeshes[index]!)) return false;
    }
    return true;
  }

  private sameHierarchy(): boolean {
    // Hilo Node has no public hierarchy revision or add/remove event. Compare the
    // cached child references without allocating or traversing recursively. This
    // also catches same-size replacements and children created later by addons.
    for (let index = 0; index < this.nodes.length; index++) {
      const current = this.nodes[index]!.children;
      const previous = this.children[index]!;
      if (current.length !== previous.length) return false;
      for (let child = 0; child < current.length; child++) if (current[child] !== previous[child]) return false;
    }
    return true;
  }

  clear(): void {
    for (const surface of this.surfaces) surface.excluded.length = 0;
    this.scene = null;
    this.model = null;
    this.habitat = null;
    this.surfaces.length = 0;
    this.excluded.length = 0;
    this.nodes.length = 0;
    this.children.length = 0;
    this.modelMeshes.length = 0;
    this.habitatMeshes.length = 0;
    this.sourceSurfaces.length = 0;
    this.surfaceMeshes.length = 0;
  }
}
