import assert from 'node:assert/strict';
import { EcologySimulation } from '../src/ecology/simulation.ts';
import { LIVING_CAST } from '../src/ecology/livingTypes.ts';
import { LIVING_TUNING } from '../src/ecology/livingContent.ts';
import { COASTAL_LAYOUT, isInRiver } from '../src/ecology/layout.ts';
import { isTraversable } from '../src/ecology/navigation.ts';

const advance = (sim, seconds, observer = () => {}) => {
  for (let f = 0; f < Math.ceil(seconds * 30); f++) { sim.update(1 / 30); observer(f); }
};
const until = (sim, predicate, seconds) => {
  for (let f = 0; f < seconds * 30; f++) { sim.update(1 / 30); if (predicate()) return true; }
  return false;
};
const types = (id) => ['007', '054', '060', '079', '118', '129'].includes(id) ? ['water']
  : ['004', '037', '058'].includes(id) ? ['fire'] : ['001', '043'].includes(id) ? ['grass']
  : id === '012' ? ['bug', 'flying'] : id === '016' ? ['normal', 'flying'] : id === '092' ? ['ghost']
  : id === '025' ? ['electric'] : ['normal'];
const entry = (id) => ({ id, name: `伙伴 ${id}`, model: '', idleAnimation: 'idle', types: types(id),
  animations: ['idle', 'walk', 'run', 'attack', 'happy', 'sleep'].map((name) => ({ name, label: name })) });
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} / ${expected}`);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const climate = new EcologySimulation({ living: true, seed: 1 });
assert.deepEqual(climate.world.weather, { kind: 'sunny', wetness: 0, snow: 0, changedAt: 0 });
advance(climate, 3);
climate.setWeather('snow');
close(climate.world.weather.changedAt, 3, 'Weather change timestamps use simulation time');
assert.equal(climate.world.weather.snow, 0, 'Selecting snow never instantly coats the island');
assert.equal(climate.discoveries.length, 0, 'Selecting weather fabricates no discoveries');
advance(climate, 10);
close(climate.world.weather.snow, 10 / LIVING_TUNING.snowAccumulateSeconds, 'Snow builds gradually');
const frozen = JSON.stringify({ world: climate.world, elapsed: climate.elapsed });
for (let i = 0; i < 20; i++) { climate.update(0); climate.update(-1); climate.update(NaN); }
assert.equal(JSON.stringify({ world: climate.world, elapsed: climate.elapsed }), frozen, 'Paused or invalid updates cannot accumulate or melt snow');
const changedAt = climate.world.weather.changedAt;
climate.setWeather('snow');
assert.equal(climate.world.weather.changedAt, changedAt, 'Selecting the existing weather does not restart its transition');
advance(climate, 46);
assert.equal(climate.world.weather.snow, 1, 'Full snow coverage is reached after roughly fifty-five seconds');
assert.equal(climate.discoveries.length, 0, 'An empty scene does not invent residents observing the snow');

climate.setWeather('rain');
assert.equal(climate.world.weather.snow, 1, 'Switching to rain preserves the snow until simulation advances');
advance(climate, 20);
close(climate.world.weather.snow, .5, 'Rain melts half the snow in twenty seconds');
assert.ok(climate.world.weather.wetness > .8, 'Rain and melting snow leave the ground wet');
advance(climate, 21);
assert.equal(climate.world.weather.snow, 0, 'Rain finishes melting a full layer in roughly forty seconds');
climate.setWeather('sunny');
const wetBefore = climate.world.weather.wetness;
advance(climate, 20);
assert.ok(climate.world.weather.wetness > 0 && climate.world.weather.wetness < wetBefore, 'Sunshine dries wet ground gradually');

climate.setWeather('snow');
advance(climate, 56);
climate.reset();
assert.equal(climate.elapsed, 0);
assert.deepEqual(climate.world.weather, { kind: 'snow', wetness: 0, snow: 0, changedAt: 0 }, 'Reset preserves selected weather while clearing coverage and dampness');
advance(climate, 56);
climate.setWeather('sunny');
advance(climate, 50);
close(climate.world.weather.snow, .5, 'Sunshine takes about twice as long as rain to melt a full layer');
advance(climate, 51);
assert.equal(climate.world.weather.snow, 0);
assert.ok(climate.world.weather.wetness > .1, 'Recently melted snow leaves a damp surface even in sunshine');
advance(climate, 80);
assert.equal(climate.world.weather.wetness, 0, 'Residual melt water eventually dries');

// Weather can change between bites, but it does not cancel, refund or duplicate
// the ongoing food action. A resident considers shelter after finishing it.
const meal = new EcologySimulation({ living: true, seed: 2 });
meal.world.tree.mature = 0;
const eater = meal.add(entry('052'), .24, .8);
Object.assign(eater, { x: -7.2, z: 1.5, age: 10, state: 'resting', decisionIn: 20 });
eater.needs.hunger = .95;
meal.intervene('fruit', { x: -6.95, z: 2.2 });
const fruit = meal.world.fruits[0];
assert.ok(until(meal, () => fruit.remaining === .5, 30));
const sequence = eater.performance.sequenceId;
const position = { x: eater.x, z: eater.z };
const discoveryCount = meal.discoveries.length;
meal.setWeather('rain'); meal.setWeather('snow');
assert.equal(eater.performance.sequenceId, sequence, 'The same eating action survives a weather selection');
assert.equal(fruit.eaterUid, eater.uid);
assert.equal(fruit.remaining, .5);
assert.deepEqual({ x: eater.x, z: eater.z }, position, 'Weather selection never teleports a resident to shelter');
assert.equal(meal.discoveries.length, discoveryCount);
assert.ok(until(meal, () => fruit.remaining === 0, 5), 'The remaining bite finishes before new weather behavior is considered');
meal.reset();
assert.equal(eater.performance, null);
assert.deepEqual(meal.world.weather, { kind: 'snow', snow: 0, wetness: 0, changedAt: 0 });

for (const kind of ['sunny', 'rain', 'snow']) {
  const sim = new EcologySimulation({ living: true, seed: 7 });
  for (const id of LIVING_CAST) assert.ok(sim.add(entry(id), id === '143' ? .72 : .3, id === '143' ? 1.8 : .8));
  const before = sim.agents.map((a) => ({ uid: a.uid, x: a.x, z: a.z, state: a.state }));
  sim.setWeather(kind);
  assert.deepEqual(sim.agents.map((a) => ({ uid: a.uid, x: a.x, z: a.z, state: a.state })), before, 'Weather never locks the whole cast into an instant response');
  assert.equal(sim.discoveries.length, 0);
  const seenDiscoveries = new Set(); const actionStarted = new Map(); const kinds = new Set();
  let sleepers = 0;
  advance(sim, 300, (frame) => {
    const active = new Set(); let responders = 0;
    for (const agent of sim.agents) {
      if (agent.state === 'sleeping') sleepers++;
      if (agent.performance) {
        const id = agent.performance.sequenceId, actionKind = id.split(':')[0];
        active.add(id); kinds.add(actionKind);
        if (!actionStarted.has(id)) actionStarted.set(id, sim.elapsed);
        assert.ok(sim.elapsed - actionStarted.get(id) <= LIVING_TUNING.actionTimeout + 1, 'Weather response sequences always complete or cancel');
        if (['weatherShelter', 'weatherExplore', 'fireGather'].includes(actionKind)) responders++;
      }
      if (frame % 15 === 0) {
        assert.ok(isTraversable(agent, agent.radius, agent.profile.locomotion), `${kind}: ${agent.pokemonId} remains on valid terrain`);
        assert.ok(Object.values(agent.needs).every((n) => Number.isFinite(n) && n >= 0 && n <= 1));
        if (agent.profile.locomotion === 'aquatic') assert.ok(isInRiver(agent.x, agent.z), 'Aquatic residents continue their water-bound lives');
        for (const other of sim.agents) if (agent.uid < other.uid) assert.ok(distance(agent, other) >= agent.radius + other.radius + .039, 'Weather routes preserve full body clearance');
      }
    }
    for (const id of actionStarted.keys()) if (!active.has(id)) actionStarted.delete(id);
    if (kind !== 'sunny') assert.ok(responders <= LIVING_TUNING.maxWeatherResponders, 'Weather draws only a few simultaneous responses');
    const w = sim.world.weather;
    assert.ok(Number.isFinite(w.snow) && w.snow >= 0 && w.snow <= 1);
    assert.ok(Number.isFinite(w.wetness) && w.wetness >= 0 && w.wetness <= 1);
    assert.ok(sim.world.fruits.length <= 6 && sim.discoveries.length <= 128);
    for (const d of sim.discoveries) {
      if (seenDiscoveries.has(d.id)) continue;
      seenDiscoveries.add(d.id);
      if (d.id.includes('rain-shelter')) {
        assert.equal(kind, 'rain');
        const resident = sim.agents.find((a) => a.uid === d.participantUids[0]);
        assert.ok(resident && COASTAL_LAYOUT.obstacles.some((tree) => tree.kind === 'tree'
          && distance(resident, tree) <= tree.radius + resident.radius + 1.1), 'Shelter discoveries require actual arrival beneath a tree');
      }
      if (d.id.includes('snow-day')) {
        assert.equal(kind, 'snow');
        assert.ok(w.snow >= LIVING_TUNING.snowDiscoveryCoverage, 'Snow moments require a real visible layer');
        assert.equal(d.participantUids.length, 1);
      }
    }
  });
  assert.ok(sleepers > 100, 'Residents still have ordinary quiet rest in every weather');
  if (kind === 'rain') assert.ok(sim.discoveries.some((d) => d.id.includes('rain-shelter')), 'Some residents autonomously complete a shelter visit');
  if (kind === 'snow') assert.ok(sim.discoveries.some((d) => d.id === 'moment:snow-day'), 'Snow coverage and an actual resident response form a stable moment');
  if (kind !== 'sunny') assert.ok(kinds.has('weatherExplore'), 'Some playful residents choose to watch the weather outside');
  sim.reset();
  assert.deepEqual(sim.world.weather, { kind, wetness: 0, snow: 0, changedAt: 0 });
}

console.log('Living weather: progressive snow, paused freezing, rain/sun melt, lingering wetness, non-interrupting meals, real shelter and snow discoveries, selected-weather reset and twenty-resident terrain/body invariants passed.');
