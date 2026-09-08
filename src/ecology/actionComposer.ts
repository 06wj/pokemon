import type { EcologyAgent } from './simulation.ts';
import type { EcologyPoint } from './layout.ts';
import type { LivingAnimation, LivingBubble, LivingEffect } from './livingTypes.ts';
import { LIVING_TUNING } from './livingContent.ts';

export interface LivingStep {
  id: string;
  kind: 'move' | 'face' | 'pose';
  label: string;
  animation: LivingAnimation;
  duration: number;
  point?: EcologyPoint;
  bubble?: LivingBubble;
  effect?: LivingEffect;
  effectAt?: number;
  reach?: number;
}

export interface ComposedAction {
  id: string;
  kind: string;
  main: boolean;
  steps: LivingStep[];
  step: number;
  stepTime: number;
  elapsed: number;
  entered: boolean;
  fired: boolean;
  meta: { fruitId?: number; sourceUid?: string; ate?: boolean; water?: boolean; nap?: boolean; reactionKind?: string; reactionRecorded?: boolean };
}

export interface ComposerHost {
  moveTo(agent: EcologyAgent, point: EcologyPoint, label: string, run: boolean): boolean;
  move(agent: EcologyAgent, dt: number): void;
  pose(agent: EcologyAgent, label: string, animation: LivingAnimation): void;
  effect(agent: EcologyAgent, action: ComposedAction, step: LivingStep): boolean;
}

const separation = (a: EcologyPoint, b: EcologyPoint): number => Math.hypot(a.x - b.x, a.z - b.z);
const angleDifference = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Advances at most one authored step per tick. Effects happen exactly once,
 * after spatial checks; animation length and renderer frame rate cannot fire them. */
export function advanceAction(agent: EcologyAgent, action: ComposedAction, dt: number, host: ComposerHost): 'running' | 'done' | 'cancelled' {
  const step = action.steps[action.step];
  if (!step) return 'done';
  action.elapsed += dt;
  if (action.elapsed > LIVING_TUNING.actionTimeout) return 'cancelled';
  if (!action.entered) {
    action.entered = true; action.stepTime = 0; action.fired = false;
    if (step.kind === 'move') {
      if (!step.point || !host.moveTo(agent, step.point, step.label, step.animation === 'run')) return 'cancelled';
    } else host.pose(agent, step.label, step.animation);
  }
  action.stepTime += dt;
  if (step.kind === 'move') host.move(agent, dt);
  let facing = true;
  if (step.point && step.kind !== 'move') {
    const target = Math.atan2(step.point.x - agent.x, step.point.z - agent.z);
    const difference = angleDifference(agent.heading, target);
    agent.heading += Math.max(-dt * 3.5, Math.min(dt * 3.5, difference));
    facing = Math.abs(angleDifference(agent.heading, target)) < 0.18;
  }
  const progress = Math.min(1, action.stepTime / Math.max(.01, step.duration));
  const effectAt = Math.max(0, Math.min(1, step.effectAt ?? .45));
  if (step.effect && !action.fired && progress >= effectAt) {
    if ((step.point && step.reach !== undefined && separation(agent, step.point) > step.reach) || !facing) return 'cancelled';
    if (!host.effect(agent, action, step)) return 'cancelled';
    action.fired = true;
  }
  agent.performance = {
    sequenceId: action.id, stepId: step.id, label: step.label,
    animation: step.kind === 'move' ? agent.gait : step.animation,
    bubble: step.kind === 'move' && action.stepTime > 1.8 ? null : step.bubble ?? null,
    effect: action.fired ? step.effect ?? null : null,
    effectProgress: action.fired && step.effect ? effectAt >= 1 ? 1 : Math.max(0, Math.min(1, (progress - effectAt) / (1 - effectAt))) : undefined,
    progress, duration: step.duration, target: step.point ? { x: step.point.x, z: step.point.z } : null,
  };
  const reached = step.point && separation(agent, step.point) <= .2;
  if (step.kind === 'move' && agent.state !== 'walking' && !reached) return 'cancelled';
  const finished = step.kind === 'move' ? reached && agent.path.length === 0
    : progress >= 1 && (step.kind !== 'face' || facing);
  if (step.kind === 'move' && action.stepTime > step.duration) return 'cancelled';
  if (finished) { action.step++; action.entered = false; }
  return action.step >= action.steps.length ? 'done' : 'running';
}
