import * as Hilo3d from 'hilo3d';
import {
  ParticleCurve,
  ParticleSystemDefinition,
  type ParticleColor,
  type ParticleEmitterDefinitionInput,
  type ParticleModule,
  type ParticleStageRuntime,
  type ParticleSystem,
  type ParticleVector3,
} from '@hilo/addon-particle';
import type { HabitatKey } from '../content/habitats';

type SpriteKind = 'glow' | 'leaf' | 'bubble' | 'glint' | 'ember' | 'ash'
  | 'snow' | 'crystal' | 'arc' | 'wind' | 'star' | 'wisp';
type Range = readonly [number, number];

interface Layer {
  sprite: SpriteKind;
  capacity: number;
  rate: number;
  color: ParticleColor;
  size: Range;
  lifetime: Range;
  position: ParticleVector3;
  spread: ParticleVector3;
  direction: ParticleVector3;
  speed: Range;
  drift: ParticleVector3;
  rotation?: Range;
  spin?: number;
  opaque?: boolean;
}

const layers: Record<HabitatKey, readonly Layer[]> = {
  grove: [
    { sprite: 'glow', capacity: 28, rate: 3.5, color: [1.65, 1.9, 0.45, 0.7], size: [0.09, 0.17], lifetime: [7, 9], position: [0, 1.35, 0], spread: [5.8, 2.3, 4.6], direction: [1, 0, 0.08], speed: [0.035, 0.065], drift: [0.07, 0, 0.04] },
    { sprite: 'leaf', capacity: 9, rate: 1.1, color: [0.56, 0.73, 0.21, 0.74], size: [0.14, 0.23], lifetime: [7, 9], position: [0, 3.3, 0], spread: [5.8, 0.6, 4.5], direction: [0.45, -1, 0.06], speed: [0.24, 0.34], drift: [0.05, 0.01, 0.025], rotation: [-0.55, 0.2], spin: 0.55, opaque: true },
  ],
  lagoon: [
    { sprite: 'bubble', capacity: 44, rate: 6, color: [0.55, 1.15, 1.4, 0.72], size: [0.1, 0.23], lifetime: [5, 7], position: [0, 0.15, 0], spread: [5.2, 0.3, 4.4], direction: [0.04, 1, 0], speed: [0.28, 0.48], drift: [0.22, 0.06, 0.2] },
    { sprite: 'glint', capacity: 28, rate: 6, color: [0.75, 1.75, 2.1, 0.62], size: [0.14, 0.24], lifetime: [3, 4], position: [0, 0.12, 0], spread: [5.8, 0.15, 4.8], direction: [1, 0.08, 0], speed: [0.03, 0.1], drift: [0.1, 0.04, 0.08] },
  ],
  caldera: [
    { sprite: 'ember', capacity: 34, rate: 6, color: [2.4, 0.76, 0.13, 0.8], size: [0.09, 0.18], lifetime: [4.5, 5.5], position: [0, 0.15, 0], spread: [5.6, 0.3, 4.6], direction: [0.22, 1, 0.06], speed: [0.36, 0.55], drift: [0.04, 0.02, 0.025], spin: 0.15 },
    { sprite: 'ash', capacity: 6, rate: 1, color: [0.7, 0.55, 0.43, 0.4], size: [0.09, 0.16], lifetime: [5, 6], position: [0, 0.5, 0], spread: [5.6, 0.8, 4.6], direction: [0.22, 1, 0.06], speed: [0.24, 0.36], drift: [0.035, 0.015, 0.02], spin: 0.3, opaque: true },
  ],
  glacier: [
    { sprite: 'snow', capacity: 40, rate: 5.5, color: [0.82, 1.15, 1.4, 0.77], size: [0.1, 0.2], lifetime: [6, 8], position: [0, 3.6, 0], spread: [6, 0.5, 4.8], direction: [0.08, -1, 0], speed: [0.32, 0.45], drift: [0.025, 0.01, 0.02], spin: 0.25 },
    { sprite: 'crystal', capacity: 8, rate: 0.9, color: [0.66, 1.4, 1.8, 0.54], size: [0.13, 0.22], lifetime: [7, 9], position: [0, 2.8, 0], spread: [5.6, 1.2, 4.6], direction: [0.08, -1, 0], speed: [0.22, 0.3], drift: [0.015, 0.01, 0.01], spin: 0.15 },
  ],
  storm: [
    { sprite: 'arc', capacity: 2, rate: 1.1, color: [2.7, 1.95, 0.72, 0.85], size: [0.28, 0.4], lifetime: [0.4, 0.65], position: [0, 1.65, 0], spread: [5.6, 2.8, 4.6], direction: [1, 0.04, 0.05], speed: [0.04, 0.08], drift: [0, 0, 0], rotation: [-0.1, 0.1] },
    { sprite: 'wind', capacity: 22, rate: 5, color: [1.05, 1.1, 1.25, 0.42], size: [0.2, 0.36], lifetime: [3.5, 4.5], position: [-1, 1.5, 0], spread: [5.2, 3.3, 4.8], direction: [1, 0.04, 0.05], speed: [0.45, 0.65], drift: [0.025, 0.01, 0.015], rotation: [-0.08, 0.08] },
  ],
  astral: [
    { sprite: 'star', capacity: 26, rate: 3.2, color: [1.35, 1.1, 2.25, 0.67], size: [0.11, 0.2], lifetime: [7, 9], position: [0, 1.6, 0], spread: [5.8, 2.8, 4.6], direction: [0.55, 1, 0.08], speed: [0.05, 0.09], drift: [0.025, 0.015, 0.015], spin: 0.12 },
    { sprite: 'wisp', capacity: 6, rate: 0.8, color: [0.9, 0.6, 1.9, 0.38], size: [0.17, 0.25], lifetime: [7, 8], position: [0, 0.85, 0], spread: [5.6, 1.2, 4.6], direction: [0.55, 1, 0.08], speed: [0.07, 0.11], drift: [0.03, 0.02, 0.02], spin: 0.2 },
  ],
};

function paintSprite(kind: SpriteKind): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建栖息地特效纹理。');
  context.translate(64, 64);
  context.strokeStyle = 'white';
  context.fillStyle = 'white';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const glow = (radius: number, intensity: number): void => {
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStop(0, `rgba(255,255,255,${intensity})`);
    gradient.addColorStop(0.28, `rgba(255,255,255,${intensity * 0.5})`);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(-64, -64, 128, 128);
    context.fillStyle = 'white';
  };
  const line = (points: readonly (readonly [number, number])[], width: number): void => {
    context.beginPath();
    points.forEach(([x, y], index) => {
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.lineWidth = width;
    context.stroke();
  };
  const star = (): void => {
    context.beginPath();
    for (let index = 0; index < 8; index += 1) {
      const angle = index * Math.PI / 4;
      const radius = index % 2 === 0 ? 52 : 8;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.fill();
  };

  switch (kind) {
    case 'glow':
      glow(60, 0.8);
      context.beginPath();
      context.arc(0, 0, 9, 0, Math.PI * 2);
      context.fill();
      break;
    case 'leaf':
      context.beginPath();
      context.moveTo(-35, 44);
      context.bezierCurveTo(-44, -3, -9, -47, 38, -45);
      context.bezierCurveTo(50, -7, 7, 39, -35, 44);
      context.fill();
      context.strokeStyle = 'rgba(95,112,72,.65)';
      line([[-36, 45], [3, -3], [34, -39]], 3);
      line([[-2, 2], [-21, -10]], 2);
      line([[10, -13], [28, -10]], 2);
      break;
    case 'bubble': {
      const gradient = context.createRadialGradient(-12, -13, 2, 0, 0, 45);
      gradient.addColorStop(0, 'rgba(255,255,255,0)');
      gradient.addColorStop(0.78, 'rgba(255,255,255,.015)');
      gradient.addColorStop(0.97, 'rgba(255,255,255,.7)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = gradient;
      context.fillRect(-48, -48, 96, 96);
      context.beginPath();
      context.arc(0, 0, 39, Math.PI * 1.12, Math.PI * 1.55);
      context.lineWidth = 5;
      context.stroke();
      break;
    }
    case 'glint':
      glow(56, 0.23);
      context.scale(1, 0.38);
      star();
      break;
    case 'ember':
      glow(50, 0.36);
      context.beginPath();
      context.ellipse(0, 0, 7, 42, 0.3, 0, Math.PI * 2);
      context.fill();
      break;
    case 'ash':
      context.beginPath();
      context.moveTo(-22, -31);
      context.lineTo(21, -18);
      context.lineTo(33, 11);
      context.lineTo(-7, 31);
      context.lineTo(-30, 8);
      context.closePath();
      context.fill();
      break;
    case 'snow':
      glow(53, 0.14);
      for (let arm = 0; arm < 6; arm += 1) {
        context.save();
        context.rotate(arm * Math.PI / 3);
        line([[0, 0], [0, -48]], 4);
        line([[-11, -34], [0, -24], [11, -34]], 3);
        context.restore();
      }
      break;
    case 'crystal':
      glow(58, 0.17);
      context.fillStyle = 'rgba(255,255,255,.2)';
      context.beginPath();
      context.moveTo(0, -51);
      context.lineTo(26, 0);
      context.lineTo(0, 51);
      context.lineTo(-26, 0);
      context.closePath();
      context.fill();
      context.lineWidth = 3;
      context.stroke();
      line([[0, -51], [0, 51]], 2);
      line([[-26, 0], [26, 0]], 2);
      break;
    case 'arc':
      context.shadowColor = 'white';
      context.shadowBlur = 9;
      line([[-51, 18], [-31, -6], [-13, 9], [4, -24], [17, -7], [48, -35]], 3.5);
      line([[-13, 9], [-2, 27], [16, 20]], 2);
      break;
    case 'wind': {
      const gradient = context.createLinearGradient(-55, 0, 55, 0);
      gradient.addColorStop(0, 'rgba(255,255,255,0)');
      gradient.addColorStop(0.4, 'rgba(255,255,255,.45)');
      gradient.addColorStop(0.85, 'rgba(255,255,255,.9)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      context.strokeStyle = gradient;
      context.beginPath();
      context.moveTo(-56, 16);
      context.bezierCurveTo(-20, -13, 25, 14, 56, -14);
      context.lineWidth = 5;
      context.stroke();
      context.beginPath();
      context.moveTo(-43, 26);
      context.bezierCurveTo(-14, 4, 19, 23, 40, 1);
      context.lineWidth = 2;
      context.stroke();
      break;
    }
    case 'star':
      glow(59, 0.35);
      star();
      break;
    case 'wisp':
      context.scale(0.62, 1);
      glow(60, 0.75);
      context.strokeStyle = 'rgba(255,255,255,.65)';
      context.shadowColor = 'white';
      context.shadowBlur = 8;
      context.beginPath();
      context.moveTo(-14, 38);
      context.bezierCurveTo(30, 13, -24, -13, 10, -46);
      context.lineWidth = 4;
      context.stroke();
      break;
  }
  return canvas;
}

/** Owns one active, bounded effect and a reusable bank of procedural sprite textures. */
export class HabitatEffects {
  private readonly textures = new Map<SpriteKind, Hilo3d.Texture>();
  private readonly definitions = new Map<HabitatKey, ParticleSystemDefinition>();
  private active: ParticleSystem | null = null;
  private key: HabitatKey | null = null;
  private disposed = false;

  constructor(private readonly parent: Hilo3d.Node, private readonly particles: ParticleStageRuntime) {}

  setHabitat(key: HabitatKey): void {
    if (this.disposed || key === this.key) return;
    let definition = this.definitions.get(key);
    if (!definition) {
      definition = ParticleSystemDefinition.create({
        emitters: layers[key].map((layer, index) => this.createLayer(layer, index)),
      });
      this.definitions.set(key, definition);
    }
    // Sprite textures belong to this bank and survive scene changes.
    if (this.active) this.particles.release(this.active, false);
    this.active = this.particles.createSystem({
      name: `habitat-effects-${key}`, definition, autoPlay: true,
      seed: [...key].reduce((total, letter) => total + letter.charCodeAt(0), 0),
    }, this.parent);
    this.key = key;
  }

  private createLayer(layer: Layer, index: number): ParticleEmitterDefinitionInput {
    const waterLayer = layer.sprite === 'bubble' || layer.sprite === 'glint';
    const rotation: Range = layer.rotation ?? (waterLayer ? [-Math.PI, Math.PI] : [-0.2, 0.2]);
    let texture = this.textures.get(layer.sprite);
    if (!texture) {
      texture = new Hilo3d.Texture({ image: paintSprite(layer.sprite), flipY: false, premultiplyAlpha: false });
      this.textures.set(layer.sprite, texture);
    }
    const fade = new ParticleCurve([
      { time: 0, value: 0 }, { time: 0.12, value: 1 },
      { time: 0.65, value: 0.8 }, { time: 1, value: 0 },
    ], { interpolation: 'smooth' });
    const modules: ParticleModule[] = [
      { type: 'alpha-over-lifetime', curve: fade },
      {
        type: 'noise', mode: 'position-offset', field: 'curl', strength: layer.drift,
        frequency: waterLayer ? 0.65 : 0.25, octaves: waterLayer ? 2 : 1,
        scrollVelocity: waterLayer ? [0.09, 0.04, 0.06] : [0.025, 0, 0.015], seedOffset: 17 + index * 43,
      },
    ];
    if (layer.spin) modules.push({
      type: 'rotation-over-lifetime', curve: new ParticleCurve([
        { time: 0, value: 0 }, { time: 1, value: layer.spin },
      ]),
    });
    if (layer.sprite === 'glow' || layer.sprite === 'star' || layer.sprite === 'glint') modules.push({
      type: 'size-over-lifetime', curve: new ParticleCurve([
        { time: 0, value: 0.55 }, { time: 0.4, value: 1 },
        { time: 0.7, value: 0.65 }, { time: 1, value: 0.35 },
      ], { interpolation: 'smooth' }),
    });
    return {
      name: `${layer.sprite}-${index}`, capacity: layer.capacity, execution: 'auto',
      duration: 10, looping: true, prewarm: true, simulationSpace: 'local', overflow: 'replace-oldest',
      bounds: { mode: 'manual', min: [-7, -1.5, -5], max: [7, 6, 5] },
      emission: { rateOverTime: layer.rate },
      shape: { type: 'box', size: layer.spread, distribution: 'volume' },
      initialize: {
        position: layer.position, direction: layer.direction,
        lifetime: { min: layer.lifetime[0], max: layer.lifetime[1] },
        speed: { min: layer.speed[0], max: layer.speed[1] },
        size: { min: layer.size[0], max: layer.size[1] },
        color: layer.color,
        rotation: { min: rotation[0], max: rotation[1] },
      },
      modules,
      renderers: [{
        type: 'sprite', texture, alignment: 'view', blend: layer.opaque ? 'alpha' : 'additive',
        depthTest: true, depthWrite: false, sort: layer.opaque ? 'distance' : 'none', renderOrder: 8 + index,
      }],
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.particles.release(this.active, false);
    this.active = null;
    for (const texture of this.textures.values()) texture.destroy();
    this.textures.clear();
    this.definitions.clear();
  }
}
