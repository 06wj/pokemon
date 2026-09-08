import * as Hilo3d from 'hilo3d';
import { pokemon, type PokemonEntry } from '../content/pokemon';
import { EcologySimulation, type EcologyAgent } from '../ecology/simulation';
import { ECOLOGY_CAPACITY, POKEMON_SCALE } from '../ecology/config';
import { getEcologyProfile } from '../ecology/profiles';
import { BRIDGE, isInRiver, isOnBridge, terrainBaseHeight, waterSurfaceHeight } from '../ecology/layout';
import { EcologyLandscape } from './ecologyLandscape';
import { EcologyAtmosphere } from './ecologyAtmosphere';
import { EcologyToon } from './ecologyToon';
import { pickEcologyResident } from './ecologyPicking';
import { createOriginalMaterial } from './createMaterial';
import { getPoseBounds } from './poseBounds';
import { findAnimationClip, playAnimationClip } from './animationPlayback';
import { loadEnvironment, type EnvironmentLighting } from './environment';
import { LivingEffects } from './livingEffects';
import { LIVING_POINTS } from '../ecology/livingContent';
import { createLivingWorld, LIVING_BUBBLES, LIVING_CAST, type DiscoveryCandidate, type LivingEffectResident,
  type LivingPhoto, type LivingTool, type LivingWorld, type LivingWeather } from '../ecology/livingTypes';
import { pickLivingGround, subjectIsVisible, type PhotoSubject } from './livingCapture';

export interface EcologySnapshot {
  count: number;
  pending: number;
  paused: boolean;
  toon: boolean;
  timeOfDay: 'dawn' | 'dusk';
  selectedId: string | null;
  followingId: string | null;
  agents: { uid: string; pokemonId: string; name: string; state: string; label: string; height: number }[];
  events: { id: number; text: string }[];
  tool: LivingTool;
  world: LivingWorld;
  discoveries: DiscoveryCandidate[];
  elapsed: number;
  livingReady: boolean;
  residentTarget: number;
}

interface Options {
  container: HTMLElement;
  assetBase: string;
  onBackend(backend: string): void;
  onChange(snapshot: EcologySnapshot): void;
  onError(message: string): void;
}

interface ResidentView {
  rig: Hilo3d.Node;
  model: Hilo3d.GLTFModel;
  sources: (Hilo3d.MaterialInstance | null)[];
  width: number;
  height: number;
  depth: number;
  clip: string;
  state: string;
  restorePose(): void;
  marker: HTMLDivElement;
  markerX: number;
  markerY: number;
}

function linearColor(hex: number): Hilo3d.Color {
  const c = (n: number): number => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  return new Hilo3d.Color(c((hex >> 16 & 255) / 255), c((hex >> 8 & 255) / 255), c((hex & 255) / 255));
}

/** The renderer owns assets and clocks; every ecological decision lives in the pure simulation. */
export class EcologyStageController {
  private readonly simulation = new EcologySimulation({ living: true });
  private readonly residents = new Map<string, ResidentView>();
  private readonly reservations = new Set<object>();
  private readonly events: EcologySnapshot['events'] = [];
  private readonly ticker = new Hilo3d.Ticker(60);
  private readonly landscape: EcologyLandscape;
  private readonly atmosphere: EcologyAtmosphere;
  private readonly controls: Hilo3d.OrbitControls;
  private readonly sun: Hilo3d.DirectionalLight;
  private readonly fill: Hilo3d.DirectionalLight;
  private readonly ambient: Hilo3d.AmbientLight;
  private readonly markerLayer: HTMLDivElement;
  private readonly ray = new Hilo3d.Ray();
  private readonly point = new Hilo3d.Vector3();
  private readonly environment: EnvironmentLighting;
  private readonly livingEffects: LivingEffects;
  private readonly observedSpecies = new Map<string, DiscoveryCandidate>();
  private tool: LivingTool = 'observe';
  private livingReady = false;
  private initializingLiving = false;
  private livingGeneration = 0;
  private livingStart: Promise<void> | null = null;
  private speciesScanIn = 0;
  private observationCursor = 0;
  private readonly effectResidents: LivingEffectResident[] = [];
  private lastSimulationEvent = 0;
  private photoSequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private selectedId: string | null = null;
  private followingId: string | null = null;
  private readonly followAnchor = new Hilo3d.Vector3();
  private readonly followPosition = new Hilo3d.Vector3();
  private readonly followTarget = new Hilo3d.Vector3();
  private paused = false;
  private toon = false;
  private readonly visibleMarkerIds = new Set<string>();
  private destroyed = false;
  private accumulator = 0;
  private broadcastTime = 0;
  private eventSequence = 0;
  private duskBlend = 0;
  private cloudBlend = 0;
  private readonly morningColor = linearColor(0xcedbc6);
  private readonly eveningColor = linearColor(0xa78b90);
  private readonly rainColor = linearColor(0x8196a0);
  private readonly snowColor = linearColor(0xb2c9cf);
  private pointer: { x: number; y: number; id: number } | null = null;

  private constructor(private readonly options: Options, private readonly stage: Hilo3d.Stage,
    private readonly camera: Hilo3d.PerspectiveCamera, environment: EnvironmentLighting, landscape: EcologyLandscape,
    private readonly toonView: EcologyToon) {
    this.environment = environment;
    this.ambient = new Hilo3d.AmbientLight({ color: new Hilo3d.Color(0.77, 0.87, 1), amount: 0.65 }).addTo(stage);
    this.sun = new Hilo3d.DirectionalLight({
      color: new Hilo3d.Color(1, 0.87, 0.66), amount: 2.3,
      x: -12, y: 20, z: 8, direction: new Hilo3d.Vector3(0.65, -1.4, -0.6),
      shadow: { width: 2048, height: 2048, minBias: 0.002, maxBias: 0.015,
        shadowStrength: 0.6, cascadeCount: 3, cascadeSplitLambda: 0.62,
        cascadeMaxDistance: 80, cascadeBlend: 0.12, stabilizeCascades: true },
    }).addTo(stage);
    this.fill = new Hilo3d.DirectionalLight({ color: new Hilo3d.Color(0.57, 0.77, 1), amount: 0.7,
      direction: new Hilo3d.Vector3(-0.5, -0.7, 1) }).addTo(stage);
    this.landscape = landscape;
    this.livingEffects = new LivingEffects(stage);
    this.atmosphere = new EcologyAtmosphere(stage, camera);
    this.toonView.setLandscape(landscape.solidMeshes);
    this.controls = new Hilo3d.OrbitControls(stage, { camera, target: new Hilo3d.Vector3(0, 0, 0),
      minDistance: 0.65, maxDistance: 66, minPolarAngle: 0.22, maxPolarAngle: Math.PI * 0.44,
      rotateSpeed: 0.55, zoomSpeed: 0.75, panSpeed: 0.7, enablePan: true });
    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'ecology-world-markers';
    this.markerLayer.setAttribute('aria-hidden', 'true');
    options.container.append(this.markerLayer);
    stage.canvas.addEventListener('pointerdown', this.onPointerDown);
    stage.canvas.addEventListener('pointerup', this.onPointerUp);
    stage.canvas.addEventListener('pointercancel', this.onPointerCancel);
    stage.canvas.addEventListener('keydown', this.onCanvasKeyDown);
    stage.canvas.tabIndex = 0;
    stage.canvas.setAttribute('aria-label', '生态箱庭。拖动观察，投果模式下点击草地；按 Enter 可在花野旁投果。');
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.resize();
    this.ticker.addTick({ tick: (milliseconds): void => this.tick(milliseconds) });
    this.ticker.start();
    this.publish();
  }

  static async create(options: Options): Promise<EcologyStageController> {
    const width = Math.max(1, options.container.clientWidth), height = Math.max(1, options.container.clientHeight);
    const camera = new Hilo3d.PerspectiveCamera({ fov: 39, aspect: width / height, near: 0.04, far: 180,
      x: 14, y: 25, z: 33 });
    const requested = new URL(location.href).searchParams.get('backend');
    const toonView = new EcologyToon();
    const stage = await Hilo3d.Stage.create({
      backend: requested === 'webgl2' || requested === 'webgpu' ? requested : 'auto',
      container: options.container, camera, width, height, antialias: true, alpha: false,
      pixelRatio: Math.min(devicePixelRatio || 1, 1.5), clearColor: linearColor(0xcedbc6), shadowUpdateMode: 'full',
      fog: new Hilo3d.Fog({ mode: 'LINEAR', start: 65, end: 115, color: linearColor(0xcedbc6) }),
      renderPipeline: new Hilo3d.PostProcessRenderPipelineFactory({
        groundTruthAmbientOcclusion: false,
        bloom: { threshold: 1.3, intensity: 0.12, maxLevels: 3 },
        colorUber: { toneMapping: 'pbr-neutral', exposure: -0.2, contrast: 0.035, saturation: 0.06, dithering: true },
        features: [toonView.rendering, toonView.antialias],
      }),
    });
    let environment: EnvironmentLighting | undefined;
    let landscape: EcologyLandscape | undefined;
    try {
      environment = await loadEnvironment(stage.renderer, options.assetBase, 'forest');
      landscape = await EcologyLandscape.create(stage, options.assetBase);
      const controller = new EcologyStageController(options, stage, camera, environment, landscape, toonView);
      options.onBackend(stage.renderer.backend);
      return controller;
    } catch (error) {
      toonView.dispose();
      landscape?.destroy();
      environment?.dispose();
      stage.destroy();
      stage.canvas.remove();
      throw error;
    }
  }

  async addPokemon(pokemon: PokemonEntry): Promise<void> {
    if (this.destroyed) return;
    if (this.residents.size + this.reservations.size >= ECOLOGY_CAPACITY) {
      this.options.onError(`生态园已住满 ${ECOLOGY_CAPACITY} 位伙伴，可以清空后重新布置。`); return;
    }
    const reservation = {};
    this.reservations.add(reservation);
    this.publish();
    const load = async (): Promise<void> => {
      if (this.destroyed || !this.reservations.has(reservation)) return;
      let model: Hilo3d.GLTFModel | undefined;
      let sources: (Hilo3d.MaterialInstance | null)[] = [];
      let candidateUid: string | null = null;
      let candidateRig: Hilo3d.Node | null = null;
      let candidateMarker: HTMLDivElement | null = null;
      const previousSelection = this.selectedId;
      try {
        model = await new Hilo3d.GLTFLoader().load({ src: `${this.options.assetBase}${pokemon.model}` });
        model.anim?.stop();
        await model.ready;
        if (this.destroyed || !this.reservations.has(reservation)) {
          model.node.destroy(this.stage.renderer, true); return;
        }
        sources = model.meshes.map((mesh) => mesh.material);
        const anim = model.anim;
        const restorePose = (): void => { anim?.stop(true); };
        if (anim) playAnimationClip(anim, pokemon.idleAnimation);
        model.node.updateMatrixWorld(true);
        const bounds = getPoseBounds(model.meshes);
        if (!bounds) throw new Error('模型缺少有效几何体');
        // One shared 0.9 multiplier preserves authored species ratios. Measurement,
        // navigation, camera framing and picking all use the same displayed size.
        const width = bounds.width * POKEMON_SCALE, height = bounds.height * POKEMON_SCALE, depth = bounds.depth * POKEMON_SCALE;
        const profile = getEcologyProfile(pokemon, height);
        const footprint = profile.locomotion === 'flying' ? Math.min(width, depth) * 0.3
          : profile.locomotion === 'aquatic' ? width * 0.42 : Math.max(width, depth) * 0.42;
        const agent = this.simulation.add(pokemon, footprint, height);
        if (!agent) throw new Error('适合这位伙伴的区域暂时拥挤，请清空一些空间后重试。');
        candidateUid = agent.uid;
        for (const mesh of model.meshes) {
          mesh.material = createOriginalMaterial(mesh.material, this.environment, mesh.name);
          mesh.castShadows = true; mesh.receiveShadows = true;
        }
        model.node.x -= bounds.x; model.node.y -= bounds.yMin; model.node.z -= bounds.z;
        const rig = new Hilo3d.Node({ name: `resident-${agent.uid}` }).addTo(this.stage);
        candidateRig = rig;
        model.node.addTo(rig);
        const marker = document.createElement('div');
        candidateMarker = marker;
        marker.className = 'ecology-world-marker';
        marker.hidden = true;
        this.markerLayer.append(marker);
        const view: ResidentView = { rig, model, sources, width, height, depth, restorePose,
          marker, markerX: 0, markerY: 0, state: '', clip: pokemon.idleAnimation };
        this.residents.set(agent.uid, view);
        this.toonView.addResident(agent.uid, model.meshes);
        this.selectedId = this.followingId ?? agent.uid;
        this.options.onError('');
        this.updateResident(agent, view, 0);
        if (!this.initializingLiving) this.addEvent(`${pokemon.name}来到了河谷生态园`);
      } catch (error) {
        if (candidateUid) { this.toonView.removeResident(candidateUid); this.simulation.remove(candidateUid); this.residents.delete(candidateUid); }
        if (candidateUid && this.selectedId === candidateUid) {
          this.selectedId = this.followingId ?? (previousSelection && this.residents.has(previousSelection) ? previousSelection : null);
        }
        candidateMarker?.remove();
        candidateRig?.removeFromParent();
        candidateRig?.destroy(this.stage.renderer);
        if (model) {
          model.anim?.stop(); model.node.removeFromParent(); model.node.destroy(this.stage.renderer);
          for (const material of new Set(sources)) material?.destroyTextures();
        }
        if (!this.destroyed && this.reservations.has(reservation)) {
          console.error('Ecology model loading failed', error);
          this.options.onError(`${pokemon.name}投放失败：${error instanceof Error ? error.message : '资源加载失败'}。请再次点击重试。`);
        }
      } finally {
        this.reservations.delete(reservation);
        if (!this.destroyed) this.publish();
      }
    };
    this.queue = this.queue.then(load, load);
    await this.queue;
  }

  startLiving(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.livingStart) return this.livingStart;
    if (this.livingReady && this.residents.size >= LIVING_CAST.length) return Promise.resolve();
    const generation = this.livingGeneration;
    this.initializingLiving = true;
    this.livingReady = false;
    const work = async (): Promise<void> => {
      await Promise.resolve();
      try {
        for (const id of LIVING_CAST) {
          if (this.destroyed || generation !== this.livingGeneration) return;
          if (this.simulation.agents.some((agent) => agent.pokemonId === id)) continue;
          const entry = pokemon.find((item) => item.id === id);
          if (entry) await this.addPokemon(entry);
        }
        if (this.destroyed || generation !== this.livingGeneration) return;
        this.selectedId = null;
        this.followingId = null;
        this.resetView();
        const missing = LIVING_CAST.filter((id) => !this.simulation.agents.some((agent) => agent.pokemonId === id));
        this.livingReady = this.residents.size > 0;
        if (missing.length) this.options.onError(`${missing.length} 位伙伴暂时没有抵达，可以重新开始再试一次。`);
        else this.options.onError('');
      } finally {
        if (generation === this.livingGeneration) {
          this.initializingLiving = false;
          this.livingStart = null;
          this.publish();
        }
      }
    };
    this.livingStart = work();
    this.publish();
    return this.livingStart;
  }

  async restartLiving(): Promise<void> {
    this.reset();
    await this.startLiving();
  }

  setTool(tool: LivingTool): void {
    if (this.destroyed) return;
    this.tool = tool;
    if (tool === 'fruit') this.followingId = null;
    this.options.container.dataset.tool = tool;
    this.publish();
  }

  intervene(tool: LivingTool, point?: { x: number; z: number }): boolean {
    if (this.destroyed || this.paused || this.initializingLiving || !this.livingReady) return false;
    const ok = this.simulation.intervene(tool, point);
    if (!ok) {
      const reason = tool === 'fruit' ? '换一块空些的草地吧；地上的水果也需要伙伴慢慢发现。'
        : tool === 'shake-tree' ? '树上暂时没有成熟果实，等它慢慢长好。'
        : tool === 'prepare-fire' ? '火堆已经备好了，等小火龙自己发现。' : '花丛刚刚动过，先观察一会儿。';
      this.options.onError(reason);
    } else this.options.onError('');
    this.publish();
    return ok;
  }

  async capturePhoto(): Promise<LivingPhoto> {
    if (this.destroyed || !this.livingReady || this.initializingLiving) throw new Error('等伙伴抵达后，再留下一张照片吧。');
    const surface = document.createElement('canvas');
    const source = this.stage.canvas;
    const ratio = Math.min(1, 1280 / source.width);
    surface.width = Math.max(1, Math.round(source.width * ratio));
    surface.height = Math.max(1, Math.round(source.height * ratio));
    const context = surface.getContext('2d');
    if (!context) throw new Error('这台设备暂时无法保存照片。');
    // Present and copy in one callback; drawing-buffer preservation is not
    // required and the simulation never advances for a photo.
    await new Promise<void>((resolve, reject) => requestAnimationFrame(() => {
      if (this.destroyed) { reject(new Error('场景已经关闭。')); return; }
      try {
        this.stage.tick(0);
        context.drawImage(source, 0, 0, surface.width, surface.height);
        resolve();
      } catch { reject(new Error('照片没有保存成功，请再试一次。')); }
    }));
    const candidates = this.photoSubjects(true);
    const subjects = candidates.filter((subject) => subjectIsVisible(subject, this.camera,
      this.landscape.solidMeshes, this.stage.height, candidates));
    const visibleIds = new Set(subjects.map((subject) => subject.uid));
    const active = this.simulation.agents.filter((agent) => visibleIds.has(agent.uid));
    const recent = this.discoverySnapshot().filter((record) => record.participantUids.length > 0
      && record.participantUids.every((id) => visibleIds.has(id))
      && (record.category === 'species' || this.simulation.elapsed - record.at < 25));
    const moment = [...recent].reverse().find((record) => record.category === 'moment');
    const labels = [...new Set(active.map((agent) => agent.performance?.label || agent.behaviorLabel))].slice(0, 4);
    const sleeper = active.find((agent) => agent.state === 'sleeping');
    const title = moment?.title ?? (sleeper ? '安静的午睡时光' : active.find((agent) => agent.performance)?.performance?.label)
      ?? (subjects.length > 1 ? '一起生活的小世界' : subjects[0] ? `${subjects[0].name}的一刻` : '海风经过小岛');
    return { id: `photo-${Date.now().toString(36)}-${++this.photoSequence}`, capturedAt: new Date().toISOString(), title,
      timeOfDay: this.simulation.timeOfDay, image: surface.toDataURL('image/jpeg', .86),
      weather: this.simulation.world.weather.kind, snow: this.simulation.world.weather.snow,
      speciesIds: [...new Set(subjects.map((subject) => subject.pokemonId))], discoveryIds: recent.map((record) => record.id), labels };
  }

  setTimeOfDay(value: 'dawn' | 'dusk'): void {
    if (this.destroyed || value === this.simulation.timeOfDay) return;
    this.simulation.setTimeOfDay(value);
    this.landscape.setTimeOfDay(value);
    this.atmosphere.setTimeOfDay(value);
    this.addEvent(value === 'dawn' ? '晨光洒进河谷，伙伴们开始新的一天' : '暮色降临，林间渐渐安静下来');
    this.publish();
  }
  setWeather(weather: LivingWeather): void {
    if (this.destroyed || weather === this.simulation.world.weather.kind) return;
    this.simulation.setWeather(weather);
    this.atmosphere.setWeather(weather);
    this.addEvent(weather === 'rain' ? '雨丝落进小岛，伙伴们各自寻找舒服的地方' : weather === 'snow'
      ? '小小的雪花飘了下来，草地会渐渐披上白色' : '天空放晴，湿润的草地和积雪会慢慢恢复');
    this.publish();
  }
  setPaused(value: boolean): void { this.paused = value; this.accumulator = 0; this.publish(); }
  setToon(value: boolean): void {
    if (this.destroyed || value === this.toon) return;
    this.toonView.setEnabled(value);
    this.toon = value;
    this.publish();
  }
  petPokemon(uid: string): void {
    const view = this.residents.get(uid);
    const happy = findAnimationClip(view?.model.anim, 'happy');
    // Hilo tick accepts milliseconds, but clip start/end are stored in seconds.
    const duration = happy ? happy.end - happy.start : 2.7;
    if (this.destroyed || this.paused || this.initializingLiving || !this.simulation.pet(uid, duration)) return;
    this.focusPokemon(uid);
    const resident = this.residents.get(uid);
    if (resident) { resident.state = ''; resident.clip = ''; }
    const agent = this.simulation.agents.find((item) => item.uid === uid);
    if (agent) this.addEvent(`${agent.pokemon.name}感受到了你的善意，开心地回应你`);
    this.publish();
  }
  focusPokemon(uid: string): void {
    const agent = this.simulation.agents.find((item) => item.uid === uid);
    const view = this.residents.get(uid);
    if (!agent || !view) return;
    this.selectedId = uid;
    this.followingId = uid;
    const surface = this.residentSurfaceHeight(agent);
    this.followAnchor.set(agent.x, surface, agent.z);
    const distance = Math.max(1.15, view.height * 2.8, view.depth * 1.6, view.width * 1.5 / Math.max(0.7, this.camera.aspect));
    this.controls.setView(new Hilo3d.Vector3(agent.x + distance * 0.65, surface + view.height * 0.5 + distance * 0.65,
      agent.z + distance), new Hilo3d.Vector3(agent.x, surface + view.height * 0.5, agent.z));
    this.publish();
  }
  resetView(): void {
    this.followingId = null;
    const fit = Math.max(1, 1.45 / this.camera.aspect);
    this.controls.setView(new Hilo3d.Vector3(14 * fit, 25 * fit, 33 * fit), new Hilo3d.Vector3(0, 0, 0));
    this.publish();
  }
  resize(): void {
    if (this.destroyed) return;
    const width = Math.max(1, this.options.container.clientWidth), height = Math.max(1, this.options.container.clientHeight);
    this.stage.resize(width, height, Math.min(devicePixelRatio || 1, 1.5));
    this.toonView.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.camera.aspect = width / height;
    if (!this.followingId) this.resetView();
  }
  reset(): void {
    this.livingGeneration = (this.livingGeneration ?? 0) + 1;
    this.livingStart = null;
    this.initializingLiving = false;
    this.livingReady = false;
    this.tool = 'observe';
    this.observedSpecies?.clear();
    this.lastSimulationEvent = 0;
    this.speciesScanIn = 0;
    this.observationCursor = 0;
    if (this.effectResidents) this.effectResidents.length = 0;
    this.reservations.clear();
    this.toonView.clearResidents();
    this.visibleMarkerIds.clear();
    for (const view of this.residents.values()) this.destroyResident(view);
    this.residents.clear(); this.simulation.reset();
    this.livingEffects?.update(0, this.simulation.world ?? createLivingWorld(), [], 0);
    this.selectedId = null; this.followingId = null; this.events.length = 0; this.eventSequence = 0;
    this.accumulator = 0; this.paused = false;
    this.options.onError(''); this.publish();
  }

  private setClip(view: ResidentView, name: string, restart = false): void {
    const animation = view.model.anim;
    if (!animation || !findAnimationClip(animation, name) || (view.clip === name && !restart)) return;
    view.restorePose();
    playAnimationClip(animation, name, name !== 'happy' && name !== 'attack');
    view.clip = name;
  }
  private tick(milliseconds: number): void {
    if (this.destroyed || document.hidden) return;
    const dt = Math.min(Math.max(milliseconds / 1000, 0), 0.1);
    try {
      if (!this.paused && !this.initializingLiving) {
        this.accumulator += dt;
        while (this.accumulator >= 1 / 30) { this.simulation.update(1 / 30); this.accumulator -= 1 / 30; }
      }
      this.updateLight(dt);
      for (const agent of this.simulation.agents) {
        const view = this.residents.get(agent.uid);
        if (view) this.updateResident(agent, view, this.paused ? 0 : dt);
      }
      const effects = this.effectResidents;
      let effectIndex = 0;
      for (const agent of this.simulation.agents) {
        const view = this.residents.get(agent.uid);
        if (!view) continue;
        const resident = effects[effectIndex] ?? { uid: agent.uid, pokemonId: agent.pokemonId,
          x: 0, y: 0, z: 0, height: view.height, radius: agent.radius, heading: 0, performance: null };
        resident.uid = agent.uid; resident.pokemonId = agent.pokemonId;
        resident.x = view.rig.x; resident.y = view.rig.y; resident.z = view.rig.z;
        resident.height = view.height; resident.radius = agent.radius;
        resident.heading = agent.heading; resident.performance = agent.performance;
        effects[effectIndex++] = resident;
      }
      effects.length = effectIndex;
      this.landscape.applyLivingWorld(this.simulation.world, this.simulation.elapsed);
      this.livingEffects.update(this.paused ? 0 : dt, this.simulation.world, effects, this.simulation.elapsed);
      this.updateFollowCamera();
      // The river reads camera matrices after tracking, including while time is paused.
      this.landscape.update(this.paused ? 0 : dt);
      this.atmosphere.update(this.paused ? 0 : dt);
      this.stage.tick(dt * 1000);
      this.updateMarkers();
      this.speciesScanIn -= dt;
      if (this.livingReady && this.speciesScanIn <= 0) {
        this.speciesScanIn = 1.4;
        this.observeVisibleSpecies();
      }
      this.broadcastTime += dt;
      if (this.broadcastTime > 0.35) { this.broadcastTime = 0; this.publish(); }
    } catch (error) {
      this.ticker.stop();
      console.error('Ecology rendering failed', error);
      this.options.onError('场景渲染中断，请返回藏馆后重新进入生态园。');
    }
  }
  private residentSurfaceHeight(agent: EcologyAgent): number {
    if (agent.profile.locomotion === 'aquatic') return waterSurfaceHeight(agent.z);
    if (agent.profile.locomotion === 'flying') return terrainBaseHeight(agent.x, agent.z);
    if (isOnBridge(agent.x, agent.z)) return BRIDGE.surfaceY;
    return isInRiver(agent.x, agent.z) ? waterSurfaceHeight(agent.z) : terrainBaseHeight(agent.x, agent.z);
  }
  private updateFollowCamera(): void {
    if (!this.followingId) return;
    const agent = this.simulation.agents.find((item) => item.uid === this.followingId);
    if (!agent) { this.followingId = null; return; }
    const surface = this.residentSurfaceHeight(agent);
    const dx = agent.x - this.followAnchor.x, dy = surface - this.followAnchor.y, dz = agent.z - this.followAnchor.z;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-6) return;
    // Translate both camera and orbit target by the resident's displacement.
    // This preserves the user's current orbit, zoom and intentional pan offset.
    this.followPosition.set(this.camera.x + dx, this.camera.y + dy, this.camera.z + dz);
    this.followTarget.set(this.controls.target.x + dx, this.controls.target.y + dy, this.controls.target.z + dz);
    this.controls.setView(this.followPosition, this.followTarget);
    this.followAnchor.set(agent.x, surface, agent.z);
  }
  private updateResident(agent: EcologyAgent, view: ResidentView, dt: number): void {
    const performance = agent.performance;
    const stateKey = performance ? `${agent.state}/${performance.sequenceId}/${performance.stepId}` : agent.state;
    const changed = view.state !== stateKey;
    const animation = view.model.anim;
    const hasClip = (name: string): boolean => Boolean(findAnimationClip(animation, name));
    let clip = agent.pokemon.idleAnimation;
    if (agent.state === 'walking') clip = hasClip(agent.gait) ? agent.gait : hasClip('walk') ? 'walk' : hasClip('run') ? 'run' : clip;
    else if (performance) clip = hasClip(performance.animation) ? performance.animation
      : performance.animation === 'attack' && hasClip('happy') ? 'happy' : clip;
    else if (agent.state === 'happy' || agent.state === 'socializing') clip = hasClip('happy') ? 'happy' : clip;
    else if (agent.state === 'sleeping') clip = hasClip('sleep') ? 'sleep' : clip;
    this.setClip(view, clip, changed);
    if (changed && agent.state === 'socializing' && agent.partnerUid && agent.uid < agent.partnerUid) {
      const other = this.simulation.agents.find((item) => item.uid === agent.partnerUid);
      if (other) this.addEvent(`${agent.pokemon.name}与${other.pokemon.name}停下来互相打招呼`);
    }
    if (changed && agent.state === 'sleeping') this.addEvent(`${agent.pokemon.name}${agent.sleepGroupUid && agent.sleepGroupUid !== agent.uid ? '挨着伙伴一起睡着了' : '找到舒服的地方睡着了'}`);
    view.state = stateKey;
    if (animation) {
      animation.timeScale = agent.state === 'walking' ? agent.animationRate : 1;
      if (performance && agent.state !== 'walking' && (clip === 'attack' || clip === 'happy') && performance.duration > 0) {
        const duration = findAnimationClip(animation, clip)?.duration;
        if (duration) animation.timeScale = Math.max(.3, Math.min(3, duration / performance.duration));
      }
      animation.update(dt);
    }
    view.rig.x = agent.x; view.rig.z = agent.z;
    view.rig.rotationY = agent.heading * 180 / Math.PI;
    const ground = terrainBaseHeight(agent.x, agent.z);
    const water = waterSurfaceHeight(agent.z);
    let y = isOnBridge(agent.x, agent.z) && agent.profile.locomotion !== 'aquatic' ? BRIDGE.surfaceY + 0.005 : ground + 0.025;
    if (isInRiver(agent.x, agent.z) && !isOnBridge(agent.x, agent.z)) y = water - Math.min(0.14, view.height * 0.14);
    if (agent.profile.locomotion === 'aquatic') {
      // Surface swimmers dive below the footbridge rather than clipping through its planks.
      const nearBridge = 1 - Math.min(1, Math.max(0, Math.abs(agent.z - BRIDGE.z) - BRIDGE.halfWidth - Math.min(0.4, view.depth * 0.1)) / 0.8);
      const dive = nearBridge * nearBridge * (3 - 2 * nearBridge);
      y = water - view.height * 0.3 - (view.height * 0.75 + 0.15) * dive;
    }
    if (agent.profile.locomotion === 'flying') {
      const descent = agent.state === 'sleeping' ? Math.max(0, 1 - agent.stateTime) : 1;
      y = ground + 0.025 + descent * (0.375 + Math.sin(agent.age * 2.4) * 0.045);
    }
    if (agent.age < 1.05) {
      const t = Math.min(1, agent.age / 1.05);
      y += Math.sin(t * Math.PI) * 2.5 + (1 - t) * 1.5;
      view.rig.x -= (1 - t) * 2.2;
      view.rig.z += (1 - t) * 3.3;
      const scale = Math.min(1, 0.25 + t * 1.7); view.rig.setScale(scale * POKEMON_SCALE);
    } else view.rig.setScale(POKEMON_SCALE);
    if ((agent.state === 'happy' || agent.state === 'socializing') && !hasClip('happy')) {
      y += Math.abs(Math.sin(agent.stateTime * 6)) * Math.min(0.18, view.height * 0.2);
      view.rig.rotationZ = Math.sin(agent.stateTime * 4) * 6;
    } else view.rig.rotationZ = 0;
    view.rig.rotationX = performance?.effect === 'drink' ? Math.sin(performance.progress * Math.PI) * 7 : 0;
    view.rig.y = y;
  }
  private updateLight(dt: number): void {
    this.duskBlend += ((this.simulation.timeOfDay === 'dusk' ? 1 : 0) - this.duskBlend) * (1 - Math.exp(-dt * 2));
    const t = this.duskBlend;
    const weather = this.simulation.world.weather.kind;
    this.cloudBlend += ((weather === 'sunny' ? 0 : 1) - this.cloudBlend) * (1 - Math.exp(-dt * 1.5));
    const cloud = this.cloudBlend;
    this.sun.color.set(1, 0.87 - t * 0.29, 0.66 - t * 0.3, 1);
    this.sun.amount = (2.3 + t * 0.15) * (1 - cloud * .68);
    this.sun.direction.set(0.65 - t * 1.5, -1.4 + t * 0.9, -0.6);
    this.fill.color.set(0.57 + t * 0.13, 0.77 - t * 0.25, 1, 1);
    this.fill.amount = (0.7 - t * 0.12) * (1 - cloud * .12);
    this.ambient.amount = 0.65 - t * 0.05 + cloud * .05;
    const morning = this.morningColor, evening = this.eveningColor;
    this.stage.renderer.clearColor.set(morning.r + (evening.r - morning.r) * t,
      morning.g + (evening.g - morning.g) * t, morning.b + (evening.b - morning.b) * t, 1);
    const atmosphere = weather === 'snow' ? this.snowColor : this.rainColor;
    const clear = this.stage.renderer.clearColor;
    clear.set(clear.r + (atmosphere.r - clear.r) * cloud, clear.g + (atmosphere.g - clear.g) * cloud,
      clear.b + (atmosphere.b - clear.b) * cloud, 1);
    this.stage.fog?.color.copy(this.stage.renderer.clearColor);
  }
  private updateMarkers(): void {
    // Stable priorities prevent a crowd of simultaneous interactions from filling
    // the scene with bubbles. Existing eligible markers win ties until they finish.
    const candidates: { agent: EcologyAgent; view: ResidentView; priority: number }[] = [];
    for (const agent of this.simulation.agents) {
      const view = this.residents.get(agent.uid);
      if (!view) continue;
      view.marker.hidden = true;
      const selected = this.selectedId === agent.uid;
      const bubble = agent.performance?.bubble;
      const showPerformance = bubble && agent.performance!.progress * agent.performance!.duration < 3;
      let priority = showPerformance ? (bubble === 'surprised' ? 90 : 70) : agent.state === 'happy' ? (selected ? 60 : 50) : selected ? 40
        : agent.state === 'socializing' && agent.stateTime < 3 ? 30 : agent.state === 'sleeping' && agent.stateTime < 3 ? 10 : 0;
      if (!priority) continue;
      this.point.set(view.rig.x, view.rig.y + view.height * (agent.state === 'sleeping' ? 0.55 : 1) + 0.14, view.rig.z);
      if (!this.camera.isPointVisible(this.point)) continue;
      if (this.visibleMarkerIds.has(agent.uid)) priority += 1;
      this.point.transformMat4(this.camera.viewProjectionMatrix);
      view.markerX = (this.point.x + 1) * this.stage.width / 2;
      view.markerY = (1 - this.point.y) * this.stage.height / 2;
      candidates.push({ agent, view, priority });
    }
    candidates.sort((a, b) => b.priority - a.priority);
    this.visibleMarkerIds.clear();
    const shown = candidates.slice(0, candidates.some(({ agent }) => agent.performance?.bubble === 'surprised') ? 3 : 2);
    if (shown.length === 2) {
      const a = shown[0]!.view, b = shown[1]!.view;
      if (Math.abs(a.markerX - b.markerX) < 24 && Math.abs(a.markerY - b.markerY) < 24) {
        const midpoint = (a.markerX + b.markerX) / 2;
        const sign = a.markerX <= b.markerX ? -1 : 1;
        a.markerX = midpoint + sign * 13; b.markerX = midpoint - sign * 13;
      }
    }
    for (const { agent, view } of shown) {
      this.visibleMarkerIds.add(agent.uid);
      view.marker.hidden = false;
      view.marker.style.transform = `translate(${view.markerX}px, ${view.markerY}px) translate(-50%, -100%)`;
      view.marker.dataset.state = agent.state;
      const bubble = agent.performance?.bubble;
      view.marker.dataset.bubble = bubble ?? '';
      const text = bubble ? LIVING_BUBBLES[bubble] : agent.state === 'happy' ? '♥' : agent.state === 'socializing' ? '♫' : agent.state === 'sleeping' ? 'zZ' : agent.pokemon.name;
      if (view.marker.textContent !== text) view.marker.textContent = text;
    }
  }
  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointer = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
  };
  private readonly onPointerCancel = (): void => { this.pointer = null; };
  private readonly onPointerUp = (event: PointerEvent): void => {
    const start = this.pointer; this.pointer = null;
    if (!start || event.pointerId !== start.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const rect = this.stage.canvas.getBoundingClientRect();
    this.stage.updateMatrixWorld(true);
    this.ray.fromCamera(this.camera, (event.clientX - rect.left) / rect.width * this.stage.width,
      (event.clientY - rect.top) / rect.height * this.stage.height, this.stage.width, this.stage.height);
    if (this.tool === 'fruit') {
      const ground = pickLivingGround(this.ray);
      if (ground) this.intervene('fruit', ground);
      else this.options.onError('把水果轻轻放在岛上的草地或浅水里吧。');
      return;
    }
    const uid = pickEcologyResident(this.ray, [...this.residents].map(([id, view]) => ({
      uid: id, rig: view.rig, meshes: view.model.meshes, width: view.width, height: view.height, depth: view.depth,
    })));
    if (uid) this.petPokemon(uid);
  };
  private readonly onCanvasKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && this.tool === 'fruit') {
      event.preventDefault();
      event.stopPropagation();
      this.intervene('fruit', { x: LIVING_POINTS.flowers.x + 1.2, z: LIVING_POINTS.flowers.z + .6 });
    }
  };
  private readonly onVisibilityChange = (): void => { this.accumulator = 0; };
  private addEvent(text: string): void {
    this.events.unshift({ id: ++this.eventSequence, text });
    this.events.length = Math.min(this.events.length, 12);
  }
  private photoSubjects(measure = false): PhotoSubject[] {
    return this.simulation.agents.flatMap((agent) => {
      const view = this.residents.get(agent.uid);
      return view ? [{ uid: agent.uid, pokemonId: agent.pokemonId, name: agent.pokemon.name,
        rig: view.rig, height: view.height, width: view.width,
        bounds: measure ? getPoseBounds(view.model.meshes) : undefined }] : [];
    });
  }
  private observeVisibleSpecies(): void {
    if (this.simulation.agents.every((agent) => this.observedSpecies.has(`species:${agent.pokemonId}`))) return;
    const candidates = this.photoSubjects(true);
    const subjects = candidates.filter((subject) => !this.observedSpecies.has(`species:${subject.pokemonId}`));
    // Spread first observations across frames instead of casting twenty rays at once.
    if (!subjects.length) return;
    for (let i = 0; i < Math.min(3, subjects.length); i++) {
      const subject = subjects[(this.observationCursor + i) % subjects.length]!;
      if (!subjectIsVisible(subject, this.camera, this.landscape.solidMeshes, this.stage.height, candidates)) continue;
      this.observedSpecies.set(`species:${subject.pokemonId}`, { id: `species:${subject.pokemonId}`, category: 'species',
        title: subject.name, description: `在这座小岛上，第一次看见${subject.name}。`, speciesIds: [subject.pokemonId],
        participantUids: [subject.uid], at: this.simulation.elapsed });
    }
    this.observationCursor = (this.observationCursor + 3) % subjects.length;
  }
  private discoverySnapshot(): DiscoveryCandidate[] {
    return [...(this.observedSpecies?.values() ?? []), ...(this.simulation.discoveries ?? [])];
  }
  private publish(): void {
    if (this.destroyed) return;
    for (const event of this.simulation.events) {
      if (event.id <= (this.lastSimulationEvent ?? 0)) continue;
      this.lastSimulationEvent = event.id;
      if (event.kind !== 'arrival' && event.kind !== 'pet') this.addEvent(event.text);
    }
    this.options.container.dataset.residents = String(this.residents.size);
    this.options.container.dataset.timeOfDay = this.simulation.timeOfDay;
    this.options.container.dataset.toon = String(this.toon);
    this.options.container.dataset.tool = this.tool ?? 'observe';
    const world = this.simulation.world ?? createLivingWorld();
    this.options.container.dataset.weather = world.weather.kind;
    this.options.container.dataset.snow = world.weather.snow.toFixed(3);
    this.options.onChange({ count: this.residents.size, pending: this.reservations.size, paused: this.paused,
      toon: this.toon,
      tool: this.tool ?? 'observe', elapsed: this.simulation.elapsed,
      livingReady: this.livingReady ?? false, residentTarget: LIVING_CAST.length,
      world: { weather: { ...world.weather }, fruits: world.fruits.map((fruit) => ({ ...fruit })), tree: { ...world.tree },
        campfire: { ...world.campfire }, flowers: { ...world.flowers } }, discoveries: this.discoverySnapshot(),
      timeOfDay: this.simulation.timeOfDay, selectedId: this.selectedId, followingId: this.followingId, events: [...this.events],
      agents: this.simulation.agents.map((agent) => ({ uid: agent.uid, pokemonId: agent.pokemonId,
        name: agent.pokemon.name, state: agent.state,
        label: agent.performance?.label || (agent.state === 'walking' && agent.gait === 'run'
          ? agent.profile.locomotion === 'aquatic' ? '加快速度游弋' : agent.profile.locomotion === 'flying' ? '轻快地加速飞行'
            : agent.intent === 'social' ? '小跑着去找伙伴' : '轻快地小跑探索'
          : agent.behaviorLabel),
        height: this.residents.get(agent.uid)?.height ?? 1 })) });
  }
  private destroyResident(view: ResidentView): void {
    view.model.anim?.stop(); view.marker.remove(); view.rig.removeFromParent(); view.rig.destroy(this.stage.renderer);
    for (const source of new Set(view.sources)) source?.destroyTextures();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.reservations.clear(); this.ticker.stop(); this.controls.dispose();
    this.livingGeneration = (this.livingGeneration ?? 0) + 1;
    this.livingStart = null;
    this.livingEffects?.destroy();
    this.toonView.dispose();
    this.stage.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.stage.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.stage.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.stage.canvas.removeEventListener('keydown', this.onCanvasKeyDown);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    for (const view of this.residents.values()) this.destroyResident(view);
    this.residents.clear(); this.markerLayer.remove(); this.atmosphere.destroy(); this.landscape.destroy(); this.environment.dispose();
    this.stage.destroy(); this.stage.canvas.remove();
  }
}
