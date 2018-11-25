"""Render missing transparent catalogue icons from the exported Gen1 models.

blender --background --factory-startup --python scripts/render-gen1-icons.py -- --ids 092 097
Existing icons are retained unless --overwrite is explicitly supplied.
"""

import argparse
from pathlib import Path
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]


def render_icon(number, overwrite=False):
    directory = ROOT / 'public' / 'models' / f'{number:03d}'
    destination = directory / 'icon.png'
    if destination.exists() and not overwrite:
        print(f'GEN1_ICON {number:03d}: existing icon retained', flush=True)
        return
    model = directory / 'model.glb'
    if not model.is_file():
        raise FileNotFoundError(model)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    scene = bpy.context.scene
    scene.frame_set(0)
    bpy.context.view_layer.update()
    # The glTF importer can create a hidden Icosphere for bone display. It must
    # not enlarge the camera bounds of small/floating Pokemon.
    meshes = [obj for obj in scene.objects if obj.type == 'MESH' and not obj.hide_render
              and any(not collection.hide_render for collection in obj.users_collection)]
    # A small static Gastly thumbnail needs the eyes to remain visible through
    # its surrounding animated smoke shell. This affects this render only.
    if number == 92:
        for obj in meshes:
            if 'smoke' not in obj.name.lower():
                continue
            for slot in obj.material_slots:
                material = slot.material
                if material is None or not material.use_nodes:
                    continue
                for shader in list(material.node_tree.nodes):
                    if shader.type != 'BSDF_PRINCIPLED':
                        continue
                    alpha = shader.inputs['Alpha']
                    if alpha.is_linked:
                        original = alpha.links[0].from_socket
                        multiply = material.node_tree.nodes.new('ShaderNodeMath')
                        multiply.operation = 'MULTIPLY'
                        multiply.inputs[1].default_value = 0.35
                        material.node_tree.links.new(original, multiply.inputs[0])
                        material.node_tree.links.new(multiply.outputs[0], alpha)
                    else:
                        alpha.default_value *= 0.35
    graph = bpy.context.evaluated_depsgraph_get()
    corners = [obj.matrix_world @ Vector(corner)
               for original in meshes
               for obj in [original.evaluated_get(graph)]
               for corner in obj.bound_box]
    if not corners:
        raise RuntimeError(f'{number:03d}: model has no visible mesh')
    low = Vector(tuple(min(corner[i] for corner in corners) for i in range(3)))
    high = Vector(tuple(max(corner[i] for corner in corners) for i in range(3)))
    centre = (low + high) * 0.5
    extent = max(high - low)

    camera_data = bpy.data.cameras.new('Catalogue Camera')
    camera = bpy.data.objects.new('Catalogue Camera', camera_data)
    scene.collection.objects.link(camera)
    # The exported Y-up game model is imported into Blender's Z-up space.
    # This front three-quarter view shows both the face and silhouette.
    camera.location = centre + Vector((3.2, -7.0, 2.5)).normalized() * extent * 4
    camera.rotation_euler = (centre - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.type = 'ORTHO'
    camera_data.clip_end = extent * 20
    orientation = camera.rotation_euler.to_matrix()
    right = orientation @ Vector((1, 0, 0))
    up = orientation @ Vector((0, 1, 0))
    width = max(corner.dot(right) for corner in corners) - min(corner.dot(right) for corner in corners)
    height = max(corner.dot(up) for corner in corners) - min(corner.dot(up) for corner in corners)
    camera_data.ortho_scale = max(width, height) * 1.12
    scene.camera = camera

    def light(name, position, energy, size):
        data = bpy.data.lights.new(name, 'AREA')
        data.energy = energy * extent * extent
        data.shape = 'DISK'
        data.size = size * extent
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = centre + Vector(position) * extent
        obj.rotation_euler = (centre - obj.location).to_track_quat('-Z', 'Y').to_euler()

    light('Key', (-2, -3, 4), 180, 4)
    light('Fill', (3, -1, 1.5), 80, 3)
    light('Rim', (0, 2, 3), 130, 2)
    world = bpy.data.worlds.new('Catalogue World')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.7, 0.76, 0.85, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.45
    scene.world = world
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 4
    scene.render.resolution_x = 128
    scene.render.resolution_y = 128
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    scene.view_settings.view_transform = 'Standard'
    temporary = directory / 'icon.pending.png'
    scene.render.filepath = str(temporary)
    bpy.ops.render.render(write_still=True)
    temporary.replace(destination)
    print(f'GEN1_ICON {number:03d}: {destination}', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ids', type=int, nargs='+', default=[92, 97])
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    for number in args.ids:
        if not 1 <= number <= 151:
            raise ValueError('Gen1 IDs must be between 001 and 151')
        render_icon(number, args.overwrite)


if __name__ == '__main__':
    main()
