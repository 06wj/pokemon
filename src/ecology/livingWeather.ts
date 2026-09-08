import { LIVING_TUNING as T } from './livingContent.ts';
import type { LivingWeather, LivingWorld } from './livingTypes.ts';

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/** Selecting weather changes intent only. Snow, water and all resident replies
 * advance later through the simulation's fixed steps, including after a pause. */
export function changeLivingWeather(state: LivingWorld['weather'], kind: LivingWeather, now: number): void {
  if (!['sunny', 'rain', 'snow'].includes(kind) || state.kind === kind) return;
  state.kind = kind;
  state.changedAt = now;
}

/** Returns newly melted snow for nearby ecological effects such as damp flowers.
 * Melt water outlasts the snow briefly; these values never damage residents. */
export function advanceLivingWeather(state: LivingWorld['weather'], dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  const before = state.snow;
  state.snow = state.kind === 'snow' ? clamp(before + dt / T.snowAccumulateSeconds)
    : clamp(before - dt / (state.kind === 'rain' ? T.rainMeltSeconds : T.sunnyMeltSeconds));
  const melted = Math.max(0, before - state.snow);
  if (state.kind === 'rain') state.wetness = clamp(state.wetness + dt / T.rainWetSeconds + melted);
  else if (state.kind === 'sunny') state.wetness = clamp(state.wetness - dt / T.sunnyDrySeconds + melted * 1.5);
  else state.wetness = clamp(state.wetness - dt / T.snowDrySeconds);
  return melted;
}
