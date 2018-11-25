"""Bake the Gen1 Blender shader graphs into self-contained glTF materials.

Run from Blender's Python runtime. The source files use layered colours and
shader groups which the glTF exporter cannot translate directly. Baking each
material on a full UV square retains texture detail even when the Pokemon's
mesh has mirrored/overlapping UVs. The source .blend files are never modified.
"""

import time
from pathlib import Path

import bpy
import numpy as np


def _copy_groups(tree, copies):
    for node in tree.nodes:
        if node.type == "GROUP" and node.node_tree:
            original = node.node_tree
            if original not in copies:
                copies[original] = original.copy()
                _copy_groups(copies[original], copies)
            node.node_tree = copies[original]


def _trees(tree):
    yield tree
    for node in tree.nodes:
        if node.type == "GROUP" and node.node_tree:
            yield from _trees(node.node_tree)


def _validate_image_sources(material):
    """Empty template slots are optional; assigned but missing files are errors."""
    for tree in set(_trees(material.node_tree)):
        for node in tree.nodes:
            if node.type != "TEX_IMAGE" or node.image is None:
                continue
            image = node.image
            packed = bool(image.packed_file or len(image.packed_files))
            if image.source in {"FILE", "TILED", "SEQUENCE", "MOVIE"} and not packed:
                path = Path(bpy.path.abspath(image.filepath, library=image.library))
                if not image.filepath or not path.is_file():
                    raise RuntimeError(f"{material.name}: assigned texture {image.name!r} is missing: {image.filepath!r}")
            if min(image.size) <= 0:
                raise RuntimeError(f"{material.name}: assigned texture {image.name!r} has no readable pixels")


def _resolve_empty_images(tree):
    """Disable unassigned layer/mask slots in a private shader-tree copy.

    Cycles evaluates image=None as error magenta, whose luminance would add an
    unintended 28.5% white mask to the eyes. Explicit black/zero values mean
    the absent layer is disabled and removing the texture nodes avoids errors.
    A missing direct roughness map uses its authored BSDF socket default.
    """
    for node_tree in set(_trees(tree)):
        for node in list(node_tree.nodes):
            if node.type != "TEX_IMAGE" or node.image is not None:
                continue
            for output in node.outputs:
                links = list(output.links)
                if not links:
                    continue
                replacement = node_tree.nodes.new("ShaderNodeValue" if output.name == "Alpha" else "ShaderNodeRGB")
                replacement.outputs[0].default_value = 0.0 if output.name == "Alpha" else (0.0, 0.0, 0.0, 0.0)
                for link in links:
                    if link.to_node.type == "BSDF_PRINCIPLED" and link.to_socket.name == "Roughness":
                        node_tree.links.remove(link)
                    else:
                        node_tree.links.new(replacement.outputs[0], link.to_socket)
            node_tree.nodes.remove(node)


def _connect_input(tree, original, target):
    if original.is_linked:
        source = original.links[0].from_socket
        if original.type == "VALUE" and target.type == "RGBA" and source.type != "VALUE":
            # Keep Blender's colour-to-value conversion at scalar BSDF sockets.
            # Wiring a colour texture straight to emission would bake only its
            # red component later instead of the original luminance value.
            scalar = tree.nodes.new("ShaderNodeMath")
            scalar.operation = "MULTIPLY"
            scalar.inputs[1].default_value = 1.0
            tree.links.new(source, scalar.inputs[0])
            tree.links.new(scalar.outputs[0], target)
        else:
            tree.links.new(source, target)
    else:
        value = original.default_value
        if target.type == "RGBA" and isinstance(value, (int, float)):
            target.default_value = (value, value, value, 1.0)
        else:
            target.default_value = value


def _channel_material(source, channel):
    """Replace surface closures with emission without changing their inputs."""
    material = source.copy()
    material.name = "_gen1_bake_" + source.name + "_" + channel
    copies = {}
    _copy_groups(material.node_tree, copies)
    _resolve_empty_images(material.node_tree)
    for tree in set(_trees(material.node_tree)):
        for node in list(tree.nodes):
            if node.type not in {
                "BSDF_PRINCIPLED", "BSDF_DIFFUSE", "BSDF_GLOSSY",
                "BSDF_GLASS", "BSDF_REFRACTION", "BSDF_TRANSLUCENT",
                "BSDF_TRANSPARENT", "EMISSION",
            }:
                continue
            shader_links = [link for socket in node.outputs for link in socket.links]
            if not shader_links:
                continue
            emission = tree.nodes.new("ShaderNodeEmission")
            emission.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
            emission.inputs["Strength"].default_value = 1.0
            if channel == "alpha":
                if node.type == "BSDF_PRINCIPLED":
                    _connect_input(tree, node.inputs["Alpha"], emission.inputs["Color"])
                elif node.type != "BSDF_TRANSPARENT":
                    emission.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
            elif channel == "base":
                colour = node.inputs.get("Base Color") or node.inputs.get("Color")
                if colour is not None:
                    _connect_input(tree, colour, emission.inputs["Color"])
            elif channel == "emission":
                if node.type == "BSDF_PRINCIPLED":
                    _connect_input(tree, node.inputs["Emission Color"], emission.inputs["Color"])
                    _connect_input(tree, node.inputs["Emission Strength"], emission.inputs["Strength"])
                elif node.type == "EMISSION":
                    _connect_input(tree, node.inputs["Color"], emission.inputs["Color"])
                    _connect_input(tree, node.inputs["Strength"], emission.inputs["Strength"])
            elif channel in {"roughness", "metallic"}:
                scalar = node.inputs.get("Roughness" if channel == "roughness" else "Metallic")
                if scalar is not None:
                    _connect_input(tree, scalar, emission.inputs["Color"])
                elif channel == "roughness":
                    emission.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
            elif channel == "transmission":
                if node.type in {"BSDF_GLASS", "BSDF_REFRACTION"}:
                    emission.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
                elif node.type == "BSDF_PRINCIPLED":
                    _connect_input(tree, node.inputs["Transmission Weight"], emission.inputs["Color"])
            elif channel == "ior":
                ior = node.inputs.get("IOR")
                if ior is not None:
                    _connect_input(tree, ior, emission.inputs["Color"])
                else:
                    emission.inputs["Color"].default_value = (1.5, 1.5, 1.5, 1.0)
            for link in shader_links:
                tree.links.new(emission.outputs[0], link.to_socket)
    return material, list(copies.values())


def _resolution(material):
    sizes = [max(node.image.size) for tree in _trees(material.node_tree)
             for node in tree.nodes if node.type == "TEX_IMAGE" and node.image]
    # Tiny solid albedo images can be combined with larger colour masks.
    return min(1024, max(256, max(sizes, default=256)))


def _needs_channel(material, channel):
    for tree in _trees(material.node_tree):
        for node in tree.nodes:
            if channel == "transmission":
                if node.type in {"BSDF_GLASS", "BSDF_REFRACTION"}:
                    return True
                if node.type == "BSDF_PRINCIPLED":
                    transmission = node.inputs["Transmission Weight"]
                    if transmission.is_linked or transmission.default_value > 0.0:
                        return True
                continue
            if channel == "normal":
                normal = node.inputs.get("Normal")
                if normal is not None and normal.is_linked:
                    return True
                continue
            if node.type == "BSDF_PRINCIPLED":
                socket = node.inputs["Alpha" if channel == "alpha" else "Emission Strength"]
                if socket.is_linked or socket.default_value != (1.0 if channel == "alpha" else 0.0):
                    return True
            elif node.type == ("BSDF_TRANSPARENT" if channel == "alpha" else "EMISSION"):
                return True
    return False


def _bake(source, channel, plane, resolution):
    if channel == "normal":
        # Cycles evaluates the actual shading normal, including the source
        # normal-map groups' RGB/alpha repacking, then encodes it in tangent
        # space. Replacing the BSDF with emission would discard that normal.
        material = source.copy()
        copies = {}
        _copy_groups(material.node_tree, copies)
        _resolve_empty_images(material.node_tree)
        groups = list(copies.values())
    else:
        material, groups = _channel_material(source, channel)
    plane.data.materials.clear()
    plane.data.materials.append(material)
    target = bpy.data.images.new("_gen1_target", width=resolution, height=resolution,
                                 alpha=True, float_buffer=True)
    target.colorspace_settings.name = "Non-Color"
    texture = material.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = target
    material.node_tree.nodes.active = texture
    texture.select = True
    try:
        if channel == "normal":
            bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=0, use_clear=True)
        else:
            bpy.ops.object.bake(type="EMIT", margin=0, use_clear=True)
        pixels = np.empty(resolution * resolution * 4, dtype=np.float32)
        target.pixels.foreach_get(pixels)
        return pixels.reshape((-1, 4)).copy()
    finally:
        plane.data.materials.clear()
        bpy.data.materials.remove(material)
        for group in groups:
            if group.users == 0:
                bpy.data.node_groups.remove(group)
        bpy.data.images.remove(target)


def _texture(material, pixels, resolution, suffix, is_data=False):
    image = bpy.data.images.new(material.name + suffix, width=resolution,
                                height=resolution, alpha=True)
    image.colorspace_settings.name = "Non-Color" if is_data else "sRGB"
    # Generated byte images store their pixels in display space. Write encoded
    # values here; the glTF texture is decoded to linear by the runtime.
    if not is_data:
        rgb = np.maximum(0, pixels[:, :3])
        pixels[:, :3] = np.where(rgb <= 0.0031308, rgb * 12.92,
                                 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    image.pixels.foreach_set(np.clip(pixels, 0, 1).ravel())
    image.file_format = "PNG"
    image.pack()
    texture = material.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = "Linear"
    texture.extension = "REPEAT"
    return texture


def _prepare_pbr(source, material, plane, resolution):
    """Keep scalar factors when uniform; otherwise use glTF's data channels."""
    shader = material.node_tree.nodes.get("Principled BSDF")
    roughness = np.clip(_bake(source, "roughness", plane, resolution)[:, 0], 0, 1)
    metallic = np.clip(_bake(source, "metallic", plane, resolution)[:, 0], 0, 1)
    roughness_uniform = bool(np.ptp(roughness) < 0.00001)
    metallic_uniform = bool(np.ptp(metallic) < 0.00001)
    shader.inputs["Roughness"].default_value = float(roughness[0]) if roughness_uniform else 1.0
    shader.inputs["Metallic"].default_value = float(metallic[0]) if metallic_uniform else 1.0
    if not roughness_uniform or not metallic_uniform:
        packed = np.ones((resolution * resolution, 4), dtype=np.float32)
        # A constant channel is carried by the material factor; the texture
        # channel stays white so it does not multiply that factor a second time.
        if not roughness_uniform:
            packed[:, 1] = roughness
        if not metallic_uniform:
            packed[:, 2] = metallic
        texture = _texture(material, packed, resolution, "_metallicRoughness", is_data=True)
        separate = material.node_tree.nodes.new("ShaderNodeSeparateColor")
        separate.mode = "RGB"
        material.node_tree.links.new(texture.outputs["Color"], separate.inputs["Color"])
        if not roughness_uniform:
            material.node_tree.links.new(separate.outputs["Green"], shader.inputs["Roughness"])
        if not metallic_uniform:
            material.node_tree.links.new(separate.outputs["Blue"], shader.inputs["Metallic"])
    normal_mapped = False
    normal_delta = 0.0
    if _needs_channel(source, "normal"):
        normal = _bake(source, "normal", plane, resolution)
        normal[:, 3] = 1.0
        normal_delta = float(np.max(np.abs(normal[:, :3] - (0.5, 0.5, 1.0))))
        if normal_delta > 0.002:
            texture = _texture(material, normal, resolution, "_normal", is_data=True)
            normal_map = material.node_tree.nodes.new("ShaderNodeNormalMap")
            normal_map.space = "TANGENT"
            normal_map.inputs["Strength"].default_value = 1.0
            material.node_tree.links.new(texture.outputs["Color"], normal_map.inputs["Color"])
            material.node_tree.links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
            normal_mapped = True
    transmission_range = [0.0, 0.0]
    ior_value = float(shader.inputs["IOR"].default_value)
    if _needs_channel(source, "transmission"):
        transmission = np.clip(_bake(source, "transmission", plane, resolution)[:, 0], 0, 1)
        transmission_range = [round(float(transmission.min()), 5), round(float(transmission.max()), 5)]
        if transmission_range[1] > 0.0:
            if np.ptp(transmission) < 0.00001:
                shader.inputs["Transmission Weight"].default_value = float(transmission[0])
            else:
                shader.inputs["Transmission Weight"].default_value = 1.0
                packed = np.ones((resolution * resolution, 4), dtype=np.float32)
                packed[:, 0] = transmission
                texture = _texture(material, packed, resolution, "_transmission", is_data=True)
                separate = material.node_tree.nodes.new("ShaderNodeSeparateColor")
                separate.mode = "RGB"
                material.node_tree.links.new(texture.outputs["Color"], separate.inputs["Color"])
                material.node_tree.links.new(separate.outputs["Red"], shader.inputs["Transmission Weight"])
            # KHR_materials_ior is a scalar. Weighted averaging preserves a
            # constant IOR and gives one scalar when refractive closures mix.
            ior = _bake(source, "ior", plane, resolution)[:, 0]
            ior_value = max(1.0, float(np.average(ior, weights=transmission)))
            shader.inputs["IOR"].default_value = ior_value
    return {"roughnessRange": [round(float(roughness.min()), 5), round(float(roughness.max()), 5)],
            "metallicRange": [round(float(metallic.min()), 5), round(float(metallic.max()), 5)],
            "normalMap": normal_mapped, "normalDelta": round(normal_delta, 5),
            "transmissionRange": transmission_range, "ior": round(ior_value, 5)}


def prepare_materials(meshes):
    """Replace used mesh materials and return a JSON-serializable bake report."""
    meshes = list(meshes)
    sources = list(dict.fromkeys(slot.material for mesh in meshes
                               for slot in mesh.material_slots if slot.material))
    if not sources:
        return []
    old_scene = bpy.context.window.scene
    scene = bpy.data.scenes.new("_gen1_material_bake")
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 4
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.use_clear = True
    mesh_data = bpy.data.meshes.new("_gen1_uv_square")
    mesh_data.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
    uv_names = list(dict.fromkeys(uv.name for mesh in meshes for uv in mesh.data.uv_layers)) or ["UVMap"]
    for name in uv_names:
        layer = mesh_data.uv_layers.new(name=name)
        for loop in mesh_data.loops:
            vertex = mesh_data.vertices[loop.vertex_index].co
            layer.data[loop.index].uv = (vertex.x, vertex.y)
    mesh_data.uv_layers.active_index = 0
    mesh_data.uv_layers[0].active_render = True
    plane = bpy.data.objects.new("_gen1_material_plane", mesh_data)
    scene.collection.objects.link(plane)
    bpy.context.window.scene = scene
    plane.select_set(True)
    bpy.context.view_layer.objects.active = plane
    report = []
    replacements = {}
    try:
        for source in sources:
            if not source.use_nodes or source.node_tree is None:
                continue
            started = time.monotonic()
            _validate_image_sources(source)
            size = _resolution(source)
            base = _bake(source, "base", plane, size)
            base[:, 3] = 1.0
            if _needs_channel(source, "alpha"):
                base[:, 3] = np.clip(_bake(source, "alpha", plane, size)[:, 0], 0, 1)
                base[base[:, 3] > 0.99, 3] = 1.0
            alpha_min = float(base[:, 3].min())
            replacement = bpy.data.materials.new(source.name + "_gltf")
            replacement.use_nodes = True
            replacement.diffuse_color = (*np.clip(np.mean(base[:, :3], axis=0), 0, 1), 1.0)
            replacement.use_backface_culling = source.use_backface_culling
            shader = replacement.node_tree.nodes.get("Principled BSDF")
            pbr_report = _prepare_pbr(source, replacement, plane, size)
            base_uniform = bool(np.max(np.ptp(base, axis=0)) < 0.00001)
            if base_uniform:
                shader.inputs["Base Color"].default_value = tuple(base[0])
                shader.inputs["Alpha"].default_value = alpha_min
            else:
                texture = _texture(replacement, base, size, "_base")
                replacement.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
            if alpha_min < 0.999:
                if not base_uniform:
                    replacement.node_tree.links.new(texture.outputs["Alpha"], shader.inputs["Alpha"])
                if hasattr(replacement, "surface_render_method"):
                    replacement.surface_render_method = "DITHERED"
                elif hasattr(replacement, "blend_method"):
                    replacement.blend_method = "HASHED"
            emission_strength = 0.0
            if _needs_channel(source, "emission"):
                emissive = _bake(source, "emission", plane, size)
                emission_strength = float(np.max(emissive[:, :3]))
                if emission_strength > 0.001:
                    scale = max(1.0, emission_strength)
                    emissive[:, :3] /= scale
                    emissive[:, 3] = 1.0
                    texture = _texture(replacement, emissive, size, "_emission")
                    replacement.node_tree.links.new(texture.outputs["Color"], shader.inputs["Emission Color"])
                    shader.inputs["Emission Strength"].default_value = scale
            replacements[source] = replacement
            entry = {"source": source.name, "material": replacement.name,
                     "resolution": size, "constantColor": base_uniform,
                     "alphaMin": round(alpha_min, 5),
                     "emissionMax": round(emission_strength, 5),
                     **pbr_report,
                     "seconds": round(time.monotonic() - started, 2)}
            report.append(entry)
            print("GEN1_MATERIAL", entry, flush=True)
    finally:
        bpy.context.window.scene = old_scene
        bpy.data.objects.remove(plane, do_unlink=True)
        bpy.data.meshes.remove(mesh_data)
        bpy.data.scenes.remove(scene)
    for mesh in meshes:
        for slot in mesh.material_slots:
            if slot.material in replacements:
                slot.material = replacements[slot.material]
    return report
