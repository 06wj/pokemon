"""Export regression tests; no Blender or third-party Python packages required."""
from copy import deepcopy
import unittest

from gen1_skinning import append_accessor, compact_glb, pack_glb, read_accessor, unpack_glb


def fixture(count=130, used=(2, 129), interleaved=False):
    document = {'asset': {'version': '2.0'}, 'buffers': [{}], 'bufferViews': [], 'accessors': [],
                'nodes': [{'name': f'joint-{i}', **({'children': [i + 1]} if i + 1 < count else {})}
                          for i in range(count)], 'meshes': [], 'skins': [], 'scenes': [{'nodes': [0]}], 'scene': 0}
    binary = bytearray()
    def add(rows, kind, shape):
        return append_accessor(document, binary, rows, kind, shape)
    vertices = [(1, 2, 3)] * len(used)
    positions = add(vertices, 5126, 'VEC3')
    indices = add([(j, 0, 1, 0) for j in used], 5123, 'VEC4')
    if interleaved:
        view = document['bufferViews'][document['accessors'][indices]['bufferView']]
        original = bytes(binary[view['byteOffset']:])
        del binary[view['byteOffset']:]
        for i in range(len(used)):
            binary.extend(b'\0' * 4 + original[i * 8:i * 8 + 8] + b'\0' * 4)
        view['byteLength'] = len(used) * 16
        view['byteStride'] = 16
        document['accessors'][indices]['byteOffset'] = 4
    weights = add([(255, 0, 0, 0)] * len(used), 5121, 'VEC4')
    document['accessors'][weights]['normalized'] = True
    matrices = add([tuple(1 if k in (0, 5, 10, 15) else i if k == 12 else 0 for k in range(16))
                    for i in range(count)], 5126, 'MAT4')
    primitive = {'attributes': {'POSITION': positions, 'JOINTS_0': indices, 'WEIGHTS_0': weights}, 'mode': 0}
    document['meshes'] = [{'name': 'shared', 'primitives': [primitive, deepcopy(primitive)]}]
    document['skins'] = [{'joints': list(range(count)), 'skeleton': 0, 'inverseBindMatrices': matrices}]
    # Two instances of one mesh/skin must continue sharing a single remapped binding.
    document['nodes'].extend([{'mesh': 0, 'skin': 0}, {'mesh': 0, 'skin': 0}])
    document['scenes'][0]['nodes'].extend([count, count + 1])
    # Animation and embedded image data must survive binary buffer compaction unchanged.
    time = add([(0,), (1,)], 5126, 'SCALAR')
    translations = add([(0, 0, 0), (0, 2, 0)], 5126, 'VEC3')
    document['animations'] = [{'samplers': [{'input': time, 'output': translations}],
                               'channels': [{'sampler': 0, 'target': {'node': count - 1, 'path': 'translation'}}]}]
    document['images'] = [{'mimeType': 'image/png', 'bufferView': len(document['bufferViews'])}]
    document['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': 8})
    binary.extend(b'\x89PNG\r\n\x1a\n')
    return pack_glb(document, binary)


class SkinPaletteTests(unittest.TestCase):
    def test_remaps_shared_mesh_without_losing_animation_or_ancestors(self):
        for interleaved in [False, True]:
            with self.subTest(interleaved=interleaved):
                source = fixture(interleaved=interleaved)
                before, original = unpack_glb(source)
                result, report = compact_glb(source)
                after, binary = unpack_glb(result)
                self.assertEqual(len(report), 1)
                self.assertEqual(after['skins'][0]['joints'], [2, 129])
                self.assertEqual(after['nodes'][:130], before['nodes'][:130])
                self.assertEqual(after['skins'][0]['skeleton'], 0)
                self.assertEqual(after['nodes'][130], after['nodes'][131])
                self.assertEqual(len(after['meshes']), 1)
                self.assertEqual(len(after['meshes'][0]['primitives']), 2)
                for old, new in zip(before['meshes'][0]['primitives'], after['meshes'][0]['primitives']):
                    a, b = old['attributes'], new['attributes']
                    self.assertEqual(read_accessor(after, binary, b['JOINTS_0']), [(0, 0, 0, 0), (1, 0, 0, 0)])
                    for field in ['POSITION', 'WEIGHTS_0']:
                        self.assertEqual(read_accessor(before, original, a[field]), read_accessor(after, binary, b[field]))
                    self.assertTrue(after['accessors'][b['WEIGHTS_0']]['normalized'])
                old_matrices = read_accessor(before, original, before['skins'][0]['inverseBindMatrices'])
                self.assertEqual(read_accessor(after, binary, after['skins'][0]['inverseBindMatrices']),
                                 [old_matrices[2], old_matrices[129]])
                self.assertEqual(after['animations'][0]['channels'], before['animations'][0]['channels'])
                for key in ['input', 'output']:
                    self.assertEqual(read_accessor(before, original, before['animations'][0]['samplers'][0][key]),
                                     read_accessor(after, binary, after['animations'][0]['samplers'][0][key]))
                image = after['bufferViews'][after['images'][0]['bufferView']]
                self.assertEqual(binary[image['byteOffset']:image['byteOffset'] + image['byteLength']], b'\x89PNG\r\n\x1a\n')
                self.assertEqual(compact_glb(result), (result, []), 'Repeated runs are byte-identical')

    def test_compacts_models_below_the_limit_too(self):
        for count in [3, 75, 128]:
            with self.subTest(count=count):
                data, report = compact_glb(fixture(count=count, used=(1, count - 1)))
                document, _ = unpack_glb(data)
                self.assertEqual(document['skins'][0]['joints'], [1, count - 1])
                self.assertEqual(report[0]['after'], 2)
                self.assertEqual(compact_glb(data), (data, []))

    def test_does_not_touch_a_fully_used_palette_at_the_limit(self):
        data = fixture(count=128, used=tuple(range(128)))
        self.assertEqual(compact_glb(data), (data, []))

    def test_shared_geometry_can_use_different_skeletons(self):
        document, binary = unpack_glb(fixture())
        second = deepcopy(document['skins'][0])
        second['joints'].reverse()
        document['skins'].append(second)
        document['nodes'][-1]['skin'] = 1
        result, report = compact_glb(pack_glb(document, binary))
        after, _ = unpack_glb(result)
        self.assertEqual(len(report), 2)
        self.assertEqual(len(after['meshes']), 2)
        self.assertEqual([skin['joints'] for skin in after['skins']], [[2, 129], [127, 0]])
        self.assertNotEqual(after['nodes'][-1]['skin'], after['nodes'][-2]['skin'])

    def test_preserves_even_tiny_nonzero_influences(self):
        document, original = unpack_glb(fixture())
        binary = bytearray(original)
        values = [(0.999999, 0.000001, 0, 0)] * 2
        index = append_accessor(document, binary, values, 5126, 'VEC4')
        for primitive in document['meshes'][0]['primitives']:
            primitive['attributes']['WEIGHTS_0'] = index
        source = pack_glb(document, binary)
        result, _ = compact_glb(source)
        after, output = unpack_glb(result)
        self.assertEqual(after['skins'][0]['joints'], [0, 2, 129])
        for primitive in after['meshes'][0]['primitives']:
            self.assertEqual(read_accessor(after, output, primitive['attributes']['WEIGHTS_0']),
                             read_accessor(document, binary, index))

    def test_refuses_to_drop_influences_from_a_mesh_that_really_exceeds_the_limit(self):
        with self.assertRaisesRegex(ValueError, 'actually uses 129 joints'):
            compact_glb(fixture(used=tuple(range(129))))


if __name__ == '__main__':
    unittest.main()
