import type { Animation, AnimationClip } from 'hilo3d';

export function findAnimationClip(animation: Animation | undefined, name: string): AnimationClip | undefined {
  return animation?.clips.find((clip) => clip.name === name);
}

/** Controllers own the clock. pause() unenrolls automatic ticking; update()
 * still evaluates manually. stop(true) restores channels omitted by a new clip. */
export function playAnimationClip(animation: Animation, name: string | undefined, loop = true): void {
  animation.stop(true);
  animation.play(name, { loop });
  animation.pause();
  animation.update(0);
}
