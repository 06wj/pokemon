import { LIVING_POINTS } from '../ecology/livingContent.ts';
import { isInRiver, isOnBridge, riverCenterX, riverHalfWidth, terrainBaseHeight } from '../ecology/layout.ts';
import type { LivingEffectResident, LivingWorld } from '../ecology/livingTypes.ts';

/** Presentation-only inputs. No audio callback completes an ecological action. */
export type LivingAudioResident = Omit<LivingEffectResident, 'performance'> & {
  state?: string;
  speed?: number;
  gait?: 'walk' | 'run';
  performance: (NonNullable<LivingEffectResident['performance']> & { effectProgress?: number }) | null;
};
export interface LivingAudioCamera { x: number; y: number; z: number; targetX?: number; targetZ?: number }
interface SoundPosition { x: number; y: number; z: number }
export type LivingSoundKind = 'step-grass' | 'step-sand' | 'step-water' | 'fruit-land' | 'bite' | 'leaves'
  | 'fire-breath' | 'electric' | 'drink' | 'water-jet' | 'splash' | 'happy' | 'sleepy' | 'sneeze';
export interface LivingSoundCue extends SoundPosition {
  kind: LivingSoundKind; key: string; gain: number; pan: number; delay: number; priority: number;
}
export const LIVING_AUDIO_LIMITS = { sources: 12, cuesPerFrame: 4, footstepsPerSecond: 6, maxDistance: 78 } as const;
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const airborne = new Set(['012', '016', '092', '060', '118', '129']);
const baseGain: Record<LivingSoundKind, number> = {
  'step-grass': .18, 'step-sand': .14, 'step-water': .15, 'fruit-land': .27, bite: .23, leaves: .18,
  'fire-breath': .25, electric: .2, drink: .21, 'water-jet': .23, splash: .24, happy: .12, sleepy: .11, sneeze: .17,
};

export function spatializeLivingSound(source: SoundPosition, camera: LivingAudioCamera): { gain: number; pan: number } {
  const dx = source.x - camera.x, dy = source.y - camera.y, dz = source.z - camera.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(distance) || distance >= LIVING_AUDIO_LIMITS.maxDistance) return { gain: 0, pan: 0 };
  const forwardX = (camera.targetX ?? 0) - camera.x, forwardZ = (camera.targetZ ?? 0) - camera.z;
  const directionLength = Math.hypot(forwardX, forwardZ);
  // Camera right in the game's Y-up coordinates; a directly overhead view centers audio.
  const rightX = directionLength > .001 ? -forwardZ / directionLength : 0;
  const rightZ = directionLength > .001 ? forwardX / directionLength : 0;
  const pan = clamp((dx * rightX + dz * rightZ) / Math.max(7, Math.hypot(dx, dz)), -.85, .85);
  const edge = 1 - (distance / LIVING_AUDIO_LIMITS.maxDistance) ** 2;
  return { gain: edge * edge / (1 + distance / 24), pan };
}

export function livingFootstepSurface(x: number, z: number): 'step-grass' | 'step-sand' | 'step-water' {
  if (!isOnBridge(x, z) && (isInRiver(x, z) || Math.abs(x - riverCenterX(z)) < riverHalfWidth + .45)) return 'step-water';
  return terrainBaseHeight(x, z) < -.03 ? 'step-sand' : 'step-grass';
}

interface MotionMemory { x: number; z: number; travel: number; lastStep: number }
/** Pure, bounded event scheduler, exported so lifecycle and dedup can be tested without Web Audio or DOM. */
export class LivingAudioScheduler {
  private lastElapsed: number | null = null;
  private rebase = true;
  private wasAudible = false;
  private effects = new Map<string, string>();
  private poses = new Map<string, string>();
  private moodAt = new Map<string, number>();
  private motion = new Map<string, MotionMemory>();
  private landed = new Set<string>();
  private shakeAt = -Infinity;
  private rustleAt = -Infinity;
  private footsteps: number[] = [];
  private lastMood = -Infinity;

  resync(): void { this.rebase = true; }
  reset(): void {
    this.lastElapsed = null; this.rebase = true; this.wasAudible = false;
    this.effects.clear(); this.poses.clear(); this.moodAt.clear(); this.motion.clear(); this.landed.clear();
    this.footsteps = []; this.lastMood = this.shakeAt = this.rustleAt = -Infinity;
  }
  private effectKey(resident: LivingAudioResident): string {
    const p = resident.performance;
    return p?.effect ? `${resident.uid}|${p.sequenceId}|${p.stepId}|${p.effect}` : '';
  }
  private mood(resident: LivingAudioResident): 'happy' | 'sleepy' | null {
    const p = resident.performance;
    if (p?.animation === 'sleep' || resident.state === 'sleeping') return 'sleepy';
    return p?.animation === 'happy' || resident.state === 'happy' ? 'happy' : null;
  }
  private poseKey(resident: LivingAudioResident): string {
    const p = resident.performance;
    return this.mood(resident) ? `${p?.sequenceId ?? resident.state}|${p?.stepId ?? 'state'}|${this.mood(resident)}` : '';
  }
  private sync(world: LivingWorld, residents: readonly LivingAudioResident[], elapsed: number): void {
    this.shakeAt = world.tree.shakeAt; this.rustleAt = world.flowers.rustleAt;
    this.effects.clear(); this.poses.clear(); this.motion.clear(); this.landed.clear();
    for (const resident of residents) {
      this.effects.set(resident.uid, this.effectKey(resident)); this.poses.set(resident.uid, this.poseKey(resident));
      this.motion.set(resident.uid, { x: resident.x, z: resident.z, travel: 0, lastStep: elapsed });
    }
    for (const fruit of world.fruits) if (fruit.landedAt <= elapsed) this.landed.add(`${fruit.id}:${fruit.landedAt}`);
    this.footsteps = []; this.lastElapsed = elapsed;
  }

  update(world: LivingWorld, residents: readonly LivingAudioResident[], elapsed: number, camera: LivingAudioCamera, audible = true): LivingSoundCue[] {
    if (!Number.isFinite(elapsed)) return [];
    const gap = this.lastElapsed === null ? 0 : elapsed - this.lastElapsed;
    if (!audible || !this.wasAudible || this.rebase || this.lastElapsed === null || gap < 0 || gap > .75) {
      this.sync(world, residents, elapsed); this.rebase = false; this.wasAudible = audible; return [];
    }
    this.lastElapsed = elapsed;
    const candidates: LivingSoundCue[] = [];
    const cue = (kind: LivingSoundKind, key: string, position: SoundPosition, priority = 2, delay = 0, volume = 1): void => {
      const spatial = spatializeLivingSound(position, camera);
      const gain = spatial.gain * baseGain[kind] * volume;
      if (gain > .006) candidates.push({ kind, key, ...position, gain, pan: spatial.pan, delay, priority });
    };
    const ground = (p: { x: number; z: number }): SoundPosition => ({ ...p, y: terrainBaseHeight(p.x, p.z) + .1 });
    if (world.tree.shakeAt !== this.shakeAt) {
      if (elapsed - world.tree.shakeAt >= 0 && elapsed - world.tree.shakeAt < .45) cue('leaves', `tree:${world.tree.shakeAt}`, ground(LIVING_POINTS.tree));
      this.shakeAt = world.tree.shakeAt;
    }
    if (world.flowers.rustleAt !== this.rustleAt) {
      if (elapsed - world.flowers.rustleAt >= 0 && elapsed - world.flowers.rustleAt < .45) cue('leaves', `flowers:${world.flowers.rustleAt}`, ground(LIVING_POINTS.flowers), 1, 0, .7);
      this.rustleAt = world.flowers.rustleAt;
    }
    const fruitKeys = new Set<string>();
    for (const fruit of world.fruits) {
      const key = `${fruit.id}:${fruit.landedAt}`; fruitKeys.add(key);
      if (fruit.landedAt > elapsed || this.landed.has(key)) continue;
      this.landed.add(key);
      if (elapsed - fruit.landedAt < .4) cue(isInRiver(fruit.x, fruit.z) ? 'splash' : 'fruit-land', `fruit:${key}`, ground(fruit));
    }
    for (const key of this.landed) if (!fruitKeys.has(key)) this.landed.delete(key);

    const ids = new Set<string>();
    for (const resident of residents) {
      ids.add(resident.uid);
      const p = resident.performance, key = this.effectKey(resident);
      const position = { x: resident.x, y: resident.y + resident.height * .45, z: resident.z };
      if (key && this.effects.get(resident.uid) !== key) {
        this.effects.set(resident.uid, key);
        const fresh = p?.effectProgress === undefined || p.effectProgress <= .22;
        if (fresh) {
          const effect = String(p?.effect);
          if (effect === 'ignite') cue('fire-breath', key, position, 3);
          else if (effect === 'electric') cue('electric', key, position, 3);
          else if (effect === 'bite') cue('bite', key, position, 3);
          else if (effect === 'drink') cue('drink', key, position, 3);
          else if (effect === 'pollen') cue('sneeze', key, position);
          else if (effect === 'splash') {
            cue('water-jet', key, position, 3);
            if (p?.target) cue('splash', `${key}:impact`, ground(p.target), 3, .16);
          }
        }
      }
      const pose = this.poseKey(resident), mood = this.mood(resident);
      if (pose !== this.poses.get(resident.uid)) {
        this.poses.set(resident.uid, pose);
        if (mood && elapsed - (this.moodAt.get(resident.uid) ?? -Infinity) > 18
          && elapsed - this.lastMood > 1.6 && (!p || p.progress < .28)) {
          cue(mood, `${resident.uid}:${pose}`, position, 1);
          this.moodAt.set(resident.uid, elapsed); this.lastMood = elapsed;
        }
      }
      const previous = this.motion.get(resident.uid);
      if (previous) {
        const distance = Math.hypot(resident.x - previous.x, resident.z - previous.z);
        previous.x = resident.x; previous.z = resident.z;
        const moving = resident.state === 'walking' || (resident.speed ?? 0) > .05 || p?.animation === 'walk' || p?.animation === 'run';
        if (moving && !airborne.has(resident.pokemonId) && distance < 2.8) {
          previous.travel += distance;
          const stride = clamp(.32 + resident.radius * .5, .38, .9);
          const running = resident.gait === 'run' || p?.animation === 'run';
          if (previous.travel >= stride && elapsed - previous.lastStep >= (running ? .23 : .42)) {
            previous.travel %= stride; previous.lastStep = elapsed;
            cue(livingFootstepSurface(resident.x, resident.z), `step:${resident.uid}:${elapsed}`, ground(resident), 0, 0, running ? 1.12 : .85);
          }
        } else previous.travel = 0;
      } else this.motion.set(resident.uid, { x: resident.x, z: resident.z, travel: 0, lastStep: elapsed });
    }
    for (const map of [this.effects, this.poses, this.moodAt, this.motion]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    this.footsteps = this.footsteps.filter((at) => elapsed - at < 1);
    candidates.sort((a, b) => b.priority - a.priority || b.gain - a.gain);
    const result: LivingSoundCue[] = [];
    for (const candidate of candidates) {
      if (result.length >= LIVING_AUDIO_LIMITS.cuesPerFrame) break;
      if (candidate.kind.startsWith('step-')) {
        if (this.footsteps.length >= LIVING_AUDIO_LIMITS.footstepsPerSecond) continue;
        this.footsteps.push(elapsed);
      }
      result.push(candidate);
    }
    return result;
  }
}

export interface LivingAudioOptions { enabled?: boolean; volume?: number; ambient?: boolean; onError?(message: string): void }
interface Voice { source: AudioScheduledSourceNode; nodes: AudioNode[] }
interface AmbientVoice { gain: GainNode; pan: StereoPannerNode; target: number; panValue: number }

/** Call resumeFromGesture from a trusted pointer/keyboard handler. Construction and update are silent. */
export class LivingAudio {
  private readonly scheduler = new LivingAudioScheduler();
  private readonly voices = new Map<AudioScheduledSourceNode, Voice>();
  private readonly ambience = new Map<'sea' | 'fire', AmbientVoice>();
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noise: AudioBuffer | null = null;
  private unlocking: Promise<boolean> | null = null;
  private unlockedOnce = false;
  private paused = false;
  private destroyed = false;
  private enabledValue: boolean;
  private readonly volume: number;
  private readonly ambient: boolean;
  private readonly options: LivingAudioOptions;
  constructor(options: LivingAudioOptions = {}) {
    this.options = options;
    this.enabledValue = options.enabled ?? true;
    this.volume = clamp(options.volume ?? .28, 0, .6);
    this.ambient = options.ambient ?? true;
  }
  get enabled(): boolean { return this.enabledValue; }
  get unlocked(): boolean { return this.unlockedOnce; }
  get activeSources(): number { return this.voices.size; }

  setEnabled(enabled: boolean): void {
    if (this.destroyed || enabled === this.enabledValue) return;
    this.enabledValue = enabled; this.scheduler.resync(); this.syncContext();
  }
  /** The controller also passes page visibility and initialization through this single pause switch. */
  setPaused(paused: boolean): void {
    if (this.destroyed || paused === this.paused) return;
    this.paused = paused; this.scheduler.resync(); this.syncContext();
  }
  resumeFromGesture(event?: Pick<Event, 'isTrusted'>): Promise<boolean> {
    if (this.destroyed || !this.enabledValue) return Promise.resolve(false);
    if (this.unlockedOnce && this.context?.state === 'running') return Promise.resolve(true);
    const activated = typeof navigator !== 'undefined' && Boolean(navigator.userActivation?.isActive);
    if (!activated && !event?.isTrusted) return Promise.resolve(false);
    if (this.unlocking) return this.unlocking;
    this.unlocking = this.unlock().finally(() => { this.unlocking = null; });
    return this.unlocking;
  }
  private async unlock(): Promise<boolean> {
    try {
      if (!this.context) {
        const Context = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Context) { this.options.onError?.('这台浏览器暂时无法播放环境音，可以继续安静地观察。'); return false; }
        const context = new Context({ latencyHint: 'interactive' }); this.context = context;
        this.master = context.createGain(); this.master.gain.value = 0;
        this.compressor = context.createDynamicsCompressor();
        this.compressor.threshold.value = -22; this.compressor.knee.value = 18; this.compressor.ratio.value = 3;
        this.compressor.attack.value = .006; this.compressor.release.value = .2;
        this.master.connect(this.compressor); this.compressor.connect(context.destination);
        const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate), data = buffer.getChannelData(0);
        let seed = 70841;
        for (let i = 0; i < data.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[i] = (seed / 4294967296) * 2 - 1; }
        this.noise = buffer;
      }
      await this.context.resume();
      if (this.destroyed) return false;
      this.unlockedOnce = this.context.state === 'running';
      this.scheduler.resync(); this.syncContext();
      return this.unlockedOnce;
    } catch {
      if (this.destroyed) return false;
      this.stopAll(); this.master?.disconnect(); this.compressor?.disconnect();
      const failed = this.context; this.context = null; this.master = null; this.compressor = null; this.noise = null; this.unlockedOnce = false;
      if (failed && failed.state !== 'closed') void failed.close().catch(() => undefined);
      this.options.onError?.('声音暂时没有打开，请再点一次声音按钮。'); return false;
    }
  }
  private canPlay(): boolean { return !this.destroyed && this.enabledValue && !this.paused && this.unlockedOnce; }
  private syncContext(): void {
    const context = this.context;
    if (!context || context.state === 'closed') return;
    if (!this.canPlay()) {
      this.stopAll();
      if (this.master) this.master.gain.value = 0;
      void context.suspend().catch(() => undefined);
      return;
    }
    void context.resume().then(() => {
      if (!this.canPlay()) { this.stopAll(); void context.suspend().catch(() => undefined); return; }
      if (this.master) { this.master.gain.cancelScheduledValues(context.currentTime); this.master.gain.setTargetAtTime(this.volume, context.currentTime, .035); }
      this.scheduler.resync();
    }).catch(() => undefined);
  }
  update(world: LivingWorld, residents: readonly LivingAudioResident[], elapsed: number, cameraPosition: LivingAudioCamera): void {
    if (this.destroyed) return;
    const audible = this.canPlay() && this.context?.state === 'running';
    const cues = this.scheduler.update(world, residents, elapsed, cameraPosition, audible);
    if (!audible) return;
    if (this.ambient) this.updateAmbience(world, cameraPosition);
    for (const cue of cues) this.play(cue);
  }
  reset(): void { if (this.destroyed) return; this.stopAll(); this.scheduler.reset(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.stopAll(); this.scheduler.reset();
    this.master?.disconnect(); this.compressor?.disconnect(); this.noise = null;
    const context = this.context; this.context = null; this.master = null; this.compressor = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
  private stopAll(): void {
    for (const voice of [...this.voices.values()]) {
      voice.source.onended = null;
      try { voice.source.stop(); } catch { /* Already stopped. */ }
      for (const node of voice.nodes) node.disconnect();
    }
    this.voices.clear(); this.ambience.clear();
  }
  private register(source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    this.voices.set(source, { source, nodes });
    source.onended = () => { for (const node of nodes) node.disconnect(); this.voices.delete(source); };
  }
  private route(source: AudioScheduledSourceNode, cue: LivingSoundCue, duration: number, volume: number, delay: number, filter?: BiquadFilterNode): { time: number; gain: GainNode } | null {
    const context = this.context;
    if (!context || !this.master || this.voices.size >= LIVING_AUDIO_LIMITS.sources) { source.disconnect(); filter?.disconnect(); return null; }
    const time = context.currentTime + cue.delay + delay;
    const gain = context.createGain(), pan = context.createStereoPanner(); pan.pan.value = cue.pan;
    const peak = Math.max(.0002, cue.gain * volume);
    gain.gain.setValueAtTime(.0001, time);
    gain.gain.linearRampToValueAtTime(peak, time + Math.min(.02, duration * .2));
    gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
    if (filter) { source.connect(filter); filter.connect(gain); } else source.connect(gain);
    gain.connect(pan); pan.connect(this.master);
    this.register(source, filter ? [source, filter, gain, pan] : [source, gain, pan]);
    return { time, gain };
  }
  private tone(cue: LivingSoundCue, startHz: number, endHz: number, duration: number, volume: number, delay = 0, type: OscillatorType = 'sine'): void {
    const context = this.context;
    if (!context || this.voices.size >= LIVING_AUDIO_LIMITS.sources) return;
    const oscillator = context.createOscillator(); oscillator.type = type;
    const route = this.route(oscillator, cue, duration, volume, delay);
    if (!route) return;
    oscillator.frequency.setValueAtTime(startHz, route.time);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), route.time + duration);
    oscillator.start(route.time); oscillator.stop(route.time + duration + .025);
  }
  private hiss(cue: LivingSoundCue, hz: number, duration: number, volume: number, delay = 0, type: BiquadFilterType = 'bandpass', endHz = hz): void {
    const context = this.context;
    if (!context || !this.noise || this.voices.size >= LIVING_AUDIO_LIMITS.sources) return;
    const source = context.createBufferSource(); source.buffer = this.noise; source.loop = true;
    const filter = context.createBiquadFilter(); filter.type = type; filter.Q.value = .65;
    const route = this.route(source, cue, duration, volume, delay, filter);
    if (!route) return;
    filter.frequency.setValueAtTime(hz, route.time); filter.frequency.exponentialRampToValueAtTime(Math.max(30, endHz), route.time + duration);
    let hash = 0; for (const letter of cue.key) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) | 0;
    source.start(route.time, (hash >>> 0) % 1700 / 1000); source.stop(route.time + duration + .025);
  }
  private play(cue: LivingSoundCue): void {
    switch (cue.kind) {
      case 'step-grass': this.hiss(cue, 1300, .095, .8); this.tone(cue, 105, 65, .06, .22); break;
      case 'step-sand': this.hiss(cue, 2300, .12, .68, 0, 'lowpass', 1000); break;
      case 'step-water': this.hiss(cue, 1550, .13, .72); this.tone(cue, 170, 270, .07, .17); break;
      case 'fruit-land': this.tone(cue, 125, 62, .12, .55); this.hiss(cue, 650, .075, .55); break;
      case 'bite': this.hiss(cue, 2500, .065, 1.1); this.tone(cue, 190, 115, .065, .28, .015, 'triangle'); break;
      case 'leaves': this.hiss(cue, 2300, .43, .9, 0, 'bandpass', 1500); break;
      case 'fire-breath': this.hiss(cue, 450, .6, 1.1, 0, 'lowpass', 1400); this.tone(cue, 85, 45, .3, .19); break;
      case 'electric':
        for (let i = 0; i < 3; i++) this.hiss(cue, 2600, .036, .75, i * .06, 'highpass');
        this.tone(cue, 970, 410, .06, .14, .015, 'triangle'); break;
      case 'drink':
        this.hiss(cue, 750, .43, .45);
        for (let i = 0; i < 3; i++) this.tone(cue, 220 + i * 45, 350 + i * 50, .095, .3, i * .12); break;
      case 'water-jet': this.hiss(cue, 1400, .52, .95, 0, 'bandpass', 650); break;
      case 'splash': this.hiss(cue, 2200, .22, .92, 0, 'lowpass', 500); this.tone(cue, 145, 80, .09, .15); break;
      case 'happy': this.tone(cue, 440, 560, .14, .43); this.tone(cue, 660, 600, .16, .24, .1); break;
      case 'sleepy': this.tone(cue, 145, 90, .32, .45); this.hiss(cue, 460, .27, .2); break;
      case 'sneeze': this.hiss(cue, 1500, .12, .7, 0, 'bandpass', 550); break;
    }
  }
  private ambientVoice(kind: 'sea' | 'fire'): AmbientVoice | null {
    const existing = this.ambience.get(kind);
    if (existing) return existing;
    const context = this.context;
    if (!context || !this.master || !this.noise || this.voices.size >= LIVING_AUDIO_LIMITS.sources) return null;
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain(), pan = context.createStereoPanner();
    source.buffer = this.noise; source.loop = true; filter.type = 'lowpass'; filter.frequency.value = kind === 'sea' ? 420 : 650; filter.Q.value = .5;
    gain.gain.value = 0; source.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.master);
    this.register(source, [source, filter, gain, pan]); source.start(0, kind === 'sea' ? 0 : .7);
    const voice = { gain, pan, target: 0, panValue: 0 }; this.ambience.set(kind, voice); return voice;
  }
  private updateAmbience(world: LivingWorld, camera: LivingAudioCamera): void {
    const context = this.context;
    if (!context) return;
    const sea = this.ambientVoice('sea');
    if (sea && sea.target !== .018) { sea.gain.gain.setTargetAtTime(.018, context.currentTime, .7); sea.target = .018; }
    const fire = world.campfire.lit ? this.ambientVoice('fire') : this.ambience.get('fire');
    if (fire) {
      const spatial = spatializeLivingSound({ ...LIVING_POINTS.fire, y: .3 }, camera);
      const target = world.campfire.lit ? .038 * clamp(world.campfire.heat, 0, 1) * spatial.gain : 0;
      if (Math.abs(target - fire.target) > .001 || target === 0 && fire.target !== 0) {
        fire.gain.gain.setTargetAtTime(target, context.currentTime, .4); fire.target = target;
      }
      if (Math.abs(spatial.pan - fire.panValue) > .025) { fire.pan.pan.setTargetAtTime(spatial.pan, context.currentTime, .15); fire.panValue = spatial.pan; }
    }
  }
}
