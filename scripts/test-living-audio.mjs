import assert from 'node:assert/strict';
import { LivingAudio, LivingAudioScheduler, LIVING_AUDIO_LIMITS, spatializeLivingSound, livingFootstepSurface } from '../src/hilo/livingAudio.ts';
import { createLivingWorld } from '../src/ecology/livingTypes.ts';
import { riverCenterX } from '../src/ecology/layout.ts';

const camera = { x: 0, y: 8, z: 16, targetX: 0, targetZ: 0 };
const resident = (uid = 'one', effect = null, stepId = 'first') => ({ uid, pokemonId: '025', x: -3, y: 0, z: 3, height: .8, radius: .4, heading: 0, state: 'resting', speed: 0,
  performance: effect ? { sequenceId: `scene:${uid}`, stepId, effect, effectProgress: 0, animation: 'idle', progress: .5, duration: 2, label: '生活小戏', bubble: null, target: { x: -2, z: 3 } } : null });
const world = createLivingWorld();
const scheduler = new LivingAudioScheduler();
assert.deepEqual(scheduler.update(world, [resident('one', 'bite')], 0, camera), [], 'The first snapshot establishes state silently');
assert.deepEqual(scheduler.update(world, [resident('one', 'bite')], .1, camera), [], 'An already active effect is not replayed');
assert.deepEqual(scheduler.update(world, [resident('one', 'bite', 'second')], .2, camera).map((cue) => cue.kind), ['bite']);
assert.equal(scheduler.update(world, [resident('one', 'bite', 'second')], .3, camera).length, 0, 'Per-frame snapshots deduplicate sequence/step/effect');
assert.deepEqual(scheduler.update(world, [resident('one', 'electric', 'spark')], .4, camera).map((cue) => cue.kind), ['electric']);
const splash = scheduler.update(world, [resident('one', 'splash', 'water')], .5, camera);
assert.deepEqual(splash.map((cue) => cue.kind).sort(), ['splash', 'water-jet']);
assert.equal(splash.find((cue) => cue.kind === 'splash').delay, .16, 'Water impact follows the short jet');
const stale = resident('one', 'drink', 'old-drink'); stale.performance.effectProgress = .8;
assert.equal(scheduler.update(world, [stale], .6, camera).length, 0, 'Late effects do not catch up as unexpected sounds');
stale.performance.effectProgress = 0;
assert.equal(scheduler.update(world, [stale], .7, camera).length, 0);
assert.equal(scheduler.update(world, [resident('one', 'bite', 'muted')], .8, camera, false).length, 0);
assert.equal(scheduler.update(world, [resident('one', 'bite', 'muted')], .9, camera, true).length, 0, 'Unmuting synchronizes rather than replaying');
assert.equal(scheduler.update(world, [resident('one', 'bite', 'muted')], 1, camera, true).length, 0);
assert.equal(scheduler.update(world, [resident('one', 'bite', 'new')], 1.1, camera).length, 1);
assert.equal(scheduler.update(world, [resident('one', 'bite', 'after-hidden-gap')], 9, camera).length, 0, 'Large elapsed jumps rebase');
scheduler.reset();
assert.equal(scheduler.update(world, [], 0, camera).length, 0);
assert.equal(scheduler.update(world, [resident('one', 'bite', 'second')], .1, camera).length, 1, 'Reset permits reused simulation IDs in a genuinely new action');

const fruitScheduler = new LivingAudioScheduler(), fruitWorld = createLivingWorld();
fruitScheduler.update(fruitWorld, [], 0, camera);
fruitWorld.fruits.push({ id: 1, x: -3, z: 3, bornAt: 0, landedAt: .2, remaining: 1, eaterUid: null, source: 'tree' });
assert.equal(fruitScheduler.update(fruitWorld, [], .1, camera).length, 0, 'Falling fruit does not sound before landing');
assert.deepEqual(fruitScheduler.update(fruitWorld, [], .2, camera).map((cue) => cue.kind), ['fruit-land']);
fruitWorld.fruits[0].remaining = .5;
assert.equal(fruitScheduler.update(fruitWorld, [], .3, camera).length, 0, 'Fruit mesh/remaining updates do not repeat the landing');
fruitWorld.tree.shakeAt = .4;
assert.deepEqual(fruitScheduler.update(fruitWorld, [], .4, camera).map((cue) => cue.kind), ['leaves']);
assert.equal(fruitScheduler.update(fruitWorld, [], .5, camera).length, 0);
fruitWorld.flowers.rustleAt = .6;
assert.deepEqual(fruitScheduler.update(fruitWorld, [], .6, camera).map((cue) => cue.kind), ['leaves']);
assert.equal(livingFootstepSurface(-3, 3), 'step-grass');
assert.equal(livingFootstepSurface(15, 0), 'step-sand');
assert.equal(livingFootstepSurface(riverCenterX(5), 5), 'step-water');

const left = spatializeLivingSound({ x: -5, y: 0, z: 0 }, camera);
const right = spatializeLivingSound({ x: 5, y: 0, z: 0 }, camera);
assert.ok(left.pan < 0 && right.pan > 0);
assert.ok(spatializeLivingSound({ x: -5, y: 0, z: 0 }, { x: 0, y: 8, z: -16 }).pan > 0, 'Stereo follows an orbiting camera');
assert.ok(spatializeLivingSound({ x: 0, y: 0, z: 10 }, camera).gain > spatializeLivingSound({ x: 0, y: 0, z: -30 }, camera).gain);
assert.deepEqual(spatializeLivingSound({ x: 1000, y: 0, z: 0 }, camera), { gain: 0, pan: 0 });
assert.deepEqual(spatializeLivingSound({ x: NaN, y: 0, z: 0 }, camera), { gain: 0, pan: 0 });

const walkers = Array.from({ length: 20 }, (_, i) => ({ ...resident(String(i)), x: -8 + i * .05, state: 'walking', gait: 'run', speed: 3 }));
const footScheduler = new LivingAudioScheduler(); footScheduler.update(world, walkers, 0, camera);
const stepTimes = [];
for (let frame = 1; frame <= 100; frame++) {
  const at = frame / 30;
  for (const walker of walkers) walker.z += .1;
  const cues = footScheduler.update(world, walkers, at, camera);
  assert.ok(cues.length <= LIVING_AUDIO_LIMITS.cuesPerFrame);
  for (const cue of cues) if (cue.kind.startsWith('step-')) stepTimes.push(at);
  assert.ok(stepTimes.filter((time) => at - time < 1).length <= LIVING_AUDIO_LIMITS.footstepsPerSecond, 'Twenty walkers share a bounded footstep budget');
}
assert.ok(stepTimes.length > 5, 'Actual movement generates restrained footsteps');
const stationary = new LivingAudioScheduler(); stationary.update(world, walkers, 0, camera);
for (let i = 1; i < 20; i++) assert.equal(stationary.update(world, walkers, i / 30, camera).length, 0, 'Run animation without translation makes no footfall');
const floating = { ...resident('butterfly'), pokemonId: '012', state: 'walking', speed: 3 };
const flight = new LivingAudioScheduler(); flight.update(world, [floating], 0, camera);
for (let i = 1; i < 20; i++) { floating.x += .15; assert.equal(flight.update(world, [floating], i / 30, camera).length, 0); }

// A fake audio graph verifies ownership and source limits without creating a DOM or making sound.
class Param { value = 0; setValueAtTime(v) { this.value = v; } linearRampToValueAtTime(v) { this.value = v; } exponentialRampToValueAtTime(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } cancelScheduledValues() {} }
class Node { connections = []; connect(node) { this.connections.push(node); return node; } disconnect() { this.connections = []; } }
class Source extends Node {
  onended = null; frequency = new Param(); stoppedAt = Infinity; stopped = false;
  constructor(context) { super(); this.context = context; context.sources.push(this); }
  start() { this.started = true; }
  stop(at = this.context.currentTime) { this.stoppedAt = at; if (at <= this.context.currentTime) this.finish(); }
  finish() { if (this.stopped) return; this.stopped = true; this.onended?.(); }
}
class FakeContext {
  static created = 0; static last;
  state = 'suspended'; currentTime = 0; sampleRate = 8000; destination = new Node(); sources = [];
  constructor() { FakeContext.created++; FakeContext.last = this; }
  createGain() { return Object.assign(new Node(), { gain: new Param() }); }
  createStereoPanner() { return Object.assign(new Node(), { pan: new Param() }); }
  createBiquadFilter() { return Object.assign(new Node(), { frequency: new Param(), Q: new Param() }); }
  createDynamicsCompressor() { return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map((key) => [key, new Param()]))); }
  createBuffer(_channels, length) { const samples = new Float32Array(length); return { getChannelData() { return samples; } }; }
  createOscillator() { return new Source(this); }
  createBufferSource() { return new Source(this); }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
  advance(at) { this.currentTime = at; for (const source of this.sources) if (source.stoppedAt <= at) source.finish(); }
}
const oldContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
Object.defineProperty(globalThis, 'AudioContext', { value: FakeContext, configurable: true });
try {
  const audio = new LivingAudio();
  audio.update(world, [resident('one', 'bite')], 0, camera); audio.setPaused(true); audio.setPaused(false); audio.setEnabled(false); audio.setEnabled(true); audio.reset();
  assert.equal(FakeContext.created, 0, 'Constructor, updates and enable toggles cannot create an AudioContext');
  assert.equal(await audio.resumeFromGesture(), false, 'Calls without a user gesture do not unlock audio');
  assert.equal(FakeContext.created, 0);
  assert.equal(await audio.resumeFromGesture({ isTrusted: true }), true);
  await Promise.resolve();
  assert.equal(FakeContext.created, 1);
  audio.update(world, [], 0, camera);
  const noisy = Array.from({ length: 20 }, (_, i) => resident(`voice-${i}`, 'electric'));
  audio.update(world, noisy, .1, camera);
  assert.ok(audio.activeSources > 2 && audio.activeSources <= LIVING_AUDIO_LIMITS.sources);
  const beforeGesture = audio.activeSources;
  await audio.resumeFromGesture({ isTrusted: true });
  assert.equal(audio.activeSources, beforeGesture, 'Further gestures leave playing sounds intact');
  audio.setPaused(true);
  assert.equal(audio.activeSources, 0); assert.equal(FakeContext.last.state, 'suspended');
  audio.update(world, [resident('one', 'bite', 'paused')], .2, camera);
  audio.setPaused(false); await Promise.resolve(); await Promise.resolve();
  audio.update(world, [resident('one', 'bite', 'paused')], .3, camera);
  assert.ok(audio.activeSources <= 2, 'Resuming starts only quiet ambience, not missed effects');
  audio.update(world, [resident('one', 'bite', 'fresh')], .4, camera);
  assert.ok(audio.activeSources > 2);
  FakeContext.last.advance(2);
  assert.ok(audio.activeSources <= 2, 'Ended one-shots release their nodes');
  audio.setEnabled(false); assert.equal(audio.activeSources, 0);
  audio.setEnabled(true); await Promise.resolve(); await Promise.resolve();
  audio.update(world, [], .5, camera); audio.reset(); assert.equal(audio.activeSources, 0);
  audio.destroy(); assert.equal(FakeContext.last.state, 'closed'); assert.equal(audio.activeSources, 0);
  audio.update(world, noisy, .6, camera); audio.destroy(); assert.equal(FakeContext.created, 1);
} finally {
  if (oldContext) Object.defineProperty(globalThis, 'AudioContext', oldContext); else delete globalThis.AudioContext;
}
console.log('Living audio: gesture gating, effect/landing dedup, stereo falloff, shared footstep/source budgets, pause/no-catchup, reset and disposal passed without DOM or audible output.');
