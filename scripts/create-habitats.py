"""Author six compact dioramas in Blender and export independent glTF 2 assets.

Run in Blender's Python console or through Blender MCP:
  exec(compile(open('/absolute/repo/scripts/create-habitats.py').read(),
               '/absolute/repo/scripts/create-habitats.py', 'exec'))

This script creates new scenes; existing scenes and objects are preserved.
Coordinates: Blender Z-up, with the principal foliage/rocks at positive Y.
glTF export converts these to Y-up with scenery behind the hero at negative Z.
All habitats have a clear central standing area at Y=0 in the exported asset.
No external textures are needed. Meshes are batched per material.
"""
from pathlib import Path
import math
import random
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1] if '__file__' in globals() else Path('/Users/06wj/Documents/github/pokemon')
OUTPUT = ROOT / 'public' / 'habitats'
OUTPUT.mkdir(parents=True, exist_ok=True)
TAU = math.tau
CURRENT = None
BATCHES = {}
MATERIALS = {}


def color(value):
    v = [(value >> shift & 255) / 255 for shift in (16, 8, 0)]
    return tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in v)


def material(name, hexcolor, roughness=.7, metallic=0., emission=0., double_sided=False):
    mat = bpy.data.materials.new('Habitat_' + name)
    mat.use_nodes = True
    node = mat.node_tree.nodes.get('Principled BSDF')
    rgba = (*color(hexcolor), 1.)
    node.inputs['Base Color'].default_value = rgba
    node.inputs['Roughness'].default_value = roughness
    node.inputs['Metallic'].default_value = metallic
    if emission:
        node.inputs['Emission Color'].default_value = rgba
        node.inputs['Emission Strength'].default_value = emission
    mat.diffuse_color = rgba
    mat.use_backface_culling = not double_sided
    MATERIALS[name] = mat
    return name


def mesh(name, vertices, faces, mat, smooth=False):
    batch = BATCHES.setdefault(mat, [[], [], []])
    offset = len(batch[0])
    batch[0].extend(vertices)
    batch[1].extend(tuple(i + offset for i in face) for face in faces)
    batch[2].extend([smooth] * len(faces))


def radial_radius(a, radius):
    return radius * (1 + .027 * math.sin(3*a+.4) + .018 * math.sin(7*a-1.2) + .012 * math.sin(11*a))


def island(name, radius, height, mats, xy=(0, 0), elliptical=1.):
    """Rounded, irregular five-ring profile and a flat, unbroken standing surface."""
    count = 96
    profiles = [(0., height), (.55, height), (.95, height-.035), (1., height-.13), (.97, height-.39), (.88, height-.68)]
    rings = []
    for ri, (fraction, z) in enumerate(profiles[1:]):
        rings.append([(xy[0]+math.cos(i*TAU/count)*radial_radius(i*TAU/count, radius)*fraction,
                       xy[1]+math.sin(i*TAU/count)*radial_radius(i*TAU/count, radius)*fraction*elliptical,
                       z + (0 if ri == 0 else .02*math.sin(i*TAU/count*5))) for i in range(count)])
    mesh(name+'_top', [(xy[0],xy[1],height)]+rings[0], [(0,i+1,(i+1)%count+1) for i in range(count)], mats[0])
    for ri in range(len(rings)-1):
        vertices = rings[ri]+rings[ri+1]
        faces = [(i,i+count,(i+1)%count+count,(i+1)%count) for i in range(count)]
        mesh(name+'_stratum_'+str(ri), vertices, faces, mats[min(ri,len(mats)-1)], smooth=True)
    mesh(name+'_underside', rings[-1], [tuple(reversed(range(count)))], mats[-1])


def tube(name, points, radius, mat, sides=7, radii=None):
    if len(points) < 2: return
    vertices=[]
    for i, p in enumerate(points):
        p=Vector(p)
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(i-1,0)])
        tangent.normalize()
        ref=Vector((0,0,1)) if abs(tangent.z)<.9 else Vector((0,1,0))
        u=tangent.cross(ref).normalized()
        v=tangent.cross(u).normalized()
        r=radius*(radii[i] if radii else 1)
        vertices.extend(tuple(p+r*(math.cos(j*TAU/sides)*u+math.sin(j*TAU/sides)*v)) for j in range(sides))
    faces=[]
    for i in range(len(points)-1):
        for j in range(sides):
            faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
    faces.extend([tuple(reversed(range(sides))), tuple((len(points)-1)*sides+j for j in range(sides))])
    mesh(name,vertices,faces,mat,True)


def rock(name, pos, size, mat, seed=0, facets=10, smooth=True):
    rng=random.Random(seed)
    vertices=[]
    rings=[(-.46,.48),(-.34,.9),(-.02,1.),(.30,.84),(.46,.42)]
    offsets=[rng.uniform(-.10,.10) for _ in range(facets)]
    for ri,(z,r) in enumerate(rings):
        for i in range(facets):
            a=i*TAU/facets+.12*(ri%2)
            rr=r*(1+offsets[i])
            vertices.append((pos[0]+math.cos(a)*size[0]*rr/2,pos[1]+math.sin(a)*size[1]*rr/2,pos[2]+(z+.5)*size[2]))
    faces=[tuple(reversed(range(facets)))]
    for j in range(len(rings)-1):
        for i in range(facets):
            faces.append((j*facets+i,j*facets+(i+1)%facets,(j+1)*facets+(i+1)%facets,(j+1)*facets+i))
    faces.append(tuple((len(rings)-1)*facets+i for i in range(facets)))
    mesh(name,vertices,faces,mat,smooth)


def leaf(name, start, end, width, mat, bend=.18):
    start,end=Vector(start),Vector(end)
    direction=end-start
    side=direction.cross(Vector((0,0,1)))
    if side.length<.01: side=Vector((1,0,0))
    side.normalize()
    normal=side.cross(direction).normalized()
    verts=[]
    steps=9
    for i in range(steps):
        t=i/(steps-1)
        center=start+direction*t+Vector((0,0,bend*math.sin(math.pi*t)))
        w=width*math.sin(math.pi*t)**.85
        verts.extend([tuple(center-side*w+normal*w*.07),tuple(center+normal*w*.24),tuple(center+side*w+normal*w*.07)])
    faces=[]
    for i in range(steps-1):
        for j in range(2): faces.append((3*i+j,3*i+j+1,3*(i+1)+j+1,3*(i+1)+j))
    mesh(name,verts,faces,mat,True)


def fern(name, origin, height, bearing, light, dark):
    o=Vector(origin)
    direction=Vector((math.cos(bearing),math.sin(bearing),0))
    side=Vector((-direction.y,direction.x,0))
    points=[]
    for i in range(18):
        t=i/17
        points.append(tuple(o+direction*(height*.72*t**1.25)+Vector((0,0,height*(1.25*t-.42*t*t)))))
    tube(name+'_stem',points,.025,dark,6,radii=[1-i/20 for i in range(18)])
    for i in range(2,15):
        t=i/17
        p=Vector(points[i]);w=height*.30*(math.sin(math.pi*t)**.8)
        for sign in [-1,1]:
            end=p+side*sign*w+direction*(height*.12)+Vector((0,0,height*.06))
            leaf(name+'_pinna',p,end,w*.24,light if i%3 else dark,bend=.045)


def crystal(name, pos, width, height, mats, lean=(0,0), rotation=0):
    count=6
    vertices=[]
    for z,r in [(0,.86),(height*.09,1),(height*.72,.82)]:
        for i in range(count):
            a=i*TAU/count+rotation
            vertices.append((pos[0]+math.cos(a)*width*r+lean[0]*z/height,pos[1]+math.sin(a)*width*r+lean[1]*z/height,pos[2]+z))
    vertices.append((pos[0]+lean[0]+width*.13,pos[1]+lean[1]-width*.17,pos[2]+height))
    mesh(name+'_base',vertices,[tuple(reversed(range(count)))],mats[0])
    for j in range(2):
        for i in range(count): mesh(name+'_side',vertices,[(j*count+i,j*count+(i+1)%count,(j+1)*count+(i+1)%count,(j+1)*count+i)],mats[i%len(mats)])
    for i in range(count): mesh(name+'_tip',vertices,[(12+i,12+(i+1)%count,18)],mats[(i+1)%len(mats)])


def column(name,pos,radius,height,mat,sides=6,lean=(0,0)):
    verts=[]
    for z,r in [(0,.88),(.07,1),(height-.07,1),(height,.88)]:
        for i in range(sides):
            a=i*TAU/sides
            verts.append((pos[0]+math.cos(a)*radius*r+lean[0]*z/height,pos[1]+math.sin(a)*radius*r+lean[1]*z/height,pos[2]+z))
    faces=[tuple(reversed(range(sides)))]
    for ring in range(3):
        for i in range(sides): faces.append((ring*sides+i,ring*sides+(i+1)%sides,(ring+1)*sides+(i+1)%sides,(ring+1)*sides+i))
    faces.append(tuple(3*sides+i for i in range(sides)))
    mesh(name,verts,faces,mat)


def arc(name,center,radius,start,end,width,depth,mat):
    count=max(4,int(abs(end-start)*20))
    verts=[]
    for i in range(count+1):
        a=start+(end-start)*i/count
        for radial,back in [(-width/2,-depth/2),(width/2,-depth/2),(width/2,depth/2),(-width/2,depth/2)]:
            verts.append((center[0]+math.cos(a)*(radius+radial),center[1]+back,center[2]+math.sin(a)*(radius+radial)))
    faces=[(3,2,1,0)]
    for i in range(count):
        for j in range(4): faces.append((i*4+j,i*4+(j+1)%4,(i+1)*4+(j+1)%4,(i+1)*4+j))
    faces.append(tuple(count*4+j for j in range(4)))
    mesh(name,verts,faces,mat)


def grove():
    soil=material('grove_earth',0x293c32,.96)
    edge=material('grove_edge',0x3e5943,.91)
    moss=material('grove_moss',0x42664b,.94)
    cushion=material('grove_moss_cushions',0x507d52,.92)
    clearing=material('grove_clearing',0x6b8553,.92)
    stone=material('grove_riverstone',0x7d9186,.82)
    shade=material('grove_stone_shadow',0x516f62,.89)
    jade=material('grove_jade_leaf',0x287254,.59,double_sided=True)
    lime=material('grove_young_leaf',0x87ac4b,.66,double_sided=True)
    stem=material('grove_leaf_stem',0x486239,.82)
    cap=material('grove_mushroom_cap',0xdba779,.67)
    ivory=material('grove_mushroom_stem',0xd4ccb0,.86)
    island('moss island',3.13,0,[moss,edge,soil])
    # A gently winding moss clearing. The standing area stays flat and open;
    # its softly uneven outline breaks up the broad surface around the hero.
    path_verts=[]
    for i in range(57):
        t=i/56
        y=-2.83+t*5.35
        x=.24*math.sin(t*TAU-.4)-.06
        width=.40+.67*math.sin(math.pi*t)**.8
        edge_noise=.045*math.sin(t*TAU*4)+.027*math.cos(t*TAU*7)
        for j in range(13):
            px=(x-width-edge_noise)*(1-j/12)+(x+width-edge_noise*.6)*(j/12)
            a=math.atan2(y,px)
            fraction=math.hypot(px,y)/radial_radius(a,3.13)
            surface=max(0,min(1,(fraction-.55)/.4))*(-.035+.02*math.sin(a*5))
            path_verts.append((px,y,surface+.0035))
    mesh('winding moss clearing',path_verts,[(13*i+j,13*i+j+1,13*(i+1)+j+1,13*(i+1)+j) for i in range(56) for j in range(12)],clearing)
    # Moss shelves and cushions soften the perimeter in staggered layers.
    cushion_positions=[(-2.49,-.64,.76,.68,.17),(-2.44,.10,.88,.62,.24),
        (-2.46,.66,.87,.78,.28),(-1.52,2.13,.88,.76,.22),(-.76,2.44,.82,.62,.22),
        (.08,2.60,.80,.53,.20),(.87,2.40,.81,.66,.25),(1.51,2.16,.78,.71,.24),
        (2.33,1.27,.90,.72,.27),(2.48,.50,.72,.79,.25),(2.39,-.29,.73,.66,.19),
        (2.05,-1.18,.77,.64,.13),(-1.52,-2.08,.71,.46,.12)]
    for idx,(x,y,w,d,h) in enumerate(cushion_positions):
        rock('sculpted moss cushion',(x,y,-.035),(w,d,h),cushion if idx%3 else moss,100+idx,14)
        if idx%2==0:
            rock('overlapping moss lobe',(x+.15,y-.16,-.028),(w*.64,d*.60,h*.82),moss,130+idx,12)
    for idx,p in enumerate([(-2.18,1.30,-.02,1.05,1.07,.77),(-2.45,.75,.025,.62,.69,.41),(2.04,1.62,.015,.88,.8,.59),(2.41,.98,.035,.59,.62,.34),(-2.22,-1.28,-.03,.46,.52,.21)]):
        rock('moss stone',p[:3],p[3:],stone if idx%2 else shade,idx)
        rock('moss pillow',(p[0]-.06,p[1],p[2]+p[5]*.83),(p[3]*.78,p[4]*.78,.16),cushion,idx+9,14)
    fern('left fern',(-2.09,1.36,.48),1.47,1.90,lime,jade)
    fern('left fern companion',(-2.10,1.37,.48),1.02,.62,jade,stem)
    fern('right fern',(2.02,1.53,.47),1.37,1.05,jade,lime)
    fern('right low fern',(2.38,.37,.13),.72,2.08,lime,jade)
    fern('left low fern',(-2.40,-.04,.12),.66,1.13,jade,lime)
    for name,origin,scale,bearing in [('broad left',(-2.40,.68,.08),.91,2.23),('broad right',(2.25,.75,.09),.86,.28),('back left shrub',(-1.24,2.22,.10),.72,1.1),('back right shrub',(.89,2.35,.13),.62,1.85)]:
        for i in range(7):
            a=bearing+(i-3)*.56
            end=(origin[0]+math.cos(a)*scale*.48,origin[1]+math.sin(a)*scale*.44,origin[2]+scale*(.57+.10*(3-abs(i-3))))
            leaf(name,origin,end,.15 if scale<.8 else .19,jade if i%3 else lime,.13)
    for idx,(x,y,s) in enumerate([(-2.13,-.73,.26),(-2.43,-.50,.19),(-1.96,-.96,.16),(1.55,-1.87,.17),(1.74,-1.78,.13),(-.82,-2.46,.14)]):
        tube('mushroom stem',[(x,y,0),(x+.015,y,.75*s)],s*.12,ivory)
        rock('mushroom cap',(x,y,.6*s),(s,s,.3*s),cap,50+idx,16)
    for idx,(x,y,s) in enumerate([(-1.62,-1.86,.22),(-1.40,-2.11,.15),(.91,-2.37,.17),(1.09,-2.34,.11),(2.38,-.97,.23),(-2.63,.12,.15)]):
        rock('foreground pebble',(x,y,-.022),(s*1.25,s,s*.56),stone if idx%2 else shade,180+idx,12)
    for i,(x,y) in enumerate([(1.92,-1.60),(2.23,-1.20),(-1.57,2.23),(.97,2.46),(-2.46,-.84),(-1.16,-2.24),(2.38,-.55)]):
        for j in range(4):
            leaf('small grass',(x,y,.015),(x+(j-1.5)*.08,y+.06,.18-j*.017),.027,lime if i%2 else jade,.025)


def lagoon():
    deep=material('lagoon_deep_turquoise',0x297e83,.22,.12)
    water=material('lagoon_surface',0x54bfc0,.17,.10)
    sandedge=material('lagoon_sand_edge',0xb9a57d,.88)
    sand=material('lagoon_sand',0xe8d4a3,.91)
    stone=material('lagoon_pearl_rock',0xb6c3b7,.63)
    foam=material('lagoon_wavelet',0xb7eddf,.25,.06)
    coral=material('lagoon_shell',0xeab9a3,.53)
    green=material('lagoon_beach_leaves',0x679b73,.7,double_sided=True)
    island('water',3.17,-.09,[water,deep,deep])
    # An asymmetric beach, broad under the hero and tapering to a crescent at the front right.
    n=96;verts=[(0,0,0)]
    for i in range(n):
        a=i*TAU/n
        r=2.46+.27*math.sin(a+.55)+.10*math.cos(3*a)
        verts.append((math.cos(a)*r-.12,math.sin(a)*r+.1,0))
    mesh('sand shoreline',verts,[(0,i+1,(i+1)%n+1) for i in range(n)],sand)
    outer=verts[1:]
    mesh('sand lip',outer+[(x*1.02,y*1.02,z-.10) for x,y,z in outer],[(i,i+n,(i+1)%n+n,(i+1)%n) for i in range(n)],sandedge,True)
    for idx,p in enumerate([(-2.0,1.35,0,1.1,.94,.8),(-2.3,.88,0,.63,.62,.45),(1.9,1.65,0,.86,.77,.58),(2.44,1.17,-.05,.56,.60,.3)]):
        rock('shore rock',p[:3],p[3:],stone,70+idx,12)
    for r,a0,a1,z in [(2.72,-2.4,-.28,-.064),(2.9,-2.1,-.22,-.07),(2.71,.12,.7,-.065)]:
        pts=[(math.cos(a0+(a1-a0)*i/48)*r,math.sin(a0+(a1-a0)*i/48)*r,z) for i in range(49)]
        tube('tidal ripple',pts,.013,foam,5,radii=[.35+.65*math.sin(math.pi*i/48) for i in range(49)])
    for idx,(x,y,r) in enumerate([(-1.74,-1.44,.18),(1.65,-1.35,.13),(2.0,-.95,.12)]):
        rock('pearl shell',(x,y,.005),(r*1.5,r,r*.46),coral,idx,12)
    for x,y in [(-2.2,1.35),(2.0,1.74)]:
        for j in range(5):
            a=j*TAU/5
            leaf('shore succulent',(x,y,.42),(x+.42*math.cos(a),y+.36*math.sin(a),.85+.2*(j%2)),.085,green,.08)


def caldera():
    top=material('caldera_top',0x514b46,.93)
    basalt=material('caldera_basalt',0x3f4141,.82)
    edge=material('caldera_weathered_edge',0x766354,.91)
    dark=material('caldera_pillars',0x464e50,.77)
    light=material('caldera_pillar_faces',0x606264,.81)
    ember=material('caldera_ember',0xf09747,.39,.12,1.0)
    warm=material('caldera_scorched_rock',0x926347,.86)
    island('basalt island',3.12,0,[top,edge,basalt])
    for i,(x,y,r,h) in enumerate([(-2.2,1.0,.48,1.18),(-1.89,1.6,.47,1.76),(-2.45,1.7,.42,1.37),(-1.38,2.16,.42,1.24),(1.88,1.77,.46,1.29),(2.35,1.23,.38,.8),(1.36,2.30,.37,.68)]):
        column('hexagonal basalt',(x,y,-.05),r,h,dark if i%3 else light,6,lean=(.07 if x>0 else -.09,0))
    for points in [[(-3,-.45,.005),(-2.45,-.5,.007),(-2.20,-.14,.008),(-1.87,.2,.006),(-1.76,.72,.006)],[(2.87,-.89,.002),(2.47,-.56,.007),(2.53,-.11,.008),(2.0,.37,.008),(2.18,.94,.006)],[(.46,2.77,.003),(.33,2.32,.006),(.02,2.02,.008),(-.51,2.19,.006)]]:
        tube('cooling fissure',points,.022,ember,5)
    for i,p in enumerate([(-2.4,-1.18,-.03,.48,.55,.35),(2.35,-1.35,-.02,.66,.59,.36),(-.84,2.57,-.01,.58,.44,.33)]):
        rock('cinder boulder',p[:3],p[3:],warm,i,8,False)
    for i,(x,y) in enumerate([(-2.54,.52),(2.55,.33),(-1.32,2.40)]):
        crystal('ember mineral',(x,y,.02),.11,.25,[warm,ember,warm],(.05,.04),i)


def glacier():
    ice=material('glacier_edge',0x85b8cb,.21,.08)
    snow=material('glacier_snow',0xe1e8e1,.81)
    under=material('glacier_deep_ice',0x498da6,.27,.14)
    a=material('glacier_crystal_a',0x9cdde7,.15,.08)
    b=material('glacier_crystal_b',0x70b3d1,.22,.12)
    c=material('glacier_crystal_c',0xc2e9e4,.13,.04)
    glint=material('glacier_glint',0xc4f2ef,.22,.05,.2)
    island('ice floe',3.12,0,[snow,ice,under])
    for i,(x,y,w,h,lx,ly) in enumerate([(-2.08,1.52,.38,2.06,-.33,.03),(-2.5,1.06,.28,1.12,-.3,0),(-1.58,2.08,.25,1.31,.06,.08),(1.9,1.79,.35,1.73,.19,.05),(2.4,1.12,.27,1.13,.28,0),(1.37,2.21,.21,.85,-.03,.03)]):
        crystal('glacial crystal',(x,y,-.02),w,h,[a,b,c],(lx,ly),i*.23)
    for i,p in enumerate([(-2.49,-.74,-.03,.59,.70,.25),(2.25,-1.13,-.04,.75,.62,.24),(-.68,2.65,-.06,.63,.43,.19)]):
        rock('snow pillow',p[:3],p[3:],snow,i,12)
    for pts in [[(-3,-.38,.002),(-2.43,-.27,.004),(-2.1,.17,.004)],[(2.81,-.75,.004),(2.4,-.46,.004),(2.07,-.1,.004)]]:
        tube('ice seam',pts,.013,glint,5)


def storm():
    sand=material('storm_ochre',0xbfa36a,.9)
    strata=material('storm_sandstone_edge',0x9e8053,.89)
    base=material('storm_sandstone_base',0x736b52,.9)
    rockmat=material('storm_windstone',0xb49a70,.78)
    gold=material('storm_amber_gold',0xedba48,.22,.25)
    amber=material('storm_amber_shade',0xbe8333,.28,.22)
    pale=material('storm_amber_glint',0xf5d27b,.21,.18)
    line=material('storm_mineral_seam',0xddc384,.57,.18)
    island('sandstone mesa',3.12,0,[sand,strata,base])
    for i,(x,y,r,h,lx) in enumerate([(-2.12,1.64,.49,1.40,-.30),(-2.5,.94,.35,.83,-.16),(1.88,1.85,.46,1.67,.31),(2.30,1.27,.37,.94,.18)]):
        column('windcut sandstone',(x,y,-.04),r,h,rockmat,7,lean=(lx,.06))
    for i,(x,y,w,h,lx) in enumerate([(-1.69,2.13,.23,1.69,-.24),(-2.27,1.96,.16,1.85,-.20),(2.39,.94,.19,.82,.19),(1.32,2.35,.15,.94,.04)]):
        crystal('amber crystal',(x,y,.03),w,h,[gold,amber,pale],(lx,0),.3+i)
    for i,(x,y,r,z) in enumerate([(-2.09,1.66,.505,.47),(-2.18,1.65,.50,.94),(2.07,1.85,.47,.8)]):
        pts=[(x+math.cos(a*TAU/7)*r,y+math.sin(a*TAU/7)*r,z) for a in range(8)]
        tube('sandstone mineral band',pts,.014,line,5)
    for i,p in enumerate([(-2.35,-1.26,-.03,.68,.57,.29),(2.16,-1.49,-.03,.49,.68,.25),(.09,2.65,-.03,.61,.44,.22)]):
        rock('wind pebble',p[:3],p[3:],rockmat,i,10)
    for i in range(3):
        pts=[(-2.75+t*.5,-.2+math.sin(t*math.pi)*.13,-.02+.01*i) for t in [j/10 for j in range(11)]]
        pts=[(x,y+i*.15,z) for x,y,z in pts]
        tube('wind carved sand',pts,.013,line,5)


def astral():
    ground=material('astral_dust',0x887c9d,.91)
    edge=material('astral_stone_edge',0x696179,.87)
    base=material('astral_deep_stone',0x504a61,.9)
    ruin=material('astral_ruin',0xaea2bb,.68)
    face=material('astral_crystal_lilac',0xa48cce,.2,.16)
    shade=material('astral_crystal_violet',0x746bb0,.25,.18)
    bright=material('astral_crystal_pearl',0xd2b7df,.18,.12)
    glint=material('astral_starlight',0xddc2f0,.26,.16,.25)
    island('astral garden',3.12,0,[ground,edge,base])
    # Broken arch, set well behind the standing area, with an open silhouette.
    arc('ancient arch left',(0,2.19,.69),1.5,1.90,3.43,.24,.32,ruin)
    arc('ancient arch upper',(0,2.19,.69),1.5,.32,1.55,.24,.32,ruin)
    arc('arch inlay left',(0,2.01,.69),1.50,1.94,3.32,.023,.015,glint)
    arc('arch inlay upper',(0,2.01,.69),1.50,.39,1.50,.023,.015,glint)
    for i,p in enumerate([(-1.6,2.02,-.02,.67,.65,.30),(1.62,1.92,-.02,.6,.61,.3),(.36,2.65,-.03,.56,.49,.23)]):
        rock('ruin foundation',p[:3],p[3:],ruin,i,8)
    for i,(x,y,w,h,lx) in enumerate([(-2.20,1.22,.30,1.45,-.2),(-2.47,.74,.20,.87,-.22),(-1.83,1.51,.19,1.05,.08),(2.16,1.38,.32,1.66,.23),(2.47,.87,.21,.88,.19),(1.83,1.83,.19,.93,-.1)]):
        crystal('astral mineral',(x,y,.005),w,h,[face,shade,bright],(lx,.06),i*.46)
    for idx,(x,y,w) in enumerate([(-2.12,-1.25,.15),(2.24,-1.09,.11),(-.50,2.65,.12)]):
        crystal('small astral mineral',(x,y,.01),w,w*2.4,[face,bright,shade],(.05,0),idx)
    # A restrained scattering of tiny mineral facets embedded at the rim.
    for i,(x,y) in enumerate([(-2.46,-.38),(2.64,.13),(1.33,-2.38),(-.97,-2.66)]):
        crystal('embedded starlight',(x,y,-.025),.045,.06,[glint,bright],(0,0),i)


def finish(key):
    for matkey,(verts,faces,smooth) in BATCHES.items():
        data=bpy.data.meshes.new('Habitat_'+key+'_'+matkey)
        data.from_pydata(verts,[],faces)
        data.materials.append(MATERIALS[matkey])
        data.update()
        for poly,flag in zip(data.polygons,smooth): poly.use_smooth=flag
        obj=bpy.data.objects.new('Habitat_'+key+'_'+matkey,data)
        CURRENT.collection.objects.link(obj)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    for obj in CURRENT.objects: obj.select_set(True)
    bpy.context.view_layer.objects.active=next(iter(CURRENT.objects))
    bpy.ops.export_scene.gltf(filepath=str(OUTPUT/(key+'.glb')),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_apply=True,export_cameras=False,export_lights=False,export_animations=False,export_materials='EXPORT',export_extras=False)
    return {'key':key,'materials':len(BATCHES),'vertices':sum(len(v[0]) for v in BATCHES.values()),'triangles':sum(sum(len(f)-2 for f in v[1]) for v in BATCHES.values()),'bytes':(OUTPUT/(key+'.glb')).stat().st_size}


def build_all():
    global CURRENT,BATCHES,MATERIALS
    old_scene=bpy.context.window.scene if bpy.context.window else bpy.context.scene
    if bpy.context.object and bpy.context.object.mode!='OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    summary=[]
    try:
        for key,build in [('grove',grove),('lagoon',lagoon),('caldera',caldera),('glacier',glacier),('storm',storm),('astral',astral)]:
            CURRENT=bpy.data.scenes.new('Habitat_'+key)
            bpy.context.window.scene=CURRENT
            BATCHES={};MATERIALS={}
            build()
            summary.append(finish(key))
    finally:
        bpy.context.window.scene=old_scene
    return summary


result={'habitats':build_all()}
