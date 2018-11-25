"""Export the ordinary Gen1 forms without modifying the Blender sources.

blender --background --factory-startup --python scripts/export-gen1.py -- --ids 001 003 005
blender --background --factory-startup --python scripts/export-gen1.py -- --all
"""
import argparse
import json
from pathlib import Path
import re
import struct
import sys

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
EXPORT_VERSION = 4
sys.path.insert(0, str(ROOT / 'scripts'))
from gen1_materials import prepare_materials
from gen1_skinning import compact_file

# This import stores the rolling form as a separately hidden mesh and omits its
# visibility animation. The weights identify two disjoint skeletal branches.
# Encode the source correction in ordinary glTF scale tracks, so every renderer
# and animation consumer sees the same form without species-specific runtime code.
ROLLING_FORM = {
    28: {
        'mesh': 'pm0028_00_00_ball_mesh_shape',
        'clip': 'run',
        'rolling_bones': ('feeler',),
        'standing_bones': ('spine_01', 'hips'),
    },
}


def source_file(number):
    base = ROOT / 'source' / 'Gen1'
    for name in (f'pm{number:04d}_00.blend', f'pm{number:04d}.blend'):
        path = base / name
        if path.is_file():
            return path
    raise RuntimeError(f'No ordinary form source for {number:03d}')


def belongs_to(obj, rig):
    parent = obj.parent
    while parent:
        if parent == rig:
            return True
        parent = parent.parent
    return any(mod.type == 'ARMATURE' and mod.object == rig for mod in obj.modifiers)


def source_rig(number):
    rigs = sorted((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), key=lambda o: o.name)
    base = f'pm{number:04d}_00'
    # Bare-name source files can contain both sexes and several regional forms.
    # Select the exact ordinary rig before collecting its children/modifiers.
    names = (f'{base}_00', f'{base}_00.trmdl', base)
    if number == 12:
        names += ('012Butterfree',)
    for name in names:
        rig = next((o for o in rigs if o.name == name), None)
        if rig is not None:
            return rig
    if len(rigs) == 1:
        return rigs[0]
    raise RuntimeError(f'{number:03d}: ambiguous ordinary armature: {[o.name for o in rigs]}')


def ordinary_actions(number):
    base = f'pm{number:04d}_00'
    actions = []
    for prefix in (f'{base}_00_', f'{base}_'):
        actions = sorted(
            (a for a in bpy.data.actions if a.name.startswith(prefix) and a.frame_range[1] > a.frame_range[0]),
            key=lambda a: (bool(re.search(r'\.\d{3}$', a.name)), a.name),
        )
        if actions:
            break
    return actions


def idle_action(number):
    actions = ordinary_actions(number)
    # Older imports name their repeating waits by context instead of "loop".
    # Explicit suffixes avoid selecting wait/run or battle/pet transitions.
    suffix = r'(?:\.gfbanm)?(?:\.\d{3})?$'
    patterns = (
        r'defaultwait\d*_loop' + suffix,
        r'_kw01_wait01' + suffix,
        r'_fi01_wait01' + suffix,
        r'_ba10_waitA01' + suffix,
        r'battlewait\d*_loop' + suffix,
        r'(?:wait|idle)\d*_loop' + suffix,
    )
    for pattern in patterns:
        action = next((a for a in actions if re.search(pattern, a.name, re.I)), None)
        if action is not None:
            return action
    raise RuntimeError(f'{number:03d}: no ordinary idle animation')


def selected_actions(number):
    """A compact showcase set; transition, facial-index and alternate-form clips stay in source."""
    actions = ordinary_actions(number)
    selected = [('idle', '待机', idle_action(number))]
    suffix = r'(?:\.gfbanm)?(?:\.\d{3})?$'
    groups = [
        ('walk', '行走', [r'_walk\d*_loop', r'_fi20_walk01']),
        ('run', '奔跑', [r'_run\d*_loop', r'_fi21_run01']),
        ('attack', '攻击', [r'_attack01', r'_attack\d+', r'_ba20_buturi01', r'_ba21_tokusyu01', r'_rangeattack01']),
        ('happy', '开心', [r'_glad\d+', r'_kw32_happyB01']),
        ('sleep', '睡眠', [r'_sleep\d*_loop', r'_kw20_drowseB01']),
    ]
    for name, label, patterns in groups:
        match = next((action for pattern in patterns for action in actions
                      if re.search(pattern + suffix, action.name, re.I)), None)
        if match:
            selected.append((name, label, match))
    return selected


def make_in_place(action):
    """The imported origin bone is Y-up; keep vertical bounce and remove horizontal travel."""
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    if re.fullmatch(r'pose\.bones\["origin"\]\.location', curve.data_path, re.I) and curve.array_index in (0, 2):
                        start = curve.evaluate(action.frame_range[0])
                        for point in curve.keyframe_points:
                            point.co.y = point.handle_left.y = point.handle_right.y = start
                        curve.update()


def preserve_unkeyed_pose(action, baseline):
    """ACTIONS export resets bones. Preserve authored defaults, including hidden LOD scales."""
    bag = action.layers[0].strips[0].channelbag(action.slots[0], ensure=True)
    existing = {(curve.data_path, curve.array_index) for layer in action.layers
                for strip in layer.strips for channelbag in strip.channelbags
                for curve in channelbag.fcurves}
    start = action.frame_range[0]
    for path, values in baseline:
        for component, value in enumerate(values):
            if (path, component) not in existing:
                curve = bag.fcurves.new(data_path=path, index=component)
                curve.keyframe_points.insert(start, value)


def apply_form_visibility(number, name, action):
    correction = ROLLING_FORM.get(number)
    if not correction:
        return
    hidden = correction['standing_bones'] if name == correction['clip'] else correction['rolling_bones']
    bag = action.layers[0].strips[0].channelbag(action.slots[0], ensure=True)
    for bone in hidden:
        path = f'pose.bones["{bone}"].scale'
        for axis in range(3):
            curve = next((c for c in bag.fcurves if c.data_path == path and c.array_index == axis), None)
            if curve is None:
                curve = bag.fcurves.new(data_path=path, index=axis)
            curve.keyframe_points.clear()
            curve.keyframe_points.insert(action.frame_range[0], 0)


def has_visible_motion(rig, meshes, action):
    """Reject stationary showcase clips after removing travel and applying forms.

    Test evaluated geometry rather than just channels: an action may animate only
    an unweighted helper, or become stationary once horizontal travel is removed.
    Irregular samples avoid aliasing short repeating motions at common fractions.
    """
    rig.animation_data.action = action
    rig.animation_data.action_slot = action.slots[0]
    start, end = action.frame_range
    reference = None
    reference_visible = None
    tolerance = None
    area_thresholds = {}
    for mesh in meshes:
        vertices = np.empty(len(mesh.data.vertices) * 3, dtype=np.float64)
        mesh.data.vertices.foreach_get('co', vertices)
        vertices = vertices.reshape((-1, 3)) @ np.asarray(mesh.matrix_world)[:3, :3].T
        area_thresholds[mesh.name] = max(float(np.sum(np.ptp(vertices, axis=0) ** 2)) * 1e-12, 1e-20)
    for fraction in (0, .113, .257, .419, .577, .733, .887, 1):
        frame = start + (end - start) * fraction
        whole = int(np.floor(frame))
        bpy.context.scene.frame_set(whole, subframe=frame - whole)
        graph = bpy.context.evaluated_depsgraph_get()
        parts = []
        visible_parts = []
        for mesh in meshes:
            evaluated = mesh.evaluated_get(graph)
            geometry = evaluated.to_mesh()
            try:
                vertices = np.empty(len(geometry.vertices) * 3, dtype=np.float64)
                geometry.vertices.foreach_get('co', vertices)
                vertices = vertices.reshape((-1, 3))
                world = np.asarray(evaluated.matrix_world)
                positions = vertices @ world[:3, :3].T + world[:3, 3]
                geometry.calc_loop_triangles()
                triangles = np.empty(len(geometry.loop_triangles) * 3, dtype=np.int32)
                geometry.loop_triangles.foreach_get('vertices', triangles)
                triangles = triangles.reshape((-1, 3))
                corners = positions[triangles]
                double_area = np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0],
                                                     corners[:, 2] - corners[:, 0]), axis=1)
                active = double_area > area_thresholds[mesh.name]
                visible = np.zeros(len(positions), dtype=bool)
                visible[triangles[active].reshape(-1)] = True
                parts.append(positions)
                visible_parts.append(visible)
            finally:
                evaluated.to_mesh_clear()
        positions = np.concatenate(parts)
        visible = np.concatenate(visible_parts)
        if not np.isfinite(positions).all():
            raise RuntimeError(f'{action.name}: evaluated animation has non-finite vertices')
        if reference is None:
            reference = positions
            reference_visible = visible
            if not visible.any():
                continue
            tolerance = max(float(np.linalg.norm(np.ptp(positions[visible], axis=0))) * 1e-5, 1e-7)
        elif positions.shape != reference.shape:
            raise RuntimeError(f'{action.name}: animated topology is unsupported')
        else:
            shown = visible | reference_visible
            if shown.any():
                if tolerance is None:
                    tolerance = max(float(np.linalg.norm(np.ptp(positions[shown], axis=0))) * 1e-5, 1e-7)
                if np.max(np.abs(positions[shown] - reference[shown])) > tolerance:
                    return True
    return False


def export_model(number):
    path = source_file(number)
    bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False)
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    rig = source_rig(number)
    form = ROLLING_FORM.get(number)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and belongs_to(o, rig)
              and (not o.hide_render or (form and o.name == form['mesh']))]
    if not meshes:
        raise RuntimeError(f'{number:03d}: no visible meshes')
    if form:
        if not any(mesh.name == form['mesh'] for mesh in meshes):
            raise RuntimeError(f'{number:03d}: rolling form mesh is missing')
        if any(name not in rig.pose.bones for name in (*form['rolling_bones'], *form['standing_bones'])):
            raise RuntimeError(f'{number:03d}: rolling form skeleton does not match the source correction')
    for mesh in meshes:
        mesh.hide_set(False)
        mesh.hide_viewport = False
        mesh.hide_render = False
    selected = selected_actions(number)
    clip_report = []
    rig.animation_data_create()
    for track in list(rig.animation_data.nla_tracks):
        rig.animation_data.nla_tracks.remove(track)
    rig.animation_data.action = selected[0][2]
    rig.animation_data.action_slot = selected[0][2].slots[0]
    bpy.context.scene.frame_set(int(selected[0][2].frame_range[0]))
    bpy.context.view_layer.update()
    baseline = []
    for bone in rig.pose.bones:
        rotation = ('rotation_quaternion' if bone.rotation_mode == 'QUATERNION'
                    else 'rotation_axis_angle' if bone.rotation_mode == 'AXIS_ANGLE' else 'rotation_euler')
        for attribute in ('location', rotation, 'scale'):
            baseline.append((bone.path_from_id(attribute), tuple(getattr(bone, attribute))))
    for name, label, source_action in selected:
        action = source_action.copy()
        action.name = name
        preserve_unkeyed_pose(action, baseline)
        if name in ('walk', 'run'):
            make_in_place(action)
        apply_form_visibility(number, name, action)
        if name != 'idle' and not has_visible_motion(rig, meshes, action):
            print(f'GEN1_SKIP_STATIC {number:03d} {name} {source_action.name}', flush=True)
            rig.animation_data.action = None
            bpy.data.actions.remove(action)
            continue
        clip_report.append({'name': name, 'label': label, 'sourceAction': source_action.name,
                            'duration': (action.frame_range[1] - action.frame_range[0]) / (bpy.context.scene.render.fps / bpy.context.scene.render.fps_base)})
        if name == 'idle':
            idle = action
        else:
            track = rig.animation_data.nla_tracks.new()
            track.name = name
            track.mute = True
            strip = track.strips.new(name, int(action.frame_range[0]), action)
            strip.action_slot = action.slots[0]
    rig.animation_data.action = idle
    if len(idle.slots):
        rig.animation_data.action_slot = idle.slots[0]
    scene = bpy.context.scene
    scene.frame_start = int(idle.frame_range[0])
    scene.frame_end = int(idle.frame_range[1])
    scene.frame_set(scene.frame_start)
    bpy.context.view_layer.update()

    # The importer already rotates its Y-up game coordinates into Blender's Z-up.
    # glTF's Y-up conversion reverses that rotation without an ad-hoc per-species fix.
    material_report = prepare_materials(meshes)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [rig, *meshes]:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    target = ROOT / 'public' / 'models' / f'{number:03d}' / 'model.glb'
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name('model.pending.glb')
    bpy.ops.export_scene.gltf(
        filepath=str(temporary), export_format='GLB', use_selection=True,
        export_yup=True, export_apply=False, export_cameras=False, export_lights=False,
        export_animations=True, export_animation_mode='ACTIONS',
        export_anim_single_armature=False, export_frame_range=False,
        export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=True, export_skins=True,
        export_morph=False, export_materials='EXPORT', export_extras=False,
        export_vertex_color='NONE', export_all_vertex_colors=False,
    )
    _, skin_report = compact_file(temporary)
    data = temporary.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + length])
    if not gltf.get('skins') or not gltf.get('meshes') or not gltf.get('animations'):
        raise RuntimeError(f'{number:03d}: export lost geometry, skin, or animation')
    if {clip['name'] for clip in gltf['animations']} != {clip['name'] for clip in clip_report}:
        raise RuntimeError(f'{number:03d}: exported animation set does not match the selected actions')
    if any('uri' in image for image in gltf.get('images', [])):
        raise RuntimeError(f'{number:03d}: texture is not embedded')
    temporary.replace(target)
    entry = {
        'model': f'models/{number:03d}/model.glb',
        'exportVersion': EXPORT_VERSION,
        'idleAnimation': 'idle',
        'animations': clip_report,
        'source': path.name,
        'fps': scene.render.fps / scene.render.fps_base,
        'bytes': len(data),
    }
    print('GEN1_EXPORT ' + json.dumps({'id': f'{number:03d}', **entry, 'materials': material_report,
                                     'skinPalettes': skin_report}), flush=True)
    return entry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--ids', nargs='+', type=int, default=[1, 3, 5])
    parser.add_argument('--skip-existing', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    ids = range(1, 152) if args.all else args.ids
    manifest_path = ROOT / 'src' / 'content' / 'animatedModels.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for number in ids:
        if not 1 <= number <= 151:
            raise ValueError('Gen1 IDs must be between 001 and 151')
        key = f'{number:03d}'
        if args.skip_existing and key in manifest and manifest[key].get('exportVersion') == EXPORT_VERSION and (ROOT / 'public' / manifest[key]['model']).is_file():
            # The independent palette step upgrades existing exports without rebaking materials.
            size, report = compact_file(ROOT / 'public' / manifest[key]['model'])
            if report or manifest[key]['bytes'] != size:
                manifest[key]['bytes'] = size
                manifest_path.write_text(json.dumps(dict(sorted(manifest.items())), ensure_ascii=False, indent=2) + '\n')
                print('GEN1_SKINS ' + json.dumps({'id': key, 'skinPalettes': report}), flush=True)
            continue
        manifest[key] = export_model(number)
        manifest_path.write_text(json.dumps(dict(sorted(manifest.items())), ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
