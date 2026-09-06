"""Build and export the river sanctuary in Blender, executed through Blender MCP.

Prepare topology with: node scripts/prepare-ecology-geometry.mjs
Then run this source in the connected Blender instance. The existing scene is
preserved; a separate scene and collection own every authored object. Re-running
rebuilds only the collection tagged with this generator's unique identity.
"""
import bpy
import bmesh
import gzip
import json
import math
from pathlib import Path
from mathutils import Vector

ROOT = Path('/Users/06wj/Documents/github/pokemon')
RECIPE = Path('/tmp/pokemon-ecology-geometry.json.gz')
ASSET = ROOT / 'public/habitats/ecology.glb'
SOURCE = ROOT / 'assets/ecology-sanctuary.blend'
PREVIEW = ROOT / 'artifacts/ecology-blender-preview.png'
TAG = 'pokemon-ecology-sanctuary-v1'

if bpy.context.mode != 'OBJECT':
    bpy.ops.object.mode_set(mode='OBJECT')

with gzip.open(RECIPE, 'rt') as stream:
    recipe = json.load(stream)

# This scene is the only scene this generator ever updates.
scene = next((item for item in bpy.data.scenes if item.get('generator') == TAG), None)
if scene is None:
    scene = bpy.data.scenes.new('Ecology Sanctuary · River & Grove')
    scene['generator'] = TAG
    scene['description'] = 'Hand-composed coastal habitat: flowering meadow, fruit grove, winding stream, timber bridge, warm sandstone, scalloped sandy beaches and tidal rocks.'
    scene['coordinate_contract'] = 'Game Y-up: ellipse x±13,z±10, ground y=0; stream center=3.2+sin(z*.3)*1.25, halfWidth=1.25.'
    scene['blender_mcp_authored'] = True
bpy.context.window.scene = scene
for collection in list(scene.collection.children):
    if collection.get('generator') == TAG:
        for obj in list(collection.all_objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(collection)

landscape = bpy.data.collections.new('Sanctuary · export geometry')
landscape['generator'] = TAG
scene.collection.children.link(landscape)
studio = bpy.data.collections.new('Sanctuary · preview studio')
studio['generator'] = TAG
scene.collection.children.link(studio)

for item in recipe['meshes']:
    name = item['name'].replace('ecology / ', '')
    flat = item['positions']
    # Author in Blender Z-up; glTF's exporter restores the runtime Y-up frame.
    vertices = [(flat[i], -flat[i + 2], flat[i + 1]) for i in range(0, len(flat), 3)]
    faces = [(i, i + 1, i + 2) for i in range(0, len(vertices), 3)]
    mesh = bpy.data.meshes.new('Sanctuary topology · ' + name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.000004)
    bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=0.000001)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = bpy.data.objects.new('Ecology · ' + name, mesh)
    landscape.objects.link(obj)
    obj['generator'] = TAG
    obj['runtime_role'] = 'water' if name == 'stream and waterfalls' else 'fireflies' if name == 'evening fireflies' else 'landscape'
    material = bpy.data.materials.new('Ecology · ' + name)
    material.diffuse_color = tuple(item['color'])
    material.use_nodes = True
    principled = material.node_tree.nodes.get('Principled BSDF')
    principled.inputs['Base Color'].default_value = tuple(item['color'])
    principled.inputs['Roughness'].default_value = .94
    principled.inputs['Metallic'].default_value = item['metallic']
    material.use_backface_culling = False
    if obj['runtime_role'] == 'water':
        principled.inputs['Base Color'].default_value = (.038, .31, .29, 1)
        principled.inputs['Roughness'].default_value = .28
        principled.inputs['Metallic'].default_value = .12
    elif obj['runtime_role'] == 'fireflies':
        principled.inputs['Emission Color'].default_value = (.8, .65, .16, 1)
        principled.inputs['Emission Strength'].default_value = 1.2
        obj.hide_render = True
    obj.data.materials.append(material)
    # Native Blender refinement gives deck edges a small highlight and keeps the
    # modifier editable in the source .blend. Flat terrain is never bevelled.
    if name in {'timber', 'timberLight', 'timberDark'}:
        bevel = obj.modifiers.new('Soft worn timber edges', 'BEVEL')
        bevel.width = .009
        bevel.segments = 2
        bevel.limit_method = 'ANGLE'
        bevel.angle_limit = .5
    if name in {'leaf', 'leafLight', 'leafSun', 'leafDark'}:
        # Layered crowns retain designed facets; individual leaf sprays remain
        # visible while the principal lobes have soft, coherent shading.
        for polygon in mesh.polygons:
            polygon.use_smooth = True

def aim(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat('-Z', 'Y').to_euler()

camera_data = bpy.data.cameras.new('Sanctuary preview camera')
camera = bpy.data.objects.new('Sanctuary preview camera', camera_data)
studio.objects.link(camera)
camera.location = (20, -29, 26)
camera_data.type = 'ORTHO'
camera_data.ortho_scale = 38
aim(camera, (0, 0, .4))
scene.camera = camera

# The editable source includes a simple ocean for material/shoreline review. It
# belongs to the preview studio; the web runtime uses its own animated sea shader.
sea_mesh = bpy.data.meshes.new('Sanctuary preview ocean surface')
sea_mesh.from_pydata([(-180, -180, -1.05), (180, -180, -1.05), (180, 180, -1.05), (-180, 180, -1.05)], [], [(0, 1, 2, 3)])
sea_mesh.update()
sea = bpy.data.objects.new('Sanctuary preview ocean · runtime replaces with shader', sea_mesh)
studio.objects.link(sea)
sea_material = bpy.data.materials.new('Sanctuary preview shallow turquoise sea')
sea_material.use_nodes = True
sea_shader = sea_material.node_tree.nodes.get('Principled BSDF')
sea_shader.inputs['Base Color'].default_value = (.055, .24, .28, 1)
sea_shader.inputs['Roughness'].default_value = .35
sea_shader.inputs['Metallic'].default_value = .2
sea_mesh.materials.append(sea_material)

for name, location, energy, size, rgb in [
    ('Dawn softbox', (-10, -9, 19), 1800, 10, (1.0, .86, .65)),
    ('Sky fill', (9, 5, 14), 1500, 12, (.67, .81, 1.0)),
    ('Grove rim', (-3, 13, 10), 1000, 8, (1.0, .90, .73)),
]:
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.shape = 'DISK'
    data.size = size
    data.color = rgb
    obj = bpy.data.objects.new(name, data)
    studio.objects.link(obj)
    obj.location = location
    aim(obj, (0, 0, 0))

world = bpy.data.worlds.new('Sanctuary warm paper atmosphere')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (.26, .34, .31, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = .6
scene.world = world
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = 1500
scene.render.resolution_y = 1100
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1

ASSET.parent.mkdir(parents=True, exist_ok=True)
SOURCE.parent.mkdir(parents=True, exist_ok=True)
PREVIEW.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='DESELECT')
for obj in landscape.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = next(iter(landscape.objects))
bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=str(ASSET), export_format='GLB', use_selection=True, use_active_scene=True,
                          export_apply=True, export_extras=True, export_yup=True,
                          export_animations=False, export_cameras=False, export_lights=False)
# Write only the sanctuary scene and its dependencies to a native editable file;
# the user's original scene and currently unsaved project stay in memory intact.
bpy.data.libraries.write(str(SOURCE), {scene}, fake_user=True, compress=True)
scene.render.filepath = str(PREVIEW)
result = {'scene': scene.name, 'collection': landscape.name, 'objects': len(landscape.objects),
          'triangles_before_bevel': sum(len(obj.data.polygons) for obj in landscape.objects),
          'glb': str(ASSET), 'glb_bytes': ASSET.stat().st_size, 'blend': str(SOURCE),
          'preview': str(PREVIEW), 'original_scene_preserved': bpy.data.scenes.get('Scene') is not None}
