import * as Hilo3d from 'hilo3d';
import { PARTICLE_STAGE_SERVICE, createParticleStageSystem } from '@hilo/addon-particle';
import { type PokemonEntry } from '../content/pokemon';
import type { MaterialKey } from '../content/materials';
import { createMaterial, createOriginalMaterial, needsFacialBacking } from './createMaterial';
import { getHabitat, type HabitatKey } from '../content/habitats';
import { loadEnvironment, type EnvironmentLighting } from './environment';
import { HabitatBackdrop } from './habitatBackdrop';
import { HabitatEffects } from './habitatEffects';
import { LagoonWater, LagoonWaterResources } from './lagoonWater';
import { ToonModel, ToonRendering, toonAntialias } from './toonRendering';
import { getPoseBounds } from './poseBounds';

interface LoadedPokemon {
  id: string;
  node: Hilo3d.Node;
  meshes: Hilo3d.Mesh[];
  faceBackings: Hilo3d.Mesh[];
  originalMaterials: (Hilo3d.MaterialInstance | null)[];
  animation?: Hilo3d.Animation;
  animationName?: string;
  resetAnimationPose(): void;
  prepareFaceBackings(): void;
  bounds?: Hilo3d.Bounds;
  updateFaceBackings: (() => void)[];
  skinMaterials: Map<Exclude<MaterialKey, 'original' | 'toon'>, Hilo3d.PBRMaterial[]>;
  toon?: ToonModel;
  destroy(): void;
}

interface PokemonStageOptions {
  container: HTMLElement;
  assetBase: string;
  onLoadingChange(loading: boolean): void;
  onBackend(backend: string): void;
  onAnimationChange?(name: string, pokemonId: string): void;
  onSceneError?(message: string): void;
}

function playAnimationClip(animation: Hilo3d.Animation, name: string | undefined): void {
  animation.loop = Infinity;
  animation.play(name);
  // This controller owns the clock; remove the registration made by Animation.play().
  animation.stop();
  animation.resume();
  animation.updateAnimStates();
}

function galleryColor(hex: number): Hilo3d.Color {
  const linear = (byte: number): number => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return new Hilo3d.Color(linear((hex >> 16) & 255), linear((hex >> 8) & 255), linear(hex & 255));
}

export class PokemonStageController {
  private readonly stage: Hilo3d.Stage;
  private readonly camera: Hilo3d.PerspectiveCamera;
  private readonly controls: Hilo3d.OrbitControls;
  private readonly rig: Hilo3d.Node;
  private readonly world: Hilo3d.Node;
  private readonly backdrop: HabitatBackdrop;
  private readonly keyLight: Hilo3d.DirectionalLight;
  private readonly fillLight: Hilo3d.DirectionalLight;
  private habitatNode: Hilo3d.Node | null = null;
  private habitatKey: HabitatKey | null = null;
  private habitatMeshes: Hilo3d.Mesh[] = [];
  private habitatToon: ToonModel | null = null;
  private lagoonWater: LagoonWater | null = null;
  private readonly lagoonWaterResources = new LagoonWaterResources();
  private environment: EnvironmentLighting | undefined;
  private readonly environments = new Map<string, Promise<EnvironmentLighting>>();
  private readonly ticker: Hilo3d.Ticker;
  private readonly options: PokemonStageOptions;
  private readonly habitatEffects: HabitatEffects;
  private current: LoadedPokemon | null = null;
  private loadSequence = 0;
  private material: MaterialKey = 'original';
  private autoRotate = false;
  private destroyed = false;

  private constructor(
    options: PokemonStageOptions,
    stage: Hilo3d.Stage,
    camera: Hilo3d.PerspectiveCamera,
    private readonly toonRendering: ToonRendering,
  ) {
    this.options = options;
    this.stage = stage;
    this.camera = camera;

    new Hilo3d.AmbientLight({
      color: new Hilo3d.Color(0.8, 0.9, 1), amount: 0.1,
    }).addTo(stage);
    // Touch-first phones/tablets use smaller shadows, independent of viewport orientation.
    const shadowMapSize = window.matchMedia('(hover: none) and (pointer: coarse)').matches ? 1024 : 2048;
    this.keyLight = new Hilo3d.DirectionalLight({
      color: new Hilo3d.Color(1, 0.91, 0.79), amount: 1.6,
      x: 6, y: 10, z: 4,
      direction: new Hilo3d.Vector3(-3, -5, -2),
      shadow: {
        width: shadowMapSize, height: shadowMapSize, minBias: 0.005, maxBias: 0.03,
        cameraInfo: { near: 0.1, far: 35, left: -6, right: 6, top: 6, bottom: -6 },
        shadowStrength: 0.85,
      },
    }).addTo(stage);
    this.fillLight = new Hilo3d.DirectionalLight({
      color: new Hilo3d.Color(0.69, 0.85, 1), amount: 0.5,
      direction: new Hilo3d.Vector3(2, -1, 2),
    }).addTo(stage);
    new Hilo3d.DirectionalLight({
      color: new Hilo3d.Color(1, 0.94, 0.86), amount: 0.8,
      direction: new Hilo3d.Vector3(0.6, -0.6, 2.5),
    }).addTo(stage);
    this.world = new Hilo3d.Node({ name: 'habitat-diorama' }).addTo(stage);
    this.habitatEffects = new HabitatEffects(this.world, stage.systems.get(PARTICLE_STAGE_SERVICE));
    this.backdrop = new HabitatBackdrop(stage, options.assetBase);
    this.rig = new Hilo3d.Node({ name: 'pokemon-rig' }).addTo(this.world);
    this.controls = new Hilo3d.OrbitControls(stage, {
      camera, target: new Hilo3d.Vector3(0, 0.75, 0), minDistance: 6, maxDistance: 24,
      minPolarAngle: 0.3, maxPolarAngle: Math.PI * 0.48,
      enablePan: false, rotateSpeed: 0.64, zoomSpeed: 0.7,
    });

    this.ticker = new Hilo3d.Ticker(60);
    this.ticker.addTick({ tick: (dtMilliseconds): void => {
      const dt = Math.min(dtMilliseconds, 50);
      try {
        if (this.autoRotate && this.current) this.world.rotationY += dt / 1000 * 7;
        this.current?.animation?.tick(dt);
        this.updatePokemonPose();
        this.lagoonWater?.update(dt);
        stage.tick(dt);
      } catch (error) {
        this.ticker.stop();
        const details: string[] = [];
        let cause: unknown = error;
        for (let depth = 0; cause && depth < 5; depth++) {
          details.push(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
          cause = cause instanceof Error ? cause.cause : undefined;
        }
        console.error(`Habitat rendering failed: ${details.join('\nCaused by: ')}`);
        this.options.onSceneError?.('当前设备无法完成场景渲染，请刷新页面后重试。');
      }
    } });
    this.ticker.start();
  }

  static async create(options: PokemonStageOptions): Promise<PokemonStageController> {
    const width = Math.max(1, options.container.clientWidth);
    const height = Math.max(1, options.container.clientHeight);
    const camera = new Hilo3d.PerspectiveCamera({
      fov: 34, aspect: width / height, near: 0.1, far: 120,
      x: 6, y: 4.2, z: 9,
    });
    const toonRendering = new ToonRendering();
    const requested = new URL(location.href).searchParams.get('backend');
    const backend = requested === 'webgl2' || requested === 'webgpu' ? requested : 'auto';
    const stage = await Hilo3d.Stage.create({
      backend, container: options.container, camera,
      shadowUpdateMode: 'full',
      fog: new Hilo3d.Fog({ mode: 'LINEAR', start: 13, end: 27, color: galleryColor(0x101d1c) }),
      width, height, pixelRatio: Math.min(devicePixelRatio || 1, 1.75),
      antialias: true, alpha: false, clearColor: galleryColor(0x101d1c),
      systems: [createParticleStageSystem()],
      renderPipeline: new Hilo3d.PostProcessRenderPipelineFactory({
        opaqueTexture: true,
        groundTruthAmbientOcclusion: false,
        bloom: { threshold: 1.8, intensity: 0.12, maxLevels: 4 },
        colorUber: { toneMapping: 'pbr-neutral', exposure: -0.5, contrast: 0.025, saturation: 0.035, dithering: true },
        features: [toonRendering, toonAntialias(toonRendering)],
      }),
    });
    options.onBackend(stage.renderer.backend);
    const controller = new PokemonStageController(options, stage, camera, toonRendering);
    controller.resize();
    return controller;
  }

  resize(): void {
    const width = Math.max(1, this.options.container.clientWidth);
    const height = Math.max(1, this.options.container.clientHeight);
    this.stage.resize(width, height, Math.min(devicePixelRatio || 1, 1.75));
    this.toonRendering.pixelRatio = Math.min(devicePixelRatio || 1, 1.75);
    this.camera.aspect = width / height;
    this.backdrop.resize(this.camera.aspect);
    // Preserve framing when the gallery switches between desktop and mobile layouts.
    this.resetView();
  }

  setAutoRotate(value: boolean): void { this.autoRotate = value; }

  /** Preview a manifest animation without changing the user's camera or idle-based framing. */
  setAnimation(name: string): void {
    const current = this.current;
    const animation = current?.animation;
    if (!current || !animation || this.destroyed) return;
    if (!animation.clips[name]) {
      console.error(`The current model does not contain animation ${name}.`);
      this.options.onSceneError?.('当前模型不包含此动作，请选择其他动作。');
      return;
    }
    if (current.animationName === name) return;
    current.resetAnimationPose();
    playAnimationClip(animation, name);
    current.animationName = name;
    this.updatePokemonPose(true);
    this.options.container.dataset.animation = name;
    this.options.onAnimationChange?.(name, current.id);
    this.options.onSceneError?.('');
  }

  private updatePokemonPose(forceWorldUpdate = false): void {
    // Water reads world matrices before stage.tick.
    if (forceWorldUpdate || this.lagoonWater) this.stage.updateMatrixWorld(true);
    for (const update of this.current?.updateFaceBackings ?? []) update();
  }

  setHabitat(key: HabitatKey): void {
    this.habitatEffects.setHabitat(key);
    void this.backdrop.setHabitat(key).catch((error: unknown) => {
      console.error(error);
      this.options.onSceneError?.('场景背景加载失败，请刷新后重试。');
    });
  }

  resetView(): void {
    const fit = Math.max(1, 1.15 / this.camera.aspect);
    this.world.rotationY = 0;
    this.controls.setView(
      new Hilo3d.Vector3(4.7 * fit, 0.75 + 3.6 * fit, 7.8 * fit),
      new Hilo3d.Vector3(0, 0.75, 0),
    );
  }

  setMaterial(key: MaterialKey): void {
    this.material = key;
    this.options.container.dataset.material = key;
    if (this.current) this.applyMaterial(this.current, key, this.environment);
    this.toonRendering.enabled = key === 'toon' && this.current !== null;
    this.toonRendering.model = key === 'toon' ? this.current?.toon ?? null : null;
    this.updateHabitatMaterial();
  }

  private updateHabitatMaterial(): void {
    const toon = this.material === 'toon';
    if (toon && this.habitatMeshes.length) this.habitatToon ??= new ToonModel(this.habitatMeshes);
    this.toonRendering.habitat = toon ? this.habitatToon : null;
    this.lagoonWater?.setToon(toon);
  }

  private applyMaterial(model: LoadedPokemon, key: MaterialKey, environment: EnvironmentLighting | undefined): void {
    if (key === 'original' || key === 'toon') {
      model.faceBackings.forEach((mesh) => { mesh.visible = false; });
      model.meshes.forEach((mesh, index) => {
        mesh.material = model.originalMaterials[index] ?? null;
      });
      if (key === 'toon') {
        model.toon ??= new ToonModel(model.meshes);
      }
    } else {
      model.prepareFaceBackings();
      let materials = model.skinMaterials.get(key);
      if (!materials) {
        materials = model.originalMaterials.map((source, index) => createMaterial(
          key, source, environment, model.meshes[index]?.name,
        ));
        model.skinMaterials.set(key, materials);
      }
      model.meshes.forEach((mesh, index) => {
        mesh.material = materials?.[index] ?? null;
      });
      const backingMaterial = materials.find((item) => !item.name?.startsWith('facial pigment'))
        ?? createMaterial(key, null, environment);
      model.faceBackings.forEach((mesh) => {
        mesh.visible = true;
        mesh.material = backingMaterial;
      });
    }
  }

  private getEnvironment(kind: 'forest' | 'studio'): Promise<EnvironmentLighting> {
    let pending = this.environments.get(kind);
    if (!pending) {
      pending = loadEnvironment(this.stage.renderer, this.options.assetBase, kind);
      this.environments.set(kind, pending);
      void pending.catch(() => this.environments.delete(kind));
    }
    return pending;
  }

  async loadPokemon(data: PokemonEntry): Promise<void> {
    const sequence = ++this.loadSequence;
    this.options.onLoadingChange(true);
    this.options.onSceneError?.('');
    const habitat = getHabitat(data);

    // Acquire all required resources transactionally: fast navigation never mounts stale scenery.
    const results = await Promise.allSettled([
      new Hilo3d.GLTFLoader().load({ src: `${this.options.assetBase}${data.model}`, isMultiAnim: true })
        .then(async (model) => {
          model.anim?.stop();
          try { await model.ready; return model; }
          catch (error) {
            model.node.destroy(this.stage.renderer, true);
            throw error;
          }
        }),
      this.habitatKey === habitat.key
        ? Promise.resolve(null)
        : new Hilo3d.GLTFLoader().load({ src: `${this.options.assetBase}habitats/${habitat.key}.glb` })
          .then(async (model) => { await model.ready; return model; }),
      this.getEnvironment(habitat.environment),
    ] as const);
    const [pokemonResult, habitatResult, environmentResult] = results;
    const rejected = results.find((result) => result.status === 'rejected');
    if (sequence !== this.loadSequence || this.destroyed || rejected) {
      if (pokemonResult.status === 'fulfilled') {
        pokemonResult.value.anim?.stop();
        pokemonResult.value.node.destroy(this.stage.renderer, true);
      }
      if (habitatResult.status === 'fulfilled') habitatResult.value?.node.destroy(this.stage.renderer, true);
      if (sequence === this.loadSequence && !this.destroyed) {
        const reason = rejected?.status === 'rejected' ? rejected.reason : null;
        console.error(`Failed to load habitat for #${data.id}: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
        this.options.onSceneError?.('场景资源加载失败，请刷新页面后重试。');
        this.options.onLoadingChange(false);
      }
      return;
    }
    if (pokemonResult.status !== 'fulfilled' || habitatResult.status !== 'fulfilled' || environmentResult.status !== 'fulfilled') return;
    const result = pokemonResult.value;
    const scenery = habitatResult.value;
    const environment = environmentResult.value;
    const sourceMaterials = result.meshes.map((mesh) => mesh.material);
    const scenerySourceMaterials = scenery?.meshes.map((mesh) => mesh.material) ?? [];
    const faceBackings: Hilo3d.Mesh[] = [];
    const updateFaceBackings: (() => void)[] = [];
    const disposeResources = (disposals: (() => unknown)[]): void => {
      for (const dispose of disposals) {
        try { dispose(); }
        catch (error) { console.error('Failed to release specimen resource', error); }
      }
    };
    const destroyPreparedPokemon = (): void => {
      // Environment cubemaps are shared across specimens and released only by this controller.
      disposeResources([
        () => result.anim?.stop(),
        () => next?.toon?.dispose(),
        () => result.node.destroy(this.stage.renderer),
        ...faceBackings.map((mesh) => (
          () => { if (!mesh.isDestroyed) mesh.destroy(this.stage.renderer); }
        )),
        ...[...new Set(sourceMaterials)].map((material) => () => material?.destroyTextures()),
      ]);
    };
    let next: LoadedPokemon;
    let preparedWater: LagoonWater | null = null;
    try {
      // Prepare detached candidates first, so failures cannot alter the displayed habitat.
      if (scenery) {
        for (const mesh of scenery.meshes) {
          mesh.castShadows = true;
          mesh.receiveShadows = true;
          mesh.material = createOriginalMaterial(mesh.material, environment, mesh.name);
        }
        if (habitat.key === 'lagoon') preparedWater = new LagoonWater(scenery.meshes, this.lagoonWaterResources, this.camera, this.stage.fog ?? undefined);
      }
      const animation = result.anim;
      let animationName: string | undefined;
      let resetAnimationPose = (): void => {};
      if (animation) {
        // A clip can omit channels present in a previous action. Restore authored local
        // transforms before switching so, for example, an attack cannot leave the jaw open.
        const targets = new Set(Object.values(animation.clips).flatMap((clip) => (
          (clip?.animStatesList ?? []).map((state) => animation.nodeNameMap[state.nodeName])
        )));
        const restPose = [...targets].filter((node): node is Hilo3d.Node => Boolean(node) && node !== result.node)
          .map((node) => ({
            node, position: node.position.clone(), quaternion: node.quaternion.clone(),
            scale: new Hilo3d.Vector3(node.scaleX, node.scaleY, node.scaleZ),
          }));
        resetAnimationPose = (): void => {
          // Zero-scale bones hide authored appendages. Restoring a matrix would decompose
          // that singular transform into NaN rotations, so retain its explicit TRS values.
          for (const { node, position, quaternion, scale } of restPose) {
            node.position.copy(position);
            node.quaternion.copy(quaternion);
            node.setScale(scale.x, scale.y, scale.z);
          }
        };
        animationName = data.idleAnimation;
        playAnimationClip(animation, animationName);
      }
      result.node.updateMatrixWorld(true);
      const displayMeshes = result.meshes;
      const bounds = getPoseBounds(displayMeshes);
      const originalMaterials = displayMeshes.map((mesh) => createOriginalMaterial(mesh.material, environment, mesh.name));
      displayMeshes.forEach((mesh, index) => {
        mesh.material = originalMaterials[index]!;
        mesh.castShadows = true;
        mesh.receiveShadows = true;
      });
      let faceBackingsPrepared = false;
      const prepareFaceBackings = (): void => {
        if (faceBackingsPrepared) return;
        // Only themed materials need atlas pigment masks and an inset surface beneath them.
        for (const mesh of displayMeshes.filter((mesh) => needsFacialBacking(mesh.material, mesh.name))) {
          const backing = mesh.clone(false);
          // Track clones immediately: geometry preparation may fail before they are parented.
          faceBackings.push(backing);
          const geometry = mesh.geometry!.clone();
          const positions = geometry.vertices!;
          const normals = geometry.normals;
          const bounds = geometry.getLocalBounds();
          const inset = Math.max(bounds.width, bounds.height, bounds.depth) * 0.001;
          const vertex = new Hilo3d.Vector3();
          const normal = new Hilo3d.Vector3();
          if (normals) {
            for (let index = 0; index < positions.count; index++) {
              vertex.copy(positions.get(index) as Hilo3d.Vector3);
              normal.copy(normals.get(index) as Hilo3d.Vector3).scale(inset);
              positions.set(index, vertex.subtract(normal));
            }
          }
          const updateBacking = (): void => {
            backing.position.copy(mesh.position);
            backing.quaternion.copy(mesh.quaternion);
            backing.setScale(mesh.scaleX, mesh.scaleY, mesh.scaleZ);
          };
          // The clone remains a SkinnedMesh, so Hilo updates both surfaces on the GPU.
          updateFaceBackings.push(updateBacking);
          backing.geometry = geometry;
          backing.visible = false;
          backing.name = `${mesh.name}-surface-backing`;
          if (mesh.parent) backing.addTo(mesh.parent);
        }
        faceBackingsPrepared = true;
      };
      next = {
        id: data.id, node: result.node, meshes: displayMeshes, faceBackings, originalMaterials,
        animation, animationName, resetAnimationPose, prepareFaceBackings, bounds, updateFaceBackings,
        skinMaterials: new Map(), destroy: destroyPreparedPokemon,
      };
      this.applyMaterial(next, this.material, environment);
      // Framing always comes from idle. Read the displayed action at commit time so
      // failed/obsolete loads cannot reset it, and changes during loading are retained.
      const preferredAnimation = this.current?.animationName ?? data.idleAnimation;
      if (animation && animation.clips[preferredAnimation] && preferredAnimation !== animationName) {
        resetAnimationPose();
        playAnimationClip(animation, preferredAnimation);
        next.animationName = preferredAnimation;
        result.node.updateMatrixWorld(true);
        for (const update of updateFaceBackings) update();
      }
    } catch (error) {
      console.error(`Failed to prepare habitat for #${data.id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      destroyPreparedPokemon();
      disposeResources([
        () => preparedWater?.dispose(),
        () => scenery?.node.destroy(this.stage.renderer),
        ...[...new Set(scenerySourceMaterials)].map((material) => () => material?.destroyTextures()),
      ]);
      this.options.onSceneError?.('场景准备失败，已保留当前展示。请重新选择伙伴或刷新页面后重试。');
      this.options.onLoadingChange(false);
      return;
    }
    this.environment = environment;
    if (scenery) {
      this.habitatToon?.dispose();
      this.habitatToon = null;
      this.lagoonWater?.dispose();
      this.lagoonWater = preparedWater;
      this.habitatNode?.removeFromParent();
      this.habitatNode?.destroy(this.stage.renderer);
      this.habitatNode = scenery.node.addTo(this.world);
      this.habitatKey = habitat.key;
      this.habitatMeshes = scenery.meshes;
    }
    this.updateHabitatMaterial();
    this.stage.renderer.clearColor.copy(galleryColor(habitat.background));
    this.stage.fog?.color.copy(galleryColor(habitat.background));
    this.keyLight.color.fromHEX(habitat.keyLight);
    this.fillLight.color.fromHEX(habitat.fillLight);
    this.mountPokemon(next);
    this.options.container.dataset.pokemon = data.id;
    this.options.container.dataset.animation = next.animationName ?? '';
    this.options.container.dataset.habitat = habitat.key;
    this.options.onAnimationChange?.(next.animationName ?? data.idleAnimation, data.id);
    this.options.onLoadingChange(false);
  }

  private mountPokemon(next: LoadedPokemon): void {
    this.current?.node.removeFromParent();
    this.current?.destroy();
    this.current = next;
    this.toonRendering.enabled = this.material === 'toon';
    this.toonRendering.model = this.material === 'toon' ? next.toon ?? null : null;
    this.rig.setScale(1);
    this.rig.rotationY = 0;
    this.rig.y = 0;
    next.node.addTo(this.rig);
    const bounds = next.bounds;
    let modelScale = 1;
    if (bounds) {
      next.node.x += -bounds.x;
      next.node.y += -bounds.yMin;
      next.node.z += -bounds.z;
      modelScale = Math.min(
        2.5 / Math.max(0.01, bounds.height),
        3.75 / Math.max(0.01, bounds.width),
        3.2 / Math.max(0.01, bounds.depth),
      );
      this.rig.setScale(modelScale);
    } else this.rig.setScale(1);
    this.rig.rotationY = 8;
    this.rig.y = 0.04;
    this.updatePokemonPose(true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadSequence += 1;
    this.ticker.stop();
    this.controls.dispose();
    this.backdrop.dispose();
    this.habitatEffects.dispose();
    this.lagoonWater?.dispose();
    this.habitatToon?.dispose();
    this.current?.node.removeFromParent();
    this.current?.destroy();
    this.habitatNode?.removeFromParent();
    this.habitatNode?.destroy(this.stage.renderer);
    for (const environment of this.environments.values()) void environment.then((value) => value.dispose(), () => {});
    this.stage.destroy();
    this.stage.canvas.remove();
  }
}
