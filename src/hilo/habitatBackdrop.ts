import * as Hilo3d from 'hilo3d';
import type { HabitatKey } from '../content/habitats';

Hilo3d.registerUniformBlockBinding('HabitatBackdropParams');

const vertex = `#version 300 es
precision highp float;
in vec3 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position.xy * 0.5 + 0.5;
  gl_Position = vec4(a_position.xy, 0.9999, 1.0);
}`;

const fragment = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_backdrop;
layout(std140) uniform HabitatBackdropParams { vec4 u_crop; };
out vec4 fragColor;
void main() {
  vec2 uv = (v_uv - 0.5) * u_crop.xy + 0.5;
  // Hilo normalizes 2D image uploads differently on WebGL2. Convert the raw
  // clip-space UV here so both backends display the painting upright.
#ifndef HILO_WEBGPU
  uv.y = 1.0 - uv.y;
#endif
  vec3 paint = texture(u_backdrop, uv).rgb;
  // Decode the painted sRGB image before it enters the shared HDR/color pipeline.
  vec3 linearColor = mix(paint / 12.92, pow((paint + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), paint));
  float vignette = 1.0 - 0.22 * smoothstep(0.24, 0.72, length(v_uv - 0.5));
  fragColor = vec4(linearColor * 0.68 * vignette, 1.0);
}`;

/** Static screen backdrop, rendered into scene color so glass also refracts the far scenery. */
export class HabitatBackdrop {
  private readonly cache = new Map<HabitatKey, Promise<Hilo3d.Texture>>();
  private readonly parameters = new Hilo3d.UniformBuffer(
    Hilo3d.createStd140Layout({ u_crop: 'vec4' }), { u_crop: [1, 1, 0, 0] },
  );
  private readonly mesh: Hilo3d.Mesh;
  private texture: Hilo3d.Texture | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly stage: Hilo3d.Stage, private readonly assetBase: string) {
    const material = new Hilo3d.ShaderMaterial({
      name: 'distant habitat painting', vs: vertex, fs: fragment,
      attributes: { a_position: Hilo3d.MaterialAttributeSemantic.POSITION },
      uniforms: { u_backdrop: { get: () => this.texture } },
      uniformBlocks: { HabitatBackdropParams: this.parameters },
      state: { depthTest: false, depthWrite: false }, cullMode: 'none',
    });
    this.mesh = new Hilo3d.Mesh({
      name: 'habitat-backdrop', geometry: new Hilo3d.PlaneGeometry({ width: 2, height: 2 }),
      material, useInstanced: false, frustumTest: false, renderOrder: -10000,
      castShadows: false, receiveShadows: false,
      visible: false,
    }).addTo(stage);
  }

  resize(aspect: number): void {
    const imageAspect = 1.5;
    this.parameters.set('u_crop', [Math.min(1, aspect / imageAspect), Math.min(1, imageAspect / aspect), 0, 0]);
  }

  async setHabitat(key: HabitatKey): Promise<void> {
    if (this.disposed) return;
    const sequence = ++this.sequence;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = new Promise<Hilo3d.Texture>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(new Hilo3d.Texture({
          name: `${key} / distant painting`, image, flipY: true,
          wrapS: Hilo3d.constants.CLAMP_TO_EDGE, wrapT: Hilo3d.constants.CLAMP_TO_EDGE,
        }));
        image.onerror = () => reject(new Error(`无法加载 ${key} 场景背景。`));
        image.src = `${this.assetBase.replace(/\/$/, '')}/backdrops/${key}.jpg`;
      });
      this.cache.set(key, pending);
    }
    let texture: Hilo3d.Texture;
    try {
      texture = await pending;
    } catch (error) {
      if (this.cache.get(key) === pending) this.cache.delete(key);
      if (this.disposed || sequence !== this.sequence) return;
      throw error;
    }
    if (this.disposed || sequence !== this.sequence) return;
    this.texture = texture;
    this.mesh.material?.invalidateData();
    this.mesh.visible = true;
  }

  dispose(): void {
    this.disposed = true;
    this.sequence++;
    this.mesh.removeFromParent();
    this.mesh.destroy(this.stage.renderer);
    for (const pending of this.cache.values()) void pending.then((texture) => texture.destroy(), () => {});
    this.cache.clear();
  }
}
