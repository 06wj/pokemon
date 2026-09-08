"""Build the v2 coastal island from scratch in an isolated Blender process.

Dispatched through Blender MCP using bpy.app.binary_path, so an unrelated open
and unsaved Blender document is never replaced. All dimensions come from the
same JSON contract as the browser's navigation and coastline shaders.
"""
from __future__ import annotations

import bpy
import json
import math
import random
import sys
import traceback
from pathlib import Path
from mathutils import Vector
from mathutils.noise import noise as noise3d

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
LAYOUT = json.loads((ROOT / 'src/ecology/coastalLayout.json').read_text())
SOURCE = ROOT / 'assets/ecology-coastal-v2.blend'
ASSET = ROOT / 'public' / LAYOUT['asset']
ART = ROOT / 'artifacts'
STATUS = ART / 'coastal-island-v2-status.json'
SEA = LAYOUT['coast']['seaLevel']
TAG = 'living-diorama-coastal-v2'
OBSTACLES = {o['id']: o for o in LAYOUT['obstacles']}
PATH_SEGMENTS = []


def status(stage, **values):
    ART.mkdir(exist_ok=True)
    STATUS.write_text(json.dumps({'stage': stage, **values}, ensure_ascii=False, indent=2))


def linear(hex_color):
    values = [int(hex_color[i:i+2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= .04045 else ((v+.055)/1.055)**2.4 for v in values) + (1,)


def smooth(t):
    t = max(0., min(1., t))
    return t*t*(3-2*t)


def mix(a, b, t):
    return tuple(x+(y-x)*t for x, y in zip(a, b))


def material(name, color, roughness=.88):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = linear(color)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = mat.diffuse_color
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


def surface_grain(mat, scale=18, strength=.13, distance=.035):
    nodes=mat.node_tree.nodes;links=mat.node_tree.links
    geometry=nodes.new('ShaderNodeNewGeometry')
    noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=scale;noise.inputs['Detail'].default_value=3
    bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=strength;bump.inputs['Distance'].default_value=distance
    links.new(geometry.outputs['Position'],noise.inputs['Vector'])
    links.new(noise.outputs['Fac'],bump.inputs['Height'])
    links.new(bump.outputs['Normal'],nodes['Principled BSDF'].inputs['Normal'])


def point(p):
    # Game (x, y, z) -> Blender (x, -z, y). glTF restores Y-up on export.
    return (p[0], -p[2], p[1])


class Batch:
    def __init__(self, name, mat, collection):
        self.name, self.mat, self.collection = name, mat, collection
        self.vertices, self.faces = [], []

    def polygon(self, points):
        i = len(self.vertices)
        self.vertices.extend(point(p) for p in points)
        self.faces.append(tuple(range(i, i+len(points))))

    def box(self, x, y, z, sx, sy, sz, angle=0):
        co, si = math.cos(angle), math.sin(angle)
        def p(a, b, c):
            return (x+a*co+c*si, y+b, z-a*si+c*co)
        a,b,c = sx/2,sy/2,sz/2
        v = [p(-a,-b,-c),p(a,-b,-c),p(a,-b,c),p(-a,-b,c),
             p(-a,b,-c),p(a,b,-c),p(a,b,c),p(-a,b,c)]
        for f in [(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]:
            self.polygon([v[i] for i in f])

    def beam(self, a, b, radius, radius2=None, sides=8):
        a,b = Vector(a),Vector(b)
        axis = (b-a).normalized()
        helper = Vector((0,1,0)) if abs(axis.y)<.92 else Vector((1,0,0))
        u = axis.cross(helper).normalized(); v=axis.cross(u).normalized()
        radius2 = radius if radius2 is None else radius2
        rings = [[tuple(c+r*(u*math.cos(i*math.tau/sides)+v*math.sin(i*math.tau/sides)))
                  for i in range(sides)] for c,r in [(a,radius),(b,radius2)]]
        for i in range(sides):
            j=(i+1)%sides
            self.polygon([rings[0][i],rings[0][j],rings[1][j],rings[1][i]])
        self.polygon(list(reversed(rings[0])));self.polygon(rings[1])

    def rock(self, x,y,z,rx,ry,rz,phase=0,sides=11,rings=5):
        def p(j,i):
            lat=j*math.pi/rings; a=i*math.tau/sides
            wiggle=1+.075*math.sin(a*3+phase)+.04*math.cos(a*5-lat*4+phase)
            top=min(.87, math.cos(lat))
            return (x+rx*math.sin(lat)*math.cos(a)*wiggle,y+ry*top,z+rz*math.sin(lat)*math.sin(a)*wiggle)
        for j in range(rings):
            for i in range(sides): self.polygon([p(j,i),p(j,i+1),p(j+1,i+1),p(j+1,i)])

    def slab(self,x,z,radius,height,phase=0):
        outline=[(-.7,-1),(.6,-1),(1,-.45),(1,.55),(.55,1),(-.62,1),(-1,.48),(-1,-.52)]
        rings=[]
        for level,scale in [(0,.88),(.70,1),(1,.80)]:
            points=[]
            for i,(px,pz) in enumerate(outline):
                px*=radius;pz*=radius*.74
                length=math.hypot(px,pz)
                if length>radius*.96:px*=radius*.96/length;pz*=radius*.96/length
                points.append((x+px*scale,.025+height*level+(.055*math.sin(i*2+phase) if level else 0),z+pz*scale))
            rings.append(points)
        self.polygon(rings[0])
        for a,b in zip(rings,rings[1:]):
            for i in range(8):j=(i+1)%8;self.polygon([a[i],b[i],b[j],a[j]])
        top=rings[-1];center=(x,.025+height+.025,z)
        for i in range(8):self.polygon([center,top[(i+1)%8],top[i]])

    def build(self, role='landscape', smooth_faces=False):
        if not self.faces:return None
        mesh=bpy.data.meshes.new(self.name+' geometry')
        mesh.from_pydata(self.vertices, [], self.faces);mesh.update()
        obj=bpy.data.objects.new(self.name,mesh);self.collection.objects.link(obj)
        mesh.materials.append(self.mat)
        for poly in mesh.polygons: poly.use_smooth=smooth_faces
        obj['generator']=TAG;obj['runtime_role']=role
        return obj


def radial_bounds(x,z):
    coast=LAYOUT['coast']
    angle=math.atan2(z/coast['baseRadii']['z'],x/coast['baseRadii']['x'])
    wobble=0
    for wave in coast['waves']:
        wavefn=math.sin if wave['function']=='sin' else math.cos
        wobble+=wave['amplitude']*wavefn(angle*wave['frequency']+wave['phase'])
    a=coast['baseRadii']['x']+wobble;b=coast['baseRadii']['z']+wobble*coast['zWobbleScale']
    r=math.hypot(x,z)
    if r<1e-8:return 13.,16.,r
    dx,dz=x/r,z/r
    core=1/math.sqrt((dx/LAYOUT['core']['x'])**2+(dz/LAYOUT['core']['z'])**2)
    shore=1/math.sqrt((dx/a)**2+(dz/b)**2)
    return core,shore,r


def shore_height(x,z):
    core,shore,r=radial_bounds(x,z)
    grass_edge=core+LAYOUT['coast']['beachStartOffset']
    if r<=grass_edge:return 0.
    if r<=shore:
        t=(r-grass_edge)/(shore-grass_edge)
        return SEA*(.3*t+.7*smooth(t))
    t=(r-shore)/LAYOUT['coast']['submergedShelfWidth']
    return max(-5.5,SEA-.62*smooth(t)-max(0.,t-1)*3.0)


def terrain_base(x,z):
    base=shore_height(x,z)
    estuary=LAYOUT['coast'].get('estuary')
    if estuary and z>estuary['startZ']:
        depth=estuary['depth']*smooth((z-estuary['startZ'])/estuary['length'])
        depth*=math.exp(-((x-river_center(z))/estuary['spread'])**2)
        base=min(base,-depth)
    return base


def river_center(z):
    knots=LAYOUT['river']['centerline']
    if z<=knots[0][1]:return knots[0][0]
    if z>=knots[-1][1]:return knots[-1][0]
    hs=[b[1]-a[1] for a,b in zip(knots,knots[1:])]
    ds=[(b[0]-a[0])/h for a,b,h in zip(knots,knots[1:],hs)]
    slopes=[ds[0]]
    for i in range(1,len(knots)-1):
        if ds[i-1]*ds[i]<=0:slopes.append(0.)
        else:
            w1=2*hs[i]+hs[i-1];w2=hs[i]+2*hs[i-1]
            slopes.append((w1+w2)/(w1/ds[i-1]+w2/ds[i]))
    slopes.append(ds[-1])
    for i,(a,b) in enumerate(zip(knots,knots[1:])):
        if z<=b[1]:
            t=(z-a[1])/hs[i]
            return (2*t**3-3*t*t+1)*a[0]+(t**3-2*t*t+t)*hs[i]*slopes[i]+(-2*t**3+3*t*t)*b[0]+(t**3-t*t)*hs[i]*slopes[i+1]


def water_height(z):
    return max(SEA,LAYOUT['river']['surfaceY']+terrain_base(river_center(z),z))


def terrain_height(x,z):
    base=terrain_base(x,z)
    d=abs(x-river_center(z));width=LAYOUT['river']['halfWidth']
    if d<width:
        return min(base,water_height(z)-.52+.41*(d/width)**3)
    return base


def terrain_color(x,z):
    core,shore,r=radial_bounds(x,z)
    t=(r-core-.22)/max(.5,shore-core-.22)
    patch=.5+.5*noise3d(Vector((x*.62,z*.62,3.7)))
    grass=mix(linear('#8C9B4B'),linear('#A9AF5C'),patch*.55)
    detail=.5+.5*noise3d(Vector((x*13.1,z*13.1,6.2)))
    grass=tuple(c*(.95+.075*detail) if i<3 else 1 for i,c in enumerate(grass))
    dry=mix(linear('#EAD59F'),linear('#DEC58C'),(.5+.5*math.sin(x*2.3+z*1.7))*.18)
    wet=linear('#C9BC8D')
    if abs(x-river_center(z))<LAYOUT['river']['halfWidth']+.03:
        return mix(wet,linear('#B6B893'),detail*.3)
    base=terrain_base(x,z)
    if base<shore_height(x,z)-.01 and base<-.08 and t<.76:
        return mix(grass,dry,smooth((-base-.08)/.3))
    if t<.09:
        color=mix(grass,dry,smooth((t+.02)/.11))
        distance=100.
        for ax,az,dx,dz,length,width in PATH_SEGMENTS:
            if abs(x-ax)>abs(dx)+1.6 or abs(z-az)>abs(dz)+1.6:continue
            u=max(0.,min(1.,((x-ax)*dx+(z-az)*dz)/length))
            d=math.hypot(x-ax-u*dx,z-az-u*dz)-width*.5
            distance=min(distance,d)
        grain=noise3d(Vector((x*4.1,z*4.1,7.4)))
        trail=1-smooth((distance+grain*.12+.02)/.30)
        fire=OBSTACLES['campfire'];fx,fz=x-fire['x'],z-fire['z']
        edge=math.hypot(fx,fz)-2.5+.12*noise3d(Vector((x*2.5,z*2.5,9.7)))
        clearing=(1-smooth((edge+.15)/.38))*.86
        dirt=mix(linear('#C8AA78'),linear('#B39365'),detail*.55)
        return mix(color,dirt,max(trail*.82,clearing))
    if t<.76:return dry
    color=mix(dry,wet,smooth((t-.76)/.4)*.75)
    return mix(color,linear('#D7C79A'),smooth((t-1.6)/.8))


def make_terrain(collection, mats):
    vertices=[];colors=[];faces=[]
    step=.18;nx=283;nz=241
    for j in range(nz):
        z=(j-(nz-1)/2)*step
        for i in range(nx):
            x=(i-(nx-1)/2)*step
            vertices.append((x,-z,terrain_height(x,z)))
            colors.append(terrain_color(x,z))
    for j in range(nz-1):
        for i in range(nx-1):
            a=j*nx+i
            if all(vertices[k][2]<-5.46 for k in (a,a+nx,a+nx+1,a+1)):continue
            faces.append((a,a+nx,a+nx+1,a+1))
    mesh=bpy.data.meshes.new('Continuous coast grid with submerged sand shelf')
    mesh.from_pydata(vertices,[],faces);mesh.update()
    color=mesh.color_attributes.new(name='CoastColor',type='FLOAT_COLOR',domain='POINT')
    color.data.foreach_set('color',[c for rgba in colors for c in rgba])
    mat=material('Coast / turf and sand vertex colors','#FFFFFF',.94)
    vertex=mat.node_tree.nodes.new('ShaderNodeVertexColor');vertex.layer_name='CoastColor'
    nodes=mat.node_tree.nodes;links=mat.node_tree.links
    geometry=nodes.new('ShaderNodeNewGeometry')
    fine=nodes.new('ShaderNodeTexNoise');fine.inputs['Scale'].default_value=38;fine.inputs['Detail'].default_value=4
    links.new(geometry.outputs['Position'],fine.inputs['Vector'])
    variation=nodes.new('ShaderNodeValToRGB');variation.color_ramp.elements[0].position=.18;variation.color_ramp.elements[0].color=(.43,.43,.43,1)
    variation.color_ramp.elements[1].position=.82;variation.color_ramp.elements[1].color=(1.35,1.35,1.35,1)
    links.new(fine.outputs['Fac'],variation.inputs[0])
    albedo=nodes.new('ShaderNodeMixRGB');albedo.blend_type='MULTIPLY';albedo.inputs[0].default_value=.55
    links.new(vertex.outputs['Color'],albedo.inputs[1]);links.new(variation.outputs['Color'],albedo.inputs[2])
    links.new(albedo.outputs[0],nodes['Principled BSDF'].inputs['Base Color'])
    surface_grain(mat,27,.24,.045)
    # Subtle procedural light cells on submerged ground, visible through the
    # actual refractive water surface in the editable Blender scene.
    nodes=mat.node_tree.nodes;links=mat.node_tree.links
    geometry=nodes.new('ShaderNodeNewGeometry');separate=nodes.new('ShaderNodeSeparateXYZ')
    links.new(geometry.outputs['Position'],separate.inputs[0])
    under=nodes.new('ShaderNodeMath');under.operation='LESS_THAN';under.inputs[1].default_value=SEA-.02
    links.new(separate.outputs['Z'],under.inputs[0])
    voronoi=nodes.new('ShaderNodeTexVoronoi');voronoi.feature='DISTANCE_TO_EDGE';voronoi.inputs['Scale'].default_value=3.4
    links.new(geometry.outputs['Position'],voronoi.inputs['Vector'])
    edge=nodes.new('ShaderNodeValToRGB');edge.color_ramp.elements[0].position=.015;edge.color_ramp.elements[0].color=(.10,.10,.10,1)
    edge.color_ramp.elements[1].position=.065;edge.color_ramp.elements[1].color=(0,0,0,1)
    links.new(voronoi.outputs['Distance'],edge.inputs[0])
    factor=nodes.new('ShaderNodeMath');factor.operation='MULTIPLY';links.new(edge.outputs['Color'],factor.inputs[0]);links.new(under.outputs[0],factor.inputs[1])
    bsdf=nodes['Principled BSDF'];bsdf.inputs['Emission Color'].default_value=linear('#DAE2AA')
    links.new(factor.outputs[0],bsdf.inputs['Emission Strength'])
    mesh.materials.append(mat)
    for p in mesh.polygons:p.use_smooth=True
    obj=bpy.data.objects.new('Coast / continuous turf sand submerged shelf',mesh);collection.objects.link(obj)
    obj['generator']=TAG;obj['runtime_role']='terrain';obj['core_ground_y']=0
    return obj


def bake_terrain_albedo(scene,obj):
    """Bake the authored colour into a portable map; keep geometric detail and
    procedural source nodes in the native file. No reference-image projection."""
    status('baking-ground-albedo')
    mesh=obj.data
    uv=mesh.uv_layers.new(name='TerrainUV')
    xs=[v.co.x for v in mesh.vertices];ys=[v.co.y for v in mesh.vertices]
    xmin,xmax=min(xs),max(xs);ymin,ymax=min(ys),max(ys)
    for loop in mesh.loops:
        p=mesh.vertices[loop.vertex_index].co
        uv.data[loop.index].uv=((p.x-xmin)/(xmax-xmin),(p.y-ymin)/(ymax-ymin))
    image=bpy.data.images.new('Coastal terrain / baked albedo',2048,2048,alpha=False)
    image.colorspace_settings.name='sRGB'
    mat=mesh.materials[0];nodes=mat.node_tree.nodes;links=mat.node_tree.links
    bsdf=nodes['Principled BSDF'];output=nodes['Material Output']
    base=bsdf.inputs['Base Color'].links[0].from_socket
    emit=nodes.new('ShaderNodeEmission');emit.inputs['Strength'].default_value=1
    links.new(base,emit.inputs['Color']);links.new(emit.outputs[0],output.inputs['Surface'])
    texture=nodes.new('ShaderNodeTexImage');texture.name='Baked portable terrain colour';texture.image=image
    nodes.active=texture
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
    scene.render.bake.margin=4
    bpy.ops.object.bake(type='EMIT')
    links.new(bsdf.outputs[0],output.inputs['Surface']);nodes.remove(emit)
    links.new(texture.outputs['Color'],bsdf.inputs['Base Color'])
    path=ROOT/'assets/textures/coastal-terrain-albedo.png';path.parent.mkdir(exist_ok=True)
    image.filepath_raw=str(path);image.file_format='PNG';image.save();image.pack()
    obj['baked_albedo']='assets/textures/coastal-terrain-albedo.png'
    return path


def curve_points(control, resolution=12):
    control=[control[0],*control,control[-1]];output=[]
    for n in range(1,len(control)-2):
        a,b,c,d=map(Vector,control[n-1:n+3])
        for k in range(resolution):
            t=k/resolution
            p=.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t)
            output.append(tuple(p))
    output.append(tuple(control[-1]));return output


def path_ribbon(batch, control, width=.85):
    points=curve_points(control)
    for n in range(len(points)-1):
        a,b=Vector(points[n]),Vector(points[n+1]);delta=(b-a).normalized()
        normal=Vector((-delta.y,delta.x))
        ra=width*(1+.055*math.sin(n*.34))/2;rb=width*(1+.055*math.sin((n+1)*.34))/2
        verts=[]
        for c,side,r in [(a,-1,ra),(a,1,ra),(b,1,rb),(b,-1,rb)]:
            p=c+normal*(side*r);verts.append((p.x,terrain_base(p.x,p.y)+.014,p.y))
        if all(abs(p[0]-river_center(p[2]))>1.32 for p in verts):batch.polygon(verts)


def make_paths(collection,mats):
    # Colour the connected terrain itself, so intersecting paths cannot make
    # coplanar black patches or look like separate planks laid on the lawn.
    loop=[(-8.351,-1.88),(-7.493,-3.408),(-5.397,-4.322),(-2.885,-4.125),(-1.075,-3.035),(-.713,-.986),(-1.45,1.513),(-3.867,2.548),(-6.805,2.297),(-8.312,.29),(-8.351,-1.88)]
    bridge=LAYOUT['bridge'];bx,bz=bridge['x'],bridge['z']
    routes=[(loop,.7),([(-8.351,-1.88),(-8.95,-3.5),(-8.95,-4.59)],.95),
            ([(-.713,-.986),(.3,-1.3),(bx-2.2,bz)],.85),
            ([(bx+2.2,bz),(7.1,-.8),(8.2,1.5),(8.7,3.1),(9.5,3.8)],.65),
            ([(-3.867,2.548),(-3.2,4.2),(-1.8,7),(-1.2,10.7)],.6)]
    PATH_SEGMENTS.clear()
    for control,width in routes:
        points=curve_points(control,10)
        for a,b in zip(points,points[1:]):
            dx,dz=b[0]-a[0],b[1]-a[1];length=dx*dx+dz*dz
            if length>1e-10:PATH_SEGMENTS.append((a[0],a[1],dx,dz,length,width))


def make_river(collection,mats):
    batch=Batch('Water / stream and waterfalls',mats['water'],collection)
    zs=[-15+i*.12 for i in range(251)]
    for za,zb in zip(zs,zs[1:]):
        if water_height(za)<=SEA+.001 and water_height(zb)<=SEA+.001:continue
        for k in range(10):
            def p(z,u):
                # River remains the same analytic corridor inside the play area.
                w=LAYOUT['river']['halfWidth']*(1+.2*smooth((abs(z)-10)/3))
                return (river_center(z)+(u*2-1)*w,water_height(z),z)
            batch.polygon([p(za,k/10),p(zb,k/10),p(zb,(k+1)/10),p(za,(k+1)/10)])
    obj=batch.build('water',True);obj['sea_level']=SEA
    return obj


def make_props(collection,mats):
    stones=Batch('Landmarks / warm resting rocks',mats['warm_stone'],collection)
    for i,o in enumerate(LAYOUT['obstacles']):
        if not o['id'].startswith('warm-rock'):continue
        r=o['radius'];stones.slab(o['x'],o['z'],r,r*.82,i)
    stones.build()
    bank=Batch('Details / creek stones and beach pebbles',mats['stone'],collection)
    rand=random.Random(893)
    for z in [-10+i*.32 for i in range(64)]:
        side=rand.choice([-1,1]);x=river_center(z)+side*1.37
        if math.hypot(x-.8,z-4.5)<1.6:continue
        if abs(z-LAYOUT['bridge']['z'])<1.4:continue
        r=rand.uniform(.08,.18)
        bank.rock(x,terrain_base(x,z)+r*.25,z,r,r*.60,r*.8,rand.random()*4,sides=7,rings=3)
    for a in [.18,.62,1.1,1.87,2.6,3.2,3.7,4.1,4.8,5.4,5.75]:
        core,shore,_=radial_bounds(math.cos(a)*18,math.sin(a)*18)
        r=core+(shore-core)*rand.uniform(.45,.82);x,z=math.cos(a)*r,math.sin(a)*r
        if abs(x-river_center(z))<2:continue
        rad=rand.uniform(.12,.32)
        bank.rock(x,terrain_base(x,z)+rad*.25,z,rad,rad*.65,rad*.8,a)
    bank.build()
    cx,cz=OBSTACLES['campfire']['x'],OBSTACLES['campfire']['z']
    ring=Batch('Campfire / twelve loose hearth stones',mats['hearth_stone'],collection)
    for i in range(12):
        a=i*math.tau/12
        ring.rock(cx+math.cos(a)*.75,.13,cz+math.sin(a)*.75,.19,.17,.17,i,sides=9,rings=4)
    ring.build()
    logs=Batch('Campfire / kindling logs',mats['wood_dark'],collection)
    for i,(a,b) in enumerate([((-.39,.14,-.29),(.4,.14,.3)),((-.39,.2,.29),(.39,.2,-.29)),((-.38,.3,0),(.4,.3,0))]):
        logs.beam(tuple(v+d for v,d in zip(a,(cx,0,cz))),tuple(v+d for v,d in zip(b,(cx,0,cz))),.12,sides=9)
    logs.build()
    wood=Batch('Campfire / stacked firewood',mats['timber'],collection)
    ends=Batch('Campfire / log end grain',mats['timber_light'],collection)
    for key,angle in [('firewood-1',-.55),('firewood-2',-.2)]:
        item=OBSTACLES[key];px,pz=item['x'],item['z'];co,si=math.cos(angle),math.sin(angle)
        for row,count in [(0,3),(1,2),(2,1)]:
            for n in range(count):
                offset=(n-(count-1)/2)*.23
                a=(px-.43*co-offset*si,.14+row*.21,pz-.43*si+offset*co)
                b=(px+.43*co-offset*si,.14+row*.21,pz+.43*si+offset*co)
                wood.beam(a,b,.115,sides=10)
                c=(b[0]+.007*co,b[1],b[2]+.007*si)
                ends.beam(b,c,.097,sides=10)
    wood.build();ends.build()
    bridge=LAYOUT['bridge'];x,z=bridge['x'],bridge['z']
    timber=Batch('Bridge / honey timber deck',mats['timber'],collection)
    endgrain=Batch('Bridge / warm worn plank edges',mats['timber_light'],collection)
    structural=Batch('Bridge / beams and posts',mats['bark_light'],collection)
    ropes=Batch('Bridge / loose rope rails',mats['rope'],collection)
    for i in range(18):
        px=x-2.2+(i+.5)*4.4/18
        target=timber if i%4 else endgrain
        target.box(px,.03,z,4.4/18-.017,.10,2.61)
    for side in [-1,1]:
        structural.box(x,-.14,z+side*.82,4.76,.25,.16)
        for end in [-1,1]:
            structural.beam((x+end*2.14,-.4,z+side*1.39),(x+end*2.14,.81,z+side*1.39),.095,.082,sides=8)
            endgrain.box(x+end*2.14,.835,z+side*1.39,.23,.07,.23)
        for n in range(22):
            u=n/22;v=(n+1)/22
            ropes.beam((x-2.14+4.28*u,.75-.18*math.sin(u*math.pi),z+side*1.39),
                       (x-2.14+4.28*v,.75-.18*math.sin(v*math.pi),z+side*1.39),.033,sides=6)
    for b in [timber,endgrain,structural,ropes]: b.build()


def make_anchors(collection):
    fire=OBSTACLES['campfire'];tree=OBSTACLES['hero-fruit-tree'];rocks=OBSTACLES['warm-rock-main']
    flowers=LAYOUT['landmarks']['flowers'];wet=LAYOUT['landmarks']['riverFlowers']
    data=[('Campfire',fire['x'],fire['z'],'campfire'),('FruitTree',tree['x'],tree['z'],'fruit-tree'),
          ('Flowers',flowers['x'],flowers['z'],'flowers'),('RiverFlowers',wet['x'],wet['z'],'flowers'),
          ('Drink',river_center(wet['z']),wet['z'],'water'),('WarmRocks',rocks['x'],rocks['z'],'warm-rock')]
    for name,x,z,kind in data:
        obj=bpy.data.objects.new('POI / '+name,None);collection.objects.link(obj)
        obj.location=(x,-z,0);obj.empty_display_type='CIRCLE';obj.empty_display_size=.4
        obj['runtime_role']='interest-point';obj['kind']=kind;obj['generator']=TAG
    for i,p in enumerate(LAYOUT['landmarks']['shadeRestSpots']):
        obj=bpy.data.objects.new(f'RestSlot / shade {i+1}',None);collection.objects.link(obj)
        obj.location=(p['x'],-p['z'],0);obj['runtime_role']='rest-slot'


def aim(obj,target):obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


def setup_studio(scene,collection,mats):
    # One world-space water material makes the creek become the sea at its
    # outlets; no differently coloured rectangular sheet protrudes offshore.
    water=mats['water'];nodes=water.node_tree.nodes;links=water.node_tree.links
    bsdf=nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value=.14
    bsdf.inputs['Transmission Weight'].default_value=.78
    bsdf.inputs['IOR'].default_value=1.333
    geometry=nodes.new('ShaderNodeNewGeometry')
    separate=nodes.new('ShaderNodeSeparateXYZ');links.new(geometry.outputs['Position'],separate.inputs[0])
    def math_node(operation,a,b=None):
        node=nodes.new('ShaderNodeMath');node.operation=operation
        if isinstance(a,(int,float)):node.inputs[0].default_value=a
        else:links.new(a,node.inputs[0])
        if b is not None:
            if isinstance(b,(int,float)):node.inputs[1].default_value=b
            else:links.new(b,node.inputs[1])
        return node.outputs[0]
    xx=math_node('MULTIPLY',separate.outputs['X'],1/16)
    yy=math_node('MULTIPLY',separate.outputs['Y'],1/12.8)
    radius=math_node('SQRT',math_node('ADD',math_node('MULTIPLY',xx,xx),math_node('MULTIPLY',yy,yy)))
    ramp=nodes.new('ShaderNodeValToRGB')
    links.new(math_node('MULTIPLY',radius,.625),ramp.inputs[0])
    stops=[(0,'#55C2C1'),(.47,'#55BCBC'),(.59,'#A5D7C1'),(.65,'#70CBC7'),(.76,'#279DBA'),(1,'#237F9E')]
    elements=ramp.color_ramp.elements
    for item in list(elements)[1:]:elements.remove(item)
    for i,(position,color) in enumerate(stops):
        item=elements[0] if i==0 else elements.new(position);item.position=position;item.color=linear(color)
    links.new(ramp.outputs['Color'],bsdf.inputs['Base Color'])
    noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=3.8;noise.inputs['Detail'].default_value=3.2;noise.inputs['Roughness'].default_value=.65
    links.new(geometry.outputs['Position'],noise.inputs['Vector'])
    wave=nodes.new('ShaderNodeTexWave');wave.wave_type='BANDS';wave.bands_direction='DIAGONAL'
    wave.inputs['Scale'].default_value=1.25;wave.inputs['Distortion'].default_value=5;wave.inputs['Detail Scale'].default_value=.7
    links.new(geometry.outputs['Position'],wave.inputs['Vector'])
    bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.3;bump.inputs['Distance'].default_value=.085
    links.new(math_node('ADD',math_node('MULTIPLY',noise.outputs['Fac'],.94),math_node('MULTIPLY',wave.outputs['Fac'],.06)),bump.inputs['Height'])
    links.new(bump.outputs['Normal'],bsdf.inputs['Normal'])
    absorption=nodes.new('ShaderNodeVolumeAbsorption');absorption.inputs['Color'].default_value=linear('#69C6D8');absorption.inputs['Density'].default_value=.035
    links.new(absorption.outputs['Volume'],nodes['Material Output'].inputs['Volume'])
    # A single continuous water surface in the native preview prevents two
    # refractive sheets from overlapping at the estuary. The engine receives
    # the dedicated creek mesh separately and owns its opaque ocean shader.
    nx,nz,spacing=289,241,.25
    verts=[];faces=[]
    for j in range(nz):
        z=(j-(nz-1)/2)*spacing
        center=river_center(z);level=water_height(z)
        width=LAYOUT['river']['halfWidth']*(1+.2*smooth((abs(z)-10)/3))
        for i in range(nx):
            x=(i-(nx-1)/2)*spacing;d=abs(x-center)
            blend=1-smooth((d-width)/.3)
            h=SEA+(level-SEA)*blend
            verts.append((x,-z,h))
    for j in range(nz-1):
        for i in range(nx-1):
            k=j*nx+i;faces.append((k,k+nx,k+nx+1,k+1))
    mesh=bpy.data.meshes.new('Unified ocean and tidal creek surface');mesh.from_pydata(verts,[],faces);mesh.materials.append(water)
    for p in mesh.polygons:p.use_smooth=True
    obj=bpy.data.objects.new('Preview / continuous sea and creek',mesh);collection.objects.link(obj)
    ocean=Batch('Preview / ocean to horizon',water,collection)
    ocean.polygon([(-180,SEA,-180),(-180,SEA,180),(-36,SEA,180),(-36,SEA,-180)])
    ocean.polygon([(36,SEA,-180),(36,SEA,180),(180,SEA,180),(180,SEA,-180)])
    ocean.polygon([(-36,SEA,-180),(-36,SEA,-30),(36,SEA,-30),(36,SEA,-180)])
    ocean.polygon([(-36,SEA,30),(-36,SEA,180),(36,SEA,180),(36,SEA,30)])
    ocean.build('preview')
    floor=Batch('Preview / distant seabed',mats['sand'],collection)
    floor.polygon([(-180,-5.5,-180),(-180,-5.5,180),(180,-5.5,180),(180,-5.5,-180)]);floor.build('preview')
    foam=Batch('Preview / sparse shore foam',mats['foam'],collection)
    for band in [0,.5]:
        for i in range(512):
            a=i*math.tau/512;b=(i+1)*math.tau/512
            if math.sin(a*33+band*6)+math.sin(a*17)<-.25:continue
            _,test_r,_=radial_bounds(math.cos(a)*18,math.sin(a)*18)
            tx,tz=math.cos(a)*test_r,math.sin(a)*test_r
            if tz>7.5 and abs(tx-river_center(tz))<3:continue
            verts=[]
            for angle,side in [(a,-1),(a,1),(b,1),(b,-1)]:
                _,shore,_=radial_bounds(math.cos(angle)*18,math.sin(angle)*18)
                r=shore+band+.075*math.sin(angle*45)+side*(.06 if band==0 else .035)*(1+.3*math.sin(angle*93))
                verts.append((math.cos(angle)*r,SEA+.018,math.sin(angle)*r))
            foam.polygon(verts)
    foam.build('preview')
    cam_data=bpy.data.cameras.new('Coastal island / hero camera');camera=bpy.data.objects.new(cam_data.name,cam_data)
    collection.objects.link(camera)
    cam=LAYOUT['referenceCamera'];az=math.radians(cam['azimuthDegrees']);el=math.radians(cam['elevationDegrees'])
    target=(0,0,cam['aimHeight']);distance=60
    camera.location=(distance*math.cos(el)*math.sin(az),-distance*math.cos(el)*math.cos(az),target[2]+distance*math.sin(el))
    aim(camera,target);cam_data.type='ORTHO';cam_data.ortho_scale=cam['orthoScale'];scene.camera=camera
    sun_data=bpy.data.lights.new('Sun / late afternoon','SUN');sun_data.energy=3.2;sun_data.angle=math.radians(6)
    sun_data.color=(1,.89,.68)
    sun=bpy.data.objects.new(sun_data.name,sun_data);collection.objects.link(sun);sun.location=(10,9,19);aim(sun,(0,0,0))
    fill_data=bpy.data.lights.new('Sky / large softbox','AREA');fill_data.energy=650;fill_data.shape='DISK';fill_data.size=22
    fill=bpy.data.objects.new(fill_data.name,fill_data);collection.objects.link(fill);fill.location=(5,4,18);aim(fill,(0,0,0))
    world=bpy.data.worlds.new('Coastal blue atmosphere');world.use_nodes=True
    world.node_tree.nodes['Background'].inputs['Color'].default_value=(.42,.56,.67,1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value=.55;scene.world=world
    flame_mat=material('Preview / golden flame','#FFAF35',.55)
    flame_bsdf=flame_mat.node_tree.nodes['Principled BSDF'];flame_bsdf.inputs['Emission Color'].default_value=linear('#FF8821');flame_bsdf.inputs['Emission Strength'].default_value=4
    flame=Batch('Preview / optional firelight',flame_mat,collection)
    cx,cz=OBSTACLES['campfire']['x'],OBSTACLES['campfire']['z']
    for x,y,z,s in [(cx,.45,cz,1),(cx-.2,.35,cz+.04,.6),(cx+.2,.34,cz-.1,.55)]:
        flame.rock(x,y,z,.17*s,.5*s,.14*s,1,sides=8,rings=5)
    flame_obj=flame.build('preview',True);flame_obj.hide_render=True
    light_data=bpy.data.lights.new('Preview / hearth warmth','POINT');light_data.energy=0;light_data.color=(1,.35,.07);light_data.shadow_soft_size=.8
    hearth=bpy.data.objects.new(light_data.name,light_data);collection.objects.link(hearth);hearth.location=(cx,-cz,.6)
    return sun_data,fill_data,world,flame_obj,light_data


def main():
    if not bpy.app.background:raise RuntimeError('Run this generator in an isolated background Blender process dispatched through MCP.')
    status('building')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version=0
    scene=bpy.context.scene;scene.name='Living Diorama / Coastal Island v2'
    scene['generator']=TAG;scene['reference']='docs/design/images/coastal-island-map-v2.png'
    scene['coordinate_contract']='Game Y-up; Blender=(x,-z,y); source src/ecology/coastalLayout.json'
    scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=1
    collections={}
    for name in ['Terrain','Vegetation','Structures','Interest Points','Preview Studio']:
        col=bpy.data.collections.new(name);scene.collection.children.link(col);collections[name]=col
    palette={'bark':'#71543A','bark_light':'#A07A45','leaf_dark':'#60752D','leaf':'#899A37',
             'leaf_light':'#ABB146','leaf_sun':'#C9C457','grass':'#8E9D4C','grass_light':'#AFB862',
             'flower_pink':'#E9A8B8','flower_yellow':'#EFD87D','flower_cream':'#F5ECD1','flower_center':'#CBA75A',
             'fruit':'#EDB181','stone':'#A5A38C','sand':'#D7C79A','path':'#BBA06B',
             'warm_stone':'#C8955F','hearth_stone':'#A5A296','wood_dark':'#715331','timber':'#AD854C',
             'timber_light':'#C7A66C','rope':'#CCB17A','water':'#5BACB4','foam':'#D6E6D8'}
    mats={k:material('Coast / '+k,v) for k,v in palette.items()}
    for key in ['path','sand','bark','bark_light','stone','warm_stone','timber']:
        surface_grain(mats[key],20 if key in ['path','sand'] else 9,.20,.04)
    make_paths(collections['Terrain'],mats)
    terrain=make_terrain(collections['Terrain'],mats)
    river=make_river(collections['Terrain'],mats)
    make_props(collections['Structures'],mats)
    from coastal_flora import build_flora
    build_flora(collections['Vegetation'],mats,LAYOUT,terrain_height)
    make_anchors(collections['Interest Points'])
    studio=setup_studio(scene,collections['Preview Studio'],mats)
    scene.render.engine='CYCLES';scene.cycles.samples=64;scene.cycles.use_denoising=True
    scene.render.resolution_x=LAYOUT['referenceCamera']['width'];scene.render.resolution_y=LAYOUT['referenceCamera']['height'];scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
    scene.view_settings.view_transform='AgX'
    scene.view_settings.look='AgX - Medium High Contrast'
    scene.view_settings.exposure=.18
    scene.render.threads_mode='FIXED';scene.render.threads=8
    bake_terrain_albedo(scene,terrain)
    # Static landscape alone is shipped. Preview sea, cameras, lamps and staged
    # firelight are intentionally outside the runtime GLB.
    bpy.ops.object.select_all(action='DESELECT')
    export_objects=[obj for name,col in collections.items() if name!='Preview Studio' for obj in col.objects]
    for obj in export_objects:obj.select_set(True)
    bpy.context.view_layer.objects.active=next(obj for obj in export_objects if obj.type=='MESH')
    bpy.context.view_layer.update()
    for obj in export_objects:
        if obj.type=='MESH':
            obj.data.calc_loop_triangles()
    triangles=sum(len(obj.data.loop_triangles) for obj in export_objects if obj.type=='MESH')
    ASSET.parent.mkdir(parents=True,exist_ok=True);SOURCE.parent.mkdir(parents=True,exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(ASSET),export_format='GLB',use_selection=True,use_active_scene=True,
                            export_apply=True,export_extras=True,export_yup=True,export_animations=False,
                            export_cameras=False,export_lights=False,export_vertex_color='NONE')
    river.hide_render=True
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE),compress=True)
    summary={'blend':str(SOURCE),'glb':str(ASSET),'glb_bytes':ASSET.stat().st_size,
             'mesh_objects':sum(o.type=='MESH' for o in export_objects),'triangles':triangles,
             'objects':len(export_objects),'obstacles':len(LAYOUT['obstacles']),
             'original_open_document_modified':False,'reference':scene['reference']}
    status('rendering-day',**summary)
    scene.render.filepath=str(ART/'coastal-island-v2-day.png');bpy.ops.render.render(write_still=True)
    status('rendering-dusk',**summary)
    sun,fill,world,flame,hearth=studio
    sun.energy=.7;sun.color=(1,.58,.31);fill.energy=1050
    world.node_tree.nodes['Background'].inputs['Color'].default_value=(.2,.3,.5,1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value=.28
    flame.hide_render=False;hearth.energy=140
    scene.render.filepath=str(ART/'coastal-island-v2-dusk.png');bpy.ops.render.render(write_still=True)
    status('complete',**summary)


if __name__=='__main__':
    try:main()
    except Exception as exc:
        status('error',error=str(exc),traceback=traceback.format_exc())
        raise
