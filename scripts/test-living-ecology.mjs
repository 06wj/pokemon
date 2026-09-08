import assert from 'node:assert/strict';
import { EcologySimulation } from '../src/ecology/simulation.ts';
import { LIVING_CAST } from '../src/ecology/livingTypes.ts';
import { LIVING_POINTS, LIVING_TUNING } from '../src/ecology/livingContent.ts';
import { isTraversable } from '../src/ecology/navigation.ts';
import { isInRiver } from '../src/ecology/layout.ts';

const types = (id) => ['007', '054', '060', '079', '118', '129'].includes(id) ? ['water']
  : ['004', '037', '058'].includes(id) ? ['fire'] : ['001', '043'].includes(id) ? ['grass']
  : id === '012' ? ['bug', 'flying'] : id === '016' ? ['normal', 'flying'] : id === '092' ? ['ghost']
  : id === '025' ? ['electric'] : ['normal'];
const entry = (id, clips = ['idle', 'walk', 'run', 'attack', 'happy', 'sleep']) => ({
  id, name: `伙伴 ${id}`, types: types(id), model: '', idleAnimation: 'idle', animations: clips.map((name) => ({ name, label: name })),
});
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const advance = (sim, seconds, observe = () => {}) => {
  for (let f = 0; f < Math.ceil(seconds * 30); f++) { sim.update(1 / 30); observe(f); }
};
const until = (sim, predicate, limit = 90) => {
  for (let f = 0; f < limit * 30; f++) { sim.update(1 / 30); if (predicate()) return true; }
  return false;
};
const place = (agent, x, z) => {
  agent.x = x; agent.z = z; agent.age = 10; agent.state = 'resting'; agent.path = []; agent.target = null; agent.decisionIn = 20;
  assert.ok(isTraversable(agent, agent.radius, agent.profile.locomotion), 'Test fixture starts on real legal terrain');
};

function validate(sim) {
  assert.ok(sim.world.fruits.length <= LIVING_TUNING.maxFruits);
  assert.ok(sim.world.tree.mature >= 0 && sim.world.tree.mature <= 4);
  assert.ok(sim.world.flowers.bloom >= 0 && sim.world.flowers.bloom <= 1);
  assert.ok(sim.world.campfire.heat >= 0 && sim.world.campfire.heat <= 1);
  assert.ok(sim.discoveries.length <= 128);
  assert.equal(new Set(sim.discoveries.map((d) => d.id)).size, sim.discoveries.length, 'Stable discovery ids deduplicate repeated behavior');
  let mainActions = 0;
  const mainKinds = new Set(['lightFire', 'waterFlowers', 'smellFlowers', 'eatFruit', 'yieldFruit']);
  for (const agent of sim.agents) {
    assert.ok(isTraversable(agent, agent.radius, agent.profile.locomotion), `${agent.pokemonId} stays on legal terrain`);
    assert.ok(Object.values(agent.needs).every((n) => Number.isFinite(n) && n >= 0 && n <= 1));
    if (agent.performance) {
      assert.ok(agent.performance.progress >= 0 && agent.performance.progress <= 1);
      assert.ok(Number.isFinite(agent.performance.duration));
      if (mainKinds.has(agent.performance.sequenceId.split(':')[0])) mainActions++;
    }
    if (agent.state === 'sleeping') { assert.equal(agent.speed, 0); assert.equal(agent.path.length, 0); }
    for (const other of sim.agents) if (agent.uid < other.uid) {
      assert.ok(distance(agent, other) >= agent.radius + other.radius + .039, 'Composed motion preserves real body clearance');
    }
  }
  assert.ok(mainActions <= 2, 'At most two main stories begin at the same time');
  for (const fruit of sim.world.fruits) {
    assert.ok(fruit.remaining >= 0 && fruit.remaining <= 1);
    if (fruit.eaterUid) assert.ok(sim.agents.some((agent) => agent.uid === fruit.eaterUid), 'Fruit reservations never reference a removed resident');
  }
}

// Finite ripe fruit, natural drops and visible player throws have real inventory.
const resources = new EcologySimulation({ living: true, seed: 17 });
for (let i = 0; i < 5; i++) { resources.intervene('shake-tree'); advance(resources, 3.1); }
assert.equal(resources.world.tree.mature, 0, 'Repeated shaking cannot manufacture ripe fruit');
assert.equal(resources.world.fruits.length, 4, 'The initial four ripe fruit become exactly four dropped objects');
advance(resources, 60);
assert.ok(resources.world.fruits.length <= 6, 'Natural fruit and ripening respect the global cap without player input');
assert.ok(resources.world.tree.mature + resources.world.fruits.length > 4, 'Newly ripened fruit exists on the tree or has naturally fallen');
resources.reset();
for (let i = 0; i < 6; i++) {
  assert.equal(resources.intervene('fruit', { x: -7.5 + i * .22, z: 2.4 }), true);
  advance(resources, .5);
}
assert.equal(resources.intervene('fruit', { x: -7, z: 3 }), false);
assert.equal(resources.intervene('fruit', { x: 100, z: 100 }), false);
assert.equal(resources.intervene('fruit', { x: NaN, z: 0 }), false);

// A far-away ability owner must walk; a tool does not teleport it or ignite remotely.
const distant = new EcologySimulation({ living: true, seed: 4 });
const remoteFire = distant.add(entry('004'), .3, .8);
place(remoteFire, 8, 3);
const original = { x: remoteFire.x, z: remoteFire.z };
distant.intervene('prepare-fire');
advance(distant, 1.5);
assert.equal(distant.world.campfire.lit, false, 'Preparing firewood cannot remotely light a fire');
assert.ok(distance(remoteFire, original) < 3, 'Early action planning cannot teleport its actor');
assert.ok(!distant.discoveries.some((d) => d.id.includes('first-fire')));

// One fruit has one eater and at most one visible waiting resident. Its two
// half-bites are consumed once, even though the effect remains visible for frames.
const feeding = new EcologySimulation({ living: true, seed: 8 });
feeding.world.tree.mature = 0;
const hungry = feeding.add(entry('052'), .24, .8);
const patient = feeding.add(entry('133'), .24, .8);
const passerby = feeding.add(entry('058'), .24, .8);
place(hungry, -7.2, 1.5); place(patient, -6, 2.2);
place(passerby, -5.5, 2.9);
hungry.needs.hunger = .95; patient.needs.hunger = .79; passerby.needs.hunger = .83;
assert.ok(feeding.intervene('fruit', { x: -6.95, z: 2.2 }));
const fruit = feeding.world.fruits[0];
const biteKeys = new Set(); let sawWaiting = false;
assert.ok(until(feeding, () => {
  assert.ok(feeding.agents.filter((a) => a.performance?.sequenceId.startsWith('waitFruit')).length <= 1, 'Three interested residents still create only one waiting slot');
  for (const agent of feeding.agents) {
    const p = agent.performance;
    if (p?.effect === 'bite') biteKeys.add(`${p.sequenceId}/${p.stepId}`);
    if (p?.sequenceId.startsWith('waitFruit')) sawWaiting = true;
  }
  return fruit.remaining === 0;
}, 24), 'A resident really approaches and eats the fruit');
assert.equal(biteKeys.size, 2, 'One full fruit produces exactly two committed half-bites');
assert.ok(sawWaiting, 'A second interested resident waits rather than consuming the same fruit');
assert.ok(feeding.agents.some((a) => a.needs.hunger < .4), 'Actual consumption produces satiety');
advance(feeding, .2);
assert.equal(feeding.world.fruits.length, 0);
validate(feeding);

// Petting after the first bite cancels the outstanding bite, without refunding
// consumption. Removing the actor also cannot leave an eater or a future effect.
const interrupted = new EcologySimulation({ living: true, seed: 2 });
interrupted.world.tree.mature = 0;
const eater = interrupted.add(entry('052'), .24, .8);
place(eater, -7.2, 1.5); eater.needs.hunger = .94;
interrupted.intervene('fruit', { x: -6.95, z: 2.2 });
const partialFruit = interrupted.world.fruits[0];
assert.ok(until(interrupted, () => partialFruit.remaining === .5, 40));
assert.ok(interrupted.pet(eater.uid));
assert.equal(eater.performance, null);
assert.equal(partialFruit.eaterUid, null);
advance(interrupted, .4);
assert.equal(partialFruit.remaining, .5, 'A cancelled second bite neither consumes again nor refunds the first');
interrupted.remove(eater.uid);
advance(interrupted, 10);
assert.equal(partialFruit.remaining, .5);

for (const interruption of ['remove', 'pet']) {
  const test = new EcologySimulation({ living: true, seed: 1 });
  const fire = test.add(entry('004'), .3, .8);
  assert.ok(until(test, () => fire.performance?.stepId === 'kindle' && fire.performance.effect === null, 45));
  test[interruption](fire.uid);
  assert.equal(fire.performance, null);
  advance(test, 3);
  assert.equal(test.world.campfire.lit, false, `${interruption} cancels the not-yet-fired ignition effect`);
}

// Animation availability does not own gameplay completion. Missing attack,
// happy and sleep clips retain the same completed local behavior semantics.
const fallback = new EcologySimulation({ living: true, seed: 1 });
fallback.add(entry('004', ['idle', 'walk']), .3, .8);
assert.ok(until(fallback, () => fallback.world.campfire.lit, 50), 'Missing attack clip does not block a valid close-range ignition');
const pausedSnapshot = JSON.stringify({ agents: fallback.agents, world: fallback.world, elapsed: fallback.elapsed });
fallback.update(0); fallback.update(NaN); fallback.update(-1);
assert.equal(JSON.stringify({ agents: fallback.agents, world: fallback.world, elapsed: fallback.elapsed }), pausedSnapshot, 'No positive update means no world or sequence progression');
const litAt = fallback.world.campfire.litAt;
fallback.remove(fallback.agents[0].uid);
advance(fallback, 4);
assert.equal(fallback.world.campfire.lit, true, 'Removing the actor preserves its already-lit fire');
assert.equal(fallback.world.campfire.litAt, litAt);
fallback.reset();
assert.equal(fallback.world.campfire.lit, false);
assert.equal(fallback.world.fruits.length, 0);
assert.equal(fallback.world.tree.mature, 4);
assert.equal(fallback.discoveries.length, 0);

const stationary = new EcologySimulation({ living: true, seed: 9 });
stationary.world.tree.mature = 0;
const still = stationary.add(entry('052', ['idle']), .24, .8);
place(still, -7.4, 2.2); still.needs.hunger = .9;
stationary.intervene('fruit', { x: -6.95, z: 2.2 });
const stillPosition = { x: still.x, z: still.z };
assert.ok(until(stationary, () => stationary.discoveries.some((d) => d.id.includes('ate-fruit')), 35), 'A stationary model can respond to food already within reach');
assert.ok(distance(still, stillPosition) < 1e-9, 'A model with no walking or running clip never slides toward distant targets');

const noise = new EcologySimulation({ living: true, seed: 13 });
const lightSleeper = noise.add(entry('133'), .24, .8);
place(lightSleeper, -8.45, -2.79); lightSleeper.state = 'sleeping'; lightSleeper.stateTime = 2;
lightSleeper.sleepDuration = 60; lightSleeper.needs.sleep = .8; lightSleeper.needs.energy = .3;
noise.intervene('shake-tree');
assert.equal(lightSleeper.state, 'sleeping', 'One light shake leaves a nearby sleeper resting');
advance(noise, 3.2); noise.intervene('shake-tree');
advance(noise, 3.2); noise.intervene('shake-tree');
assert.notEqual(lightSleeper.state, 'sleeping', 'Repeated nearby disturbance can wake a light sleeper');
assert.ok(lightSleeper.performance?.bubble === 'curious' || lightSleeper.performance?.bubble === 'surprised');

// Twenty autonomous residents exercise all four main stories, genuine replies,
// naps and long-running bounded state without any player stimulus.
for (const seed of [1, 7, 20260906]) {
  const sim = new EcologySimulation({ living: true, seed });
  for (const id of LIVING_CAST) assert.ok(sim.add(entry(id), id === '143' ? .72 : .3, id === '143' ? 1.8 : .8), `Place ${id} near its authored habitat`);
  const started = new Map(); const effectKeys = new Set(); const drank = new Set();
  const seenKinds = new Set(); const timedOut = new Set();
  advance(sim, 600, (frame) => {
    if (frame % 15 === 0) validate(sim);
    const currentIds = new Set();
    for (const agent of sim.agents) {
      const p = agent.performance;
      if (!p) continue;
      currentIds.add(p.sequenceId); seenKinds.add(p.sequenceId.split(':')[0]);
      if (!started.has(p.sequenceId)) started.set(p.sequenceId, sim.elapsed);
      if (sim.elapsed - started.get(p.sequenceId) > 66) timedOut.add(p.sequenceId);
      const key = `${p.sequenceId}/${p.stepId}/${p.effect}`;
      if (!p.effect || effectKeys.has(key)) continue;
      effectKeys.add(key);
      if (p.effect === 'ignite') {
        assert.ok(distance(agent, LIVING_POINTS.fire) <= LIVING_POINTS.fire.radius + agent.radius + 1.001);
        assert.ok(sim.world.campfire.lit);
      }
      if (p.effect === 'bite') assert.ok(distance(agent, p.target) <= agent.radius + .701, 'Every committed bite occurs at the actual fruit location');
      if (p.effect === 'drink') { assert.ok(isInRiver(agent.x, agent.z)); drank.add(p.sequenceId); }
      if (p.effect === 'splash') {
        assert.ok(drank.has(p.sequenceId), 'The same action must absorb water before it splashes flowers');
        assert.ok(!isInRiver(agent.x, agent.z), 'Spraying flowers occurs from the bank');
        assert.ok(distance(agent, LIVING_POINTS.garden) <= agent.radius + 2.001);
      }
    }
    for (const id of started.keys()) if (!currentIds.has(id)) started.delete(id);
  });
  assert.equal(timedOut.size, 0, 'Action sequences always finish or cancel within their bounded lifetime');
  for (const kind of ['lightFire', 'waterFlowers', 'smellFlowers', 'eatFruit', 'nap']) assert.ok(seenKinds.has(kind), `${kind} occurs autonomously for seed ${seed}`);
  for (const key of ['first-fire', 'water-flowers', 'smell-flower', 'ate-fruit']) assert.ok(sim.discoveries.some((d) => d.id.includes(key)), `${key} completes from real world conditions for seed ${seed}`);
  assert.ok(sim.discoveries.some((d) => d.id.includes('around-fire') && d.participantUids.length >= 2), 'Another resident independently joins the real fire');
  assert.ok(sim.discoveries.some((d) => d.id.includes('new-flowers') && d.participantUids.length >= 2), 'Flower watering eventually draws another resident');
  const oldAgents = [...sim.agents]; sim.reset();
  assert.ok(oldAgents.every((a) => a.performance === null));
  assert.equal(sim.agents.length, 0); assert.equal(sim.elapsed, 0); assert.equal(sim.world.fruits.length, 0);
}

console.log('Living ecology: twenty autonomous residents, four composed stories, spatial effects, single-consumer fruit, satiety, natural resources, replies, naps, interruption, fallback, pause and bounded reset passed.');
