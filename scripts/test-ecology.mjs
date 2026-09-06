import assert from 'node:assert/strict';
import { EcologySimulation } from '../src/ecology/simulation.ts';
import { getEcologyProfile, socialAffinity } from '../src/ecology/profiles.ts';
import { speciesFamilies } from '../src/ecology/speciesFamilies.ts';
import { canTraverseSegment, findEcologyPath, isTraversable } from '../src/ecology/navigation.ts';
import { isInRiver, isOnBridge, riverCenterX } from '../src/ecology/layout.ts';
import { ECOLOGY_CAPACITY, POKEMON_SCALE } from '../src/ecology/config.ts';

const entry = (id, types = ['normal']) => ({ id, types, name: `Pokemon ${id}`, model: '', idleAnimation: 'idle',
  animations: ['idle', 'walk', 'run', 'sleep', 'happy'].map((name) => ({ name, label: name })) });
const fixtures = [
  entry('001', ['grass', 'poison']), entry('002', ['grass', 'poison']), entry('003', ['grass', 'poison']),
  entry('004', ['fire']), entry('005', ['fire']), entry('006', ['fire', 'flying']),
  entry('007', ['water']), entry('008', ['water']), entry('009', ['water']),
  entry('025', ['electric']), entry('026', ['electric']), entry('133'), entry('134', ['water']),
  entry('129', ['water']), entry('130', ['water', 'flying']), entry('131', ['water', 'ice']),
  entry('095', ['rock', 'ground']), entry('143'), entry('092', ['ghost', 'poison']),
  entry('016', ['normal', 'flying']), entry('017', ['normal', 'flying']), entry('018', ['normal', 'flying']),
  entry('106', ['fighting']), entry('107', ['fighting']),
  entry('019'), entry('020'), entry('037', ['fire']), entry('038', ['fire']), entry('052'), entry('053'),
];
function advance(sim, seconds, observer = () => {}) {
  for (let frame = 0; frame < seconds * 30; frame++) { sim.update(1 / 30); observer(frame); }
}
function validate(sim) {
  for (const a of sim.agents) {
    for (const value of [a.x, a.z, a.heading, a.speed, a.animationRate, a.plannedSpeed, a.age, a.stateTime, ...Object.values(a.needs)]) assert.ok(Number.isFinite(value), `${a.uid}: finite state`);
    assert.ok(isTraversable(a, a.radius, a.profile.locomotion), `${a.pokemonId}: legal terrain at ${a.x},${a.z}`);
    assert.ok(Object.values(a.needs).every((value) => value >= 0 && value <= 1), 'Bounded needs');
    if (a.sleepGroupUid) assert.ok(sim.agents.some((other) => other.uid === a.sleepGroupUid), 'Sleep groups never reference removed residents');
    if (a.state === 'sleeping') {
      assert.equal(a.partnerUid, null, 'Social invitations do not interrupt sleep');
      assert.equal(a.speed, 0);
      assert.equal(a.animationRate, 0);
      assert.equal(a.path.length, 0);
      assert.ok(a.profile.locomotion === 'aquatic' || !isInRiver(a.x, a.z), 'Terrestrial and flying residents sleep on dry land');
    }
    if (a.partnerUid) {
      const partner = sim.agents.find((b) => b.uid === a.partnerUid);
      assert.equal(partner?.partnerUid, a.uid, 'Every social reservation is reciprocal');
      assert.ok(a.pairDeadline > sim.elapsed - 1 / 30, 'Reservations cannot remain stale');
    }
    for (const b of sim.agents) {
      if (a.uid >= b.uid) continue;
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= a.radius + b.radius + 0.039, 'Body discs never overlap');
    }
  }
}

assert.equal(speciesFamilies.length, 151);
assert.equal(ECOLOGY_CAPACITY, 30);
assert.equal(POKEMON_SCALE, 0.9);
for (const seed of [37, 92]) {
  const expandedSpawn = new EcologySimulation({ seed });
  for (let index = 0; index < ECOLOGY_CAPACITY; index++) {
    assert.ok(expandedSpawn.add(entry('025', ['electric']), 0.55, 1), 'Thirty authored-radius land residents fit across the habitat');
  }
  assert.equal(expandedSpawn.agents.length, 30);
  assert.ok(expandedSpawn.agents.some((agent) => agent.x > 0 || agent.x < -8 || agent.z < -2 || agent.z > 6), 'Crowded arrivals can use open space beyond the initial meadow patch');
  validate(expandedSpawn);
  assert.equal(expandedSpawn.add(entry('025', ['electric']), 0.55, 1), null, 'The real thirty-resident capacity remains enforced');
}
assert.equal(new Set(speciesFamilies.map((row) => row.id)).size, 151);
assert.equal(getEcologyProfile(entry('025'), 0.43).modelHeight, 0.43, 'Behavior uses authored model size');
assert.equal(getEcologyProfile(entry('095'), 3.72).modelHeight, 3.72, 'Serpentine models retain their authored dimensions');
assert.equal(getEcologyProfile(entry('095')).modelHeight, 1, 'There is no Pokédex height scaling fallback');
assert.equal(getEcologyProfile(entry('133')).familyId, getEcologyProfile(entry('136')).familyId, 'Branch evolutions stay in one family');
assert.equal(getEcologyProfile(entry('106')).familyId, getEcologyProfile(entry('107')).familyId, 'Shared later-generation pre-evolution remains a family');
const identity = (id) => ({ pokemonId: id, profile: getEcologyProfile(entry(id)) });
assert.ok(socialAffinity(identity('001'), identity('001')) > socialAffinity(identity('001'), identity('002')));
assert.ok(socialAffinity(identity('001'), identity('002')) > socialAffinity(identity('001'), identity('025')));

const origin = { x: -1, z: 5 };
const destination = { x: 6.5, z: 5 };
const landPath = findEcologyPath(origin, destination, 0.35, 'land');
assert.ok(landPath.length > 1, 'Land route detours through bridge');
let previous = origin;
let bridgeCrossings = 0;
for (const point of landPath) {
  assert.ok(canTraverseSegment(previous, point, 0.35, 'land'));
  for (let step = 0; step <= 50; step++) {
    const x = previous.x + (point.x - previous.x) * step / 50;
    const z = previous.z + (point.z - previous.z) * step / 50;
    if (isInRiver(x, z)) { assert.ok(isOnBridge(x, z, 0.35), 'Ground animals cross water on bridge only'); bridgeCrossings++; }
  }
  previous = point;
}
assert.ok(bridgeCrossings > 0);
assert.equal(findEcologyPath(origin, destination, 0.35, 'amphibious').length, 1, 'Amphibious animals can cross the water directly');
const fishPath = findEcologyPath({ x: riverCenterX(-6), z: -6 }, { x: riverCenterX(6), z: 6 }, 0.35, 'aquatic');
assert.ok(fishPath.length > 0, 'Fish can navigate the curved river');
assert.ok(findEcologyPath({ x: riverCenterX(-6), z: -6 }, { x: riverCenterX(6), z: 6 }, 0.92, 'aquatic').length > 0, 'Large swimmers follow narrow bends without grid quantization traps');
assert.deepEqual(findEcologyPath({ x: riverCenterX(-6), z: -6 }, origin, 0.35, 'aquatic'), [], 'Fish reject land destinations');

const sim = new EcologySimulation({ seed: 314159 });
for (const pokemon of fixtures) assert.ok(sim.add(pokemon), `Spawn ${pokemon.id}`);
assert.equal(sim.add(entry('151')), null, 'Capacity is enforced');
const initial = JSON.stringify(sim.agents.map(({ uid, x, z, heading }) => ({ uid, x, z, heading })));
let riverVisits = 0;
let groundWalked = 0;
let socialFrames = 0;
const seenStates = new Set();
advance(sim, 150, (frame) => {
  if (frame % 15 === 0) validate(sim);
  for (const a of sim.agents) {
    seenStates.add(a.state);
    if (a.profile.locomotion === 'amphibious' && isInRiver(a.x, a.z)) riverVisits++;
    if (a.profile.locomotion === 'land' && a.state === 'walking' && a.speed > 0.1) groundWalked++;
    if (a.state === 'socializing') socialFrames++;
  }
  if (frame === 1800) sim.setTimeOfDay('dusk');
  if (frame === 2700) for (const a of sim.agents.slice(0, 6)) assert.ok(sim.pet(a.uid));
});
assert.ok(riverVisits > 100, 'Water types independently visit the river');
assert.ok(groundWalked > 1000, 'Ground animals travel around the habitat');
assert.ok(socialFrames > 300 && sim.interactions > 4, 'Autonomous reciprocal encounters actually occur');
assert.ok(['arriving', 'walking', 'resting', 'sleeping', 'socializing', 'happy'].every((state) => seenStates.has(state)), 'All behavior states are exercised');
validate(sim);

// Interruption releases both sides immediately, with a cooldown preventing an
// abandoned partner from instantly initiating the same encounter again.
const pairSim = new EcologySimulation({ seed: 92 });
const one = pairSim.add(entry('025', ['electric']));
const two = pairSim.add(entry('026', ['electric']));
let foundPair = false;
advance(pairSim, 30, () => {
  if (foundPair || !one.partnerUid) return;
  assert.equal(two.partnerUid, one.uid);
  assert.ok(pairSim.pet(one.uid));
  assert.equal(one.partnerUid, null);
  assert.equal(two.partnerUid, null);
  assert.equal(one.state, 'happy');
  assert.ok(two.socialCooldown > 0);
  foundPair = true;
});
assert.ok(foundPair, 'A same-family encounter forms naturally');
assert.equal(pairSim.pet('missing'), false);
const removeSim = new EcologySimulation({ seed: 92 });
const removed = removeSim.add(entry('025', ['electric']));
const survivor = removeSim.add(entry('026', ['electric']));
let removedActivePair = false;
advance(removeSim, 30, () => {
  if (removedActivePair || !removed.partnerUid) return;
  assert.ok(removeSim.remove(removed.uid));
  assert.equal(survivor.partnerUid, null);
  assert.equal(survivor.path.length, 0);
  assert.ok(survivor.socialCooldown > 0);
  assert.equal(removeSim.agents.length, 1);
  removedActivePair = true;
});
assert.ok(removedActivePair, 'Removing an actively paired resident releases the survivor');
assert.equal(removeSim.remove(removed.uid), false, 'Repeated removal is harmless');
validate(removeSim);
const before = pairSim.elapsed;
pairSim.update(Infinity); pairSim.update(NaN); pairSim.update(-1);
assert.equal(pairSim.elapsed, before, 'Invalid elapsed values are ignored');
pairSim.update(60);
assert.ok(pairSim.elapsed - before <= 0.26, 'A background-frame stall is bounded');
validate(pairSim);

sim.reset();
assert.equal(sim.agents.length, 0);
assert.equal(sim.events.length, 0);
assert.equal(sim.elapsed, 0);
assert.equal(sim.interactions, 0);
for (const pokemon of fixtures) assert.ok(sim.add(pokemon));
assert.equal(JSON.stringify(sim.agents.map(({ uid, x, z, heading }) => ({ uid, x, z, heading }))), initial, 'Reset clears RNG, IDs, paths and encounters deterministically');

// Behavior-level comparison counts actual sleeping, separately from short rests.
function sleepingFrames(time) {
  const test = new EcologySimulation({ seed: 83 });
  test.setTimeOfDay(time);
  const a = test.add(entry('025', ['electric']));
  let resting = 0;
  advance(test, 180, () => { if (a.state === 'sleeping') resting++; });
  return resting;
}
assert.ok(sleepingFrames('dusk') > sleepingFrames('dawn'), 'Dusk causes more actual sleep for day-active Pokémon');
assert.ok(getEcologyProfile(entry('092', ['ghost', 'poison'])).nocturnal);

for (const seed of [1, 2, 3]) {
  const test = new EcologySimulation({ seed });
  const fire = test.add(entry('004', ['fire']));
  const water = test.add(entry('007', ['water']));
  let crossedBridge = 0;
  let warmBank = 0;
  let waterVisits = 0;
  advance(test, 180, (frame) => {
    if (isInRiver(fire.x, fire.z)) { assert.ok(isOnBridge(fire.x, fire.z, fire.radius)); crossedBridge++; }
    if (fire.x > riverCenterX(fire.z) + 1.25) warmBank++;
    if (isInRiver(water.x, water.z)) waterVisits++;
    if (frame % 30 === 0) validate(test);
  });
  assert.ok(crossedBridge > 0 && warmBank > 1000, 'A fire type independently routes across the bridge to the warm bank');
  assert.ok(waterVisits > 1800, 'A water type spends at least one third of its time in the stream');
}

for (const seed of [31, 92]) {
  const test = new EcologySimulation({ seed });
  const onix = test.add(entry('095', ['rock', 'ground']), 1.84, 4.452);
  assert.ok(onix);
  assert.equal(onix.radius, 1.84, 'Broad land bodies retain authored footprint clearance');
  assert.ok(test.add(entry('025', ['electric']), 0.22, 0.43));
  let movingFrames = 0;
  let reachedWestSun = false;
  advance(test, 120, (frame) => {
    if (onix.state === 'walking' && onix.speed > 0.1) movingFrames++;
    if (Math.hypot(onix.x + 5, onix.z - 5) < 2.5) reachedWestSun = true;
    if (frame % 15 === 0) validate(test);
    assert.ok(!isInRiver(onix.x, onix.z), 'An oversized land body never squeezes through the bridge');
  });
  assert.ok(movingFrames > 150, 'A broad Onix independently walks for more than five seconds');
  assert.ok(reachedWestSun, 'A broad sun-loving resident uses the reachable west-bank clearing');
}

const swimmerTest = new EcologySimulation({ seed: 130 });
for (const pokemon of [entry('129', ['water']), entry('130', ['water', 'flying'])]) {
  const swimmer = swimmerTest.add(pokemon, 0.64, 2);
  assert.ok(swimmer && Math.abs(swimmer.z) >= 2.5, 'Swimmers spawn in visible open water');
}
let underBridgeTransit = 0;
advance(swimmerTest, 180, () => {
  for (const swimmer of swimmerTest.agents) {
    if (swimmer.target) assert.ok(Math.abs(swimmer.target.z) >= 2.5, 'Swimming and meeting destinations remain outside the bridge');
    if (swimmer.state === 'socializing') assert.ok(Math.abs(swimmer.z) >= 2.5, 'Swimmers meet in open water');
    if (Math.abs(swimmer.z) < 1.2 && swimmer.state === 'walking') underBridgeTransit++;
  }
});
assert.ok(underBridgeTransit > 0, 'Swimmers can still transit beneath the bridge');

for (const seed of [1, 7, 29]) {
  const test = new EcologySimulation({ seed });
  test.setTimeOfDay('dusk');
  for (const pokemon of [entry('025', ['electric']), entry('026', ['electric']), entry('025', ['electric']), entry('001', ['grass'])]) assert.ok(test.add(pokemon));
  const firstSleeps = new Map();
  const previousSleep = new Map();
  let groupFrames = 0;
  advance(test, 180, (frame) => {
    if (frame % 30 === 0) validate(test);
    const sleepers = test.agents.filter((agent) => agent.state === 'sleeping');
    for (const agent of test.agents) {
      const prior = previousSleep.get(agent.uid);
      if (agent.state === 'sleeping') {
        if (!firstSleeps.has(agent.uid)) firstSleeps.set(agent.uid, test.elapsed);
        previousSleep.set(agent.uid, { start: test.elapsed - agent.stateTime, minimum: agent.sleepDuration });
      } else if (prior) {
        assert.ok(test.elapsed - prior.start >= prior.minimum - 1 / 30, 'Natural wake respects minimum sleep duration');
        previousSleep.delete(agent.uid);
      }
    }
    for (const a of sleepers) for (const b of sleepers) {
      if (a.uid >= b.uid || a.profile.familyId !== b.profile.familyId) continue;
      if (a.sleepGroupUid === b.sleepGroupUid && Math.hypot(a.x - b.x, a.z - b.z) < a.radius + b.radius + 2.6) groupFrames++;
    }
  });
  assert.equal(firstSleeps.size, 4, 'Every day-active resident eventually chooses sleep at dusk');
  const starts = [...firstSleeps.values()];
  assert.ok(Math.min(...starts) > 10 && Math.min(...starts) < 90, 'Sleep emerges soon after dusk, without an instant mass transition');
  assert.ok(Math.max(...starts) - Math.min(...starts) > 2, 'Individual rhythms spread out bedtime');
  assert.ok(groupFrames > 90, 'Same-family residents naturally converge and sleep together');
}

for (const seed of [1, 7, 29]) {
  const test = new EcologySimulation({ seed });
  const agent = test.add(entry('025', ['electric']));
  let walkFrames = 0, runFrames = 0, walkDistance = 0, runDistance = 0, napFrames = 0;
  let previous = { x: agent.x, z: agent.z };
  advance(test, 300, (frame) => {
    if (frame % 30 === 0) validate(test);
    const moved = Math.hypot(agent.x - previous.x, agent.z - previous.z);
    if (agent.state === 'walking' && moved > 1e-6) {
      assert.ok(Math.abs(moved * 30 - agent.speed) < 1e-7, 'Reported gait speed matches real movement');
      const movingHeading = Math.atan2(agent.x - previous.x, agent.z - previous.z);
      assert.ok(Math.abs(Math.atan2(Math.sin(movingHeading - agent.heading), Math.cos(movingHeading - agent.heading))) < 1e-7, 'Position follows the displayed heading without sideways sliding');
      const nominal = agent.gait === 'run' ? agent.profile.runSpeed : agent.profile.moveSpeed;
      assert.ok(Math.abs(agent.animationRate - agent.speed / nominal) < 1e-7, 'Animation playback follows the actual gait speed');
      if (agent.speed > 0.2) {
        if (agent.gait === 'run') { runFrames++; runDistance += moved; }
        else { walkFrames++; walkDistance += moved; }
      }
    }
    if (agent.state === 'sleeping') napFrames++;
    previous = { x: agent.x, z: agent.z };
  });
  assert.ok(runFrames > 60 && walkFrames > 300, 'Exploration naturally exercises both walking and running');
  assert.ok(runDistance / runFrames > walkDistance / walkFrames * 1.4, 'Actual running speed is meaningfully faster than actual walking');
  assert.ok(napFrames > 150, 'Daytime fatigue eventually produces a real nap');
}

const quietTest = new EcologySimulation({ seed: 1 });
const noRunEntry = entry('025', ['electric']);
noRunEntry.animations = noRunEntry.animations.filter((clip) => clip.name !== 'run');
const walker = quietTest.add(noRunEntry);
assert.equal(walker.profile.runSpeed, walker.profile.moveSpeed);
advance(quietTest, 90, () => assert.equal(walker.gait, 'walk', 'A model without a run clip never selects the running gait'));

const wakeTest = new EcologySimulation({ seed: 7 });
wakeTest.setTimeOfDay('dusk');
const sleeper = wakeTest.add(entry('025', ['electric']));
for (let frame = 0; frame < 2700 && sleeper.state !== 'sleeping'; frame++) wakeTest.update(1 / 30);
assert.equal(sleeper.state, 'sleeping', 'A sleeper is reached without changing its state or energy artificially');
const minimum = sleeper.sleepDuration;
wakeTest.setTimeOfDay('dawn');
advance(wakeTest, Math.floor(minimum - 1), () => assert.equal(sleeper.state, 'sleeping', 'Dawn preserves the minimum sleep interval'));
advance(wakeTest, 8);
assert.notEqual(sleeper.state, 'sleeping', 'Dawn wakes a rested resident after its minimum sleep');

const sleepRemoval = new EcologySimulation({ seed: 29 });
sleepRemoval.setTimeOfDay('dusk');
for (const id of ['025', '026', '025']) assert.ok(sleepRemoval.add(entry(id, ['electric'])));
let removedGroupAnchor = false;
for (let frame = 0; frame < 5400 && !removedGroupAnchor; frame++) {
  sleepRemoval.update(1 / 30);
  const sleepers = sleepRemoval.agents.filter((agent) => agent.state === 'sleeping');
  const anchor = sleepers.find((agent) => sleepers.some((other) => other !== agent && other.sleepGroupUid === agent.uid));
  if (!anchor) continue;
  assert.ok(sleepRemoval.remove(anchor.uid));
  validate(sleepRemoval);
  const remainingSleeper = sleepRemoval.agents.find((agent) => agent.state === 'sleeping');
  assert.ok(remainingSleeper);
  assert.ok(sleepRemoval.pet(remainingSleeper.uid));
  assert.equal(remainingSleeper.state, 'happy', 'Petting wakes a sleeper immediately into its happy action');
  assert.equal(remainingSleeper.sleepGroupUid, null);
  assert.ok(remainingSleeper.lastWakeAt > 0);
  removedGroupAnchor = true;
}
assert.ok(removedGroupAnchor, 'A natural sleeping group can lose its anchor safely');
advance(sleepRemoval, 30, () => validate(sleepRemoval));
sleepRemoval.reset();
assert.equal(sleepRemoval.snapshot().sleeping, 0);
assert.equal(sleepRemoval.agents.length, 0);

const varietyTest = new EcologySimulation({ seed: 7 });
for (const id of ['025', '026', '025', '133']) assert.ok(varietyTest.add(entry(id, ['electric'])));
const partnersSeen = new Map();
const encounterStarts = new Map();
const activePairs = new Set();
advance(varietyTest, 300, () => {
  const thisFramePairs = new Set();
  for (const agent of varietyTest.agents) {
    if (agent.state !== 'socializing' || !agent.partnerUid) continue;
    const pair = [agent.uid, agent.partnerUid].sort().join(':');
    thisFramePairs.add(pair);
    const partners = partnersSeen.get(agent.uid) ?? new Set();
    partners.add(agent.partnerUid);
    partnersSeen.set(agent.uid, partners);
    if (agent.uid > agent.partnerUid || activePairs.has(pair)) continue;
    const lastStart = encounterStarts.get(pair);
    if (lastStart !== undefined) assert.ok(varietyTest.elapsed - lastStart > 21, 'The same pair has time to do other things between conversations');
    encounterStarts.set(pair, varietyTest.elapsed);
  }
  activePairs.clear();
  for (const pair of thisFramePairs) activePairs.add(pair);
});
assert.ok([...partnersSeen.values()].filter((partners) => partners.size >= 2).length >= 2, 'Recent-partner memory allows natural partner variety');

console.log(`Ecology: ${sim.capacity}-agent invariants, sourced families, authored proportions, terrain and body clearance, independent walk/run speeds, daytime naps, staggered dusk/group sleep, wake/pet/remove hysteresis, bridge transit, social variety and deterministic reset passed.`);
