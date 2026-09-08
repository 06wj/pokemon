import * as Hilo3d from 'hilo3d';
import { COASTAL_LAYOUT, RIVER_SEGMENTS } from '../ecology/layout';
import type { LivingWorld } from '../ecology/livingTypes.ts';
import { livingTreeShakeOffset } from './livingEffects.ts';

interface LivingSceneryMesh {
  mesh: Hilo3d.Mesh;
  x: number;
  y: number;
  z: number;
  scaleY: number;
  motion: number;
}

const glslFloat = (value: number): string => Number.isInteger(value) ? value.toFixed(1) : String(value);
const river = COASTAL_LAYOUT.river;
const riverCenterShader = `float riverCenterAt(float z) {
  if (z <= ${glslFloat(RIVER_SEGMENTS[0]!.z0)}) return ${glslFloat(RIVER_SEGMENTS[0]!.d)};
  ${RIVER_SEGMENTS.map((segment) => `if (z <= ${glslFloat(segment.z1)}) {
    float t = (z - (${glslFloat(segment.z0)})) / ${glslFloat(segment.z1 - segment.z0)};
    return ((${glslFloat(segment.a)} * t + (${glslFloat(segment.b)})) * t + (${glslFloat(segment.c)})) * t + (${glslFloat(segment.d)});
  }`).join('\n  ')}
  return ${glslFloat(river.centerline[river.centerline.length - 1]![0]!)};
}`;

Hilo3d.registerUniformBlockBinding('EcologyStreamParams');
const waterLayout = Hilo3d.createStd140Layout({ uModel: 'mat4', uViewProjection: 'mat4', uTimeMood: 'vec4' });
const waterBlock = `layout(std140) uniform EcologyStreamParams { mat4 uModel; mat4 uViewProjection; vec4 uTimeMood; };`;
const waterVertex = `#version 300 es
precision highp float;
in vec3 a_position;
out vec3 vPosition;
${waterBlock}
void main() { vPosition = a_position; gl_Position = uViewProjection * uModel * vec4(a_position, 1.0); }`;
const waterFragment = `#version 300 es
precision highp float;
in vec3 vPosition;
${waterBlock}
out vec4 fragColor;
${riverCenterShader}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
void main() {
  float time = uTimeMood.x, dusk = uTimeMood.y;
  vec2 p = vPosition.xz;
  float center = riverCenterAt(p.y);
  float edge = abs(p.x-center)/${glslFloat(river.halfWidth)};
  float shallow = smoothstep(0.42, 1.0, edge);
  float waviness = noise(p*1.7 + vec2(0.0,-time*.15));
  vec3 deep = mix(vec3(.025,.26,.27),vec3(.045,.16,.21),dusk);
  vec3 clear = mix(vec3(.18,.47,.39),vec3(.19,.31,.31),dusk);
  vec3 water = mix(deep,clear, shallow*.78+waviness*.13);
  float wave = abs(sin(p.y*8.0 + sin(p.x*9.0)*.28 + noise(p*4.0)*3.0 - time*1.55));
  float streak = (1.0-smoothstep(.02,.095,wave))*smoothstep(.48,.68,noise(p*3.0+vec2(0,-time*.16)));
  float glint = pow(max(0.0,1.0-abs(p.x-center+.28)),6.0)*streak;
  water += mix(vec3(.17,.25,.18),vec3(.30,.18,.10),dusk)*streak*.36;
  water += vec3(.26,.34,.28)*glint*.4;
  float foam = smoothstep(.92,1.0,edge)*smoothstep(.38,.63,noise(p*7.0-vec2(0,time*.25)));
  water = mix(water,vec3(.46,.65,.55),foam*.66);
  // The rebuilt banks slope down into the sea. Match that gentle descent with
  // increasingly sandy shallows rather than the former vertical waterfall bands.
  float mouth = smoothstep(0.0, 1.0, (${glslFloat(river.surfaceY)} - vPosition.y)
    / (${glslFloat(river.surfaceY)} - ${glslFloat(COASTAL_LAYOUT.coast.seaLevel)}));
  vec3 mouthWater = mix(vec3(.20,.49,.32), vec3(.036,.14,.13), dusk);
  mouthWater += mix(vec3(.025,.045,.03), vec3(.01,.02,.018), dusk) * waviness;
  water = mix(water, mouthWater, mouth);
  fragColor = vec4(water,1.0);
}`;

/** The static environment is authored and exported through Blender MCP. */
export class EcologyLandscape {
  private readonly staticMeshes: Hilo3d.Mesh[] = [];
  private readonly waterBuffer = new Hilo3d.UniformBuffer(waterLayout);
  private readonly waterMaterial: Hilo3d.ShaderMaterial;
  private readonly waterMeshes: Hilo3d.Mesh[] = [];
  private readonly motes: Hilo3d.Mesh[] = [];
  private readonly heroTree: LivingSceneryMesh[] = [];
  private readonly flowerBeds: LivingSceneryMesh[] = [];
  private readonly kindling: Hilo3d.Mesh[] = [];
  private readonly terrainSurfaces: { material: Hilo3d.PBRMaterial; color: Hilo3d.Color; roughness: number }[] = [];
  private readonly shakeOffset = { x: 0, z: 0 };
  private readonly timeMood = new Float32Array(4);
  private time = 0;
  private dusk = false;
  private disposed = false;

  /** Authored solid scenery; the custom stream and luminous motes retain their own materials. */
  get solidMeshes(): readonly Hilo3d.Mesh[] { return this.staticMeshes; }

  static async create(stage: Hilo3d.Stage, assetBase: string): Promise<EcologyLandscape> {
    const model = await new Hilo3d.GLTFLoader().load({ src: `${assetBase.replace(/\/$/, '')}/${COASTAL_LAYOUT.asset}` });
    try {
      await model.ready;
      return new EcologyLandscape(stage, model.node);
    } catch (error) {
      model.node.destroy(stage.renderer, true);
      throw error;
    }
  }

  private constructor(private readonly stage: Hilo3d.Stage, private readonly root: Hilo3d.Node) {
    this.waterMaterial = new Hilo3d.ShaderMaterial({
      name: 'ecology / moving turquoise river', vs: waterVertex, fs: waterFragment,
      attributes: { a_position: Hilo3d.MaterialAttributeSemantic.POSITION },
      uniformBlocks: { EcologyStreamParams: this.waterBuffer }, cullMode: 'none',
    });
    root.name = 'ecology / Blender coastal sanctuary v2';
    root.traverse((node) => {
      if (!(node instanceof Hilo3d.Mesh)) return;
      node.castShadows = true;
      node.receiveShadows = true;
      // GLTFLoader makes a mesh-* child below the authored named node.
      const authoredName = `${node.name} ${node.parent?.name ?? ''}`;
      const name = `${authoredName} ${node.material?.name ?? ''}`;
      // Verified in ecology-coastal-v2.glb: only this terrain material carries
      // the Blender caustic-node fallback emissiveFactor [0.701,0.761,0.402].
      // Its baked albedo is already lit by the runtime. Mutate the factor only;
      // do not replace emission textures or touch foliage/normal fire materials.
      if (/continuous turf sand submerged shelf/i.test(authoredName)
        && node.material instanceof Hilo3d.PBRMaterial
        && node.material.name === 'Coast / turf and sand vertex colors') {
        node.material.emissionFactor.set(0, 0, 0, 1);
        node.material.invalidateData();
        this.terrainSurfaces.push({ material: node.material, roughness: node.material.roughness,
          color: new Hilo3d.Color(node.material.baseColor.r, node.material.baseColor.g, node.material.baseColor.b, node.material.baseColor.a) });
      }
      if (/Fruit_hero-fruit-tree(?:\b|_)/i.test(authoredName)) {
        // The main tree has 0..5 actual ripe fruit in LivingEffects. Other
        // trees keep their decorative fruit; only this landmark can be shaken.
        node.visible = false;
        node.castShadows = false;
        node.receiveShadows = false;
        return;
      }
      if (/Flora_hero-fruit-tree_(?:leaf|bark)/i.test(node.name)) {
        this.heroTree.push({ mesh: node, x: node.x, y: node.y, z: node.z, scaleY: node.scaleY,
          motion: /_leaf/i.test(node.name) ? 1 : .18 });
      }
      if (/Flora_(?:Meadow_west|Riverbank_north)_Flower_Mass/i.test(node.name)) {
        this.flowerBeds.push({ mesh: node, x: node.x, y: node.y, z: node.z, scaleY: node.scaleY, motion: 1 });
      }
      if (/Campfire.*kindling logs/i.test(node.name)) this.kindling.push(node);
      if (/stream and waterfalls/i.test(name)) {
        node.material = this.waterMaterial;
        node.castShadows = false;
        node.receiveShadows = false;
        this.waterMeshes.push(node);
      } else if (/evening fireflies/i.test(name)) {
        node.visible = false;
        node.castShadows = false;
        node.receiveShadows = false;
        this.motes.push(node);
      } else {
        if (/turf|path|sand/i.test(name)) node.castShadows = false;
        this.staticMeshes.push(node);
      }
    });
    root.addTo(stage);
    this.update(0);
  }

  setTimeOfDay(timeOfDay: 'dawn' | 'dusk'): void {
    this.dusk = timeOfDay === 'dusk';
    for (const mote of this.motes) mote.visible = this.dusk;
  }

  /** Presentation only; timestamps are in the simulation's elapsed seconds. */
  applyLivingWorld(world: LivingWorld, elapsed: number): void {
    if (this.disposed || !Number.isFinite(elapsed)) return;
    const wetness = Math.max(0, Math.min(1, world.weather.wetness));
    for (const surface of this.terrainSurfaces) {
      const darken = 1 - wetness * .19;
      surface.material.baseColor.set(surface.color.r * darken, surface.color.g * darken, surface.color.b * darken, surface.color.a);
      surface.material.roughness = surface.roughness + (.31 - surface.roughness) * wetness;
      surface.material.invalidateData();
    }
    livingTreeShakeOffset(elapsed, world.tree.shakeAt, this.shakeOffset);
    for (const item of this.heroTree) {
      // Authored meshes contain world-space vertices. Small translations avoid
      // accidentally rotating these trees around the island's world origin.
      item.mesh.x = item.x + this.shakeOffset.x * item.motion;
      item.mesh.z = item.z + this.shakeOffset.z * item.motion;
    }
    for (const mesh of this.kindling) mesh.visible = world.campfire.prepared || world.campfire.lit;
    const rustleAge = elapsed - world.flowers.rustleAt;
    const rustle = rustleAge >= 0 && rustleAge < 1.3 ? Math.exp(-rustleAge * 2) * (1 - rustleAge / 1.3) : 0;
    const bloom = Math.max(0, Math.min(1, world.flowers.bloom));
    for (let i = 0; i < this.flowerBeds.length; i++) {
      const item = this.flowerBeds[i]!;
      item.mesh.x = item.x + Math.sin(rustleAge * 28 + i * .07) * rustle * .045;
      item.mesh.z = item.z + Math.cos(rustleAge * 23 + i * .07) * rustle * .025;
      // Both flower beds stand on the flat core ground. Scale the complete stem
      // and petal batches together so opening never detaches petals from stems.
      item.mesh.scaleY = item.scaleY * (.90 + .10 * bloom);
    }
  }

  update(dtSeconds: number): void {
    if (this.disposed) return;
    this.time += Math.min(.1, Math.max(0, dtSeconds));
    const camera = this.stage.camera;
    if (!camera || !this.waterMeshes.length) return;
    camera.updateViewProjectionMatrix();
    this.timeMood[0] = this.time;
    this.timeMood[1] = this.timeMood[1]! + ((this.dusk ? 1 : 0) - this.timeMood[1]!) * Math.min(1, dtSeconds * 2);
    this.waterBuffer.set('uModel', this.waterMeshes[0]!.worldMatrix.elements);
    this.waterBuffer.set('uViewProjection', camera.viewProjectionMatrix.elements);
    this.waterBuffer.set('uTimeMood', this.timeMood);
    this.waterMaterial.invalidateData();
    for (const mote of this.motes) {
      mote.y = Math.sin(this.time * .34) * .11;
      mote.x = Math.sin(this.time * .17) * .11;
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.root.destroy(this.stage.renderer, true);
    this.staticMeshes.length = 0;
    this.waterMeshes.length = 0;
    this.motes.length = 0;
    this.heroTree.length = 0;
    this.flowerBeds.length = 0;
    this.kindling.length = 0;
    this.terrainSurfaces.length = 0;
  }
}
