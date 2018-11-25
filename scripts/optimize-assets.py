"""Optimize delivery assets with high-quality JPEG only; preserve remaining PNG bytes.

Requires Pillow. Originals live in ignored source/; the report is tracked.
Reruns skip previously optimized files; changed/re-exported files become new originals.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import re

from PIL import Image, ImageChops, ImageStat
from gen1_skinning import pack_glb, unpack_glb

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'source' / 'asset-optimization'
REPORT = ROOT / 'scripts' / 'asset-optimization-report.json'
FACIAL = re.compile(r'eye|iris|mouth|pupil', re.I)
COLOR_SLOTS = {'baseColorTexture', 'emissiveTexture'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def backup(path, data):
    # Content-addressed originals make every optimization recoverable, including re-exports.
    target = ARCHIVE / 'originals' / digest(data) / path.relative_to(ROOT)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(data)
    return str(target.relative_to(ROOT))


def atomic_write(path, data):
    temporary = path.with_name(path.name + '.optimizing')
    temporary.write_bytes(data)
    temporary.replace(path)


def optimize_image(data, *, color, facial=False, exact_alpha=True, background=False):
    """Never quantize data maps or facial atlases used by runtime pigment masks."""
    if not color or facial or not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return data, 'image/jpeg' if data.startswith(b'\xff\xd8') else 'image/png', 'preserved'
    with Image.open(io.BytesIO(data)) as source:
        rgba = source.convert('RGBA')
        alpha = rgba.getchannel('A')
        opaque = alpha.getextrema() == (255, 255)
        rgb = rgba.convert('RGB')
        # Never quantize PNGs: preserve their original storage format for mobile WebGPU.
        candidates = [(data, 'image/png', 'preserved')]
        if opaque:
            # No chroma subsampling: preserve small color edges and UV seams.
            for quality in (95, 98, 100):
                output = io.BytesIO()
                rgb.save(output, 'JPEG', quality=quality, subsampling=0, optimize=True)
                jpeg = output.getvalue()
                decoded = Image.open(io.BytesIO(jpeg)).convert('RGB')
                diff = ImageChops.difference(rgb, decoded)
                rms = sum(x * x for x in ImageStat.Stat(diff).rms) / 3
                maximum = max(x[1] for x in diff.getextrema())
                if rms <= 6.5 and maximum <= (20 if background else 16):
                    candidates.append((jpeg, 'image/jpeg', f'jpeg{quality}'))
                    break
        if background:
            candidates = [candidate for candidate in candidates if candidate[1] == 'image/jpeg']
            if not candidates:
                raise ValueError('Background cannot meet JPEG quality limits; review before replacing it')
        result = min(candidates, key=lambda x: len(x[0]))
        decoded = Image.open(io.BytesIO(result[0])).convert('RGBA')
        assert decoded.size == rgba.size
        if exact_alpha:
            assert ImageChops.difference(alpha, decoded.getchannel('A')).getbbox() is None
        return result


def image_usage(doc):
    uses = defaultdict(set)
    protected = set()
    material_meshes = defaultdict(list)
    for mesh in doc.get('meshes', []):
        for primitive in mesh['primitives']:
            material_meshes[primitive.get('material')].append(mesh.get('name', ''))

    def visit(obj, facial):
        if not isinstance(obj, dict):
            return
        for key, value in obj.items():
            if key.endswith('Texture') and isinstance(value, dict) and 'index' in value:
                texture = doc['textures'][value['index']]
                if 'source' not in texture:
                    raise ValueError('Only standard embedded glTF textures are supported')
                image_index = texture['source']
                uses[image_index].add(key)
                if facial or FACIAL.search(doc['images'][image_index].get('name', '')):
                    protected.add(image_index)
            else:
                visit(value, facial)

    for index, material in enumerate(doc.get('materials', [])):
        facial = bool(FACIAL.search(' '.join([material.get('name', ''), *material_meshes[index]])))
        visit(material, facial)
    return uses, protected


def optimize_glb(path):
    before = path.read_bytes()
    doc, binary = unpack_glb(before)
    original_doc = deepcopy(doc)
    uses, facial = image_usage(doc)
    replacements = {}
    stats = Counter()
    encoded = {}
    image_views = {image['bufferView'] for image in doc.get('images', [])}
    accessor_views = {a['bufferView'] for a in doc.get('accessors', []) if 'bufferView' in a}
    if image_views & accessor_views:
        raise ValueError('Images must not share buffer views with accessors')
    for index, image in enumerate(doc.get('images', [])):
        view_index = image['bufferView']
        view = doc['bufferViews'][view_index]
        start = view.get('byteOffset', 0)
        data = binary[start:start + view['byteLength']]
        color = bool(uses[index]) and uses[index] <= COLOR_SLOTS
        key = (digest(data), color, index in facial)
        if key not in encoded:
            encoded[key] = optimize_image(data, color=color, facial=index in facial)
        optimized, mime, method = encoded[key]
        if view_index in replacements and replacements[view_index] != optimized:
            raise ValueError('Shared image view has incompatible material usage')
        replacements[view_index] = optimized
        image['mimeType'] = mime
        stats[method] += 1

    output = bytearray()
    image_offsets = {}
    for index, view in enumerate(doc['bufferViews']):
        start = view.get('byteOffset', 0)
        data = replacements.get(index, binary[start:start + view['byteLength']])
        # Keep every image/texture/material identity and sampler. Share only identical bytes.
        key = digest(data)
        if index in image_views and key in image_offsets:
            view['byteOffset'], view['byteLength'] = image_offsets[key]
            stats['deduplicatedBytes'] += len(data)
            continue
        output.extend(b'\0' * (-len(output) % 4))
        view['byteOffset'], view['byteLength'] = len(output), len(data)
        output.extend(data)
        if index in image_views:
            image_offsets[key] = (view['byteOffset'], view['byteLength'])
        else:
            assert data == binary[start:start + original_doc['bufferViews'][index]['byteLength']]
    after = pack_glb(doc, output)
    # Validate every non-image field and accessor payload, not only a few animated poses.
    verified, verified_binary = unpack_glb(after)
    for key in original_doc:
        if key not in ('images', 'buffers', 'bufferViews'):
            assert verified[key] == original_doc[key], key
    for index, old in enumerate(original_doc['bufferViews']):
        new = verified['bufferViews'][index]
        if index not in image_views:
            assert binary[old.get('byteOffset', 0):old.get('byteOffset', 0) + old['byteLength']] == verified_binary[new['byteOffset']:new['byteOffset'] + new['byteLength']]
    if len(after) >= len(before):
        after = before
    archive = backup(path, before)
    if after != before:
        atomic_write(path, after)
    return {'before': len(before), 'after': len(after), 'sha256': digest(after), 'original': archive, 'methods': dict(stats)}


def optimize_png(path, background=False):
    before = path.read_bytes()
    after, mime, method = optimize_image(before, color=background, background=background)
    target = path.with_suffix('.jpg') if mime == 'image/jpeg' else path
    archive = backup(path, before)
    atomic_write(target, after)
    if target != path:
        path.unlink()  # Exact original was archived above; avoid shipping both copies.
    return {'before': len(before), 'after': len(after), 'sha256': digest(after), 'original': archive, 'output': str(target.relative_to(ROOT)), 'method': method}


def restore_quantized_pngs(report):
    """Undo the legacy pngquant pass from verified originals without re-encoding JPEGs."""
    targets = [(name, entry) for name, entry in report.items()
               if entry.get('methods', {}).get('pngquant', 0) or entry.get('method') == 'pngquant']
    # Check every source before writing, so missing local backups fail safely.
    for name, entry in targets:
        current = ROOT / entry.get('output', name)
        original = ROOT / entry['original']
        if digest(current.read_bytes()) != entry['sha256']:
            raise ValueError(f'Asset changed since optimization; review before restoring: {name}')
        if digest(original.read_bytes()) != original.relative_to(ARCHIVE / 'originals').parts[0]:
            raise ValueError(f'Original backup hash mismatch: {name}')
    restored = 0
    for name, entry in targets:
        path = ROOT / entry.get('output', name)
        before = path.read_bytes()
        original = (ROOT / entry['original']).read_bytes()
        if name.endswith('.glb'):
            doc, binary = unpack_glb(before)
            old_doc, old_binary = unpack_glb(original)
            def payload(document, data, view_index):
                view = document['bufferViews'][view_index]
                offset = view.get('byteOffset', 0)
                return data[offset:offset + view['byteLength']]
            replacements = {}
            changed = 0
            for index, image in enumerate(doc.get('images', [])):
                if image['mimeType'] != 'image/png':
                    continue
                old_image = old_doc['images'][index]
                assert old_image['mimeType'] == 'image/png'
                raw = payload(old_doc, old_binary, old_image['bufferView'])
                if raw != payload(doc, binary, image['bufferView']):
                    replacements[image['bufferView']] = raw
                    changed += 1
            assert changed == entry['methods']['pngquant'], name
            output = bytearray()
            image_views = {image['bufferView'] for image in doc.get('images', [])}
            offsets = {}
            deduplicated = 0
            for index, view in enumerate(doc['bufferViews']):
                raw = replacements.get(index, payload(doc, binary, index))
                key = digest(raw)
                if index in image_views and key in offsets:
                    view['byteOffset'], view['byteLength'] = offsets[key]
                    deduplicated += len(raw)
                    continue
                output.extend(b'\0' * (-len(output) % 4))
                view['byteOffset'], view['byteLength'] = len(output), len(raw)
                output.extend(raw)
                if index in image_views:
                    offsets[key] = (view['byteOffset'], view['byteLength'])
            after = pack_glb(doc, output)
            entry['methods']['preserved'] = entry['methods'].get('preserved', 0) + changed
            entry['methods'].pop('pngquant')
            entry['methods']['deduplicatedBytes'] = deduplicated
            restored += changed
        else:
            after = original
            entry['method'] = 'preserved'
            restored += 1
        backup(path, before)
        atomic_write(path, after)
        entry.update(after=len(after), sha256=digest(after))
        atomic_write(REPORT, (json.dumps(report, indent=2) + '\n').encode())
    print(f'Restored {restored} PNG images in {len(targets)} assets; JPEG payloads unchanged.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ids', nargs='+', help='Optimize selected GLBs only')
    parser.add_argument('--restore-quantized-pngs', action='store_true', help='Restore legacy pngquant results from local backups; retain existing JPEGs')
    args = parser.parse_args()
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    prior_report = REPORT if REPORT.exists() else ARCHIVE / 'report.json'
    report = json.loads(prior_report.read_text()) if prior_report.exists() else {}
    if args.restore_quantized_pngs:
        if args.ids:
            parser.error('--restore-quantized-pngs restores all affected PNGs; do not combine with --ids')
        restore_quantized_pngs(report)
    paths = [ROOT / 'public/models' / f'{int(id):03d}' / 'model.glb' for id in args.ids] if args.ids else sorted((ROOT / 'public/models').glob('*/model.glb'))

    def work(path):
        key = str(path.relative_to(ROOT))
        old = report.get(key)
        if old and digest(path.read_bytes()) == old['sha256']:
            return key, old
        result = optimize_glb(path)
        print(f'{key}: {result["before"] / 1048576:.2f} -> {result["after"] / 1048576:.2f} MiB', flush=True)
        return key, result

    with ThreadPoolExecutor(max_workers=4) as pool:
        for key, result in pool.map(work, paths):
            report[key] = result
            atomic_write(REPORT, (json.dumps(report, indent=2) + '\n').encode())
    if not args.ids:
        for path in [*sorted((ROOT / 'public/backdrops').glob('*.png')), *sorted((ROOT / 'public/assets').glob('*.png')), *sorted((ROOT / 'public/models').glob('*/icon.png'))]:
            key = str(path.relative_to(ROOT))
            if key in report and digest(path.read_bytes()) == report[key]['sha256']:
                continue
            report[key] = optimize_png(path, background='models' not in path.parts)
            atomic_write(REPORT, (json.dumps(report, indent=2) + '\n').encode())
    manifest_path = ROOT / 'src/content/animatedModels.json'
    manifest = json.loads(manifest_path.read_text())
    for entry in manifest.values():
        entry['bytes'] = (ROOT / 'public' / entry['model']).stat().st_size
    atomic_write(manifest_path, (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode())
    before = sum(r['before'] for r in report.values())
    after = sum(r['after'] for r in report.values())
    print(f'Total: {before / 1048576:.2f} -> {after / 1048576:.2f} MiB; saved {(before-after) / 1048576:.2f} MiB', flush=True)


if __name__ == '__main__':
    main()
