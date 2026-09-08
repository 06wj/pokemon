import type { EcologyAgent } from '../ecology/simulation.ts';

export interface LivingMotion {
  pitch: number; roll: number; yaw: number; breathing: number;
  heading: number | null;
}

export const createLivingMotion = (): LivingMotion => ({ pitch: 0, roll: 0, yaw: 0, breathing: 1, heading: null });
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));
const pulse = (progress: number): number => Math.sin(clamp(progress, 0, 1) * Math.PI);

/** Small, additive body gestures, below the authored skeleton. They never move
 * the navigation footprint or drive an effect; paused poses remain exact. */
export function updateLivingMotion(agent: EcologyAgent, dt: number, out: LivingMotion): void {
  if (dt <= 0) return;
  const p = agent.performance;
  const phase = Number(agent.pokemonId) * .731;
  const angular = out.heading === null ? 0
    : Math.atan2(Math.sin(agent.heading - out.heading), Math.cos(agent.heading - out.heading)) / dt;
  out.heading = agent.heading;
  let pitch = 0, roll = 0, yaw = 0, breathing = 1;
  if (agent.state === 'sleeping') {
    breathing = 1 + Math.sin(agent.age * 1.35 + phase) * .005;
  } else if (agent.state === 'walking') {
    // Banking stays small enough for feet, bridge clearance and species ratios.
    roll = clamp(-angular * .8, -2.4, 2.4) * Math.min(1, agent.speed / .5);
    pitch = agent.gait === 'run' ? 1.1 * Math.min(1, agent.speed) : .25;
  } else if (p) {
    const envelope = pulse(p.progress);
    if (/smell|sniff|inspect|drink/.test(p.stepId)) pitch = envelope * 3.2;
    if (/charge|prepare|breath|itchy/.test(p.stepId)) pitch = -envelope * 1.8;
    if (p.effect === 'bite') pitch = Math.sin((p.effectProgress ?? p.progress) * Math.PI * 2) * 1.25;
    if (p.effect === 'ignite' || p.effect === 'splash' || p.effect === 'electric') {
      pitch = -pulse(p.effectProgress ?? p.progress) * (p.effect === 'electric' ? 1.3 : 2.3);
    }
    if (p.effect === 'pollen') pitch = Math.sin((p.effectProgress ?? p.progress) * Math.PI * 2) * 2;
    if (p.bubble === 'surprised' && p.animation === 'idle') pitch = -envelope * 2.2;
    if (/settle|getting-sleepy|shelter-rest/.test(p.stepId)) pitch = envelope * 1.2;
  } else if (agent.state === 'resting') {
    // An occasional unhurried glance belongs only to idle time: aiming and
    // partner-facing sequences retain their actual simulation heading.
    const glance = (agent.age + phase) % 13;
    if (glance < 2.8 && agent.stateTime > 1) yaw = Math.sin(glance / 2.8 * Math.PI * 2) * 4.5;
    pitch = Math.sin(agent.age * 1.6 + phase) * .3;
  }
  const blend = 1 - Math.exp(-dt * 10);
  out.pitch += (pitch - out.pitch) * blend;
  out.roll += (roll - out.roll) * blend;
  out.yaw += (yaw - out.yaw) * blend;
  out.breathing += (breathing - out.breathing) * blend;
}

/** Simulation-time envelope rather than CSS time, so bubbles also freeze. */
export function livingBubbleEnvelope(age: number, lifetime: number): { opacity: number; scale: number; rise: number } {
  const fadeIn = clamp(age / .2, 0, 1);
  const fadeOut = clamp((lifetime - age) / .38, 0, 1);
  return { opacity: fadeIn * fadeOut, scale: .86 + fadeIn * .14, rise: Math.min(2, Math.max(0, age) * .85) };
}
