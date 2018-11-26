import sys
import bpy
# print(sys.argv[-2])
# print(sys.argv[-1])
bpy.ops.wm.collada_import(filepath=sys.argv[-2])
bpy.ops.export_scene.gltf(filepath=sys.argv[-1])