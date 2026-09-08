import type { PokemonEntry } from '../content/pokemon.ts';
import { BRIDGE, ECOLOGY_OBSTACLES, ECOLOGY_ZONES, WORLD_BOUNDS, isInRiver, isOnBridge, riverCenterX, riverHalfWidth, type EcologyPoint, type EcologyZone } from './layout.ts';
import { canTraverseSegment, findEcologyPath, isTraversable } from './navigation.ts';
import { getEcologyProfile, socialAffinity, type EcologyProfile } from './profiles.ts';
import { ECOLOGY_CAPACITY } from './config.ts';
import { LivingSimulation } from './livingSimulation.ts';
import { createLivingWorld, type DiscoveryCandidate, type LivingPerformance, type LivingTool, type LivingWeather, type LivingWorld } from './livingTypes.ts';
import { advanceLivingWeather, changeLivingWeather } from './livingWeather.ts';

export type TimeOfDay = 'dawn' | 'dusk';
export type EcologyState = 'arriving' | 'walking' | 'resting' | 'sleeping' | 'socializing' | 'happy';
export type EcologyGait = 'walk' | 'run';
type EcologyIntent = 'explore' | 'habitat' | 'social' | 'sleep' | 'living';
export interface EcologyAgent extends EcologyPoint {
  uid: string;
  pokemonId: string;
  pokemon: PokemonEntry;
  profile: EcologyProfile;
  heading: number;
  speed: number;
  gait: EcologyGait;
  animationRate: number;
  plannedSpeed: number;
  quietSteps: boolean;
  radius: number;
  state: EcologyState;
  behaviorLabel: string;
  age: number;
  stateTime: number;
  partnerUid: string | null;
  needs: { energy: number; social: number; curiosity: number; sleep: number; hunger: number };
  performance: LivingPerformance | null;
  target: EcologyPoint | null;
  path: EcologyPoint[];
  decisionIn: number;
  socialCooldown: number;
  pairDeadline: number;
  stuckTime: number;
  destinationZone: EcologyZone | null;
  intent: EcologyIntent;
  preferredGait: EcologyGait;
  sleepGroupUid: string | null;
  sleepDuration: number;
  lastWakeAt: number;
  lastRunAt: number;
  sleepBias: number;
  recentPartners: Record<string, number>;
  visited: (EcologyPoint & { at: number })[];
}

export interface EcologyEvent { id: number; text: string; at: number; kind: 'arrival' | 'social' | 'pet' | 'sleep' | 'wake' }
const FIXED_STEP = 1 / 30;
const canLinger = (point: EcologyPoint, profile: EcologyProfile): boolean =>
  profile.locomotion !== 'aquatic' || Math.abs(point.z - BRIDGE.z) >= BRIDGE.halfWidth + 1.3;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const distance = (a: EcologyPoint, b: EcologyPoint): number => Math.hypot(a.x - b.x, a.z - b.z);
const turnToward = (from: number, to: number, max: number): number => {
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + Math.max(-max, Math.min(max, difference));
};

/**
 * Deterministic local utility AI. Decisions run every few seconds, locomotion at
 * 30 Hz. Needs score resting, habitat visits, exploration and partner approach.
 * Social encounters are reciprocal reservations with timeouts and cooldowns.
 * Navigation validates full movement segments; avoidance never pushes an agent
 * onto forbidden terrain. No network or model service is needed at runtime.
 */
export class EcologySimulation {
  readonly agents: EcologyAgent[] = [];
  readonly capacity: number;
  readonly events: EcologyEvent[] = [];
  timeOfDay: TimeOfDay = 'dawn';
  elapsed = 0;
  interactions = 0;
  private readonly seed: number;
  private randomState: number;
  private sequence = 0;
  private eventSequence = 0;
  private accumulator = 0;
  private readonly livingDirector: LivingSimulation | null;
  readonly world: LivingWorld;
  readonly discoveries: DiscoveryCandidate[];
  readonly recentEvents: DiscoveryCandidate[];

  constructor(options: { seed?: number; capacity?: number; living?: boolean } = {}) {
    this.seed = options.seed ?? 20260906;
    this.randomState = this.seed;
    this.capacity = Math.max(1, Math.min(ECOLOGY_CAPACITY, Math.floor(options.capacity ?? ECOLOGY_CAPACITY)));
    this.livingDirector = options.living ? new LivingSimulation({
      agents: this.agents, now: () => this.elapsed, dusk: () => this.timeOfDay === 'dusk', random: () => this.random(),
      canStand: (agent, point) => canLinger(point, agent.profile) && this.pointFree(agent, point, .08),
      canRest: (agent, point) => this.canRest(agent, point),
      moveTo: (agent, point, label, run) => {
        if (!agent.pokemon.animations.some((clip) => clip.name === 'walk' || clip.name === 'run')) {
          if (distance(agent, point) > .2) return false;
          this.releasePair(agent); agent.intent = 'living'; agent.sleepGroupUid = null;
          agent.path = []; agent.target = null; this.setState(agent, 'resting', label); return true;
        }
        const path = findEcologyPath(agent, point, agent.radius, agent.profile.locomotion);
        if (!path.length || !canLinger(point, agent.profile)) return false;
        this.releasePair(agent); agent.intent = 'living'; agent.destinationZone = null; agent.sleepGroupUid = null;
        this.walkTo(agent, point, path, label, run); return true;
      },
      move: (agent, dt) => this.move(agent, dt),
      stop: (agent, label, animation) => {
        this.releasePair(agent); agent.path = []; agent.target = null;
        this.setState(agent, animation === 'happy' ? 'happy' : 'resting', label);
      },
      sleep: (agent) => this.startSleep(agent, agent.uid), wake: (agent) => this.wake(agent),
      wantsSleep: (agent) => this.shouldSleep(agent), note: (text) => this.event(text, 'social'),
    }) : null;
    this.world = this.livingDirector?.world ?? createLivingWorld();
    this.discoveries = this.livingDirector?.discoveries ?? [];
    this.recentEvents = this.livingDirector?.recentEvents ?? [];
  }

  private random(): number {
    this.randomState += 0x6d2b79f5;
    let t = this.randomState;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  private event(text: string, kind: EcologyEvent['kind']): void {
    this.events.push({ id: ++this.eventSequence, text, kind, at: this.elapsed });
    if (this.events.length > 30) this.events.shift();
  }

  add(pokemon: PokemonEntry, footprintRadius?: number, modelHeight = 1): EcologyAgent | null {
    if (this.agents.length >= this.capacity) return null;
    const profile = getEcologyProfile(pokemon, modelHeight);
    if (this.livingDirector && profile.living.waterBound) profile.locomotion = 'aquatic';
    // A navigation disc represents the authored body, excluding tails/wings.
    // Broad land animals retain their clearance even when they cannot fit the
    // bridge; swimmers use a channel-fitting core disc, excluding fins/tails.
    const requested = footprintRadius ?? Math.sqrt(profile.modelHeight) * 0.3;
    const maximum = profile.locomotion === 'aquatic' ? 0.92 : profile.locomotion === 'flying' ? 1 : 2.5;
    const radius = Math.max(0.16, Math.min(maximum, Number.isFinite(requested) ? requested : 0.3));
    const family = this.agents.find((agent) => agent.profile.familyId === profile.familyId && agent.profile.locomotion === profile.locomotion);
    let position: EcologyPoint | null = null;
    for (let attempt = 0; attempt < 160; attempt++) {
      let candidate: EcologyPoint;
      if (this.livingDirector && attempt < 72) {
        const home = profile.living.home;
        const angle = this.random() * Math.PI * 2;
        const spread = .2 + radius + attempt / 72 * 3;
        if (profile.locomotion === 'aquatic') {
          const z = home.z + Math.sin(angle) * spread;
          candidate = { x: riverCenterX(z) + Math.cos(angle) * Math.min(.35, spread * .2), z };
        } else candidate = { x: home.x + Math.sin(angle) * spread, z: home.z + Math.cos(angle) * spread };
      } else if (profile.locomotion === 'aquatic') {
        const z = this.random() * 14 - 7;
        candidate = { x: riverCenterX(z) + (this.random() - 0.5) * Math.max(0.1, riverHalfWidth - radius), z };
      } else if (family && attempt < 40) {
        const angle = this.random() * Math.PI * 2;
        const separation = family.radius + radius + 0.7 + this.random() * 2;
        candidate = { x: family.x + Math.sin(angle) * separation, z: family.z + Math.cos(angle) * separation };
      } else if (attempt < 80) {
        candidate = { x: -8 + this.random() * 8, z: -2 + this.random() * 8 };
      } else {
        candidate = {
          x: (this.random() * 2 - 1) * (WORLD_BOUNDS.x - radius),
          z: (this.random() * 2 - 1) * (WORLD_BOUNDS.z - radius),
        };
      }
      if (canLinger(candidate, profile) && isTraversable(candidate, radius, profile.locomotion) && this.agents.every((agent) => distance(candidate, agent) > agent.radius + radius + 0.3)) {
        position = candidate;
        break;
      }
    }
    if (!position) return null;
    const agent: EcologyAgent = {
      ...position, uid: `ecology-${++this.sequence}`, pokemonId: pokemon.id, pokemon, profile, radius,
      heading: this.random() * Math.PI * 2, speed: 0, gait: 'walk', animationRate: 0, plannedSpeed: 0, quietSteps: false,
      state: 'arriving', behaviorLabel: '来到栖息地',
      age: 0, stateTime: 0, partnerUid: null,
      needs: { energy: 0.78 + this.random() * 0.18, social: 0.5 + this.random() * 0.3, curiosity: 0.7, sleep: 0.1 + this.random() * 0.15, hunger: 0 },
      performance: null,
      target: null, path: [], decisionIn: 1.1, socialCooldown: 0, pairDeadline: 0, stuckTime: 0, destinationZone: null,
      intent: 'explore', preferredGait: 'walk', sleepGroupUid: null, sleepDuration: 0, lastWakeAt: -30, lastRunAt: -30,
      sleepBias: this.random(), recentPartners: {}, visited: [],
    };
    this.agents.push(agent);
    this.livingDirector?.add(agent);
    this.event(`${pokemon.name} 来到栖息地`, 'arrival');
    return agent;
  }

  reset(): void {
    if (!this.livingDirector) Object.assign(this.world.weather, { wetness: 0, snow: 0, changedAt: 0 });
    this.livingDirector?.reset();
    this.agents.length = 0;
    this.events.length = 0;
    this.elapsed = 0;
    this.interactions = 0;
    this.sequence = 0;
    this.eventSequence = 0;
    this.accumulator = 0;
    this.randomState = this.seed;
  }

  /** Roll back an interrupted asset load or remove a resident without leaving
   * another resident reserved for a partner that no longer exists. */
  remove(uid: string): boolean {
    const index = this.agents.findIndex((agent) => agent.uid === uid);
    const agent = this.agents[index];
    if (!agent) return false;
    this.livingDirector?.remove(agent);
    this.releasePair(agent);
    agent.path = [];
    agent.target = null;
    this.agents.splice(index, 1);
    const group = this.agents.filter((other) => other.sleepGroupUid === uid);
    const successor = group[0]?.uid ?? null;
    for (const other of group) other.sleepGroupUid = successor;
    for (const other of this.agents) delete other.recentPartners[uid];
    return true;
  }

  setTimeOfDay(time: TimeOfDay): void {
    if (time === this.timeOfDay) return;
    this.timeOfDay = time;
    for (const agent of this.agents) {
      if (!agent.partnerUid && agent.state !== 'happy' && agent.state !== 'arriving' && agent.state !== 'sleeping') agent.decisionIn = Math.min(agent.decisionIn, 0.5 + this.random() * 3);
    }
  }

  setWeather(kind: LivingWeather): void {
    changeLivingWeather(this.world.weather, kind, this.elapsed);
  }

  pet(uid: string, durationSeconds = 2.7): boolean {
    const agent = this.agents.find((item) => item.uid === uid);
    if (!agent) return false;
    this.livingDirector?.cancel(agent);
    this.releasePair(agent);
    if (agent.state === 'sleeping' || agent.intent === 'sleep') {
      agent.lastWakeAt = this.elapsed;
      agent.sleepGroupUid = null;
      agent.intent = 'explore';
      agent.needs.sleep = Math.min(agent.needs.sleep, 0.28);
    }
    this.setState(agent, 'happy', '开心地回应你');
    agent.path = [];
    agent.target = null;
    agent.decisionIn = Number.isFinite(durationSeconds) ? Math.max(2, Math.min(12, durationSeconds)) : 2.7;
    agent.needs.social = Math.max(0, agent.needs.social - 0.35);
    agent.needs.energy = Math.min(1, agent.needs.energy + 0.06);
    this.event(`${agent.pokemon.name} 开心地回应了你`, 'pet');
    return true;
  }

  intervene(tool: LivingTool, point?: EcologyPoint): boolean {
    return this.livingDirector?.intervene(tool, point) ?? false;
  }

  update(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    // A background tab never catches up with one huge teleporting update.
    this.accumulator += Math.min(dtSeconds, 0.25);
    while (this.accumulator + 1e-9 >= FIXED_STEP) {
      this.accumulator -= FIXED_STEP;
      this.step(FIXED_STEP);
    }
  }

  snapshot(): { count: number; walking: number; socializing: number; resting: number; sleeping: number; interactions: number; timeOfDay: TimeOfDay; events: EcologyEvent[] } {
    return {
      count: this.agents.length,
      walking: this.agents.filter((agent) => agent.state === 'walking').length,
      socializing: this.agents.filter((agent) => agent.state === 'socializing').length,
      resting: this.agents.filter((agent) => agent.state === 'resting').length,
      sleeping: this.agents.filter((agent) => agent.state === 'sleeping').length,
      interactions: this.interactions,
      timeOfDay: this.timeOfDay,
      events: this.events.slice(-4).reverse(),
    };
  }

  private setState(agent: EcologyAgent, state: EcologyState, label: string): void {
    agent.state = state;
    agent.quietSteps = false;
    agent.behaviorLabel = label;
    agent.stateTime = 0;
    if (state !== 'walking') { agent.speed = 0; agent.plannedSpeed = 0; agent.animationRate = 0; agent.gait = 'walk'; }
  }

  private releasePair(agent: EcologyAgent): void {
    const partner = this.agents.find((item) => item.uid === agent.partnerUid);
    agent.partnerUid = null;
    agent.pairDeadline = 0;
    agent.socialCooldown = Math.max(agent.socialCooldown, 18);
    if (partner?.partnerUid === agent.uid) {
      partner.partnerUid = null;
      partner.pairDeadline = 0;
      partner.socialCooldown = Math.max(partner.socialCooldown, 18);
      partner.path = [];
      partner.target = null;
      this.setState(partner, 'resting', '回味刚才的交流');
      partner.decisionIn = 1.0 + this.random();
    }
  }

  private step(dt: number): void {
    this.elapsed += dt;
    if (this.livingDirector) this.livingDirector.updateWorld(dt);
    else advanceLivingWeather(this.world.weather, dt);
    for (const agent of this.agents) {
      agent.age += dt;
      agent.stateTime += dt;
      agent.decisionIn -= dt;
      agent.socialCooldown = Math.max(0, agent.socialCooldown - dt);
      const inactive = this.isInactiveTime(agent);
      if (agent.state === 'sleeping') {
        this.livingDirector?.onSleep(agent);
        agent.needs.energy = clamp01(agent.needs.energy + dt * 0.023);
        agent.needs.sleep = clamp01(agent.needs.sleep - dt * 0.017);
        const nearbyFamily = this.agents.some((other) => other !== agent && other.state === 'sleeping'
          && other.profile.familyId === agent.profile.familyId && distance(agent, other) < agent.radius + other.radius + 2.6);
        agent.behaviorLabel = nearbyFamily ? '挨着同族伙伴一起入睡' : agent.profile.locomotion === 'aquatic' ? '在平静的水面打盹' : '蜷在安静的角落睡觉';
        const dawnWake = !inactive && agent.needs.energy >= 0.48;
        const refreshed = agent.needs.energy >= 0.84 && agent.needs.sleep <= 0.13;
        if (agent.stateTime >= agent.sleepDuration && (dawnWake || refreshed)) this.wake(agent);
        continue;
      }
      agent.needs.social = clamp01(agent.needs.social + dt * 0.012 * agent.profile.sociability);
      agent.needs.curiosity = clamp01(agent.needs.curiosity + dt * 0.017);
      const exertion = agent.state === 'walking' ? (agent.gait === 'run' ? 0.021 : 0.01) : 0;
      agent.needs.energy = clamp01(agent.needs.energy + dt * (agent.state === 'resting' ? 0.003 : -0.002 - exertion));
      agent.needs.sleep = clamp01(agent.needs.sleep + dt * ((inactive ? 0.009 + agent.sleepBias * 0.003 : 0.0018) + exertion * 0.18));
      if (this.livingDirector?.updateAgent(agent, dt)) continue;
      if (agent.state === 'happy' || agent.state === 'arriving') {
        if (agent.decisionIn <= 0) this.decide(agent);
        continue;
      }
      if (agent.partnerUid) {
        const partner = this.agents.find((item) => item.uid === agent.partnerUid);
        if (!partner || partner.partnerUid !== agent.uid || this.elapsed >= agent.pairDeadline) {
          this.releasePair(agent);
          agent.path = [];
          agent.target = null;
          this.setState(agent, 'resting', '稍作休息');
          agent.decisionIn = 1.2;
          continue;
        }
        if (agent.state === 'socializing') {
          agent.heading = turnToward(agent.heading, Math.atan2(partner.x - agent.x, partner.z - agent.z), dt * 3);
          agent.needs.social = clamp01(agent.needs.social - dt * 0.15);
          continue;
        }
        if (canLinger(agent, agent.profile) && canLinger(partner, partner.profile)
          && distance(agent, partner) <= agent.radius + partner.radius + 0.95 && canTraverseSegment(agent, partner, Math.min(agent.radius, partner.radius), agent.profile.locomotion)) {
          this.startSocial(agent, partner);
          continue;
        }
      }
      if (agent.state === 'walking') {
        if (!agent.partnerUid && agent.intent !== 'sleep' && agent.decisionIn <= 0) {
          agent.decisionIn = 2.5 + this.random() * 2;
          if (this.shouldSleep(agent) && this.seekSleep(agent)) continue;
        }
        this.move(agent, dt);
      }
      if (!agent.partnerUid && agent.decisionIn <= 0 && agent.state !== 'walking') this.decide(agent);
    }
  }

  private decide(agent: EcologyAgent): void {
    if (this.shouldSleep(agent) && this.seekSleep(agent)) return;
    if (this.livingDirector?.choose(agent)) return;
    if (this.livingDirector && !agent.pokemon.animations.some((clip) => clip.name === 'walk' || clip.name === 'run')) {
      this.setState(agent, 'resting', '安静地看看身边的伙伴'); agent.decisionIn = 4; return;
    }
    agent.intent = 'explore';
    agent.sleepGroupUid = null;
    const duskSleep = this.isInactiveTime(agent) ? 0.12 : 0;
    const restScore = (1 - agent.needs.energy) * 0.7 + duskSleep;
    const candidates = this.agents.filter((other) => other !== agent && !other.performance && !other.partnerUid && other.socialCooldown <= 0
      && other.state !== 'arriving' && other.state !== 'happy' && other.state !== 'sleeping' && other.intent !== 'sleep'
      && other.needs.energy > 0.3 && other.needs.social > 0.18 && !this.shouldSleep(other)
      && distance(agent, other) < 9 && !(agent.profile.locomotion === 'aquatic' && other.profile.locomotion === 'land')
      && !(agent.profile.locomotion === 'land' && other.profile.locomotion === 'aquatic'));
    candidates.sort((a, b) => this.partnerUtility(agent, b) - this.partnerUtility(agent, a));
    const partner = candidates[0];
    const socialScore = partner && agent.socialCooldown <= 0 && agent.needs.social > 0.38
      ? agent.needs.social * agent.profile.sociability * 1.25 + this.partnerUtility(agent, partner) * 0.5 : -1;
    const habitatScore = this.habitatNeed(agent) * 0.9 + agent.needs.curiosity * 0.23;
    const wanderScore = agent.needs.curiosity * 0.67 + this.random() * 0.16;
    if (this.canRest(agent, agent) && restScore >= Math.max(socialScore, habitatScore, wanderScore)) {
      this.setState(agent, 'resting', duskSleep ? '迎着晚风休憩' : '在这里歇一会儿');
      agent.decisionIn = 3 + this.random() * 4;
      agent.needs.curiosity = Math.max(0, agent.needs.curiosity - 0.15);
      return;
    }
    if (partner && socialScore > Math.max(habitatScore, wanderScore) && this.approach(agent, partner)) return;
    const habitat = habitatScore > wanderScore || this.random() < 0.38;
    for (let attempt = 0; attempt < 18; attempt++) {
      const zone = habitat ? agent.profile.preferredZone : null;
      const target = this.sampleDestination(agent, zone);
      if (!canLinger(target, agent.profile) || !this.pointFree(agent, target, 0.08) || distance(agent, target) < 1.2) continue;
      if (attempt < 12 && agent.visited.some((visit) => this.elapsed - visit.at < 65 && distance(visit, target) < 2)) continue;
      const path = findEcologyPath(agent, target, agent.radius, agent.profile.locomotion);
      if (!path.length) continue;
      agent.destinationZone = zone;
      agent.intent = zone ? 'habitat' : 'explore';
      const label = zone === 'river' ? (agent.profile.locomotion === 'aquatic' ? '顺着溪流游弋' : '去溪边玩水')
        : zone === 'grove' ? '去林荫里找果子' : zone === 'warm-rock' ? '去暖石坡晒太阳' : '沿着花间小径散步';
      const run = agent.needs.energy > 0.64 && agent.needs.curiosity > 0.25 && !this.isInactiveTime(agent)
        && distance(agent, target) > 2.6 && (this.elapsed - agent.lastRunAt > 22 || this.random() < (zone ? 0.24 : 0.5));
      this.walkTo(agent, target, path, label, run);
      return;
    }
    this.setState(agent, 'resting', '观察身边的伙伴');
    agent.decisionIn = 1.5 + this.random() * 2;
  }

  private partnerUtility(agent: EcologyAgent, other: EcologyAgent): number {
    const recentlyMet = agent.recentPartners[other.uid];
    const repetition = recentlyMet === undefined ? 0 : Math.max(0, 1 - (this.elapsed - recentlyMet) / 65) * 1.2;
    return socialAffinity(agent, other) * 1.7 - distance(agent, other) * 0.065 + other.needs.social * 0.12 - repetition;
  }

  private isInactiveTime(agent: EcologyAgent): boolean {
    return (this.timeOfDay === 'dusk') !== agent.profile.nocturnal;
  }

  private shouldSleep(agent: EcologyAgent): boolean {
    if (agent.age < 7 || this.elapsed - agent.lastWakeAt < 18) return false;
    return agent.needs.energy < 0.24 || agent.needs.sleep > 0.74
      || (this.isInactiveTime(agent) && agent.needs.sleep > 0.46 + agent.sleepBias * 0.15);
  }

  private canRest(agent: EcologyAgent, point: EcologyPoint): boolean {
    if (!canLinger(point, agent.profile)) return false;
    if (agent.profile.locomotion === 'aquatic') return true;
    // Flying residents land to sleep, and amphibians choose dry banks. Keep the
    // actual bridge and both entrances clear of long resting/sleeping sessions.
    if (Math.abs(point.x - riverCenterX(point.z)) < riverHalfWidth + agent.radius + 0.16) return false;
    return !(Math.abs(point.x - BRIDGE.x) < BRIDGE.halfLength + agent.radius + 0.45
      && Math.abs(point.z - BRIDGE.z) < BRIDGE.halfWidth + agent.radius + 0.4);
  }

  private seekSleep(agent: EcologyAgent): boolean {
    if (this.livingDirector?.nap(agent)) return true;
    const anchors = this.agents.filter((other) => other !== agent && other.profile.familyId === agent.profile.familyId
      && (other.state === 'sleeping' || other.intent === 'sleep') && distance(agent, other) < 12
      && (agent.profile.locomotion === 'aquatic') === (other.profile.locomotion === 'aquatic'));
    anchors.sort((a, b) => distance(agent, a) - distance(agent, b));
    const anchor = anchors[0];
    if (!anchor && this.canRest(agent, agent)) {
      this.startSleep(agent, agent.uid);
      return true;
    }
    const center = anchor?.target ?? anchor ?? agent;
    const groupUid = anchor?.sleepGroupUid ?? anchor?.uid ?? agent.uid;
    if (anchor && this.canRest(agent, agent) && distance(agent, center) < agent.radius + anchor.radius + 1.7) {
      this.startSleep(agent, groupUid);
      return true;
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = this.random() * Math.PI * 2;
      const separation = anchor ? agent.radius + anchor.radius + 0.4 + this.random() * 1.1 : 1.3 + this.random() * 3.5;
      const target = { x: center.x + Math.sin(angle) * separation, z: center.z + Math.cos(angle) * separation };
      if (!this.canRest(agent, target) || !this.pointFree(agent, target, 0.2)) continue;
      const path = findEcologyPath(agent, target, agent.radius, agent.profile.locomotion);
      if (!path.length) continue;
      this.releasePair(agent);
      agent.intent = 'sleep';
      agent.sleepGroupUid = groupUid;
      agent.destinationZone = null;
      this.walkTo(agent, target, path, anchor ? '去同族伙伴身边准备睡觉' : '找一处安静的地方睡觉');
      return true;
    }
    // Crowding must not indefinitely prevent an exhausted resident from napping.
    if (this.canRest(agent, agent)) { this.startSleep(agent, agent.uid); return true; }
    return false;
  }

  private startSleep(agent: EcologyAgent, groupUid: string): void {
    this.releasePair(agent);
    agent.path = [];
    agent.target = null;
    agent.intent = 'sleep';
    agent.sleepGroupUid = groupUid;
    agent.sleepDuration = 16 + this.random() * 8 + (1 - agent.needs.energy) * 14;
    this.setState(agent, 'sleeping', groupUid === agent.uid ? '蜷在安静的角落睡觉' : '挨着同族伙伴一起入睡');
    agent.decisionIn = agent.sleepDuration;
    this.event(`${agent.pokemon.name}${groupUid === agent.uid ? '找了个舒服的地方睡着了' : '挨着同族伙伴睡着了'}`, 'sleep');
  }

  private wake(agent: EcologyAgent): void {
    agent.lastWakeAt = this.elapsed;
    agent.sleepGroupUid = null;
    agent.intent = 'explore';
    agent.needs.curiosity = Math.max(0.55, agent.needs.curiosity);
    agent.socialCooldown = Math.max(5, agent.socialCooldown);
    this.setState(agent, 'resting', '睡醒后伸了个懒腰');
    agent.decisionIn = 2 + this.random() * 2;
    this.event(`${agent.pokemon.name}睡醒了，精神恢复了一些`, 'wake');
  }

  private habitatNeed(agent: EcologyAgent): number {
    if (agent.profile.preferredZone === 'river') return Math.min(1, Math.abs(agent.x - riverCenterX(agent.z)) / 4);
    return Math.min(1, distance(agent, this.zoneCenter(agent, agent.profile.preferredZone)) / 7);
  }

  private zoneCenter(agent: EcologyAgent, zone: EcologyZone): EcologyPoint & { radius: number } {
    // Flower lovers keep exploring their authored flower patch between stories.
    // Otherwise the legacy type-only grove preference pulls every grass/bug
    // resident across the island before the east-bank garden can bloom.
    if (this.livingDirector && agent.profile.living.interests.flowers > .8 && (zone === 'grove' || zone === 'meadow')) {
      return { ...agent.profile.living.home, radius: 2.6 };
    }
    // The narrow bridge is a real constraint, not a reason to shrink a resident.
    // Broad ground animals can warm themselves in the west-bank sun clearing.
    if (zone === 'warm-rock' && agent.profile.locomotion === 'land' && agent.radius > BRIDGE.halfWidth - 0.15) {
      return { x: -5, z: 5, radius: 2 };
    }
    return ECOLOGY_ZONES[zone];
  }

  private sampleDestination(agent: EcologyAgent, zone: EcologyZone | null): EcologyPoint {
    if (agent.profile.locomotion === 'aquatic' || zone === 'river') {
      const z = Math.max(-7.5, Math.min(7.5, zone ? this.random() * 14 - 7 : agent.z + this.random() * 8 - 4));
      return { x: riverCenterX(z) + (this.random() - 0.5) * Math.max(0.1, (riverHalfWidth - agent.radius) * 1.1), z };
    }
    const center = zone ? this.zoneCenter(agent, zone) : agent;
    const angle = this.random() * Math.PI * 2;
    const radius = zone ? Math.sqrt(this.random()) * this.zoneCenter(agent, zone).radius : 1.6 + this.random() * 4;
    return { x: center.x + Math.sin(angle) * radius, z: center.z + Math.cos(angle) * radius };
  }

  private approach(agent: EcologyAgent, partner: EcologyAgent): boolean {
    // Swimmers may transit below the bridge, but a social invitation must not
    // stop either participant beneath its opaque deck.
    if (!canLinger(partner, partner.profile) || partner.state === 'sleeping' || partner.intent === 'sleep') return false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.atan2(agent.x - partner.x, agent.z - partner.z) + (attempt === 0 ? 0 : (this.random() - 0.5) * Math.PI * 2);
      const gap = agent.radius + partner.radius + 0.55;
      const target = { x: partner.x + Math.sin(angle) * gap, z: partner.z + Math.cos(angle) * gap };
      if (!canLinger(target, agent.profile) || !this.pointFree(agent, target, 0.04)) continue;
      if (!canTraverseSegment(target, partner, Math.min(agent.radius, partner.radius), agent.profile.locomotion)) continue;
      const path = findEcologyPath(agent, target, agent.radius, agent.profile.locomotion);
      if (!path.length) continue;
      agent.partnerUid = partner.uid;
      partner.partnerUid = agent.uid;
      agent.pairDeadline = partner.pairDeadline = this.elapsed + 20;
      partner.path = [];
      partner.target = null;
      this.setState(partner, 'resting', `等${agent.pokemon.name}过来`);
      partner.decisionIn = 20;
      agent.destinationZone = null;
      agent.intent = 'social';
      const family = agent.profile.familyId === partner.profile.familyId;
      this.walkTo(agent, target, path, family ? '去找同族伙伴' : `去和${partner.pokemon.name}打招呼`,
        family && distance(agent, partner) > 3 && agent.needs.energy > 0.72 && !this.isInactiveTime(agent));
      return true;
    }
    return false;
  }

  private startSocial(agent: EcologyAgent, partner: EcologyAgent): void {
    const deadline = this.elapsed + 3.4 + this.random() * 2.3;
    for (const item of [agent, partner]) {
      item.path = [];
      item.target = null;
      item.pairDeadline = deadline;
      item.recentPartners[item === agent ? partner.uid : agent.uid] = this.elapsed;
      this.setState(item, 'socializing', item.profile.familyId === (item === agent ? partner : agent).profile.familyId ? '和同族伙伴聊得很开心' : '和新朋友交流');
    }
    this.interactions++;
    this.event(`${agent.pokemon.name}和${partner.pokemon.name}正在交流`, 'social');
  }

  private walkTo(agent: EcologyAgent, target: EcologyPoint, path: EcologyPoint[], label: string, run = false): void {
    agent.target = target;
    agent.path = path;
    agent.stuckTime = 0;
    agent.decisionIn = 2.5 + this.random() * 2;
    agent.preferredGait = run && agent.profile.runSpeed > agent.profile.moveSpeed ? 'run' : 'walk';
    this.setState(agent, 'walking', label);
  }

  private pointFree(agent: EcologyAgent, point: EcologyPoint, extra = 0): boolean {
    return isTraversable(point, agent.radius, agent.profile.locomotion) && this.agents.every((other) => other === agent || distance(point, other) >= agent.radius + other.radius + 0.04 + extra);
  }

  private bodySegmentFree(agent: EcologyAgent, target: EcologyPoint): boolean {
    const dx = target.x - agent.x;
    const dz = target.z - agent.z;
    const lengthSquared = dx * dx + dz * dz;
    return this.agents.every((other) => {
      if (other === agent) return true;
      const t = lengthSquared > 0 ? clamp01(((other.x - agent.x) * dx + (other.z - agent.z) * dz) / lengthSquared) : 0;
      return Math.hypot(agent.x + dx * t - other.x, agent.z + dz * t - other.z) >= agent.radius + other.radius + 0.04;
    });
  }

  private move(agent: EcologyAgent, dt: number): void {
    while (agent.path[0] && distance(agent, agent.path[0]) < 0.09) agent.path.shift();
    const waypoint = agent.path[0];
    if (!waypoint) {
      agent.target = null;
      if (agent.intent === 'sleep') {
        if (this.canRest(agent, agent)) this.startSleep(agent, agent.sleepGroupUid ?? agent.uid);
        else if (!this.seekSleep(agent)) this.decide(agent);
        return;
      }
      if (!canLinger(agent, agent.profile)) { this.decide(agent); return; }
      this.setState(agent, 'resting', agent.partnerUid ? '等候伙伴的回应' : agent.destinationZone === 'river' ? '享受清凉的溪水' : '享受栖息地的片刻宁静');
      agent.needs.curiosity = Math.max(0, agent.needs.curiosity - 0.3);
      agent.visited.push({ x: agent.x, z: agent.z, at: this.elapsed });
      if (agent.visited.length > 6) agent.visited.shift();
      agent.decisionIn = 2.5 + this.random() * 3.5;
      return;
    }
    const remaining = distance(agent, waypoint);
    let desiredX = (waypoint.x - agent.x) / remaining;
    let desiredZ = (waypoint.z - agent.z) / remaining;
    let crowded = false;
    let nearSleeper = false;
    for (const other of this.agents) {
      if (other === agent) continue;
      const separation = distance(agent, other);
      const sleeping = Boolean(this.livingDirector) && other.state === 'sleeping'
        && agent.profile.locomotion !== 'aquatic';
      const comfort = agent.radius + other.radius + (sleeping ? 1.2 : .8);
      if (sleeping && separation < comfort + 1.1) nearSleeper = true;
      if (separation < comfort + 0.5) crowded = true;
      if (separation > 0.001 && separation < comfort) {
        const weight = (comfort - separation) / comfort * 1.25;
        desiredX += (agent.x - other.x) / separation * weight;
        desiredZ += (agent.z - other.z) / separation * weight;
      }
    }
    agent.quietSteps = nearSleeper;
    const desiredHeading = Math.atan2(desiredX, desiredZ);
    const nearBridge = Math.abs(agent.x - BRIDGE.x) < BRIDGE.halfLength + 0.8
      && Math.abs(agent.z - BRIDGE.z) < BRIDGE.halfWidth + 0.75;
    const nearObstacle = ECOLOGY_OBSTACLES.some((obstacle) => distance(agent, obstacle) < agent.radius + obstacle.radius + 0.8);
    const inWater = isInRiver(agent.x, agent.z) && !isOnBridge(agent.x, agent.z);
    const running = agent.preferredGait === 'run' && agent.profile.runSpeed > agent.profile.moveSpeed
      && agent.needs.energy > 0.45 && !nearBridge && !nearObstacle && !crowded && !nearSleeper
      && !(inWater && agent.profile.locomotion !== 'aquatic' && agent.profile.locomotion !== 'flying');
    agent.gait = running ? 'run' : 'walk';
    const nominal = running ? agent.profile.runSpeed : agent.profile.moveSpeed;
    const circadianPace = this.isInactiveTime(agent) ? 0.8 : 1;
    const terrainPace = nearSleeper ? .62 : nearBridge ? 0.72 : crowded || nearObstacle ? 0.8
      : inWater && agent.profile.locomotion === 'amphibious' ? 0.7 : 1;
    const headingDifference = Math.atan2(Math.sin(desiredHeading - agent.heading), Math.cos(desiredHeading - agent.heading));
    const turnPace = Math.max(0, Math.cos(headingDifference));
    const acceleration = running ? 3.5 : 2.5;
    const braking = 4.8;
    const arrivalLimit = agent.path.length === 1 ? Math.sqrt(2 * braking * Math.max(0, remaining - 0.055)) : Infinity;
    agent.plannedSpeed = Math.min(nominal * circadianPace * terrainPace * turnPace, arrivalLimit);
    const nextSpeed = Math.max(0, agent.speed + Math.max(-braking * dt, Math.min(acceleration * dt, agent.plannedSpeed - agent.speed)));
    const step = Math.min(remaining, nextSpeed * dt);
    const previousHeading = agent.heading;
    const turnRate = running ? 3.2 : 4.2;
    // Position always follows the displayed heading. Slow turning and easing at
    // destinations prevent strafing and keep the authored gait synchronized.
    agent.heading = turnToward(previousHeading, desiredHeading, dt * turnRate);
    if (step < 1e-6) {
      agent.speed = 0;
      agent.animationRate = 0;
      agent.stuckTime += dt;
    } else {
      const turnSign = Number(agent.uid.slice(8)) % 2 === 0 ? 1 : -1;
      const alternatives = [0, 0.45 * turnSign, -0.45 * turnSign, 0.9 * turnSign, -0.9 * turnSign, 1.45 * turnSign, -1.45 * turnSign];
      let next: EcologyPoint | null = null;
      for (const offset of alternatives) {
        const heading = turnToward(previousHeading, desiredHeading + offset, dt * turnRate);
        const candidate = { x: agent.x + Math.sin(heading) * step, z: agent.z + Math.cos(heading) * step };
        if (this.pointFree(agent, candidate) && this.bodySegmentFree(agent, candidate) && canTraverseSegment(agent, candidate, agent.radius, agent.profile.locomotion)) {
          next = candidate;
          agent.heading = heading;
          break;
        }
      }
      if (next) {
        agent.speed = distance(agent, next) / dt;
        agent.x = next.x;
        agent.z = next.z;
        agent.animationRate = agent.speed / nominal;
        if (running && agent.speed > agent.profile.moveSpeed * 1.2) agent.lastRunAt = this.elapsed;
        agent.stuckTime = distance(agent, waypoint) < remaining - step * 0.12 ? 0 : agent.stuckTime + dt;
      } else {
        agent.speed = 0;
        agent.animationRate = 0;
        agent.stuckTime += dt;
      }
    }
    if (agent.stuckTime > 2.5 || agent.stateTime > 50) {
      this.releasePair(agent);
      agent.path = [];
      agent.target = null;
      this.setState(agent, 'resting', '让伙伴先走');
      agent.decisionIn = 0.8 + this.random() * 1.8;
      agent.stuckTime = 0;
    }
  }
}
