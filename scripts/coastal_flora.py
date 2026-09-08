"""Batched, editable coastal vegetation for the proposed island rebuild.

Only Blender's public data API is used.  Call ``build_flora`` from the scene
builder; importing this module does not create objects.  Layout coordinates are
game Y-up: a game point (x, height, z) becomes Blender (x, -z, height).

The canopy is a set of irregular, shallow leafy shelves covered with closed,
ridged six-vertex leaves.  It intentionally avoids sphere-only tree crowns and
transparent leaf cards.  Geometry is batched by tree/flower bed and material.
Fruit groups contain disconnected closed meshes, so Blender's Separate by Loose
Parts can split them later.  This module does not implement fruit consumption.
"""

from __future__ import annotations

import json
import math
import random
from typing import Callable

import bpy


_TAU = math.tau
_REQUIRED_MATERIALS = (
    "bark", "bark_light", "leaf_dark", "leaf", "leaf_light", "leaf_sun",
    "grass", "grass_light", "flower_pink", "flower_yellow", "flower_cream",
    "flower_center", "fruit",
)


def _add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _mul(a, value):
    return (a[0] * value, a[1] * value, a[2] * value)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _unit(a):
    length = math.sqrt(sum(component * component for component in a))
    return _mul(a, 1.0 / length) if length > 1.0e-9 else (1.0, 0.0, 0.0)


def _frame(axis):
    axis = _unit(axis)
    reference = (0.0, 0.0, 1.0) if abs(axis[2]) < 0.92 else (0.0, 1.0, 0.0)
    side = _unit(_cross(reference, axis))
    return axis, side, _unit(_cross(axis, side))


def _game(point):
    """Convert a Blender-space point back to a serializable game point."""
    return {"x": round(point[0], 4), "y": round(point[2], 4),
            "z": round(-point[1], 4)}


def _hero_profile(point, anchor_blender_y, ground):
    """Lift/narrow the upper hero tree while preserving its doorway and roots."""
    t = max(0.0, min(1.0, (point[2] - ground - 2.0) / 1.0))
    blend = t * t * (3.0 - 2.0 * t)
    return (point[0],
            anchor_blender_y + (point[1] - anchor_blender_y) * (1.0 - 0.22 * blend),
            point[2] + 1.4 * blend)


class _Batch:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.smooth = []

    def mesh(self, vertices, faces, smooth=False):
        start = len(self.vertices)
        self.vertices.extend(vertices)
        self.faces.extend(tuple(start + index for index in face) for face in faces)
        self.smooth.extend([smooth] * len(faces))

    def polygon(self, vertices, smooth=False):
        self.mesh(vertices, [tuple(range(len(vertices)))], smooth)

    @property
    def triangles(self):
        return sum(len(face) - 2 for face in self.faces)

    def emit(self, collection, material, name, properties):
        if not self.faces:
            return None
        mesh = bpy.data.meshes.new(name + "_Mesh")
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.materials.append(material)
        mesh.update()
        for face, use_smooth in zip(mesh.polygons, self.smooth):
            face.use_smooth = use_smooth
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        # Vertices are already in world coordinates.  Keep these explicit for
        # exporters and later editing tools that inspect transform identity.
        obj.location = (0.0, 0.0, 0.0)
        obj.rotation_euler = (0.0, 0.0, 0.0)
        obj.scale = (1.0, 1.0, 1.0)
        obj["runtime_role"] = "landscape"
        obj["flora_material"] = material.name
        obj["mesh_triangle_count"] = self.triangles
        for key, value in properties.items():
            obj[key] = value
        return obj


def _tube(batch, points, radii, sides=7, smooth=True, cap_start=True, cap_end=True):
    """Tapered, bent solid branch/stem with stable local ring frames."""
    vertices = []
    for index, (point, radius) in enumerate(zip(points, radii)):
        tangent = _sub(points[min(index + 1, len(points) - 1)],
                       points[max(0, index - 1)])
        _, side, normal = _frame(tangent)
        for segment in range(sides):
            angle = _TAU * segment / sides
            radial = _add(_mul(side, math.cos(angle) * radius),
                          _mul(normal, math.sin(angle) * radius))
            vertices.append(_add(point, radial))
    faces = []
    for row in range(len(points) - 1):
        for segment in range(sides):
            a = row * sides + segment
            b = row * sides + (segment + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    if cap_start:
        faces.append(tuple(reversed(range(sides))))
    if cap_end:
        start = (len(points) - 1) * sides
        faces.append(tuple(start + index for index in range(sides)))
    batch.mesh(vertices, faces, smooth)


def _leaf(batch, attachment, direction, length, width):
    """Closed 3-D leaf: four outline vertices and two raised midribs; 8 tris."""
    axis, side, normal = _frame(direction)
    middle = _add(attachment, _mul(axis, length * 0.46))
    tip = _add(_add(attachment, _mul(axis, length)), _mul(normal, -length * 0.025))
    vertices = [attachment,
                _add(middle, _mul(side, -width * 0.5)),
                tip,
                _add(middle, _mul(side, width * 0.5)),
                _add(middle, _mul(normal, width * 0.20)),
                _add(middle, _mul(normal, -width * 0.11))]
    faces = [(4, 0, 1), (4, 1, 2), (4, 2, 3), (4, 3, 0),
             (5, 1, 0), (5, 2, 1), (5, 3, 2), (5, 0, 3)]
    batch.mesh(vertices, faces, False)


def _ellipsoid(batch, center, radii, segments=8, rings=4, smooth=True):
    vertices = [_add(center, (0.0, 0.0, radii[2]))]
    for row in range(1, rings):
        latitude = math.pi * row / rings
        for segment in range(segments):
            angle = _TAU * segment / segments
            vertices.append(_add(center, (radii[0] * math.sin(latitude) * math.cos(angle),
                                          radii[1] * math.sin(latitude) * math.sin(angle),
                                          radii[2] * math.cos(latitude))))
    bottom = len(vertices)
    vertices.append(_add(center, (0.0, 0.0, -radii[2])))
    faces = [(0, 1 + segment, 1 + (segment + 1) % segments)
             for segment in range(segments)]
    for row in range(rings - 2):
        a, b = 1 + row * segments, 1 + (row + 1) * segments
        for segment in range(segments):
            nxt = (segment + 1) % segments
            faces.append((a + segment, b + segment, b + nxt, a + nxt))
    last = 1 + (rings - 2) * segments
    faces.extend((bottom, last + (segment + 1) % segments, last + segment)
                 for segment in range(segments))
    batch.mesh(vertices, faces, smooth)


def _crown_lobe(batches, center, rx, ry, thickness, rotation, rng, leaf_count, leaf_size):
    """An irregular eaved canopy shelf, with real leaves on top and its rim."""
    phase = rng.uniform(0.0, _TAU)
    segments = 14
    # Flat, overhanging lower rim and asymmetric top.  These are deliberately
    # shallow layered shelves rather than UV-sphere foliage balls.
    rings = [(0.47, -0.43), (1.0, -0.12), (0.88, 0.28), (0.44, 0.66)]
    vertices = []
    cosine, sine = math.cos(rotation), math.sin(rotation)

    def place(x, y, height):
        return (center[0] + x * cosine - y * sine,
                center[1] + x * sine + y * cosine,
                center[2] + height)

    for scale, height in rings:
        for index in range(segments):
            angle = _TAU * index / segments
            scallop = 1.0 + 0.09 * math.sin(3.0 * angle + phase) + 0.05 * math.cos(5.0 * angle)
            vertices.append(place(math.cos(angle) * rx * scale * scallop,
                                  math.sin(angle) * ry * scale * scallop,
                                  thickness * (height + 0.05 * math.sin(angle + phase))))
    faces = [tuple(reversed(range(segments)))]
    for row in range(len(rings) - 1):
        for index in range(segments):
            a, b = row * segments + index, row * segments + (index + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    top = len(vertices)
    vertices.append(place(-rx * 0.08, ry * 0.06, thickness * 0.85))
    start = (len(rings) - 1) * segments
    faces.extend((top, start + index, start + (index + 1) % segments)
                 for index in range(segments))
    batches["leaf_dark" if rng.random() < 0.48 else "leaf"].mesh(vertices, faces, True)

    for _ in range(leaf_count):
        angle = rng.uniform(0.0, _TAU)
        is_rim = rng.random() < 0.32
        radius = rng.uniform(0.84, 1.04) if is_rim else math.sqrt(rng.random()) * 0.96
        scallop = 1.0 + 0.075 * math.sin(3.0 * angle + phase)
        top_height = math.sqrt(max(0.0, 1.0 - min(radius, 1.0) ** 2)) * 0.88 - 0.10
        position = place(math.cos(angle) * rx * radius * scallop,
                         math.sin(angle) * ry * radius * scallop,
                         thickness * top_height + rng.uniform(-0.015, 0.035))
        outward = angle + rotation + rng.uniform(-0.60, 0.60)
        inclination = rng.uniform(-0.65, -0.12) if is_rim else rng.uniform(-0.12, 0.40)
        direction = (math.cos(outward), math.sin(outward), inclination)
        value = rng.random()
        material = ("leaf_dark" if value < 0.07 else "leaf" if value < 0.32
                    else "leaf_light" if value < 0.76 else "leaf_sun")
        length = leaf_size * rng.uniform(0.72, 1.19)
        _leaf(batches[material], position, direction, length, length * rng.uniform(0.43, 0.62))


def _hollow_hero_trunk(batches, x, by, ground):
    """An actual front opening: open C-rings, recessed wall and thick lips."""
    heights = [0.02, 0.25, 0.70, 1.10, 1.42, 1.70, 2.10, 2.65, 3.15, 3.65, 4.05]
    radii = [0.82, 0.78, 0.69, 0.59, 0.55, 0.50, 0.47, 0.45, 0.42, 0.33, 0.19]
    gaps = [0.76, 0.76, 0.71, 0.61, 0.40, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    rows = []
    # Blender -Y is game +Z: the opening faces the glade and viewing side.
    forward = -math.pi * 0.5
    for height, radius, gap in zip(heights, radii, gaps):
        row = []
        bend_x = 0.32 * math.sin(height * 1.30) - 0.085 * height
        bend_y = 0.12 * math.sin(height * 1.15) - 0.035 * height + 0.025 * height * height
        for index in range(19):
            angle = forward + gap + (_TAU - 2.0 * gap) * index / 18
            flute = 1.0 + 0.07 * math.sin(angle * 7.0 + height * 1.3)
            row.append((x + bend_x + radius * math.cos(angle) * flute,
                        by + bend_y + radius * math.sin(angle) * flute,
                        ground + height))
        rows.append(row)
    for row in range(len(rows) - 1):
        for column in range(18):
            material = "bark_light" if column in (2, 7, 12, 16) else "bark"
            batches[material].polygon([rows[row][column], rows[row][column + 1],
                                       rows[row + 1][column + 1], rows[row + 1][column]], True)
    batches["bark"].polygon(rows[-1][:-1], True)

    left = [rows[index][0] for index in range(6)]
    right = [rows[index][-1] for index in range(6)]
    # Walls recede into the open trunk; this is not a dark sticker on a solid
    # cylinder.  The back is a separate material batch and remains editable.
    back_left = [(point[0] * 0.88 + x * 0.12, by + 0.12, point[2]) for point in left]
    back_right = [(point[0] * 0.88 + x * 0.12, by + 0.12, point[2]) for point in right]
    for edge, back in ((left, back_left), (right, back_right)):
        for index in range(len(edge) - 1):
            batches["bark"].polygon([edge[index], back[index], back[index + 1], edge[index + 1]])
    outline = back_left + list(reversed(back_right[:-1]))
    center = (x + 0.01, by + 0.15, ground + 0.79)
    batches["cavity"].mesh([center] + outline,
                           [(0, 1 + i, 1 + (i + 1) % len(outline)) for i in range(len(outline))])
    batches["cavity"].polygon([left[0], back_left[0], back_right[0], right[0]])
    _tube(batches["bark_light"], left, [0.092, 0.084, 0.075, 0.062, 0.051, 0.028], 7)
    _tube(batches["bark"], right, [0.11, 0.088, 0.074, 0.066, 0.050, 0.028], 7)


def _build_tree(tree, materials, collection, terrain_height, rng, ordinal):
    tree_id = str(tree["id"])
    hero = tree_id == "hero-fruit-tree"
    x, z, radius = float(tree["x"]), float(tree["z"]), float(tree["radius"])
    by, ground = -z, float(terrain_height(x, z))
    if not math.isfinite(ground):
        raise ValueError(f"Non-finite terrain height at tree {tree_id}")
    keys = ["bark", "bark_light", "leaf_dark", "leaf", "leaf_light", "leaf_sun", "fruit"]
    if hero:
        keys.append("cavity")
    batches = {key: _Batch() for key in keys}
    height = 7.2 if hero else (2.86, 2.96, 3.04, 2.91)[ordinal % 4]

    if hero:
        _hollow_hero_trunk(batches, x, by, ground)
    else:
        _tube(batches["bark"], [(x, by, ground - 0.025),
                                (x + 0.06, by, ground + 0.32),
                                (x - 0.05, by + 0.04, ground + 0.93),
                                (x + 0.035, by + 0.07, ground + 1.45),
                                (x + 0.045, by + 0.06, ground + height - 0.70)],
              [radius * 0.61, radius * 0.48, 0.165, 0.115, 0.045], 10)

    # Broad but short roots stay very close to the navigation obstacle.  Sleep
    # spots are farther away and are also excluded from understory placement.
    root_count = 10 if hero else 5
    for index in range(root_count):
        angle = _TAU * index / root_count + rng.uniform(-0.17, 0.17)
        # Keep the hero's front doorway open instead of putting a root across it.
        if hero and abs(math.atan2(math.sin(angle + math.pi / 2), math.cos(angle + math.pi / 2))) < 0.42:
            continue
        ux, uy = math.cos(angle), math.sin(angle)
        end_radius = radius * rng.uniform(0.93, 1.055)
        endpoint = (x + ux * end_radius, by + uy * end_radius)
        end_ground = float(terrain_height(endpoint[0], -endpoint[1]))
        width = 0.235 if hero else 0.086
        _tube(batches["bark_light" if index % 3 == 0 else "bark"],
              [(x + ux * radius * 0.40, by + uy * radius * 0.40, ground + (0.79 if hero else 0.22)),
               (x + ux * radius * 0.69, by + uy * radius * 0.69, ground + (0.23 if hero else 0.10)),
               (endpoint[0], endpoint[1], end_ground + 0.025)],
              [width, width * 0.65, 0.012], 7, True)

    if hero:
        for index in range(6):
            angle = _TAU * index / 6 + 0.16
            ux, uy = math.cos(angle), math.sin(angle)
            _tube(batches["bark_light" if index == 2 else "bark"],
                  [(x + ux * 0.16, by + uy * 0.16, ground + 2.14),
                   (x + ux * 0.55, by + uy * 0.51, ground + 2.86),
                   (x + ux * 1.38, by + uy * 1.28, ground + 3.30),
                   (x + ux * 2.31, by + uy * 2.08, ground + 3.92)],
                  [0.33, 0.255, 0.14, 0.038], 9)
        lobes = []
        for index in range(9):
            angle = _TAU * index / 9 + 0.08
            spread = rng.uniform(1.93, 2.11)
            lobes.append(((x + math.cos(angle) * spread, by + math.sin(angle) * spread,
                           ground + rng.uniform(3.45, 3.78)),
                          rng.uniform(1.50, 1.72), rng.uniform(1.24, 1.45), 0.90, angle, 220, 0.315))
        for index in range(5):
            angle = _TAU * index / 5 + 0.31
            lobes.append(((x + math.cos(angle) * 1.12, by + math.sin(angle) * 1.12,
                           ground + rng.uniform(4.93, 5.15)), 1.54, 1.34, 0.93, angle, 230, 0.29))
        for index in range(3):
            angle = _TAU * index / 3
            lobes.append(((x + math.cos(angle) * 0.36 - 0.12, by + math.sin(angle) * 0.33,
                           ground + 6.28 + index * 0.035), 1.40, 1.21, 0.95, angle, 190, 0.27))
    else:
        lobes = []
        for index in range(5):
            angle = _TAU * index / 5 + ordinal * 0.43
            ux, uy = math.cos(angle), math.sin(angle)
            _tube(batches["bark_light" if index == 1 else "bark"],
                  [(x, by, ground + 1.28),
                   (x + ux * 0.29, by + uy * 0.29, ground + 1.67),
                   (x + ux * 0.68, by + uy * 0.68, ground + height - 0.68)],
                  [0.105, 0.074, 0.021], 7)
            lobes.append(((x + ux * 0.38, by + uy * 0.38, ground + height - 0.90),
                          0.65, 0.59, 0.77, angle, 90, 0.20))
        lobes.append(((x - 0.05, by + 0.06, ground + height - 0.50),
                      0.65, 0.60, 0.64, 0.4, 135, 0.19))
    if hero:
        # Bring the final leaf silhouette to roughly eight metres without
        # expanding the trunk or the 1.05m navigation/root footprint.
        lobes = [((x + (center[0] - x) * 1.035,
                   by + (center[1] - by) * 1.035, center[2]),
                  rx * 1.035, ry * 1.035, thick, angle, count, size)
                 for center, rx, ry, thick, angle, count, size in lobes]
    for lobe in lobes:
        center, rx, ry, thick, rotation, count, size = lobe
        _crown_lobe(batches, center, rx, ry, thick, rotation, rng, count, size)

    # Warm fruits hang outside the lower leafy skirts where their silhouettes
    # remain legible.  One disjoint-mesh fruit object per tree keeps draw calls low.
    fruit_positions = []
    fruit_count = 27 if hero else 9
    for index in range(fruit_count):
        # Anchor to a real canopy shelf, so enlarged fruit never floats beyond
        # a rim.  A few higher fruits break up the lower-fruit necklace.
        lobe_index = (9 + index % 5) if hero and index % 5 == 0 else index % (9 if hero else 5)
        lobe_center, lobe_rx, _, lobe_thickness, angle, _, _ = lobes[lobe_index]
        angle += rng.uniform(-0.21, 0.21)
        distance = lobe_rx * rng.uniform(0.72, 0.88)
        fruit_radius = rng.uniform(0.15, 0.19) if hero else rng.uniform(0.10, 0.125)
        center = (lobe_center[0] + math.cos(angle) * distance,
                  lobe_center[1] + math.sin(angle) * distance,
                  lobe_center[2] - lobe_thickness * 0.10 - fruit_radius * 0.88)
        _ellipsoid(batches["fruit"], center, (fruit_radius, fruit_radius * 0.93, fruit_radius * 1.02), 9, 5)
        _tube(batches["bark"], [_add(center, (0, 0, fruit_radius * 0.90)),
                                _add(center, (0.022, 0.01, fruit_radius + 0.105))],
              [0.013, 0.009], 5)
        _leaf(batches["leaf_light"], _add(center, (0.018, 0.0, fruit_radius + 0.07)),
              (math.cos(angle + 0.6), math.sin(angle + 0.6), 0.17), fruit_radius * 1.12, fruit_radius * 0.54)
        fruit_positions.append(_game(center))

    if hero:
        # Apply one continuous world-space deformation to wood, leaves and
        # fruit together, before from_pydata creates the mesh and its normals.
        # At <=2m it is identity; 2..3m uses smoothstep; >=3m lifts by 1.4m
        # and compresses game-Z depth to 78%.  X and topology are unchanged.
        for batch in batches.values():
            batch.vertices = [_hero_profile(point, by, ground) for point in batch.vertices]
        fruit_positions = [_game(_hero_profile((point["x"], -point["z"], point["y"]), by, ground))
                           for point in fruit_positions]
        height += 1.4

    objects = []
    common = {"tree_id": tree_id, "landmark": tree_id, "flora_kind": "tree",
              "nominal_height_m": height, "navigation_radius_m": radius,
              "game_x": x, "game_z": z}
    if hero:
        common.update({"upper_crown_depth_scale": 0.78, "upper_crown_lift_m": 1.4,
                       "crown_transition_height_m": "2..3 above ground, smoothstep"})
    for key, batch in batches.items():
        properties = dict(common)
        name = f"Flora_{tree_id}_{key}"
        if key == "fruit":
            name = f"Fruit_{tree_id}"
            properties.update({"flora_kind": "fruit_group", "fruit_count": fruit_count,
                               "fruit_centers_game": json.dumps(fruit_positions),
                               "fruit_units": "disconnected meshes; separate by loose parts",
                               "consumption_implemented": False})
        if key == "cavity":
            properties["opening_facing_game"] = "+Z"
        obj = batch.emit(collection, materials[key], name, properties)
        if obj is not None:
            objects.append(obj)
    return objects


def _blossom(batches, x, z, terrain_height, rng):
    ground = float(terrain_height(x, z))
    height = rng.uniform(0.23, 0.46)
    lean = rng.uniform(-0.035, 0.035)
    top = (x + lean, -z + rng.uniform(-0.025, 0.025), ground + height)
    _tube(batches["grass"], [(x, -z, ground + 0.014), top], [0.010, 0.006], 4)
    for sign in (-1, 1):
        angle = rng.uniform(0.0, _TAU)
        _leaf(batches["grass_light"], (x, -z, ground + height * rng.uniform(0.27, 0.51)),
              (math.cos(angle), math.sin(angle), 0.35 * sign), rng.uniform(0.16, 0.24), rng.uniform(0.047, 0.075))
    species = rng.choices(["flower_pink", "flower_yellow", "flower_cream"], [0.43, 0.30, 0.27])[0]
    petal_count = {"flower_pink": 5, "flower_yellow": 7, "flower_cream": 6}[species]
    petal_length = rng.uniform(0.072, 0.109)
    phase = rng.uniform(0.0, _TAU)
    for index in range(petal_count):
        angle = phase + _TAU * index / petal_count
        _leaf(batches[species], _add(top, (0.0, 0.0, 0.006)),
              (math.cos(angle), math.sin(angle), rng.uniform(0.06, 0.35)),
              petal_length, petal_length * (0.77 if species == "flower_pink" else 0.52))
    _ellipsoid(batches["flower_center"], _add(top, (0.0, 0.0, 0.016)),
               (0.030, 0.030, 0.023), 6, 3)


def _fern_spray(stem_batch, leaf_batch, x, z, terrain_height, rng):
    """Low, three-frond fern root: volume under the flowers, no new objects."""
    ground = float(terrain_height(x, z))
    origin = (x, -z, ground + 0.024)
    phase = rng.uniform(0.0, _TAU)
    for frond in range(3):
        angle = phase + frond * 2.03
        length = rng.uniform(0.37, 0.53)
        dx, dy = math.cos(angle), math.sin(angle)
        end = (x + dx * length, -z + dy * length, ground + rng.uniform(0.12, 0.22))
        middle = (x + dx * length * 0.48, -z + dy * length * 0.48, ground + 0.23)
        _tube(stem_batch, [origin, middle, end], [0.011, 0.008, 0.003], 4)
        for row in range(4):
            fraction = (row + 1) / 5.0
            attachment = (x + dx * length * fraction, -z + dy * length * fraction,
                          ground + 0.024 + math.sin(fraction * math.pi * 0.85) * 0.20)
            for side in (-1, 1):
                direction = (dx * 0.44 - dy * side, dy * 0.44 + dx * side, 0.12)
                leaflet = 0.17 * (1.0 - fraction * 0.42)
                _leaf(leaf_batch, attachment, direction, leaflet, leaflet * 0.39)
        _leaf(leaf_batch, end, (dx, dy, -0.08), 0.105, 0.038)


def _flower_bed(collection, materials, terrain_height, rng, name, centers, landmark):
    keys = ["grass", "grass_light", "flower_pink", "flower_yellow", "flower_cream", "flower_center"]
    batches = {key: _Batch() for key in keys}
    for index, (x, z) in enumerate(centers):
        _blossom(batches, x, z, terrain_height, rng)
        if rng.random() < 0.56:
            ground = float(terrain_height(x, z))
            for _ in range(3):
                angle = rng.uniform(0.0, _TAU)
                _leaf(batches["grass"], (x, -z, ground + 0.018),
                      (math.cos(angle), math.sin(angle), rng.uniform(0.12, 0.45)),
                      rng.uniform(0.21, 0.32), rng.uniform(0.035, 0.061))
        if index % 15 == 7:
            _fern_spray(batches["grass"], batches["grass_light"], x, z, terrain_height, rng)
    objects = []
    for key, batch in batches.items():
        obj = batch.emit(collection, materials[key], f"Flora_{name}_{key}",
                         {"landmark": landmark, "flora_kind": "flower_bed", "bed_id": name,
                          "flower_count": len(centers), "max_stem_height_m": 0.46})
        if obj is not None:
            objects.append(obj)
    return objects


def _sleep_clear(x, z, layout, padding=0.85):
    return all(math.hypot(x - float(spot["x"]), z - float(spot["z"])) > padding
               for spot in layout.get("landmarks", {}).get("shadeRestSpots", []))


def _river_center_x(z, layout):
    river = layout.get("river", {})
    points = sorted(river.get("centerline", []), key=lambda point: point[1])
    if len(points) < 2:
        return (float(river.get("centerX", 3.2))
                + math.sin(z * float(river.get("frequency", 0.3))) * float(river.get("amplitude", 1.25)))
    xs, zs = [float(point[0]) for point in points], [float(point[1]) for point in points]
    widths = [zs[i + 1] - zs[i] for i in range(len(points) - 1)]
    slopes = [(xs[i + 1] - xs[i]) / widths[i] for i in range(len(widths))]
    tangents = [slopes[0]]
    for i in range(1, len(points) - 1):
        a, b = slopes[i - 1], slopes[i]
        if a * b <= 0:
            tangents.append(0.0)
        else:
            w1, w2 = 2 * widths[i] + widths[i - 1], widths[i] + 2 * widths[i - 1]
            tangents.append((w1 + w2) / (w1 / a + w2 / b))
    tangents.append(slopes[-1])
    if z <= zs[0]:
        return xs[0]
    if z >= zs[-1]:
        return xs[-1]
    i = next(index for index in range(len(widths)) if z <= zs[index + 1])
    t = (z - zs[i]) / widths[i]
    return ((2 * t ** 3 - 3 * t ** 2 + 1) * xs[i]
            + (t ** 3 - 2 * t ** 2 + t) * widths[i] * tangents[i]
            + (-2 * t ** 3 + 3 * t ** 2) * xs[i + 1]
            + (t ** 3 - t ** 2) * widths[i] * tangents[i + 1])


def _land_point(x, z, layout, terrain_height, max_shift=0.0):
    """Keep roots on actual land; nudge river-bed samples to the nearest bank."""
    river_x = _river_center_x(z, layout)
    river_width = float(layout.get("river", {}).get("halfWidth", 1.25))
    side = 1.0 if x >= river_x else -1.0
    steps = int(max_shift / 0.08) + 1
    for step in range(steps):
        candidate_x = x + side * step * 0.08
        ground = float(terrain_height(candidate_x, z))
        if (math.isfinite(ground) and ground >= -0.075
                and abs(candidate_x - river_x) >= river_width + 0.08
                and _sleep_clear(candidate_x, z, layout)):
            return candidate_x, z
    return None


def _segment_distance(x, z, a, b):
    dx, dz = float(b["x"]) - float(a["x"]), float(b["z"]) - float(a["z"])
    length = dx * dx + dz * dz
    t = max(0.0, min(1.0, ((x - float(a["x"])) * dx + (z - float(a["z"])) * dz) / max(length, 1e-8)))
    return math.hypot(x - (float(a["x"]) + t * dx), z - (float(a["z"]) + t * dz))


def _grass_clear(x, z, layout):
    core = layout.get("core", {})
    rx, rz = float(core.get("x", 13.0)), float(core.get("z", 10.0))
    if (x / rx) ** 2 + (z / rz) ** 2 > 1.045:
        return False
    river = layout.get("river", {})
    river_x = _river_center_x(z, layout)
    if abs(x - river_x) < float(river.get("halfWidth", 1.25)) + 0.17:
        return False
    bridge = layout.get("bridge", {})
    if (abs(x - float(bridge.get("x", 3.2))) < float(bridge.get("halfLength", 2.2)) + 0.45
            and abs(z - float(bridge.get("z", 0.0))) < float(bridge.get("halfWidth", 1.2)) + 0.45):
        return False
    if not _sleep_clear(x, z, layout):
        return False
    for obstacle in layout.get("obstacles", []):
        margin = 0.12 if obstacle.get("kind") == "tree" else 0.18
        if obstacle["id"] == "campfire":
            margin = 1.38
        if math.hypot(x - float(obstacle["x"]), z - float(obstacle["z"])) < float(obstacle["radius"]) + margin:
            return False
    # Keep the main glade and flower-to-camp approach visually open.  These
    # exclusions are inferred from the landmarks, not extra collision geometry.
    camp = next((item for item in layout.get("obstacles", []) if item["id"] == "campfire"), None)
    if camp:
        for destination in (layout["landmarks"]["flowers"], layout.get("bridge", {})):
            if "x" in destination and "z" in destination and _segment_distance(x, z, camp, destination) < 0.61:
                return False
    return True


def _wild_white_flower(batches, x, z, terrain_height, rng):
    ground = float(terrain_height(x, z))
    top = (x + 0.01, -z, ground + rng.uniform(0.12, 0.21))
    _tube(batches["grass"], [(x, -z, ground + 0.014), top], [0.007, 0.004], 4)
    for index in range(5):
        angle = _TAU * index / 5 + rng.uniform(-0.10, 0.10)
        _leaf(batches["flower_cream"], top, (math.cos(angle), math.sin(angle), 0.08),
              rng.uniform(0.037, 0.053), 0.024)
    _ellipsoid(batches["flower_center"], _add(top, (0.0, 0.0, 0.01)), (0.017, 0.017, 0.013), 6, 3)


def _cavity_material():
    name = "Coastal_Flora_Cavity_Shadow"
    material = bpy.data.materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name)
    material.diffuse_color = (0.048, 0.039, 0.023, 1.0)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    if shader is not None:
        shader.inputs["Base Color"].default_value = material.diffuse_color
        shader.inputs["Roughness"].default_value = 0.96
    return material


def build_flora(collection, materials, layout, terrain_height: Callable[[float, float], float],
                seed=20260908) -> list[bpy.types.Object]:
    """Build five trees, broad flower beds and clustered ground vegetation.

    Parameters are a target ``bpy.types.Collection``, the scene material mapping,
    decoded ``coastalLayout.json`` and a game-coordinate terrain sampler.  The
    sampler returns game height / Blender Z.  This function only adds vegetation
    to the supplied collection; it does not reset a scene, alter terrain, export,
    start playback or implement runtime interactions.

    The generated collection stores exact triangulated-face and batch counts.
    Typical settings are about 150k triangles, below the revised 180k flora cap.
    """
    missing = [key for key in _REQUIRED_MATERIALS if key not in materials]
    if missing:
        raise KeyError("Missing coastal flora materials: " + ", ".join(missing))
    if "flowers" not in layout.get("landmarks", {}) or "riverFlowers" not in layout.get("landmarks", {}):
        raise KeyError("coastal layout must contain landmarks.flowers and landmarks.riverFlowers")
    rng = random.Random(seed)
    local_materials = dict(materials)
    local_materials["cavity"] = _cavity_material()
    objects = []
    trees = [obstacle for obstacle in layout.get("obstacles", []) if obstacle.get("kind") == "tree"]
    for ordinal, tree in enumerate(trees):
        objects.extend(_build_tree(tree, local_materials, collection, terrain_height, rng, ordinal))

    landmarks = layout["landmarks"]
    flower = landmarks["flowers"]
    fx, fz = float(flower["x"]), float(flower["z"])
    beds = []
    main_beds = landmarks.get("flowerBeds") or [
        {"id": "west", "x": fx - 2.0, "z": fz - 0.6},
        {"id": "south", "x": fx + 2.0, "z": fz + 1.2},
    ]
    # Three interleaved rows give each bed real area.  The shallow bends stay
    # open toward the central meadow; there is no closed, thin flower ring.
    for bed in main_beds:
        centers = []
        cx, cz = float(bed["x"]), float(bed["z"])
        for column in range(67):
            for row in (-1, 0, 1):
                t = -1.0 + 2.0 * (column + rng.uniform(0.10, 0.90)) / 67
                along = 2.08 * t
                sideways = row * 0.43 + rng.uniform(-0.13, 0.13)
                bend = 0.48 * (1.0 - t * t)
                if str(bed["id"]) == "west":
                    point = (cx - bend + sideways, cz + along + rng.uniform(-0.05, 0.05))
                else:
                    point = (cx + along + rng.uniform(-0.05, 0.05), cz + bend + sideways)
                on_land = _land_point(*point, layout, terrain_height)
                if on_land:
                    centers.append(on_land)
        beds.append(("Meadow_" + str(bed["id"]) + "_Flower_Mass", centers, "flowers"))
    river_beds = landmarks.get("riverFlowerBeds") or [dict(landmarks["riverFlowers"], id="main")]
    for bed in river_beds:
        rfx, rfz = float(bed["x"]), float(bed["z"])
        riverside = []
        for _ in range(90):
            angle, radial = rng.uniform(0, _TAU), math.sqrt(rng.random())
            point = (rfx + math.cos(angle) * radial * 0.72,
                     rfz + math.sin(angle) * radial * 0.47)
            on_land = _land_point(*point, layout, terrain_height, max_shift=1.36)
            if on_land:
                riverside.append(on_land)
        beds.append(("Riverbank_" + str(bed["id"]) + "_Flower_Mass", riverside, "riverFlowers"))
    for name, centers, landmark in beds:
        objects.extend(_flower_bed(collection, local_materials, terrain_height, rng, name, centers, landmark))

    # A larger but clustered understory.  Most blades gather around flower-bed,
    # tree and stone edges; sleeping positions and the central glade stay clear.
    grass_batches = {key: _Batch() for key in ("grass", "grass_light", "flower_cream", "flower_center")}
    candidates = []
    for tree in trees:
        for _ in range(36 if tree["id"] == "hero-fruit-tree" else 18):
            angle = rng.uniform(0, _TAU)
            distance = float(tree["radius"]) + rng.uniform(0.20, 1.28)
            candidates.append((float(tree["x"]) + math.cos(angle) * distance,
                               float(tree["z"]) + math.sin(angle) * distance))
    for _, centers, _ in beds:
        for x, z in centers[::3]:
            candidates.append((x + rng.uniform(-0.49, 0.49), z + rng.uniform(-0.49, 0.49)))
    for obstacle in layout.get("obstacles", []):
        if obstacle.get("kind") == "rock" and str(obstacle["id"]).startswith("warm-rock"):
            for _ in range(20):
                angle = rng.uniform(0, _TAU)
                distance = float(obstacle["radius"]) + rng.uniform(0.22, 0.90)
                candidates.append((float(obstacle["x"]) + math.cos(angle) * distance,
                                   float(obstacle["z"]) + math.sin(angle) * distance))
    candidates.extend((rng.uniform(-10.0, 10.0), rng.uniform(-7.0, 7.0)) for _ in range(20))
    rng.shuffle(candidates)
    # Extra candidates remain near the chosen plant/stone landmarks, so filling
    # the target count never turns into a carpet over every square of the lawn.
    foci = list(main_beds) + list(river_beds) + trees
    for _ in range(380):
        focus = rng.choice(foci)
        angle, distance = rng.uniform(0, _TAU), rng.uniform(0.72, 2.05)
        candidates.append((float(focus["x"]) + math.cos(angle) * distance,
                           float(focus["z"]) + math.sin(angle) * distance))
    accepted = []
    for x, z in candidates:
        if len(accepted) >= 214:
            break
        if not _grass_clear(x, z, layout) or _land_point(x, z, layout, terrain_height) is None:
            continue
        if any((x - other_x) ** 2 + (z - other_z) ** 2 < 0.16 ** 2 for other_x, other_z in accepted):
            continue
        ground = float(terrain_height(x, z))
        for index in range(rng.randint(6, 9)):
            angle = rng.uniform(0, _TAU)
            key = "grass_light" if index % 3 == 0 else "grass"
            _leaf(grass_batches[key], (x, -z, ground + 0.012),
                  (math.cos(angle), math.sin(angle), rng.uniform(0.55, 1.2)),
                  rng.uniform(0.23, 0.42), rng.uniform(0.028, 0.050))
        if len(accepted) % 5 == 0:
            _wild_white_flower(grass_batches, x + 0.075, z - 0.045, terrain_height, rng)
        accepted.append((x, z))
    tuft_count = len(accepted)
    for key, batch in grass_batches.items():
        obj = batch.emit(collection, local_materials[key], f"Flora_Sparse_Understory_{key}",
                         {"landmark": "island_understory",
                          "flora_kind": "wildflowers" if key.startswith("flower_") else "sparse_grass",
                          "tuft_count": tuft_count, "sleep_clearance_m": 0.85})
        if obj is not None:
            objects.append(obj)

    triangle_count = sum(int(obj["mesh_triangle_count"]) for obj in objects)
    collection["flora_seed"] = int(seed)
    collection["flora_triangle_count"] = triangle_count
    collection["flora_object_count"] = len(objects)
    collection["flora_tree_count"] = len(trees)
    collection["flora_note"] = "World-space editable batches; +Z game-facing hero cavity; no runtime fruit logic"
    collection["flora_flower_bed_count"] = len(beds)
    collection["flora_flower_count"] = sum(len(centers) for _, centers, _ in beds)
    collection["flora_understory_tuft_count"] = tuft_count
    if triangle_count > 180_000:
        raise RuntimeError(f"Flora geometry budget exceeded: {triangle_count:,} > 180,000 triangles")
    if len(objects) >= 75:
        raise RuntimeError(f"Flora object budget exceeded: {len(objects)} >= 75")
    return objects
