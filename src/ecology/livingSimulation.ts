import type { EcologyAgent } from './simulation.ts';
import { advanceAction, type ComposedAction, type LivingStep } from './actionComposer.ts';
import { LIVING_POINTS as P, LIVING_TUNING as T } from './livingContent.ts';
import { COASTAL_LAYOUT, isInRiver, isOnBridge, type EcologyPoint } from './layout.ts';
import { isTraversable } from './navigation.ts';
import { createLivingWorld, type DiscoveryCandidate, type LivingAnimation, type LivingBubble, type LivingFruit, type LivingTool, type LivingWeather, type LivingWorld } from './livingTypes.ts';
import { advanceLivingWeather } from './livingWeather.ts';

export interface LivingHost {
  agents: EcologyAgent[];
  now(): number;
  dusk(): boolean;
  random(): number;
  canStand(agent: EcologyAgent, point: EcologyPoint): boolean;
  canRest(agent: EcologyAgent, point: EcologyPoint): boolean;
  moveTo(agent: EcologyAgent, point: EcologyPoint, label: string, run: boolean): boolean;
  move(agent: EcologyAgent, dt: number): void;
  stop(agent: EcologyAgent, label: string, animation?: LivingAnimation): void;
  sleep(agent: EcologyAgent): void;
  wake(agent: EcologyAgent): void;
  wantsSleep(agent: EcologyAgent): boolean;
  note(text: string): void;
}

interface ResidentMemory {
  nextThink: number;
  eatAfter: number;
  fireAfter: number;
  flowerAfter: number;
  waterAfter: number;
  napAfter: number;
  flowerVisits: number;
  sleptAt: number;
  sleepBubbleUntil: number;
  weatherAfter: number;
  weatherKind: LivingWeather;
  weatherChangedAt: number;
  seen: Set<number>;
}
interface LivingSignal extends EcologyPoint {
  id: number;
  kind: 'fire' | 'flowers' | 'sneeze' | 'food';
  at: number;
  sourceUid: string;
  radius: number;
}
const dist = (a: EcologyPoint, b: EcologyPoint): number => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const moving = (id: string, point: EcologyPoint, label: string, run = false, bubble: LivingBubble = 'curious'): LivingStep =>
  ({ id, kind: 'move', point, label, animation: run ? 'run' : 'walk', duration: 38, bubble });
const facing = (id: string, point: EcologyPoint, label: string): LivingStep =>
  ({ id, kind: 'face', point, label, animation: 'idle', duration: .8 });
const pose = (id: string, animation: LivingAnimation, duration: number, label: string, extra: Partial<LivingStep> = {}): LivingStep =>
  ({ id, kind: 'pose', animation, duration, label, ...extra });

/** Local events and authored single-resident sequences. Other residents choose
 * their own replies; no event reserves an entire cast or bypasses navigation. */
export class LivingSimulation {
  readonly world: LivingWorld = createLivingWorld();
  readonly discoveries: DiscoveryCandidate[] = [];
  private readonly actions = new Map<string, ComposedAction>();
  private readonly memories = new Map<string, ResidentMemory>();
  private readonly waiters = new Map<number, string>();
  private readonly inviters = new Map<number, string>();
  private readonly signals: LivingSignal[] = [];
  private serial = 0;
  private fruitSerial = 0;
  private signalSerial = 0;
  private nextDrop = 5;
  private nextRipen = T.ripenSeconds as number;
  private nextThrow = 0;
  private igniterUid: string | null = null;
  private gardenerUid: string | null = null;
  private shakeStreak = 0;
  private loudNoise: (EcologyPoint & { at: number }) | null = null;

  private readonly host: LivingHost;
  constructor(host: LivingHost) { this.host = host; }

  add(agent: EcologyAgent): void {
    this.memories.set(agent.uid, {
      nextThink: this.host.now() + 1.8 + this.host.random() * 2.4,
      eatAfter: 0, fireAfter: 0, flowerAfter: 0, waterAfter: 0, napAfter: 0,
      flowerVisits: 0, sleptAt: -1, sleepBubbleUntil: 0,
      weatherAfter: 0, weatherKind: 'sunny', weatherChangedAt: -1, seen: new Set(),
    });
    agent.needs.hunger = agent.profile.living.abilities.ignite || agent.profile.living.abilities.waterFlowers
      || agent.profile.living.abilities.smellFlowers ? .27 : .48 + this.host.random() * .25;
    agent.needs.curiosity = .35 + .5 * agent.profile.living.curiosity;
    if (agent.profile.living.restBias > .9) agent.needs.sleep = .53;
  }

  reset(): void {
    for (const agent of this.host.agents) this.cancel(agent);
    const selectedWeather = this.world.weather.kind;
    Object.assign(this.world, createLivingWorld());
    this.world.weather.kind = selectedWeather;
    this.discoveries.length = 0; this.memories.clear(); this.actions.clear(); this.waiters.clear(); this.inviters.clear(); this.signals.length = 0;
    this.serial = 0; this.fruitSerial = 0; this.signalSerial = 0;
    this.nextDrop = 5; this.nextRipen = T.ripenSeconds; this.nextThrow = 0;
    this.igniterUid = null; this.gardenerUid = null;
    this.shakeStreak = 0; this.loudNoise = null;
  }

  remove(agent: EcologyAgent): void {
    this.cancel(agent); this.memories.delete(agent.uid);
    if (this.igniterUid === agent.uid) this.igniterUid = null;
    if (this.gardenerUid === agent.uid) this.gardenerUid = null;
    for (const [fruitId, uid] of this.inviters) if (uid === agent.uid) this.inviters.delete(fruitId);
    for (const other of this.host.agents) if (other !== agent && this.actions.get(other.uid)?.meta.sourceUid === agent.uid) this.cancel(other);
    for (let i = this.signals.length - 1; i >= 0; i--) if (this.signals[i]!.sourceUid === agent.uid) this.signals.splice(i, 1);
  }

  cancel(agent: EcologyAgent): void {
    const action = this.actions.get(agent.uid);
    this.actions.delete(agent.uid);
    for (const fruit of this.world.fruits) if (fruit.eaterUid === agent.uid) fruit.eaterUid = null;
    for (const [id, uid] of this.waiters) if (uid === agent.uid) this.waiters.delete(id);
    agent.performance = null;
    if (action) this.host.stop(agent, '歇一会儿，再看看周围');
    const memory = this.memories.get(agent.uid);
    if (memory) {
      const now = this.host.now();
      memory.nextThink = now + 4;
      // A blocked approach did not perform the main action. Retry after giving
      // neighbours room, rather than charging the successful-action cooldown.
      if (action?.kind === 'lightFire' && !this.world.campfire.lit) memory.fireAfter = Math.min(memory.fireAfter, now + 8);
      if (action?.kind === 'waterFlowers' && this.world.flowers.moisture < .6) memory.waterAfter = Math.min(memory.waterAfter, now + 9);
      if (action?.kind === 'smellFlowers' && action.step < 2) memory.flowerAfter = Math.min(memory.flowerAfter, now + 8);
    }
  }

  intervene(tool: LivingTool, point?: EcologyPoint): boolean {
    const now = this.host.now();
    if (tool === 'observe') return true;
    if (tool === 'fruit') {
      if (now < this.nextThrow || this.world.fruits.length >= T.maxFruits) return false;
      const target = point ?? { x: P.tree.x + 2.3, z: P.tree.z + 1.6 };
      if (!this.fruitPosition(target)) return false;
      this.dropFruit(target, 'player'); this.nextThrow = now + .45;
      return true;
    }
    if (tool === 'shake-tree') {
      if (now - this.world.tree.shakeAt < 3) return false;
      this.shakeStreak = now - this.world.tree.shakeAt < 7 ? this.shakeStreak + 1 : 1;
      this.world.tree.shakeAt = now;
      if (this.world.tree.mature > 0 && this.world.fruits.length < T.maxFruits) this.dropFromTree();
      this.softNoise(P.tree, 3.5, this.shakeStreak >= 3);
      return true;
    }
    if (tool === 'prepare-fire') {
      if (this.world.campfire.lit) return false;
      if (this.world.campfire.prepared) {
        for (const a of this.host.agents) if (a.profile.living.abilities.ignite) this.memories.get(a.uid)!.nextThink = now;
        return true;
      }
      this.world.campfire.prepared = true;
      return true;
    }
    if (tool === 'rustle-flowers') {
      if (now - this.world.flowers.rustleAt < 3) return false;
      this.world.flowers.rustleAt = now;
      this.softNoise(P.flowers, 2.6);
      for (const a of this.host.agents) if (dist(a, P.flowers) < T.flowerPerception) this.memories.get(a.uid)!.nextThink = Math.min(this.memories.get(a.uid)!.nextThink ?? now, now + .7);
      return true;
    }
    return false;
  }

  private fruitPosition(point: EcologyPoint): boolean {
    return Number.isFinite(point.x) && Number.isFinite(point.z) && !isOnBridge(point.x, point.z)
      && isTraversable(point, .16, isInRiver(point.x, point.z) ? 'aquatic' : 'land');
  }

  private dropFruit(point: EcologyPoint, source: LivingFruit['source']): void {
    const now = this.host.now();
    this.world.fruits.push({ ...point, id: ++this.fruitSerial, source, bornAt: now,
      landedAt: now + T.fruitFallSeconds, remaining: 1, eaterUid: null });
  }

  private dropFromTree(): boolean {
    if (this.world.tree.mature < 1 || this.world.fruits.length >= T.maxFruits) return false;
    for (let i = 0; i < 16; i++) {
      const angle = this.host.random() * Math.PI * 2;
      const radius = P.tree.radius + .6 + this.host.random() * 1.7;
      const point = { x: P.tree.x + Math.sin(angle) * radius, z: P.tree.z + Math.cos(angle) * radius };
      if (!this.fruitPosition(point) || this.world.fruits.some((fruit) => dist(fruit, point) < .6)) continue;
      this.world.tree.mature--; this.dropFruit(point, 'tree'); return true;
    }
    return false;
  }

  updateWorld(dt: number): void {
    const now = this.host.now();
    const meltedSnow = advanceLivingWeather(this.world.weather, dt);
    if (now >= this.nextDrop) { this.dropFromTree(); this.nextDrop = now + T.naturalDropSeconds + this.host.random() * 7; }
    if (now >= this.nextRipen) { this.world.tree.mature = Math.min(T.ripeFruitLimit, this.world.tree.mature + 1); this.nextRipen = now + T.ripenSeconds; }
    for (let i = this.world.fruits.length - 1; i >= 0; i--) {
      const fruit = this.world.fruits[i]!;
      if (fruit.eaterUid && !this.host.agents.some((a) => a.uid === fruit.eaterUid)) fruit.eaterUid = null;
      if (fruit.remaining <= 0 || now - fruit.bornAt > T.fruitLifetime) {
        this.world.fruits.splice(i, 1); this.waiters.delete(fruit.id); this.inviters.delete(fruit.id);
      }
    }
    if (this.world.campfire.lit) {
      this.world.campfire.heat = clamp(1 - (now - this.world.campfire.litAt) / T.fireSeconds);
      if (this.world.campfire.heat <= 0) { this.world.campfire.lit = false; this.world.campfire.prepared = false; }
    }
    this.world.flowers.moisture = clamp(this.world.flowers.moisture + dt * (this.world.weather.kind === 'rain' ? .016 : -.0018) + meltedSnow * .6);
    this.world.flowers.bloom = clamp(this.world.flowers.bloom + dt * (this.world.flowers.moisture > .5 ? .01 : -.00065));
    for (const a of this.host.agents) a.needs.hunger = clamp(a.needs.hunger + dt * (a.state === 'sleeping' ? .00035 : .0032) * a.profile.living.appetite);
    for (let i = this.signals.length - 1; i >= 0; i--) if (now - this.signals[i]!.at > 18) this.signals.splice(i, 1);
    const liveSignals = new Set(this.signals.map((signal) => signal.id));
    for (const memory of this.memories.values()) for (const id of memory.seen) if (!liveSignals.has(id)) memory.seen.delete(id);
  }

  onSleep(agent: EcologyAgent): void {
    const memory = this.memories.get(agent.uid);
    if (!memory) return;
    if (memory.sleptAt !== agent.age - agent.stateTime && agent.stateTime < .08) {
      memory.sleptAt = agent.age - agent.stateTime;
      this.discover('nap', 'behavior', '找一处舒服的地方睡觉', `${agent.pokemon.name}放慢脚步，安静睡着了。`, [agent]);
      if (dist(agent, P.tree) < 5) this.discover('shade-nap', 'moment', '树荫下的午觉', '树叶轻轻晃动，伙伴在安静的树荫里睡着。', [agent]);
    }
    if (this.host.now() >= memory.sleepBubbleUntil) agent.performance = null;
  }

  updateAgent(agent: EcologyAgent, dt: number): boolean {
    const action = this.actions.get(agent.uid);
    if (action) {
      if (!this.valid(agent, action)) { this.cancel(agent); return true; }
      const status = advanceAction(agent, action, dt, {
        moveTo: this.host.moveTo, move: this.host.move,
        pose: (a, label, animation) => this.host.stop(a, label, animation),
        effect: (a, current, step) => this.effect(a, current, step),
      });
      if (status === 'cancelled') this.cancel(agent);
      else if (status === 'done') this.finish(agent, action);
      return true;
    }
    return this.choose(agent);
  }

  choose(agent: EcologyAgent): boolean {
    const memory = this.memories.get(agent.uid), now = this.host.now();
    if (!memory || now < memory.nextThink || agent.age < 2 || agent.partnerUid
      || agent.state === 'happy' || agent.state === 'sleeping') return false;
    memory.nextThink = now + T.perceptionSeconds + this.host.random() * 1.7;
    if ((this.host.wantsSleep(agent) || (agent.profile.living.restBias > .9 && agent.needs.sleep > .5 && agent.age > 18)) && this.nap(agent)) return true;
    for (const signal of this.signals) {
      if (signal.sourceUid === agent.uid || memory.seen.has(signal.id) || dist(agent, signal) > signal.radius) continue;
      memory.seen.add(signal.id);
      if (signal.kind === 'sneeze' && agent.needs.energy > .2) {
        const surprise = agent.profile.living.caution > .5;
        return this.start(agent, 'sneezeReply', false, [facing('look', signal, '咦，谁打了个喷嚏？'),
          pose('reply', surprise ? 'idle' : 'happy', 2.2, surprise ? '被花粉轻轻惊了一下' : '看着伙伴忍不住开心', { point: signal, bubble: surprise ? 'surprised' : 'happy' })], { sourceUid: signal.sourceUid });
      }
    }
    const nature = agent.profile.living;
    if (!(nature.abilities.ignite && this.world.campfire.prepared && !this.world.campfire.lit) && this.weatherResponse(agent)) return true;
    if (this.mainCount() < T.maxMainActions) {
      if (nature.abilities.ignite && this.world.campfire.prepared && !this.world.campfire.lit && now >= memory.fireAfter && dist(agent, P.fire) < 16
        && (this.host.dusk() || this.host.random() < .85) && this.lightFire(agent)) return true;
      if (nature.abilities.waterFlowers && this.world.flowers.moisture < .6 && now >= memory.waterAfter && this.waterFlowers(agent)) return true;
      if (nature.abilities.smellFlowers && this.world.flowers.bloom > .15 && now >= memory.flowerAfter && this.smellFlowers(agent)) return true;
      if (nature.interests.fruit > .1 && agent.needs.hunger > .46 && now >= memory.eatAfter && this.findFruit(agent)) return true;
    }
    const warmth = clamp(nature.interests.warmth + (this.world.weather.kind === 'sunny' ? 0 : .22));
    if (agent.profile.locomotion !== 'aquatic' && this.world.campfire.lit && warmth > .4 && now >= memory.fireAfter
      && (this.world.weather.kind === 'sunny' || this.weatherResponders() < T.maxWeatherResponders)
      && dist(agent, P.fire) < T.firePerception && this.guests() < T.maxFireGuests && this.host.random() < warmth && this.gatherFire(agent)) return true;
    if (agent.uid !== this.gardenerUid && this.world.flowers.moisture > .55 && nature.interests.flowers > .5 && now >= memory.flowerAfter
      && dist(agent, P.garden) < T.flowerPerception && this.visitGarden(agent)) return true;
    return false;
  }

  /** Weather is considered only by an available resident's next decision. A
   * bite or another composed action completes without being interrupted here. */
  private weatherResponse(agent: EcologyAgent): boolean {
    const weather = this.world.weather, memory = this.memories.get(agent.uid)!;
    const now = this.host.now(), nature = agent.profile.living;
    if (weather.kind === 'sunny' || agent.profile.locomotion === 'aquatic') return false;
    const changed = memory.weatherKind !== weather.kind || memory.weatherChangedAt !== weather.changedAt;
    if (!changed && now < memory.weatherAfter) return false;
    if (this.weatherResponders() >= T.maxWeatherResponders) return false;
    memory.weatherKind = weather.kind; memory.weatherChangedAt = weather.changedAt;
    memory.weatherAfter = now + T.weatherReactionSeconds + this.host.random() * 16;
    const snow = weather.kind === 'snow';
    // Some playful residents keep watching the weather from where they already
    // are. Their companions need not make the same choice at the same instant.
    if (nature.playfulness > .8 && nature.caution < .5 && this.host.random() < .6) {
      const point = { x: agent.x + Math.sin(agent.heading), z: agent.z + Math.cos(agent.heading) };
      return this.start(agent, 'weatherExplore', false, [facing('notice-weather', point, snow ? '看看飘落的小雪花' : '听听落在身边的雨声'),
        pose('weather-curiosity', 'idle', 2.2, snow ? '雪花落到眼前了' : '雨滴落下，溅起一圈圈水纹', { point, bubble: snow ? 'curious' : 'water' }),
        pose('weather-play', 'happy', 2, snow ? '在雪里也想玩一小会儿' : '喜欢这一点清凉的小雨')]);
    }
    const desire = clamp((snow ? .4 : .3) + nature.caution * .35 + nature.interests.warmth * .35
      - nature.playfulness * .22 - nature.interests.water * (snow ? .12 : .4));
    if (this.host.random() > desire) return false;
    if (this.world.campfire.lit && nature.interests.warmth > .5 && now >= memory.fireAfter
      && this.guests() < T.maxFireGuests && dist(agent, P.fire) < T.firePerception && this.gatherFire(agent)) return true;
    const trees = COASTAL_LAYOUT.obstacles.filter((obstacle) => obstacle.kind === 'tree');
    trees.sort((a, b) => dist(agent, a) - dist(agent, b));
    for (const tree of trees) {
      if (dist(agent, tree) > 13) continue;
      const point = this.near(agent, tree, tree.radius + agent.radius + .45, tree.radius + agent.radius + .85, true);
      if (!point || !this.host.canRest(agent, point)) continue;
      if (this.start(agent, 'weatherShelter', false, [moving('weather-shelter', point, snow ? '到树荫下避一避雪' : '到树下避一会儿雨', false, snow ? 'warm' : 'water'),
        facing('shelter-arrival', tree, '树枝下面，有一处舒服的空地'),
        pose('shelter-listen', 'idle', 2.3, snow ? '看雪花慢慢落下' : '在树荫下听雨声', { point: tree, bubble: snow ? 'warm' : 'water' }),
        pose('shelter-rest', 'idle', 6 + nature.restBias * 5, '安静歇一会儿，看看外面的世界')])) return true;
    }
    memory.weatherAfter = now + 8;
    return false;
  }

  private shelteredByTree(agent: EcologyAgent): boolean {
    return COASTAL_LAYOUT.obstacles.some((tree) => tree.kind === 'tree'
      && dist(agent, tree) <= tree.radius + agent.radius + 1.1);
  }

  private weatherResponders(): number {
    return [...this.actions.values()].filter((action) => ['weatherShelter', 'weatherExplore', 'fireGather'].includes(action.kind)).length;
  }

  private mainCount(): number { return [...this.actions.values()].filter((action) => action.main).length; }
  private guests(): number {
    return this.host.agents.filter((a) => a.uid !== this.igniterUid && (this.actions.get(a.uid)?.kind === 'fireGather'
      || (dist(a, P.fire) < P.fire.radius + a.radius + 2.2 && ['resting', 'happy', 'sleeping'].includes(a.state)))).length;
  }

  private near(agent: EcologyAgent, center: EcologyPoint, minimum: number, maximum: number, dry = false): EcologyPoint | null {
    const first = Math.atan2(agent.x - center.x, agent.z - center.z);
    for (let i = 0; i < 18; i++) {
      const angle = first + i * 2.399963;
      const radius = minimum + (maximum - minimum) * ((i % 4) / 3);
      const point = { x: center.x + Math.sin(angle) * radius, z: center.z + Math.cos(angle) * radius };
      if (!this.host.canStand(agent, point) || (dry && !isTraversable(point, agent.radius, 'land'))) continue;
      if (this.host.agents.some((other) => other !== agent && other.target && dist(point, other.target) < agent.radius + other.radius + .18)) continue;
      return point;
    }
    return null;
  }

  private start(agent: EcologyAgent, kind: string, main: boolean, steps: LivingStep[], meta: ComposedAction['meta'] = {}): boolean {
    if (this.actions.has(agent.uid) || !steps.length) return false;
    const firstMove = steps.find((step) => step.kind === 'move');
    if (firstMove?.point && !this.host.moveTo(agent, firstMove.point, firstMove.label, firstMove.animation === 'run')) return false;
    this.host.stop(agent, steps[0]!.label);
    const action: ComposedAction = { id: `${kind}:${agent.uid}:${++this.serial}`, kind, main, steps,
      step: 0, stepTime: 0, elapsed: 0, entered: false, fired: false, meta };
    this.actions.set(agent.uid, action);
    agent.performance = { sequenceId: action.id, stepId: steps[0]!.id, label: steps[0]!.label,
      animation: 'idle', bubble: 'curious', effect: null, progress: 0, duration: steps[0]!.duration, target: firstMove?.point ?? null };
    return true;
  }

  private valid(agent: EcologyAgent, action: ComposedAction): boolean {
    if (action.meta.sourceUid && !this.host.agents.some((a) => a.uid === action.meta.sourceUid)) return false;
    if (action.meta.fruitId !== undefined) {
      const fruit = this.world.fruits.find((item) => item.id === action.meta.fruitId);
      if ((!fruit || fruit.remaining <= 0) && !action.meta.ate && action.kind !== 'yieldFruit') return false;
      if (action.kind === 'eatFruit' && fruit && fruit.eaterUid !== agent.uid) return false;
    }
    return true;
  }

  private finish(agent: EcologyAgent, action: ComposedAction): void {
    this.actions.delete(agent.uid); agent.performance = null;
    const memory = this.memories.get(agent.uid)!;
    memory.nextThink = this.host.now() + 3.5;
    for (const fruit of this.world.fruits) if (fruit.eaterUid === agent.uid) fruit.eaterUid = null;
    for (const [id, uid] of this.waiters) if (uid === agent.uid) this.waiters.delete(id);
    if (this.world.weather.kind === 'rain' && ['weatherShelter', 'nap'].includes(action.kind) && this.shelteredByTree(agent)) {
      this.discover('rain-shelter', 'behavior', '树荫下听雨', `${agent.pokemon.name}自己走到了树下，停下来听一会儿雨声。`, [agent]);
    }
    if (this.world.weather.kind === 'snow' && this.world.weather.snow >= T.snowDiscoveryCoverage
      && ['weatherShelter', 'weatherExplore', 'fireGather', 'nap'].includes(action.kind)) {
      this.discover('snow-day', 'moment', '雪慢慢铺满了小岛', '地面已经铺上一层雪，一位伙伴停下来，望着这个安静的小世界。', [agent], false);
    }
    if (action.kind === 'nap' || action.meta.nap) { this.host.sleep(agent); return; }
    this.host.stop(agent, action.meta.ate ? '吃饱了，去别处看看' : '回味刚才的小小发现');
    agent.decisionIn = 3.5 + this.host.random() * 3;
    agent.needs.curiosity = Math.max(agent.needs.curiosity, .5);
    if (action.kind === 'sneezeReply') {
      const source = this.host.agents.find((a) => a.uid === action.meta.sourceUid);
      if (source) this.discover('sneeze-company', 'moment', '一口喷嚏，两双眼睛', '花粉飘起来，旁边的伙伴也看了过来。', [source, agent]);
    }
  }

  private findFruit(agent: EcologyAgent): boolean {
    const memory = this.memories.get(agent.uid)!, now = this.host.now();
    const foods = this.world.fruits.filter((fruit) => fruit.landedAt <= now && fruit.remaining > 0 && dist(agent, fruit) < T.fruitPerception
      && (agent.profile.locomotion !== 'aquatic' || isInRiver(fruit.x, fruit.z)));
    foods.sort((a, b) => dist(agent, a) - dist(agent, b));
    for (const fruit of foods) {
      if (!fruit.eaterUid && agent.profile.living.caution > .7 && agent.needs.hunger < .72
        && this.host.agents.some((other) => other !== agent && dist(other, fruit) < 1.5)) continue;
      if (fruit.eaterUid) {
        if (this.waiters.has(fruit.id) || agent.needs.hunger < .55) continue;
        const point = this.near(agent, fruit, agent.radius + 1.6, agent.radius + 2.1);
        if (!point) continue;
        if (this.start(agent, 'waitFruit', false, [moving('wait-nearby', point, '等伙伴吃完这一口'), facing('watch', fruit, '不着急，先等等'),
          pose('waiting', 'idle', 4.5, '等一小会儿，也许有另一枚果子', { point: fruit, bubble: 'fruit' })], { fruitId: fruit.id, sourceUid: fruit.eaterUid })) {
          this.waiters.set(fruit.id, agent.uid); memory.eatAfter = now + 9; return true;
        }
        continue;
      }
      const point = this.near(agent, fruit, agent.radius + .2, agent.radius + .45);
      if (!point) continue;
      const hungrier = this.host.agents.find((other) => other !== agent && other.state !== 'sleeping' && other.needs.hunger > agent.needs.hunger + .12 && dist(other, fruit) < 4);
      if (hungrier && agent.needs.hunger < .72 && !this.inviters.has(fruit.id)) {
        const aside = this.near(agent, fruit, agent.radius + 1.5, agent.radius + 1.9) ?? point;
        if (this.start(agent, 'yieldFruit', true, [moving('notice-fruit', point, '发现一枚果子'), facing('offer', fruit, '这次让伙伴先吃'),
          pose('invite', 'happy', 1.8, '让出果子，招呼旁边的伙伴', { point: fruit, effect: 'invite', reach: agent.radius + .8, bubble: 'happy' }),
          moving('give-space', aside, '退到一旁，让伙伴先来')], { fruitId: fruit.id })) {
          memory.eatAfter = now + 25; return true;
        }
      }
      const reach = agent.radius + .7;
      if (this.start(agent, 'eatFruit', true, [moving('approach-fruit', point, '去吃一枚香甜的水果', agent.needs.hunger > .7, 'fruit'), facing('smell-fruit', fruit, '闻到了水果的香气'),
        pose('bite-one', 'idle', 2, '咔嚓，吃一小口', { point: fruit, effect: 'bite', reach, bubble: 'eating' }),
        pose('bite-two', 'idle', 2, '慢慢吃完，心满意足', { point: fruit, effect: 'bite', reach, bubble: 'eating' }),
        pose('satisfied', 'happy', 2, '吃饱了，心情真好', { bubble: 'happy' })], { fruitId: fruit.id })) {
        fruit.eaterUid = agent.uid; memory.eatAfter = now + 8; return true;
      }
    }
    return false;
  }

  private lightFire(agent: EcologyAgent): boolean {
    const point = this.near(agent, P.fire, P.fire.radius + agent.radius + .35, P.fire.radius + agent.radius + .7, true);
    if (!point) return false;
    const back = this.near(agent, P.fire, P.fire.radius + agent.radius + 1.5, P.fire.radius + agent.radius + 2, true) ?? point;
    if (!this.start(agent, 'lightFire', true, [moving('approach-wood', point, '去看看备好的柴火'), facing('aim-fire', P.fire, '对准干燥的木堆'),
      pose('kindle', 'attack', 2.2, '轻轻喷火，点亮木堆', { point: P.fire, effect: 'ignite', reach: P.fire.radius + agent.radius + 1, bubble: 'warm' }),
      moving('step-away', back, '退到暖光外围'), pose('enjoy-fire', 'happy', 2, '第一簇火光亮起来了', { point: P.fire, bubble: 'happy' })])) return false;
    this.memories.get(agent.uid)!.fireAfter = this.host.now() + T.repeatFireSeconds;
    return true;
  }

  private gatherFire(agent: EcologyAgent): boolean {
    const radius = P.fire.radius + agent.radius + 1.65;
    const first = this.near(agent, P.fire, radius, radius + .35, true);
    if (!first) return false;
    const angle = Math.atan2(first.x - P.fire.x, first.z - P.fire.z);
    const second = { x: P.fire.x + Math.sin(angle + .55) * radius, z: P.fire.z + Math.cos(angle + .55) * radius };
    const third = { x: P.fire.x + Math.sin(angle + 1.05) * radius, z: P.fire.z + Math.cos(angle + 1.05) * radius };
    const steps = [moving('follow-glow', first, '循着暖光，去看一看伙伴', false, 'warm'), facing('look-fire', P.fire, '这里真暖和'),
      pose('warm-welcome', 'happy', 2.4, '和伙伴分享这一簇暖光', { point: P.fire, effect: 'invite', reach: radius + .8, bubble: 'warm' })];
    if (agent.profile.living.playfulness > .55 && this.host.canStand(agent, second) && this.host.canStand(agent, third)) steps.push(moving('circle-one', second, '绕着暖光慢慢走'), moving('circle-two', third, '在火堆外围散步'));
    const nap = agent.profile.living.restBias > .8 && agent.needs.sleep > .35;
    steps.push(pose('linger', nap ? 'idle' : 'happy', nap ? 3 : 2, nap ? '暖和得有点困了' : '和伙伴待一小会儿', { bubble: nap ? 'sleepy' : 'music' }));
    if (!this.start(agent, 'fireGather', false, steps, { nap })) return false;
    this.memories.get(agent.uid)!.fireAfter = this.host.now() + T.repeatFireSeconds;
    return true;
  }

  private waterFlowers(agent: EcologyAgent): boolean {
    const drink = this.near(agent, P.river, 0, .35);
    const bank = this.near(agent, P.garden, agent.radius + .35, agent.radius + 1.2, true);
    if (!drink || !bank || !isInRiver(drink.x, drink.z)) return false;
    if (!this.start(agent, 'waterFlowers', true, [moving('enter-stream', drink, '到清凉的河里吸一口水'), facing('face-water', { x: drink.x + .05, z: drink.z + .5 }, '在水里停一会儿'),
      pose('drink', 'idle', 2.6, '吸一口清凉的河水', { point: drink, effect: 'drink', reach: .7, bubble: 'water' }),
      moving('reach-bank', bank, '把水带到岸边的花丛'), facing('aim-flowers', P.garden, '对准岸边的小花'),
      pose('water-garden', 'attack', 2.6, '给花朵一点水', { point: P.garden, effect: 'splash', reach: agent.radius + 2, bubble: 'water' }),
      pose('admire-garden', 'happy', 2.5, '花朵舒展开了', { point: P.garden, bubble: 'flower' })])) return false;
    this.memories.get(agent.uid)!.waterAfter = this.host.now() + T.repeatWaterSeconds;
    return true;
  }

  private visitGarden(agent: EcologyAgent): boolean {
    const point = this.near(agent, P.garden, agent.radius + .9, agent.radius + 1.7, true);
    if (!point) return false;
    if (!this.start(agent, 'gardenVisit', false, [moving('new-flowers', point, '新开的花朵吸引了它'), facing('inspect-flowers', P.garden, '看看被浇过水的小花'),
      pose('flowers-happy', 'happy', 3, '喜欢这一片新开的花', { point: P.garden, effect: 'invite', reach: agent.radius + 2, bubble: 'flower' })])) return false;
    this.memories.get(agent.uid)!.flowerAfter = this.host.now() + 48;
    return true;
  }

  private smellFlowers(agent: EcologyAgent): boolean {
    const point = this.near(agent, P.flowers, agent.radius + .7, agent.radius + 1.05, true);
    if (!point) return false;
    const memory = this.memories.get(agent.uid)!;
    const sneeze = memory.flowerVisits % 3 === 0;
    const steps = [moving('follow-scent', point, '闻到花香，凑近看看'), facing('face-blossom', P.flowers, '把鼻尖朝向小花'),
      pose('smell', 'idle', 3, '安静地闻一闻花香', { point: P.flowers, bubble: 'flower' })];
    if (sneeze) steps.push(pose('itchy-nose', 'idle', 1, '鼻子有一点点痒', { bubble: 'curious' }),
      pose('sneeze', 'attack', 1.6, '啊嚏！花粉轻轻飘起来', { point: P.flowers, effect: 'pollen', reach: agent.radius + 1.5, bubble: 'surprised' }));
    steps.push(pose('flower-delight', 'happy', 2, '这朵花真香', { point: P.flowers, effect: 'invite', reach: agent.radius + 1.5, bubble: 'happy' }));
    if (!this.start(agent, 'smellFlowers', true, steps)) return false;
    memory.flowerVisits++; memory.flowerAfter = this.host.now() + T.repeatFlowerSeconds;
    return true;
  }

  nap(agent: EcologyAgent): boolean {
    const memory = this.memories.get(agent.uid);
    if (!memory || this.actions.has(agent.uid) || this.host.now() < memory.napAfter) return false;
    if (agent.profile.locomotion === 'aquatic') return false;
    const centers = [P.tree, ...COASTAL_LAYOUT.landmarks.shadeRestSpots,
      { x: COASTAL_LAYOUT.zones['warm-rock'].x - 2.1, z: COASTAL_LAYOUT.zones['warm-rock'].z + 2.3 }];
    centers.sort((a, b) => dist(agent, a) - dist(agent, b));
    for (const center of centers) {
      const minimum = center === P.tree ? P.tree.radius + agent.radius + .7 : .3;
      const point = this.near(agent, center, minimum, minimum + 1.3, true);
      if (!point || !this.host.canRest(agent, point)) continue;
      if (this.loudNoise && this.host.now() - this.loudNoise.at < 18 && dist(point, this.loudNoise) < 3.5) continue;
      if (this.start(agent, 'nap', false, [moving('quiet-place', point, '找一处安静的树荫'),
        pose('getting-sleepy', 'idle', 2.3, '这里很舒服，可以睡一会儿', { bubble: 'sleepy' })])) {
        memory.napAfter = this.host.now() + 45; return true;
      }
    }
    return false;
  }

  private effect(agent: EcologyAgent, action: ComposedAction, step: LivingStep): boolean {
    const now = this.host.now();
    if (step.effect === 'bite') {
      const fruit = this.world.fruits.find((item) => item.id === action.meta.fruitId);
      if (!fruit || fruit.eaterUid !== agent.uid || fruit.remaining <= 0 || now < fruit.landedAt || dist(agent, fruit) > agent.radius + .7) return false;
      fruit.remaining = Math.max(0, fruit.remaining - .5);
      agent.needs.hunger = clamp(agent.needs.hunger - .36); agent.needs.energy = clamp(agent.needs.energy + .055);
      if (fruit.remaining === 0) {
        action.meta.ate = true; this.memories.get(agent.uid)!.eatAfter = now + T.fruitSatietySeconds;
        action.steps = action.steps.filter((pending, i) => i <= action.step || pending.effect !== 'bite');
        this.discover('ate-fruit', 'behavior', '吃饱了，去别处看看', `${agent.pokemon.name}真正走到水果旁，慢慢吃完了它。`, [agent]);
        const inviter = this.host.agents.find((a) => a.uid === this.inviters.get(fruit.id));
        if (inviter && inviter !== agent) this.discover('shared-fruit', 'moment', '这次让你先吃', '一位伙伴让出位置，另一位吃到了甜甜的果子。', [inviter, agent]);
      }
    } else if (step.effect === 'ignite') {
      if (!agent.profile.living.abilities.ignite || !this.world.campfire.prepared || this.world.campfire.lit) return false;
      this.world.campfire.lit = true; this.world.campfire.heat = 1; this.world.campfire.litAt = now;
      this.igniterUid = agent.uid; this.signal('fire', agent, P.fire, T.firePerception);
      this.discover('first-fire', 'behavior', '第一簇火光', `${agent.pokemon.name}靠近木堆，轻轻点起了火。`, [agent]);
    } else if (step.effect === 'drink') {
      if (!isInRiver(agent.x, agent.z) || !agent.profile.living.abilities.waterFlowers) return false;
      action.meta.water = true;
      this.discover('drink-water', 'behavior', '清凉的一口水', `${agent.pokemon.name}到河里吸了一口水。`, [agent]);
    } else if (step.effect === 'splash') {
      if (!action.meta.water || isInRiver(agent.x, agent.z)) return false;
      action.meta.water = false; this.world.flowers.moisture = .98; this.world.flowers.bloom = Math.max(.82, this.world.flowers.bloom);
      this.gardenerUid = agent.uid; this.signal('flowers', agent, P.garden, T.flowerPerception);
      this.discover('water-flowers', 'behavior', '给花的一口水', '从河里带来的水，让岸边的小花舒展开来。', [agent]);
    } else if (step.effect === 'pollen') {
      this.signal('sneeze', agent, agent, T.sneezePerception); this.softNoise(agent, 2.5);
      this.discover('flower-sneeze', 'behavior', '花香里的小喷嚏', '凑近花朵时，鼻子忽然有一点痒。', [agent]);
    } else if (step.effect === 'invite') {
      if (action.kind === 'yieldFruit' && action.meta.fruitId !== undefined) {
        this.inviters.set(action.meta.fruitId, agent.uid);
        this.signal('food', agent, step.point ?? agent, T.fruitPerception);
        this.discover('yield-fruit', 'behavior', '你先来吧', `${agent.pokemon.name}退开一点，把果子留给伙伴。`, [agent]);
      } else if (action.kind === 'fireGather') {
        const igniter = this.host.agents.find((a) => a.uid === this.igniterUid);
        if (igniter && igniter !== agent) this.discover('around-fire', 'moment', '围着暖光的小聚会', '火光引来了一位自己走过来的伙伴。', [igniter, agent]);
      } else if (action.kind === 'gardenVisit') {
        const gardener = this.host.agents.find((a) => a.uid === this.gardenerUid);
        if (gardener && gardener !== agent) this.discover('new-flowers', 'moment', '花开之后，有客来访', '一口水让花开了，也引来了喜欢花的伙伴。', [gardener, agent]);
      } else if (action.kind === 'smellFlowers') this.discover('smell-flower', 'behavior', '停下来闻一朵花', `${agent.pokemon.name}在花边停留，开心地闻着花香。`, [agent]);
    }
    return true;
  }

  private signal(kind: LivingSignal['kind'], agent: EcologyAgent, point: EcologyPoint, radius: number): void {
    this.signals.push({ x: point.x, z: point.z, id: ++this.signalSerial, kind, at: this.host.now(), sourceUid: agent.uid, radius });
    if (this.signals.length > 24) this.signals.shift();
  }

  private softNoise(point: EcologyPoint, radius: number, strong = false): void {
    if (strong) this.loudNoise = { x: point.x, z: point.z, at: this.host.now() };
    for (const agent of this.host.agents) {
      if (agent.state !== 'sleeping' || dist(agent, point) > radius) continue;
      const memory = this.memories.get(agent.uid)!;
      const tolerance = .8 + agent.profile.living.restBias * .5 - agent.profile.living.caution * .25;
      if (strong && tolerance < 1.1) {
        this.host.wake(agent);
        this.start(agent, 'wakeReaction', false, [facing('wake-look', point, '听到近处的动静，醒来看看'),
          pose('wake-surprise', 'idle', 2.3, '这边有些吵，换个安静的地方吧', { bubble: 'surprised', point })]);
        this.discover('noise-wake', 'behavior', '是谁在摇树？', '近处接连的树叶声，让一位轻睡的伙伴醒了过来。', [agent]);
        continue;
      }
      agent.heading += .12; memory.sleepBubbleUntil = this.host.now() + 1.6;
      agent.performance = { sequenceId: `sleep-noise:${agent.uid}:${++this.serial}`, stepId: 'keep-sleeping', label: '轻轻哼一声，接着睡', animation: 'sleep', bubble: 'sleepy', effect: null, progress: 0, duration: 1.6, target: null };
    }
  }

  private discover(key: string, category: DiscoveryCandidate['category'], title: string, description: string, agents: EcologyAgent[], bySpecies = true): void {
    const speciesIds = [...new Set(agents.map((a) => a.pokemonId))].sort();
    const id = `${category}:${key}${bySpecies ? `:${speciesIds.join('-')}` : ''}`;
    if (this.discoveries.some((item) => item.id === id)) return;
    this.discoveries.push({ id, category, title, description, speciesIds, participantUids: agents.map((a) => a.uid), at: this.host.now() });
    if (this.discoveries.length > 128) this.discoveries.shift();
    this.host.note(title);
  }
}
