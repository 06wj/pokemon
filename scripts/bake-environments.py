"""Bake portable RGBA16F IBL textures from the CC0 Radiance sources in public/environments.

Requires Python 3 + NumPy. Run from repository root: python3 scripts/bake-environments.py
Uses cosine-weighted diffuse convolution, GGX importance sampling, and a split-sum BRDF LUT.
Binary files contain a 16-byte LE header (magic, side, levels, faces), followed by
level-major, canonical +X/-X/+Y/-Y/+Z/-Z top-left RGBA half-float texels.
"""
from pathlib import Path
import json
import math
import struct
import numpy as np

ROOT = Path(__file__).resolve().parents[1] / 'public' / 'environments'
SIDE = 128
SAMPLES = 512
MAGIC = 0x314C4249  # IBL1


def read_hdr(path):
    with path.open('rb') as f:
        while f.readline().strip():
            pass
        fields = f.readline().split()
        height, width = int(fields[1]), int(fields[3])
        rgbe = np.empty((height, width, 4), np.uint8)
        for row in range(height):
            header = f.read(4)
            if header[:2] != b'\x02\x02':
                raise ValueError('Expected scanline RLE in the 1k Radiance source')
            for channel in range(4):
                x = 0
                while x < width:
                    count = f.read(1)[0]
                    if count > 128:
                        count -= 128
                        rgbe[row, x:x+count, channel] = f.read(1)[0]
                    else:
                        rgbe[row, x:x+count, channel] = np.frombuffer(f.read(count), np.uint8)
                    x += count
        radiance = rgbe[:, :, :3].astype(np.float32) * np.exp2(rgbe[:, :, 3].astype(np.float32) - 136)[:, :, None]
        radiance[rgbe[:, :, 3] == 0] = 0
        return radiance


def sample_hdr(hdr, direction):
    h, w, _ = hdr.shape
    x = (np.arctan2(direction[..., 0], direction[..., 2]) / (2 * np.pi) + .5) * w - .5
    y = np.arccos(np.clip(direction[..., 1], -1, 1)) / np.pi * h - .5
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    x1, y1 = (x0 + 1) % w, np.clip(y0 + 1, 0, h-1)
    x0, y0 = x0 % w, np.clip(y0, 0, h-1)
    return (hdr[y0, x0] * (1-fx) + hdr[y0, x1] * fx) * (1-fy) + (hdr[y1, x0] * (1-fx) + hdr[y1, x1] * fx) * fy


def hdr_mip_pyramid(hdr):
    levels = [hdr]
    while min(levels[-1].shape[:2]) > 1:
        image = levels[-1]
        h, w, _ = image.shape
        latitude = np.sin((np.arange(h) + .5) / h * np.pi).astype(np.float32)
        weighted = image * latitude[:, None, None]
        reduced = weighted.reshape(h//2, 2, w//2, 2, 3).sum(axis=(1, 3))
        reduced /= (latitude.reshape(h//2, 2).sum(axis=1) * 2)[:, None, None]
        levels.append(reduced)
    return levels


def sample_hdr_lod(pyramid, direction, lod):
    shape = direction.shape[:-1]
    direction = direction.reshape(-1, 3)
    lod = np.clip(lod.reshape(-1), 0, len(pyramid)-1)
    lower = np.floor(lod).astype(np.int32)
    upper = np.minimum(lower+1, len(pyramid)-1)
    blend = lod-lower
    result = np.zeros((len(direction), 3), np.float32)
    for level, hdr in enumerate(pyramid):
        indices = np.flatnonzero(lower == level)
        if len(indices):
            result[indices] += sample_hdr(hdr, direction[indices]) * (1-blend[indices, None])
        indices = np.flatnonzero(upper == level)
        if len(indices):
            result[indices] += sample_hdr(hdr, direction[indices]) * blend[indices, None]
    return result.reshape(*shape, 3)


def sh_basis(n):
    x, y, z = n[..., 0], n[..., 1], n[..., 2]
    return np.stack([np.full_like(x, .2820947918), .4886025119*y, .4886025119*z, .4886025119*x,
        1.0925484306*x*y, 1.0925484306*y*z, .3153915653*(3*z*z-1),
        1.0925484306*x*z, .5462742153*(x*x-y*y)], -1)


def diffuse_sh(hdr):
    # Integrate every HDR texel with its exact row solid angle. Analytic cosine-lobe
    # band factors give E/pi, eliminating Monte Carlo variance from tiny bright lamps.
    height, width, _ = hdr.shape
    theta = (np.arange(height)+.5)/height*np.pi
    phi = (np.arange(width)+.5)/width*2*np.pi-np.pi
    st = np.sin(theta)[:, None]
    n = np.stack([st*np.sin(phi)[None, :], np.broadcast_to(np.cos(theta)[:, None], (height, width)), st*np.cos(phi)[None, :]], -1)
    row_weight = (np.cos(np.arange(height)/height*np.pi)-np.cos((np.arange(height)+1)/height*np.pi))*2*np.pi/width
    weighted = hdr*row_weight[:, None, None]
    coefficients = sh_basis(n).reshape(-1, 9).T @ weighted.reshape(-1, 3)
    coefficients *= np.array([1, 2/3, 2/3, 2/3, 1/4, 1/4, 1/4, 1/4, 1/4])[:, None]
    return coefficients


def directions(side, face):
    grid = (np.arange(side, dtype=np.float32) + .5) / side * 2 - 1
    u, v = np.meshgrid(grid, grid)
    one = np.ones_like(u)
    entries = [(one, -v, -u), (-one, -v, u), (u, one, v), (u, -one, -v), (u, -v, one), (-u, -v, -one)]
    n = np.stack(entries[face], -1).reshape(-1, 3)
    return n / np.linalg.norm(n, axis=1)[:, None]


def hammersley(count):
    bits = np.arange(count, dtype=np.uint32)
    bits = (bits << 16) | (bits >> 16)
    bits = ((bits & 0x55555555) << 1) | ((bits & 0xAAAAAAAA) >> 1)
    bits = ((bits & 0x33333333) << 2) | ((bits & 0xCCCCCCCC) >> 2)
    bits = ((bits & 0x0F0F0F0F) << 4) | ((bits & 0xF0F0F0F0) >> 4)
    bits = ((bits & 0x00FF00FF) << 8) | ((bits & 0xFF00FF00) >> 8)
    return (np.arange(count, dtype=np.float32) + .5) / count, bits.astype(np.float32) * 2.3283064365386963e-10


def tangent_basis(n):
    up = np.tile([0., 1., 0.], (len(n), 1)).astype(np.float32)
    up[np.abs(n[:, 1]) > .99] = [0, 0, 1]
    t = np.cross(up, n)
    t /= np.linalg.norm(t, axis=1)[:, None]
    return t, np.cross(n, t)


def convolve(hdr, n, roughness=None, pyramid=None):
    if roughness == 0:
        return sample_hdr(hdr, n)
    xi, xj = hammersley(SAMPLES)
    phi = 2 * np.pi * xi
    if roughness is None:
        cos_t = np.sqrt(1-xj)
    else:
        a = max(roughness ** 2, .001)
        cos_t = np.sqrt((1-xj) / (1 + (a*a-1) * xj))
    sin_t = np.sqrt(1-cos_t*cos_t)
    local = np.stack([np.cos(phi)*sin_t, np.sin(phi)*sin_t, cos_t], -1)
    out = []
    for start in range(0, len(n), 512):
        normal = n[start:start+512]
        t, b = tangent_basis(normal)
        half = t[:, None, :] * local[None, :, 0:1] + b[:, None, :] * local[None, :, 1:2] + normal[:, None, :] * local[None, :, 2:3]
        if roughness is None:
            out.append(sample_hdr(hdr, half).mean(axis=1))
        else:
            light = 2 * np.sum(normal[:, None, :] * half, axis=-1)[..., None] * half - normal[:, None, :]
            ndotl = np.maximum(np.sum(normal[:, None, :] * light, axis=-1), 0)
            if pyramid is not None:
                # Source footprint from the GGX importance PDF. Filtering the original
                # radiance avoids noisy point-light hits in broad roughness lobes.
                distribution = a*a / (np.pi * np.square(cos_t*cos_t*(a*a-1)+1))
                sample_area = 4 / np.maximum(SAMPLES*distribution, 1e-8)
                texel_area = 2*np.pi*np.pi/(hdr.shape[0]*hdr.shape[1]) * np.maximum(np.sqrt(np.maximum(0, 1-light[..., 1]**2)), .01)
                lod = .5*np.log2(np.maximum(sample_area[None, :]/texel_area, 1))
                sampled = sample_hdr_lod(pyramid, light, lod)
            else:
                sampled = sample_hdr(hdr, light)
            out.append(np.sum(sampled * ndotl[..., None], axis=1) / np.maximum(ndotl.sum(axis=1)[:, None], 1e-5))
    return np.concatenate(out)


def write_texture(path, side, levels, faces, pixels):
    with path.open('wb') as f:
        f.write(struct.pack('<4I', MAGIC, side, levels, faces))
        for pixel in pixels:
            rgba = np.ones((len(pixel), 4), np.float32)
            rgba[:, :pixel.shape[-1]] = pixel
            f.write(np.clip(rgba, 0, 65000).astype('<f2').tobytes())


def bake_brdf():
    # Rows are top-left UV: shader looks up (NdotV, 1 - perceptualRoughness).
    size = 128
    xi, xj = hammersley(1024)
    phi = 2 * np.pi * xi
    ndotv = (np.arange(size, dtype=np.float32) + .5) / size
    rows = []
    for y in range(size):
        rough = 1 - (y+.5)/size
        a = rough*rough
        cos_t = np.sqrt((1-xj)/(1+(a*a-1)*xj))
        sin_t = np.sqrt(1-cos_t*cos_t)
        half = np.stack([np.cos(phi)*sin_t, np.sin(phi)*sin_t, cos_t], -1)
        view = np.stack([np.sqrt(1-ndotv*ndotv), np.zeros(size), ndotv], -1)
        vdh = np.maximum(np.sum(view[:, None, :] * half[None, :, :], axis=-1), 0)
        light = 2*vdh[..., None]*half[None, :, :] - view[:, None, :]
        ndotl = np.maximum(light[:, :, 2], 0)
        k = rough*rough / 2
        gv = ndotv / (ndotv*(1-k)+k)
        gl = ndotl / np.maximum(ndotl*(1-k)+k, 1e-6)
        visibility = gv[:, None]*gl*vdh/np.maximum(cos_t[None, :]*ndotv[:, None], 1e-6)
        fresnel = np.power(1-vdh, 5)
        rows.append(np.stack([np.mean((1-fresnel)*visibility*(ndotl > 0), axis=1), np.mean(fresnel*visibility*(ndotl > 0), axis=1)], -1))
    write_texture(ROOT/'brdf-lut.bin', size, 1, 1, [np.concatenate(rows)])


def bake(name, filename):
    hdr = read_hdr(ROOT/filename)
    # The photographs were captured at different exposures. A global exposure adjustment
    # matches their mean hemispherical illumination while preserving all HDR contrast.
    latitude_weight = np.sin((np.arange(hdr.shape[0])+.5)/hdr.shape[0]*np.pi)
    luminance = hdr @ np.array([.2126, .7152, .0722])
    mean = np.sum(luminance * latitude_weight[:, None]) / (np.sum(latitude_weight)*hdr.shape[1])
    exposure = .65/mean
    hdr *= exposure
    print(name, 'source mean:', round(float(mean), 4), 'exposure:', round(float(exposure), 4), flush=True)
    levels = int(math.log2(SIDE))+1
    pyramid = hdr_mip_pyramid(hdr)
    spec = []
    for level in range(levels):
        side = max(1, SIDE >> level)
        # Hilo's public mipmapCount is the number of levels, used directly as the LOD scale.
        roughness = level/levels
        spec.extend(convolve(hdr, directions(side, face), roughness, pyramid) for face in range(6))
        print(name, 'GGX mip', level, side, flush=True)
    write_texture(ROOT/f'{name}-specular.bin', SIDE, levels, 6, spec)
    coefficients = diffuse_sh(hdr)
    diffuse = [np.maximum(sh_basis(directions(16, face)) @ coefficients, 0) for face in range(6)]
    write_texture(ROOT/f'{name}-diffuse.bin', 16, 1, 6, diffuse)
    return {'source': filename, 'sourceExposureMultiplier': float(exposure), 'specularSide': SIDE, 'specularLevels': levels, 'diffuseSide': 16, 'samples': SAMPLES, 'diffuseConvolution': 'full-image SH9 analytic cosine', 'specularConvolution': 'GGX PDF-filtered solid-angle HDR mip pyramid'}


if __name__ == '__main__':
    metadata = {key:bake(key, file) for key,file in [('forest','forest_slope_1k.hdr'), ('studio','studio_small_09_1k.hdr')]}
    bake_brdf()
    (ROOT/'bake-manifest.json').write_text(json.dumps(metadata, indent=2)+'\n')
