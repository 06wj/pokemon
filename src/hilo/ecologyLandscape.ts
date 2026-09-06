import * as Hilo3d from 'hilo3d';

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
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
void main() {
  float time = uTimeMood.x, dusk = uTimeMood.y;
  vec2 p = vPosition.xz;
  float center = 3.2 + sin(p.y * 0.3) * 1.25;
  float edge = abs(p.x-center)/1.25;
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
  // Cliff-edge curtains are continuous with the stream, with vertical ribbons.
  if (vPosition.y < -.09) {
    float fall = .5 + .5*sin(p.x*32.0 + noise(p*7.0)*3.0 + vPosition.y*5.0 + time*3.5);
    water = mix(vec3(.035,.24,.24),vec3(.30,.52,.44),pow(fall,5.0)*.75);
  }
  fragColor = vec4(water,1.0);
}`;

/** The static environment is authored and exported through Blender MCP. */
export class EcologyLandscape {
  private readonly staticMeshes: Hilo3d.Mesh[] = [];
  private readonly waterBuffer = new Hilo3d.UniformBuffer(waterLayout);
  private readonly waterMaterial: Hilo3d.ShaderMaterial;
  private readonly waterMeshes: Hilo3d.Mesh[] = [];
  private readonly motes: Hilo3d.Mesh[] = [];
  private readonly timeMood = new Float32Array(4);
  private time = 0;
  private dusk = false;
  private disposed = false;

  /** Authored solid scenery; the custom stream and luminous motes retain their own materials. */
  get solidMeshes(): readonly Hilo3d.Mesh[] { return this.staticMeshes; }

  static async create(stage: Hilo3d.Stage, assetBase: string): Promise<EcologyLandscape> {
    const model = await new Hilo3d.GLTFLoader().load({ src: `${assetBase.replace(/\/$/, '')}/habitats/ecology.glb` });
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
    root.name = 'ecology / Blender river sanctuary';
    root.traverse((node) => {
      if (!(node instanceof Hilo3d.Mesh)) return;
      node.castShadows = true;
      node.receiveShadows = true;
      const name = `${node.name} ${node.material?.name ?? ''}`;
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
  }
}
