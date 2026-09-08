import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
try {
  const { createLivingMotion, updateLivingMotion, livingBubbleEnvelope } = await server.ssrLoadModule('/src/hilo/livingMotion.ts');
  const { EcologySimulation } = await server.ssrLoadModule('/src/ecology/simulation.ts');
  const { pokemon } = await server.ssrLoadModule('/src/content/pokemon.ts');
  const sim = new EcologySimulation({ living: true });
  const walker = sim.add(pokemon.find(p => p.id === '025'), .24, 1);
  const sleeper = sim.add(pokemon.find(p => p.id === '001'), .3, 1);
  assert.ok(walker && sleeper);
  Object.assign(walker, { x: -5, z: 3, heading: Math.PI / 2, age: 20, state: 'walking', stateTime: 1,
    preferredGait: 'run', speed: 0, path: [{ x: -2, z: 3 }], target: { x: -2, z: 3 }, performance: null });
  Object.assign(sleeper, { x: -4.5, z: 4.9, state: 'sleeping', path: [], target: null });
  for (let i = 0; i < 20; i++) sim.move(walker, 1 / 30);
  assert.equal(walker.quietSteps, true, 'A nearby sleeper makes the resident step gently before physical crowding');
  assert.equal(walker.gait, 'walk', 'Running is suppressed beside a sleeping companion');
  assert.ok(walker.speed > .05, 'Quiet steps do not freeze a legal path');
  assert.ok(walker.speed <= walker.profile.moveSpeed * .63);
  assert.equal(sleeper.state, 'sleeping', 'A quiet passer-by does not wake the sleeper');

  const motion = createLivingMotion();
  walker.state = 'resting'; walker.stateTime = 4;
  for (let i = 0; i < 180; i++) { walker.age += 1 / 60; updateLivingMotion(walker, 1 / 60, motion); }
  const frozen = { ...motion };
  walker.heading += 1; walker.age += 10;
  updateLivingMotion(walker, 0, motion);
  assert.deepEqual(motion, frozen, 'Paused gestures and breath are exactly frozen');
  walker.performance = { sequenceId: 'water', stepId: 'aim-flowers', animation: 'idle', bubble: null,
    effect: null, progress: .5, duration: 2, target: { x: 0, z: 0 } };
  for (let i = 0; i < 90; i++) updateLivingMotion(walker, 1 / 60, motion);
  assert.ok(Math.abs(motion.yaw) < .001, 'Casual glances settle before a directed effect aims');
  walker.state = 'sleeping'; walker.performance = null;
  for (let i = 0; i < 300; i++) {
    walker.age += 1 / 60; updateLivingMotion(walker, 1 / 60, motion);
    assert.ok(motion.breathing >= .994 && motion.breathing <= 1.006, 'Sleeping breath preserves authored proportions');
    assert.ok(Object.values(motion).every(Number.isFinite));
  }
  assert.equal(livingBubbleEnvelope(0, 3).opacity, 0);
  assert.equal(livingBubbleEnvelope(1, 3).opacity, 1);
  assert.equal(livingBubbleEnvelope(3, 3).opacity, 0, 'Bubbles enter and disappear without wall-clock CSS animations');
  console.log('Living motion: quiet passing, continued legal movement, pause, directed aiming, restrained breath and bubble lifetime passed.');
} finally { await server.close(); }
