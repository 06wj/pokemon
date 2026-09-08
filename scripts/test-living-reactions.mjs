import assert from 'node:assert/strict';
import { EcologySimulation } from '../src/ecology/simulation.ts';
import { advanceAction } from '../src/ecology/actionComposer.ts';
import { LIVING_CAST } from '../src/ecology/livingTypes.ts';
import { LIVING_POINTS as P, LIVING_TUNING as T } from '../src/ecology/livingContent.ts';
import { isTraversable } from '../src/ecology/navigation.ts';

const entry = (id) => ({ id, name: `伙伴 ${id}`, model: '', idleAnimation: 'idle',
  types: ['007', '054', '060', '079', '118', '129'].includes(id) ? ['water']
    : ['004', '037', '058'].includes(id) ? ['fire'] : ['001', '043'].includes(id) ? ['grass']
      : id === '012' ? ['bug', 'flying'] : id === '016' ? ['normal', 'flying'] : id === '092' ? ['ghost']
        : id === '025' ? ['electric'] : ['normal'],
  animations: ['idle', 'walk', 'run', 'attack', 'happy', 'sleep'].map((name) => ({ name, label: name })) });
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const advance = (sim, seconds, observe = () => {}) => {
  for (let f = 0; f < Math.ceil(seconds * 30); f++) { sim.update(1 / 30); observe(f); }
};
const until = (sim, predicate, limit = 60, observe = () => {}) => {
  for (let f = 0; f < limit * 30; f++) { sim.update(1 / 30); observe(); if (predicate()) return true; }
  return false;
};
function place(agent, x, z) {
  Object.assign(agent, { x, z, age: 10, state: 'resting', stateTime: 0, decisionIn: 9999, path: [], target: null });
  Object.assign(agent.needs, { hunger: .1, sleep: .1, social: 0, curiosity: 0, energy: .95 });
  assert.ok(isTraversable(agent, agent.radius, agent.profile.locomotion), `Fixture ${agent.pokemonId} begins in valid space`);
}
const reply = (agent) => agent.performance && ['elementReply', 'sneezeReply'].includes(agent.performance.sequenceId.split(':')[0]);

// Effect progress starts at the actual commitment threshold, not at animation
// start, and a lingering effect cannot commit again on subsequent frames.
const phaseSim = new EcologySimulation({ living: true });
const phaseAgent = phaseSim.add(entry('025'), .3, .8);
place(phaseAgent, -7, 2);
phaseAgent.heading = 0;
const makeAction = (point) => ({ id: 'phase-check', kind: 'phase', main: true, step: 0, stepTime: 0, elapsed: 0,
  entered: false, fired: false, meta: {}, steps: [{ id: 'electric-flicker', kind: 'pose', point,
    label: '一点小电光', animation: 'attack', duration: 2, effect: 'electric', effectAt: .4, reach: 1.2 }] });
let commits = 0;
const phaseHost = { moveTo: () => true, move() {}, pose() {}, effect: () => { commits++; return true; } };
const phase = makeAction({ x: -7, z: 2.8 });
let previousProgress = -1, observedEffect = false;
for (let f = 0; f < 60; f++) {
  advanceAction(phaseAgent, phase, 1 / 30, phaseHost);
  const p = phaseAgent.performance;
  if (p.effect) {
    observedEffect = true;
    assert.ok(p.effectProgress >= 0 && p.effectProgress <= 1 && p.effectProgress >= previousProgress);
    assert.ok(Math.abs(p.effectProgress - (p.progress - .4) / .6) < 1e-9);
    previousProgress = p.effectProgress;
  } else assert.equal(p.effectProgress, undefined);
}
assert.ok(observedEffect && previousProgress > .99);
assert.equal(commits, 1, 'One effect step commits exactly once');
const farPhase = makeAction({ x: -7, z: 10 });
commits = 0;
let cancelled = false;
for (let f = 0; f < 60 && !cancelled; f++) cancelled = advanceAction(phaseAgent, farPhase, 1 / 30, phaseHost) === 'cancelled';
assert.ok(cancelled);
assert.equal(commits, 0, 'An out-of-range effect never produces a fake commitment');

// Fire is watched promptly by a small subset of free neighbours. Its audience
// does not include a currently eating, tired or far-away resident.
const fire = new EcologySimulation({ living: true, seed: 2 });
fire.setTimeOfDay('dusk'); fire.world.tree.mature = 0;
const lighter = fire.add(entry('004'), .3, .8); place(lighter, -2.715, -1.527);
const cautious = fire.add(entry('133'), .3, .8); place(cautious, -4.15, .6);
const playful = fire.add(entry('058'), .3, .8); place(playful, -5.35, .2);
const spare = fire.add(entry('016'), .3, .8); place(spare, -1.2, -1.1);
const far = fire.add(entry('037'), .3, .8); place(far, 6, 3);
for (const a of [cautious, playful, spare, far]) a.profile.living.interests.warmth = .2;
const eater = fire.add(entry('052'), .3, .8); place(eater, -2.55, .2); eater.needs.hunger = .95;
fire.intervene('fruit', { x: -2.05, z: .2 });
const sleeper = fire.add(entry('143'), .3, .8); place(sleeper, -4.2, -3.5);
Object.assign(sleeper, { state: 'sleeping', stateTime: 2, sleepDuration: 60 });
Object.assign(sleeper.needs, { energy: .2, sleep: .8 });
let ignitionAt = null, eatingSequence = null, sleepProgress = 0;
const firstReplies = new Map(); const fireEffectSteps = new Set();
advance(fire, 22, () => {
  if (lighter.performance?.effect === 'ignite') {
    fireEffectSteps.add(`${lighter.performance.sequenceId}/${lighter.performance.stepId}`);
    if (ignitionAt === null) {
      ignitionAt = fire.elapsed;
      assert.ok(eater.performance?.sequenceId.startsWith('eatFruit'), 'The protected actor is actually in the food action when the flame starts');
      eatingSequence = eater.performance.sequenceId;
    }
  }
  if (ignitionAt !== null && fire.elapsed - ignitionAt < .6) assert.equal(eater.performance?.sequenceId, eatingSequence, 'A short flame cannot interrupt a meal');
  for (const a of fire.agents) if (reply(a) && !firstReplies.has(a.uid)) firstReplies.set(a.uid, fire.elapsed);
  assert.ok(!reply(eater) && !reply(far), 'Busy and far residents are not drafted into the reaction');
  assert.equal(sleeper.state, 'sleeping', 'A nearby sleeper stays asleep through a gentle elemental effect');
  if (sleeper.performance?.stepId === 'keep-sleeping') sleepProgress = Math.max(sleepProgress, sleeper.performance.progress);
});
assert.notEqual(ignitionAt, null);
assert.equal(fireEffectSteps.size, 1);
assert.ok(firstReplies.size >= 1 && firstReplies.size <= T.elementalRepliesPerSignal);
for (const when of firstReplies.values()) assert.ok(when > ignitionAt && when - ignitionAt < .75, 'Nearby observers start turning while the short effect is still visible');
assert.ok(fire.recentEvents.some((event) => event.id.includes('reply-fire-burst') && event.at - ignitionAt < .8),
  'The real-time moment is available while the observer begins looking, not several seconds after the visual effect ended');
assert.ok(sleepProgress > .5, 'The sleepy murmur advances its fade progress instead of remaining invisible at zero');

// A cautious water-side watcher can give space and look back. The resource
// effect still requires drinking first and emits a single burst signal.
const water = new EcologySimulation({ living: true, seed: 4 });
water.world.tree.mature = 0;
const squirter = water.add(entry('007'), .3, .8); place(squirter, P.river.x, P.river.z);
const flowerWatcher = water.add(entry('001'), .3, .8); place(flowerWatcher, 6, -4.4);
flowerWatcher.profile.living.caution = .9;
const waterSteps = new Set(); let waterAt = null, sawRetreat = false, waterReplyAt = null;
advance(water, 32, () => {
  if (squirter.performance?.effect) waterSteps.add(squirter.performance.effect);
  if (squirter.performance?.effect === 'splash' && waterAt === null) waterAt = water.elapsed;
  if (reply(flowerWatcher) && waterReplyAt === null) waterReplyAt = water.elapsed;
  if (flowerWatcher.performance?.stepId === 'reaction-give-space') sawRetreat = true;
  assert.ok(isTraversable(flowerWatcher, flowerWatcher.radius, flowerWatcher.profile.locomotion));
});
assert.ok(waterSteps.has('drink') && waterSteps.has('splash'));
assert.ok(waterReplyAt !== null && waterReplyAt - waterAt < .75);
assert.ok(sawRetreat, 'A cautious neighbour makes an actual legal small retreat');

function electricFixture(seed = 3) {
  const sim = new EcologySimulation({ living: true, seed }); sim.setTimeOfDay('dusk'); sim.world.tree.mature = 0;
  const pika = sim.add(entry('025'), .2, .8);
  pika.profile.living.abilities.smellFlowers = false;
  pika.profile.living.home = { x: -11.4, z: .5 };
  place(pika, -11, .5);
  return { sim, pika };
}
const edge = electricFixture();
const edgeWatcher = edge.sim.add(entry('133'), .2, .8); place(edgeWatcher, -12.5, .5);
edgeWatcher.profile.living.caution = .99; edgeWatcher.profile.living.interests.warmth = .2;
const edgePosition = { x: edgeWatcher.x, z: edgeWatcher.z };
let sawElectric = false, sawCharge = false, sawSettle = false, sawEdgeReply = false, firstElectricAt = null, edgeReplyMovement = 0;
advance(edge.sim, 28, () => {
  const p = edge.pika.performance;
  if (p?.stepId === 'electric-charge') sawCharge = true;
  if (p?.effect === 'electric') { sawElectric = true; firstElectricAt ??= edge.sim.elapsed; assert.ok(p.effectProgress >= 0 && p.effectProgress <= 1); }
  if (p?.stepId === 'electric-settle') { sawSettle = true; assert.equal(p.effect, null); }
  if (reply(edgeWatcher)) { sawEdgeReply = true; edgeReplyMovement = Math.max(edgeReplyMovement, distance(edgeWatcher, edgePosition)); }
  assert.ok(isTraversable(edgeWatcher, edgeWatcher.radius, edgeWatcher.profile.locomotion));
});
assert.ok(sawCharge && sawElectric && sawSettle && sawEdgeReply, 'Electricity has a readable preparation, short effect, reaction and release');
assert.ok(edgeReplyMovement < .05, 'A watcher against the boundary looks back in place when retreat space is unavailable');
const firstCollected = edge.sim.discoveries.find((d) => d.id.includes('little-electric'));
const firstCollectedAt = firstCollected.at;
assert.ok(until(edge.sim, () => edge.sim.recentEvents.some((d) => d.id === firstCollected.id && d.at > firstCollectedAt + 20), 160), 'A later real electric display becomes a fresh current event');
assert.equal(edge.sim.discoveries.filter((d) => d.id === firstCollected.id).length, 1, 'The permanent collection still deduplicates');
assert.equal(firstCollected.at, firstCollectedAt, 'Current event updates never overwrite the first discovery timestamp');
const latestElectric = edge.sim.recentEvents.filter((d) => d.id === firstCollected.id).at(-1);
assert.ok(latestElectric.at > firstElectricAt && latestElectric.participantUids.includes(edge.pika.uid));
for (const a of [...edge.sim.agents]) edge.sim.remove(a.uid);
advance(edge.sim, T.recentEventSeconds + 1);
assert.equal(edge.sim.recentEvents.length, 0, 'Old occurrences expire from photograph association');

// Original flower observation remains available and can flow into a tiny spark.
const flowers = new EcologySimulation({ living: true, seed: 1 });
flowers.add(entry('025'), .3, .8);
assert.ok(until(flowers, () => flowers.discoveries.some((d) => d.id.includes('smell-flower'))
  && flowers.discoveries.some((d) => d.id.includes('little-electric')), 90));

for (const method of ['pet', 'remove']) {
  const { sim, pika } = electricFixture(5);
  assert.ok(until(sim, () => pika.performance?.stepId === 'electric-flicker' && pika.performance.effect === null, 45));
  sim[method](pika.uid); advance(sim, 2);
  assert.ok(!sim.recentEvents.some((d) => d.id.includes('little-electric')), `${method} cancels the pending electric effect`);
}
const removedSource = electricFixture(3);
const lateWatcher = removedSource.sim.add(entry('133'), .2, .8); place(lateWatcher, -12.5, .5);
lateWatcher.profile.living.interests.warmth = .2;
assert.ok(until(removedSource.sim, () => removedSource.pika.performance?.effect === 'electric', 45));
removedSource.sim.remove(removedSource.pika.uid);
advance(removedSource.sim, 3, () => assert.ok(!reply(lateWatcher), 'A removed source leaves no queued ghost reaction'));

const quiet = electricFixture(3);
quiet.pika.profile.living.home = { x: -9.6, z: 1.8 }; place(quiet.pika, -9.6, 1.8);
assert.ok(until(quiet.sim, () => quiet.pika.performance?.stepId === 'electric-charge', 45));
const resting = quiet.sim.add(entry('143'), .3, .8); place(resting, -10.9, 2);
Object.assign(resting, { state: 'sleeping', stateTime: 2, sleepDuration: 60 });
Object.assign(resting.needs, { energy: .2, sleep: .8 });
advance(quiet.sim, 2);
assert.ok(!quiet.sim.recentEvents.some((d) => d.id.includes('little-electric')), 'The effect rechecks a newly occupied sleeping quiet zone before firing');
assert.equal(resting.state, 'sleeping');

// A mixed population keeps bounded signals, responses and current-event history
// under normal play. Reactions do not fan out into self-triggered chains.
const mixed = new EcologySimulation({ living: true, seed: 7 });
for (const id of LIVING_CAST) assert.ok(mixed.add(entry(id), id === '143' ? .72 : .3, id === '143' ? 1.8 : .8));
advance(mixed, 300, (frame) => {
  assert.ok(mixed.agents.filter(reply).length <= T.maxElementalReplies);
  assert.ok(mixed.recentEvents.length <= T.maxRecentEvents);
  assert.ok(mixed.recentEvents.every((d) => mixed.elapsed - d.at <= T.recentEventSeconds + 1 / 30));
  if (frame % 15 === 0) for (const a of mixed.agents) {
    assert.ok(isTraversable(a, a.radius, a.profile.locomotion));
    for (const b of mixed.agents) if (a.uid < b.uid) assert.ok(distance(a, b) >= a.radius + b.radius + .039);
  }
});
mixed.reset();
assert.equal(mixed.recentEvents.length, 0);
assert.equal(mixed.discoveries.length, 0);
console.log('Living reactions: committed effect progress, brief fire/water/electric signals, prompt bounded replies, protected meals/sleep, legal retreat fallback, quiet-zone cancellation, preserved flower play and fresh repeated photo events passed.');
