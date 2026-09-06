/** One grid shared by shading and the final nearest-neighbor resolve. */
export function pixelBlockSize(width: number, pixelRatio: number): number {
  return Math.max(1, Math.round(pixelRatio * (width / Math.max(pixelRatio, 1) < 560 ? 2 : 4)));
}

/** Original pigment and scene depth become a small, lit sprite palette. */
export const pixelFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform sampler2D sceneColor;
uniform sampler2D pigmentColor;
uniform sampler2D surfaceData;
uniform sampler2D sceneDepth;
layout(std140) uniform AnimeInkBlock { vec4 sizeInk; vec4 lightNear; vec4 farDepth; };
layout(location = 0) out vec4 outputColor;

ivec2 clampPixel(ivec2 p) { return clamp(p, ivec2(0), ivec2(sizeInk.xy) - 1); }
vec4 pigment(ivec2 p) { return texelFetch(pigmentColor, clampPixel(p), 0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float depthAt(ivec2 p) {
  float z = texelFetch(sceneDepth, clampPixel(p), 0).r;
  z = mix(z, 1.0 - z, farDepth.y);
  return lightNear.w * farDepth.x / max(farDepth.x - z * (farDepth.x - lightNear.w), 0.00001);
}
vec3 normalAt(ivec2 p) {
  vec2 xy = texelFetch(surfaceData, p, 0).xy * 2.0 - 1.0;
  vec3 n = vec3(xy, 1.0 - abs(xy.x) - abs(xy.y));
  float fold = clamp(-n.z, 0.0, 1.0);
  n.xy += mix(vec2(fold), vec2(-fold), step(vec2(0.0), n.xy));
  return normalize(n);
}
float dither(ivec2 cell) {
  const int bayer[16] = int[16](0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5);
  return (float(bayer[(cell.y & 3) * 4 + (cell.x & 3)]) + 0.5) / 16.0 - 0.5;
}
vec3 palette(vec3 color) {
  // Quantize perceptual RGB so dark pigments keep their identity.
  vec3 displayColor = pow(clamp(color, vec3(0), vec3(1)), vec3(1.0 / 2.2));
  vec3 levels = displayColor * 23.0;
  vec3 settled = floor(levels) + smoothstep(vec3(0.35), vec3(0.65), fract(levels));
  return pow(settled / 23.0, vec3(2.2));
}
ivec2 samplePosition(ivec2 cell, int block, int index) {
  vec2 offset = (vec2(index % 3, index / 3) + 0.5) * float(block) / 3.0;
  return clampPixel(cell * block + ivec2(offset));
}
void sampleCell(ivec2 cell, int block, out vec4 original, out vec4 base, out vec3 normal, out float z) {
  vec4 pigments[9];
  vec3 normals[9];
  float depths[9];
  original = vec4(0.0);
  z = farDepth.x;
  for (int i = 0; i < 9; i++) {
    ivec2 q = samplePosition(cell, block, i);
    original += texelFetch(sceneColor, q, 0) / 9.0;
    pigments[i] = pigment(q);
    normals[i] = normalAt(q);
    depths[i] = depthAt(q);
    if (pigments[i].a > 0.01) z = min(z, depths[i]);
  }
  base = vec4(0.0);
  normal = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    // Do not average a foreground face with the scenery behind it.
    float weight = pigments[i].a * (1.0 - smoothstep(0.06, 0.18, depths[i] - z));
    base.rgb += pigments[i].rgb * weight;
    base.a += weight;
    normal += normals[i] * weight;
  }
  base.rgb /= max(base.a, 0.0001);
  base.a /= 9.0;
  normal /= max(length(normal), 0.0001);
}
void neighborCell(ivec2 cell, int block, out vec4 base, out float z) {
  base = vec4(0.0);
  z = farDepth.x;
  for (int i = 0; i < 9; i++) {
    ivec2 q = samplePosition(cell, block, i);
    vec4 sampleBase = pigment(q);
    base.rgb += sampleBase.rgb * sampleBase.a;
    base.a += sampleBase.a;
    if (sampleBase.a > 0.01) z = min(z, depthAt(q));
  }
  base.rgb /= max(base.a, 0.0001);
  base.a /= 9.0;
}
void main() {
  int block = max(1, int(sizeInk.z));
  // This pass runs once per logical pixel, not once per full-resolution output texel.
  ivec2 cell = ivec2(vUv * ceil(sizeInk.xy / float(block)));
  vec4 original, base;
  vec3 normal;
  float z;
  sampleCell(cell, block, original, base, normal, z);
  float mask = smoothstep(0.05, 0.95, base.a);
  vec3 color = original.rgb;
  if (mask > 0.0) {
    float diffuse = dot(normal, normalize(lightNear.xyz));
    float light = smoothstep(-0.55, 0.85, diffuse);
    float illumination = luma(original.rgb) / max(luma(base.rgb), 0.018);
    light *= mix(0.55, 1.0, smoothstep(0.18, 0.85, illumination));
    // Four stable plateaus with a narrow transition, rather than a hard threshold.
    float level = clamp(light * 3.0 + dither(cell) * 0.18, 0.0, 3.0);
    float ramp = (floor(level) + smoothstep(0.35, 0.65, fract(level))) / 3.0;
    vec3 shade = mix(vec3(0.32, 0.38, 0.58), vec3(1.15, 1.12, 1.03), ramp);
    color = mix(color, base.rgb * shade, mask);
  }
  float edge = 0.0;
  vec3 edgePigment = base.rgb * mask;
  float samples = mask;
  const ivec2 directions[4] = ivec2[4](ivec2(1,0), ivec2(-1,0), ivec2(0,1), ivec2(0,-1));
  for (int i = 0; i < 4; i++) {
    vec4 neighbor;
    float qz;
    neighborCell(cell + directions[i], block, neighbor, qz);
    if (neighbor.a < 0.01) continue;
    float silhouette = (1.0 - mask) * neighbor.a * smoothstep(-0.03, 0.03, z - qz);
    float overlap = mask * neighbor.a * smoothstep(0.08, 0.24, qz - z) * 0.55;
    edge = max(edge, max(silhouette, overlap));
    edgePigment += neighbor.rgb * silhouette;
    samples += silhouette;
  }
  vec3 ink = vec3(0.008, 0.012, 0.025) + edgePigment / max(samples, 1.0) * 0.13;
  color = mix(color, ink, edge);
  outputColor = vec4(palette(color), original.a);
}`;

/** Integer expansion preserves partial edge cells when the viewport is not divisible by the grid. */
export const pixelExpandFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform sampler2D pixelScene;
layout(std140) uniform AnimeInkBlock { vec4 sizeInk; vec4 lightNear; vec4 farDepth; };
layout(location = 0) out vec4 outputColor;
void main() {
  ivec2 cell = ivec2(vUv * sizeInk.xy) / max(1, int(sizeInk.z));
  cell = clamp(cell, ivec2(0), textureSize(pixelScene, 0) - 1);
  outputColor = texelFetch(pixelScene, cell, 0);
}`;

/** Run after tone mapping, so bloom/AA cannot soften the final square pixels. */
export const pixelResolveFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform sampler2D paintedScene;
layout(std140) uniform PixelGridBlock { vec4 grid; };
layout(location = 0) out vec4 outputColor;
void main() {
  ivec2 extent = textureSize(paintedScene, 0);
  int block = max(1, int(grid.x));
  ivec2 cell = ivec2(vUv * vec2(extent)) / block;
  ivec2 p = clamp(cell * block + ivec2(block / 2), ivec2(0), extent - 1);
  outputColor = texelFetch(paintedScene, p, 0);
}`;
