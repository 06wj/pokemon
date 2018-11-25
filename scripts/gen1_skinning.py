"""Compact every glTF skin palette without changing geometry or animation.

Also works on existing exports: python3 scripts/gen1_skinning.py --all
Only the standard, uncompressed GLB data written by export-gen1.py is accepted.
"""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import struct

MAX_SKIN_JOINTS = 128
ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
WIDTHS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def unpack_glb(data):
    magic, version, size = struct.unpack_from('<III', data)
    if (magic, version, size) != (0x46546C67, 2, len(data)):
        raise ValueError('Expected a complete glTF 2 GLB')
    length, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4E4F534A:
        raise ValueError('Expected a JSON chunk')
    document = json.loads(data[20:20 + length])
    size, kind = struct.unpack_from('<II', data, 20 + length)
    if kind != 0x004E4942 or 28 + length + size != len(data):
        raise ValueError('Expected one embedded binary chunk')
    if len(document['buffers']) != 1 or 'uri' in document['buffers'][0]:
        raise ValueError('Expected one self-contained buffer')
    return document, data[28 + length:28 + length + document['buffers'][0]['byteLength']]


def pack_glb(document, binary):
    document['buffers'][0]['byteLength'] = len(binary)
    content = json.dumps(document, separators=(',', ':'), ensure_ascii=False).encode()
    content += b' ' * (-len(content) % 4)
    binary = bytes(binary) + b'\0' * (-len(binary) % 4)
    return (struct.pack('<IIIII', 0x46546C67, 2, 28 + len(content) + len(binary), len(content), 0x4E4F534A)
            + content + struct.pack('<II', len(binary), 0x004E4942) + binary)


def read_accessor(document, binary, index):
    accessor = document['accessors'][index]
    if 'sparse' in accessor:
        raise ValueError('Skin palette compaction requires dense joint and weight accessors')
    view = document['bufferViews'][accessor['bufferView']]
    fmt = '<' + COMPONENTS[accessor['componentType']] * WIDTHS[accessor['type']]
    size = struct.calcsize(fmt)
    stride = view.get('byteStride', size)
    offset = accessor.get('byteOffset', 0)
    if view['buffer'] != 0 or offset + max(0, accessor['count'] - 1) * stride + size > view['byteLength']:
        raise ValueError('Accessor exceeds its embedded buffer view')
    start = view.get('byteOffset', 0) + offset
    return [struct.unpack_from(fmt, binary, start + row * stride) for row in range(accessor['count'])]


def append_accessor(document, binary, rows, component_type, value_type):
    binary.extend(b'\0' * (-len(binary) % 4))
    offset = len(binary)
    fmt = '<' + COMPONENTS[component_type] * WIDTHS[value_type]
    for row in rows:
        binary.extend(struct.pack(fmt, *row))
    view_index = len(document['bufferViews'])
    document['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(binary) - offset})
    index = len(document['accessors'])
    document['accessors'].append({'bufferView': view_index, 'componentType': component_type,
                                  'count': len(rows), 'type': value_type})
    return index


def prune_data(document, binary):
    """Remove replaced palettes/streams, preserving every live accessor and image byte."""
    def compact_table(name, references):
        used = sorted({obj[key] for obj, key in references})
        mapping = {old: new for new, old in enumerate(used)}
        document[name] = [document[name][old] for old in used]
        for obj, key in references:
            obj[key] = mapping[obj[key]]

    for table, key in [('meshes', 'mesh'), ('skins', 'skin')]:
        compact_table(table, [(node, key) for node in document['nodes'] if key in node])
    references = []
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            references.extend((primitive['attributes'], key) for key in primitive['attributes'])
            if 'indices' in primitive:
                references.append((primitive, 'indices'))
            for target in primitive.get('targets', []):
                references.extend((target, key) for key in target)
    references.extend((skin, 'inverseBindMatrices') for skin in document['skins'] if 'inverseBindMatrices' in skin)
    for clip in document.get('animations', []):
        for sampler in clip['samplers']:
            references.extend([(sampler, 'input'), (sampler, 'output')])
    # Shared mesh accessors can appear in several primitives; remap each field once.
    references = list({(id(obj), key): (obj, key) for obj, key in references}.values())
    compact_table('accessors', references)
    views = [(a, 'bufferView') for a in document['accessors'] if 'bufferView' in a]
    for accessor in document['accessors']:
        if 'sparse' in accessor:
            views.extend((accessor['sparse'][part], 'bufferView') for part in ['indices', 'values'])
    views.extend((image, 'bufferView') for image in document.get('images', []) if 'bufferView' in image)
    compact_table('bufferViews', views)
    result = bytearray()
    for view in document['bufferViews']:
        result.extend(b'\0' * (-len(result) % 4))
        start = view.get('byteOffset', 0)
        chunk = binary[start:start + view['byteLength']]
        if view['buffer'] != 0 or len(chunk) != view['byteLength']:
            raise ValueError('Buffer view exceeds the embedded buffer')
        view['byteOffset'] = len(result)
        result.extend(chunk)
    return result


def compact_glb(data):
    document, original_binary = unpack_glb(data)
    if not document.get('skins'):
        return data, []
    # Extension-specific accessor references need their own remapping rules.
    if any(not name.startswith('KHR_materials_') and name != 'KHR_texture_transform'
           for name in document.get('extensionsUsed', [])):
        raise ValueError('Skin palette compaction requires standard uncompressed geometry and animation')
    binary = bytearray(original_binary)
    reports = []
    bindings = {}
    palettes = {}
    for node in document['nodes']:
        if 'skin' not in node or 'mesh' not in node:
            continue
        source_skin = node['skin']
        skin = document['skins'][source_skin]
        binding = (node['mesh'], source_skin)
        if binding in bindings:
            node['mesh'], node['skin'] = bindings[binding]
            continue
        mesh = deepcopy(document['meshes'][node['mesh']])
        streams = []
        used = set()
        for primitive in mesh['primitives']:
            attrs = primitive['attributes']
            if 'JOINTS_0' not in attrs or 'WEIGHTS_0' not in attrs:
                raise ValueError('Skinned primitives require joints and weights')
            for key in sorted(k for k in attrs if k.startswith('JOINTS_')):
                joint_accessor = document['accessors'][attrs[key]]
                weight_index = attrs['WEIGHTS_' + key[7:]]
                weight_accessor = document['accessors'][weight_index]
                if (joint_accessor['type'] != 'VEC4' or joint_accessor['componentType'] not in (5121, 5123)
                        or joint_accessor.get('normalized', False) or weight_accessor['type'] != 'VEC4'):
                    raise ValueError('Expected unsigned VEC4 joints and VEC4 weights')
                joints = read_accessor(document, binary, attrs[key])
                weights = read_accessor(document, binary, weight_index)
                if len(joints) != len(weights):
                    raise ValueError('Joint/weight counts differ')
                for indices, values in zip(joints, weights):
                    for joint, weight in zip(indices, values):
                        if not 0 <= joint < len(skin['joints']) or not 0 <= weight < float('inf'):
                            raise ValueError('Invalid joint index or skin weight')
                        if weight > 0:
                            used.add(joint)
                streams.append((attrs, key, joints, weights))
        if not used or len(used) > MAX_SKIN_JOINTS:
            raise ValueError(f"{mesh.get('name', node['mesh'])} actually uses {len(used)} joints; "
                             'triangle partitioning is required, no weights have been discarded')
        # A compact mesh already references only live influences. Keep its streams and
        # bindings intact, including when other meshes in this file still need compaction.
        if len(used) == len(skin['joints']):
            continue
        ordered = tuple(sorted(used))
        remap = {old: new for new, old in enumerate(ordered)}
        for attrs, key, joints, weights in streams:
            rows = [tuple(remap[joint] if weight > 0 else 0 for joint, weight in zip(indices, values))
                    for indices, values in zip(joints, weights)]
            attrs[key] = append_accessor(document, binary, rows, 5121, 'VEC4')
        palette_key = (source_skin, ordered)
        if palette_key not in palettes:
            compact = deepcopy(skin)
            compact['joints'] = [skin['joints'][joint] for joint in ordered]
            if 'inverseBindMatrices' in skin:
                accessor = document['accessors'][skin['inverseBindMatrices']]
                if accessor['type'] != 'MAT4' or accessor['componentType'] != 5126:
                    raise ValueError('Expected float inverse bind matrices')
                matrices = read_accessor(document, binary, skin['inverseBindMatrices'])
                compact['inverseBindMatrices'] = append_accessor(document, binary,
                    [matrices[joint] for joint in ordered], 5126, 'MAT4')
            palettes[palette_key] = len(document['skins'])
            document['skins'].append(compact)
        node['skin'] = palettes[palette_key]
        node['mesh'] = len(document['meshes'])
        document['meshes'].append(mesh)
        bindings[binding] = (node['mesh'], node['skin'])
        reports.append({'mesh': node.get('name', mesh.get('name')), 'before': len(skin['joints']), 'after': len(used)})
    if not reports:
        return data, []
    binary = prune_data(document, binary)
    return pack_glb(document, binary), reports


def compact_file(path):
    data, reports = compact_glb(path.read_bytes())
    if reports:
        temporary = path.with_suffix('.skin-pending.glb')
        temporary.write_bytes(data)
        temporary.replace(path)
    return len(data), reports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--all', action='store_true')
    group.add_argument('--ids', nargs='+', type=int)
    args = parser.parse_args()
    path = ROOT / 'src/content/animatedModels.json'
    manifest = json.loads(path.read_text())
    for number in range(1, 152) if args.all else args.ids:
        key = f'{number:03d}'
        entry = manifest[key]
        size, reports = compact_file(ROOT / 'public' / entry['model'])
        if reports or entry['bytes'] != size:
            entry['bytes'] = size
            temporary = path.with_suffix('.pending.json')
            temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
            temporary.replace(path)
            print(json.dumps({'id': key, 'bytes': size, 'meshes': reports}, ensure_ascii=False))


if __name__ == '__main__':
    main()
