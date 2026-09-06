import * as Hilo3d from 'hilo3d';
import type { PokemonEntry } from '../content/pokemon';
import { EcologySimulation, type EcologyAgent } from '../ecology/simulation';
import { ECOLOGY_CAPACITY, POKEMON_SCALE } from '../ecology/config';
import { getEcologyProfile } from '../ecology/profiles';
import { BRIDGE, isInRiver, isOnBridge } from '../ecology/layout';
import { EcologyLandscape } from './ecologyLandscape';
import { EcologyAtmosphere } from './ecologyAtmosphere';
import { EcologyToon } from './ecologyToon';
import { pickEcologyResident } from './ecologyPicking';
import { createOriginalMaterial } from './createMaterial';
import { getPoseBounds } from './poseBounds';
import { loadEnvironment, type EnvironmentLighting } from './environment';

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
  private readonly simulation = new EcologySimulation();
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
  private readonly morningColor = linearColor(0xcedbc6);
  private readonly eveningColor = linearColor(0xa78b90);
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
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.resize();
    this.ticker.addTick({ tick: (milliseconds): void => this.tick(milliseconds) });
    this.ticker.start();
    this.publish();
  }

  static async create(options: Options): Promise<EcologyStageController> {
    const width = Math.max(1, options.container.clientWidth), height = Math.max(1, options.container.clientHeight);
    const camera = new Hilo3d.PerspectiveCamera({ fov: 39, aspect: width / height, near: 0.04, far: 180,
      x: 20, y: 24, z: 31 });
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
        model = await new Hilo3d.GLTFLoader().load({ src: `${this.options.assetBase}${pokemon.model}`, isMultiAnim: true });
        model.anim?.stop();
        await model.ready;
        if (this.destroyed || !this.reservations.has(reservation)) {
          model.node.destroy(this.stage.renderer, true); return;
        }
        sources = model.meshes.map((mesh) => mesh.material);
        const anim = model.anim;
        const targets = anim ? new Set(Object.values(anim.clips).flatMap((clip) =>
          (clip?.animStatesList ?? []).map((state) => anim.nodeNameMap[state.nodeName]))) : new Set<Hilo3d.Node>();
        const pose = [...targets].filter((node): node is Hilo3d.Node => Boolean(node) && node !== model?.node)
          .map((node) => ({ node, position: node.position.clone(), quaternion: node.quaternion.clone(),
            scale: new Hilo3d.Vector3(node.scaleX, node.scaleY, node.scaleZ) }));
        const restorePose = (): void => {
          for (const { node, position, quaternion, scale } of pose) {
            node.position.copy(position); node.quaternion.copy(quaternion); node.setScale(scale.x, scale.y, scale.z);
          }
        };
        if (anim) { anim.play(pokemon.idleAnimation); anim.stop(); anim.resume(); anim.updateAnimStates(); }
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
        this.addEvent(`${pokemon.name}来到了河谷生态园`);
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

  setTimeOfDay(value: 'dawn' | 'dusk'): void {
    if (this.destroyed || value === this.simulation.timeOfDay) return;
    this.simulation.setTimeOfDay(value);
    this.landscape.setTimeOfDay(value);
    this.atmosphere.setTimeOfDay(value);
    this.addEvent(value === 'dawn' ? '晨光洒进河谷，伙伴们开始新的一天' : '暮色降临，林间渐渐安静下来');
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
    const happy = view?.model.anim?.clips.happy;
    // Hilo tick accepts milliseconds, but clip start/end are stored in seconds.
    const duration = happy ? happy.end - happy.start : 2.7;
    if (this.destroyed || !this.simulation.pet(uid, duration)) return;
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
    this.followAnchor.set(agent.x, view.height * 0.5, agent.z);
    const distance = Math.max(1.15, view.height * 2.8, view.depth * 1.6, view.width * 1.5 / Math.max(0.7, this.camera.aspect));
    this.controls.setView(new Hilo3d.Vector3(agent.x + distance * 0.65, view.height * 0.5 + distance * 0.65,
      agent.z + distance), new Hilo3d.Vector3(agent.x, view.height * 0.5, agent.z));
    this.publish();
  }
  resetView(): void {
    this.followingId = null;
    const fit = Math.max(1, 1.45 / this.camera.aspect);
    this.controls.setView(new Hilo3d.Vector3(11 * fit, 18.7 * fit, 24.2 * fit), new Hilo3d.Vector3(0, 0, 0));
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
    this.reservations.clear();
    this.toonView.clearResidents();
    this.visibleMarkerIds.clear();
    for (const view of this.residents.values()) this.destroyResident(view);
    this.residents.clear(); this.simulation.reset();
    this.selectedId = null; this.followingId = null; this.events.length = 0; this.eventSequence = 0;
    this.accumulator = 0; this.paused = false;
    this.options.onError(''); this.publish();
  }

  private setClip(view: ResidentView, name: string, restart = false): void {
    const animation = view.model.anim;
    if (!animation || !animation.clips[name] || (view.clip === name && !restart)) return;
    view.restorePose();
    animation.loop = name === 'happy' ? 1 : Infinity;
    animation.play(name); animation.stop(); animation.resume(); animation.updateAnimStates();
    view.clip = name;
  }
  private tick(milliseconds: number): void {
    if (this.destroyed || document.hidden) return;
    const dt = Math.min(Math.max(milliseconds / 1000, 0), 0.1);
    try {
      if (!this.paused) {
        this.accumulator += dt;
        while (this.accumulator >= 1 / 30) { this.simulation.update(1 / 30); this.accumulator -= 1 / 30; }
      }
      this.updateLight(dt);
      for (const agent of this.simulation.agents) {
        const view = this.residents.get(agent.uid);
        if (view) this.updateResident(agent, view, this.paused ? 0 : dt);
      }
      this.updateFollowCamera();
      // The river reads camera matrices after tracking, including while time is paused.
      this.landscape.update(this.paused ? 0 : dt);
      this.atmosphere.update(this.paused ? 0 : dt);
      this.stage.tick(dt * 1000);
      this.updateMarkers();
      this.broadcastTime += dt;
      if (this.broadcastTime > 0.35) { this.broadcastTime = 0; this.publish(); }
    } catch (error) {
      this.ticker.stop();
      console.error('Ecology rendering failed', error);
      this.options.onError('场景渲染中断，请返回藏馆后重新进入生态园。');
    }
  }
  private updateFollowCamera(): void {
    if (!this.followingId) return;
    const agent = this.simulation.agents.find((item) => item.uid === this.followingId);
    if (!agent) { this.followingId = null; return; }
    const dx = agent.x - this.followAnchor.x, dz = agent.z - this.followAnchor.z;
    if (Math.abs(dx) + Math.abs(dz) < 1e-6) return;
    // Translate both camera and orbit target by the resident's displacement.
    // This preserves the user's current orbit, zoom and intentional pan offset.
    this.followPosition.set(this.camera.x + dx, this.camera.y, this.camera.z + dz);
    this.followTarget.set(this.controls.target.x + dx, this.controls.target.y, this.controls.target.z + dz);
    this.controls.setView(this.followPosition, this.followTarget);
    this.followAnchor.x = agent.x; this.followAnchor.z = agent.z;
  }
  private updateResident(agent: EcologyAgent, view: ResidentView, dt: number): void {
    const changed = view.state !== agent.state;
    const animation = view.model.anim;
    const clips = animation?.clips;
    let clip = agent.pokemon.idleAnimation;
    if (agent.state === 'walking') clip = clips?.[agent.gait] ? agent.gait : clips?.walk ? 'walk' : clips?.run ? 'run' : clip;
    else if (agent.state === 'happy' || agent.state === 'socializing') clip = clips?.happy ? 'happy' : clip;
    else if (agent.state === 'sleeping') clip = clips?.sleep ? 'sleep' : clip;
    this.setClip(view, clip, changed);
    if (changed && agent.state === 'socializing' && agent.partnerUid && agent.uid < agent.partnerUid) {
      const other = this.simulation.agents.find((item) => item.uid === agent.partnerUid);
      if (other) this.addEvent(`${agent.pokemon.name}与${other.pokemon.name}停下来互相打招呼`);
    }
    if (changed && agent.state === 'sleeping') this.addEvent(`${agent.pokemon.name}${agent.sleepGroupUid && agent.sleepGroupUid !== agent.uid ? '挨着伙伴一起睡着了' : '找到舒服的地方睡着了'}`);
    view.state = agent.state;
    if (animation) {
      animation.timeScale = agent.state === 'walking' ? agent.animationRate : 1;
      animation.tick(dt * 1000);
    }
    view.rig.x = agent.x; view.rig.z = agent.z;
    view.rig.rotationY = agent.heading * 180 / Math.PI;
    let y = isOnBridge(agent.x, agent.z) && agent.profile.locomotion !== 'aquatic' ? 0.085 : 0.025;
    if (isInRiver(agent.x, agent.z) && !isOnBridge(agent.x, agent.z)) y = -Math.min(0.14, view.height * 0.14);
    if (agent.profile.locomotion === 'aquatic') {
      // Surface swimmers dive below the footbridge rather than clipping through its planks.
      const nearBridge = 1 - Math.min(1, Math.max(0, Math.abs(agent.z - BRIDGE.z) - BRIDGE.halfWidth - Math.min(0.4, view.depth * 0.1)) / 0.8);
      const dive = nearBridge * nearBridge * (3 - 2 * nearBridge);
      y = -view.height * 0.3 - (view.height * 0.75 + 0.15) * dive;
    }
    if (agent.profile.locomotion === 'flying') {
      const descent = agent.state === 'sleeping' ? Math.max(0, 1 - agent.stateTime) : 1;
      y = 0.025 + descent * (0.375 + Math.sin(agent.age * 2.4) * 0.045);
    }
    if (agent.age < 1.05) {
      const t = Math.min(1, agent.age / 1.05);
      y += Math.sin(t * Math.PI) * 2.5 + (1 - t) * 1.5;
      view.rig.x -= (1 - t) * 2.2;
      view.rig.z += (1 - t) * 3.3;
      const scale = Math.min(1, 0.25 + t * 1.7); view.rig.setScale(scale * POKEMON_SCALE);
    } else view.rig.setScale(POKEMON_SCALE);
    if ((agent.state === 'happy' || agent.state === 'socializing') && !clips?.happy) {
      y += Math.abs(Math.sin(agent.stateTime * 6)) * Math.min(0.18, view.height * 0.2);
      view.rig.rotationZ = Math.sin(agent.stateTime * 4) * 6;
    } else view.rig.rotationZ = 0;
    view.rig.y = y;
  }
  private updateLight(dt: number): void {
    this.duskBlend += ((this.simulation.timeOfDay === 'dusk' ? 1 : 0) - this.duskBlend) * (1 - Math.exp(-dt * 2));
    const t = this.duskBlend;
    this.sun.color.set(1, 0.87 - t * 0.29, 0.66 - t * 0.3, 1);
    this.sun.amount = 2.3 + t * 0.15;
    this.sun.direction.set(0.65 - t * 1.5, -1.4 + t * 0.9, -0.6);
    this.fill.color.set(0.57 + t * 0.13, 0.77 - t * 0.25, 1, 1);
    this.fill.amount = 0.7 - t * 0.12;
    this.ambient.amount = 0.65 - t * 0.05;
    const morning = this.morningColor, evening = this.eveningColor;
    this.stage.renderer.clearColor.set(morning.r + (evening.r - morning.r) * t,
      morning.g + (evening.g - morning.g) * t, morning.b + (evening.b - morning.b) * t, 1);
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
      let priority = agent.state === 'happy' ? (selected ? 60 : 50) : selected ? 40
        : agent.state === 'socializing' ? 30 : agent.state === 'sleeping' ? 10 : 0;
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
    const shown = candidates.slice(0, 2);
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
      const text = agent.state === 'happy' ? '♥' : agent.state === 'socializing' ? '♫' : agent.state === 'sleeping' ? 'zZ' : agent.pokemon.name;
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
    const uid = pickEcologyResident(this.ray, [...this.residents].map(([id, view]) => ({
      uid: id, rig: view.rig, meshes: view.model.meshes, width: view.width, height: view.height, depth: view.depth,
    })));
    if (uid) this.petPokemon(uid);
  };
  private readonly onVisibilityChange = (): void => { this.accumulator = 0; };
  private addEvent(text: string): void {
    this.events.unshift({ id: ++this.eventSequence, text });
    this.events.length = Math.min(this.events.length, 12);
  }
  private publish(): void {
    if (this.destroyed) return;
    this.options.container.dataset.residents = String(this.residents.size);
    this.options.container.dataset.timeOfDay = this.simulation.timeOfDay;
    this.options.container.dataset.toon = String(this.toon);
    this.options.onChange({ count: this.residents.size, pending: this.reservations.size, paused: this.paused,
      toon: this.toon,
      timeOfDay: this.simulation.timeOfDay, selectedId: this.selectedId, followingId: this.followingId, events: [...this.events],
      agents: this.simulation.agents.map((agent) => ({ uid: agent.uid, pokemonId: agent.pokemonId,
        name: agent.pokemon.name, state: agent.state,
        label: agent.state === 'walking' && agent.gait === 'run'
          ? agent.profile.locomotion === 'aquatic' ? '加快速度游弋' : agent.profile.locomotion === 'flying' ? '轻快地加速飞行'
            : agent.intent === 'social' ? '小跑着去找伙伴' : '轻快地小跑探索'
          : agent.behaviorLabel,
        height: this.residents.get(agent.uid)?.height ?? 1 })) });
  }
  private destroyResident(view: ResidentView): void {
    view.model.anim?.stop(); view.marker.remove(); view.rig.removeFromParent(); view.rig.destroy(this.stage.renderer);
    for (const source of new Set(view.sources)) source?.destroyTextures();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.reservations.clear(); this.ticker.stop(); this.controls.dispose();
    this.toonView.dispose();
    this.stage.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.stage.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.stage.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    for (const view of this.residents.values()) this.destroyResident(view);
    this.residents.clear(); this.markerLayer.remove(); this.atmosphere.destroy(); this.landscape.destroy(); this.environment.dispose();
    this.stage.destroy(); this.stage.canvas.remove();
  }
}
