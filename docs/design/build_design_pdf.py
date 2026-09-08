#!/usr/bin/env python3
"""Build the review edition of the living diorama design book.

Requirements: reportlab, Pillow. Uses embedded system TrueType Chinese fonts.
Usage: python3 docs/design/build_design_pdf.py
The editable full design lives next to this script; diagrams live in images/.
"""
from pathlib import Path
import os
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
IMAGES = HERE / 'images'
OUT = ROOT / 'output/pdf/living-diorama-design-v0.1.pdf'
W, H = 841.89, 595.28
M = 42
INK = HexColor('#21493F')
MUTED = HexColor('#63766A')
PAPER = HexColor('#F7F3E7')
PANEL = HexColor('#FFFFFF')
LINE = HexColor('#DADFCF')
GREEN = HexColor('#769C64')
FIRE = HexColor('#E78C56')
WATER = HexColor('#75B4C6')
YELLOW = HexColor('#EAC56E')
LAVENDER = HexColor('#AC9BBE')


def register_fonts():
    regular = os.environ.get('DIORAMA_FONT_REGULAR', '/System/Library/Fonts/STHeiti Light.ttc')
    bold = os.environ.get('DIORAMA_FONT_BOLD', '/System/Library/Fonts/STHeiti Medium.ttc')
    if not Path(regular).exists() or not Path(bold).exists():
        raise SystemExit('Set DIORAMA_FONT_REGULAR and DIORAMA_FONT_BOLD to Chinese TrueType fonts.')
    pdfmetrics.registerFont(TTFont('CJK', regular, subfontIndex=0))
    pdfmetrics.registerFont(TTFont('CJKB', bold, subfontIndex=0))


def txt(x, y, text, size=11, color=INK, bold=False):
    # Pastel accents are for surfaces; small labels need darker ink.
    color = {
        WATER.hexval(): HexColor('#3E7E90'), FIRE.hexval(): HexColor('#AB562A'),
        YELLOW.hexval(): HexColor('#93701E'), GREEN.hexval(): HexColor('#537340'),
        LAVENDER.hexval(): HexColor('#76618A'),
    }.get(color.hexval(), color)
    c.setFillColor(color)
    c.setFont('CJKB' if bold else 'CJK', size)
    c.drawString(x, H-y-size*.82, text)


def para(x, y, width, text, size=11.2, leading=17, color=INK, bold=False):
    style = ParagraphStyle('body', fontName='CJKB' if bold else 'CJK', fontSize=size,
                           leading=leading, textColor=color, wordWrap='CJK', spaceAfter=0)
    p = Paragraph(text.replace('\n','<br/>'), style)
    _, h = p.wrap(width, 900)
    p.drawOn(c, x, H-y-h)
    return h


def rect(x,y,w,h,fill=PANEL,r=13,stroke=None):
    c.setFillColor(fill)
    c.setStrokeColor(stroke or fill)
    c.roundRect(x,H-y-h,w,h,r,stroke=bool(stroke),fill=1)


def line(x1,y1,x2,y2,color=LINE,width=1):
    c.setStrokeColor(color); c.setLineWidth(width)
    c.line(x1,H-y1,x2,H-y2)


def pill(x,y,label,color=GREEN,size=9.4):
    width = pdfmetrics.stringWidth(label,'CJKB',size)+18
    rect(x,y,width,21,color,r=10)
    txt(x+9,y+5,label,size,INK if color in [YELLOW,WATER,LAVENDER] else white,True)
    return width


def page_header(n, section, title, subtitle=None):
    c.setFillColor(PAPER); c.rect(0,0,W,H,fill=1,stroke=0)
    txt(M,23,'共生之境  /  LIVING DIORAMA',9.2,MUTED,True)
    c.setFillColor(MUTED); c.setFont('CJK',9.2)
    c.drawRightString(W-M,H-31,f'设计提案 v0.1  ·  {section}')
    txt(M,55,title,25,INK,True)
    if subtitle: txt(M,91,subtitle,11.3,MUTED)
    line(M,553,W-M,553)
    txt(M,566,'概念与设计提案 · 非已实现功能 · 2026.09',8.5,MUTED)
    c.setFillColor(MUTED); c.setFont('CJKB',9)
    c.drawRightString(W-M,H-573,f'{n:02d} / 12')


def img(path,x,y,w,h,contain=True):
    path=Path(path)
    if not path.exists(): raise FileNotFoundError(path)
    with Image.open(path) as im:
        iw,ih=im.size
    scale = min(w/iw,h/ih) if contain else max(w/iw,h/ih)
    dw,dh=iw*scale,ih*scale
    c.saveState()
    p=c.beginPath(); p.rect(x,H-y-h,w,h); c.clipPath(p,stroke=0,fill=0)
    c.drawImage(ImageReader(str(path)),x+(w-dw)/2,H-y-h+(h-dh)/2,dw,dh,mask='auto')
    c.restoreState()


def dot(x,y,r,color):
    c.setFillColor(color); c.circle(x,H-y,r,fill=1,stroke=0)


def arrow(x1,y1,x2,y2,color=GREEN,width=1.6):
    import math
    line(x1,y1,x2,y2,color,width)
    a=math.atan2(y2-y1,x2-x1)
    for s in [-1,1]:
        angle=a+s*.55
        line(x2,y2,x2-7*math.cos(angle),y2-7*math.sin(angle),color,width)


def card(x,y,w,h,kicker,title,body,color=GREEN):
    rect(x,y,w,h)
    rect(x,y,5,h,color,r=2)
    txt(x+18,y+15,kicker,9,color,True)
    txt(x+18,y+34,title,16,INK,True)
    para(x+18,y+62,w-36,body,11,16.5)


def full_diagram(n,section,title,subtitle,name):
    page_header(n,section,title,subtitle)
    img(IMAGES/(name+'.png'),M,111,W-2*M,427)
    c.showPage()


def cover():
    c.setFillColor(PAPER);c.rect(0,0,W,H,fill=1,stroke=0)
    hero=IMAGES/'concept-art.png'
    img(hero,0,0,W,337,contain=True)
    # A solid caption zone preserves legibility independently of the hero image.
    c.setFillColor(PAPER);c.rect(0,0,W,258,fill=1,stroke=0)
    pill(M,360,'微缩生态箱 · 宠物互动游戏',INK,10)
    txt(M,400,'共生之境',40,INK,True)
    txt(M+187,417,'LIVING DIORAMA',17,MUTED,True)
    para(M,455,615,'观察一个小生态，轻轻干预，让宝可梦彼此产生意外，\n把那些只发生在此刻的小故事留下来。',15,23)
    txt(W-171,461,'玩法设计 v0.1 · 提案',12,INK,True)
    txt(W-171,485,'2026.09.07',10.5,MUTED)
    line(M,532,W-M,532)
    txt(M,548,'20 只居民  /  6 位重点编排  /  六套基础动画  /  日常生活与四条主戏',10,MUTED)
    txt(M,569,'原创宠物氛围概念 · 20 只居民容量示意；造型独立创作，玩法角色可映射到项目宝可梦。',8.5,MUTED)
    c.showPage()


def residents():
    page_header(4,'角色与表演','20 位居民，先让六个鲜明性格带头接戏','6 位重点编排 + 14 位泛型居民；性格与生态偏好决定选择，六套基础动画负责表演。')
    entries=[
      ('004','小火龙','温暖的发起者','偏爱干燥、火堆；点火后邀请伙伴靠近。','Attack + 火星 = 点火',FIRE),
      ('007','杰尼龟','会搬运水的玩伴','河边吸水、岸边喷水；让花成为新热点。','Attack + 水束 = 吐水',WATER),
      ('025','皮卡丘','好奇的气氛组','靠近花嗅闻；喷嚏、惊讶带动伙伴反应。','Idle + 朝向 / 气泡 = 闻花',YELLOW),
      ('001','妙蛙种子','安静的花园邻居','在花边休息；受浇灌和花香吸引。','Happy = 花开后的回应',GREEN),
      ('012','巴大蝶','移动的生态线索','围花飞行，引来观察者；避免地面跑动观感。','Walk/Run + 空中路径 = 飞行',LAVENDER),
      ('143','卡比兽','节奏的反差','树下睡觉；受喧闹短暂惊醒，再慢慢睡回去。','Sleep → Idle → Sleep',MUTED),
    ]
    cw=(W-2*M-28)/3
    for i,(num,name,role,body,anim,color) in enumerate(entries):
        x=M+(i%3)*(cw+14); y=121+(i//3)*151
        rect(x,y,cw,137)
        pill(x+14,y+13,num,color)
        txt(x+61,y+15,name,16,INK,True)
        txt(x+14,y+47,role,10.5,color,True)
        para(x+14,y+65,cw-28,body,10.5,15)
        txt(x+14,y+113,anim,9.2,MUTED)
    rect(M,438,W-2*M,96,HexColor('#E9EFDF'))
    txt(M+18,451,'另外 14 位居民：用通用偏好与反应接入生态',11,INK,True)
    txt(M+18,474,'波波 / 皮皮 / 六尾 / 胖丁 / 走路草 / 喵喵 / 可达鸭 / 卡蒂狗',10.5,MUTED)
    txt(M+18,492,'蚊香蝌蚪 / 呆呆兽 / 鬼斯 / 角金鱼 / 鲤鱼王 / 伊布',10.5,MUTED)
    txt(M+18,515,'六套动作：Idle · Walk · Run · Attack · Happy · Sleep（睡觉已确认可用）',10.3,INK,True)
    c.showPage()


def scene_tracks():
    page_header(7,'两条生态故事','水让花醒来，花让伙伴接戏','一次环境状态变化被下一只宝可梦读取，串起看得见因果的生态连锁。')
    left=M; gap=20; cw=(W-2*M-gap)/2
    def track(x,color,kicker,title,steps,ending):
        rect(x,122,cw,357)
        pill(x+18,137,kicker,color)
        txt(x+18,169,title,19,INK,True)
        for j,(a,b,anim) in enumerate(steps):
            yy=207+j*60
            dot(x+27,yy+8,10,color);txt(x+23.8,yy+3,str(j+1),9,INK,True)
            if j<3: line(x+27,yy+19,x+27,yy+49,LINE,1.3)
            txt(x+48,yy,a,12,INK,True)
            txt(x+48,yy+20,b,10,MUTED)
            txt(x+48,yy+36,anim,9.2,color,True)
        para(x+18,448,cw-36,ending,10.4,15)
    track(left,WATER,'STORY 03','杰尼龟：把水带到岸上',[
      ('进入浅水位','在可达的河内锚点停下，面向水面。','Walk → Idle · 吸水粒子'),
      ('有水了，寻找目标','写入短期储水状态；转向岸边花丛。','Walk · 水滴气泡'),
      ('向花吐水','占用岸边喷水位，定向发射水束。','Attack · 水束 / 水花'),
      ('花开，伙伴到来','花丛湿润；妙蛙种子与巴大蝶被吸引。','Happy / Walk · 新兴趣点'),
    ],'变体：没有合适目标就保留水片刻，再回河边；不强迫每次都成功。')
    track(left+cw+gap,YELLOW,'STORY 04','皮卡丘：一朵花的连锁',[
      ('发现可闻的花','好奇心升高，靠近并看向花。','Walk → Idle · 目光锁定'),
      ('闻一闻，停一停','用靠近与短暂停顿表达嗅闻。','Idle · 花香粒子 / 花朵气泡'),
      ('一个小喷嚏','有冷却的轻概率变体；出现短促花粉。','Attack · 喷嚏音 / 花粉'),
      ('伙伴给出回应','巴大蝶绕开后返回，附近伙伴惊讶或开心。','Run / Idle / Happy · 反应窗口'),
    ],'变体：也可以安静赏花，没有喷嚏；伙伴不在场时，故事照样自然结束。')
    para(M,496,W-2*M,'连锁的关键：河水 → 湿润花丛 → 花香 / 蝶群 → 好奇的皮卡丘。每一环改变可感知的状态，让下一环有机会自然发生。',12,18,INK,True)
    c.showPage()


def fruit_and_sleep():
    page_header(5,'基础生活与主戏 01','它们会饿、会吃，也会自己找树荫睡觉','日常需求是生态的底盘。饥饿与困意改变选择，不变成倒计时任务或离线惩罚。')
    labels=['想吃东西','寻找果实','真实进食','满足探索','开始疲惫','找安静处','睡觉 / 醒来']
    bw=(W-2*M-6*10)/7
    for i,label in enumerate(labels):
        x=M+i*(bw+10)
        rect(x,125,bw,58,HexColor('#E7EFE3') if i<4 else HexColor('#EEE8F2'))
        txt(x+11,137,f'0{i+1}',9,GREEN if i<4 else LAVENDER,True)
        txt(x+11,158,label,11,INK,True)
        if i<6: arrow(x+bw+1,153,x+bw+9,153,MUTED,1.2)
    line(M+12,193,W-M-12,193,LINE)
    txt(M+12,203,'醒来以后，自主生活继续；成熟果自然掉落，让不操作时也有食物与新动静。',11,MUTED)
    cw=(W-2*M-20)/2
    card(M,237,cw,252,'STORY 01 · 水果觅食','一颗果子，不同的选择','',FIRE)
    card(M+cw+20,237,cw,252,'EVERYDAY · 树荫午睡','睡觉也是正在发生的生活','',LAVENDER)
    left=[
      ('落果 / 扔果 / 摇树','真实果实落在可达地面，形成气味与兴趣点。'),
      ('注意 → 走近 → 闻一闻','饥饿者优先；饱足、害羞或忙碌者可能不来。'),
      ('进食 / 礼让 / 轻微争先','Idle + 咔嚓声 / 果子缺口，吃后真实消耗。'),
      ('满足 → 离开 → 伙伴回应','吃饱者去探索，后来者改找另一颗或离开。'),
    ]
    right=[
      ('走慢一点，开始想睡','困意气泡短暂出现，寻找安全、安静的位置。'),
      ('找到树荫与空位','避开主路径、噪声和拥挤；抵达后才停下。'),
      ('Sleep，伙伴轻轻经过','有人绕行、驻足或一起安静下来；无需全员聚集。'),
      ('自然醒 / 被近处动静叫醒','Idle → Happy 后重新选择；太吵可换处休息。'),
    ]
    for bx,rows,col in [(M,left,FIRE),(M+cw+20,right,LAVENDER)]:
        for j,(a,b) in enumerate(rows):
            yy=305+j*43
            dot(bx+23,yy+6,3,col)
            txt(bx+34,yy,a,11,INK,True)
            txt(bx+34,yy+18,b,9.8,MUTED)
    para(M,506,W-2*M,'有限成熟果、可达落点、进食占位与消耗状态必须一致。20 只居民各有饱足、困意与选择，不会同时抢一颗果，也不会等玩家喂养才能继续生活。',11,17,INK,True)
    c.showPage()


def story_catalog():
    page_header(11,'生活小戏库','同一片箱庭，还能慢慢长出这些小故事','P0 表示首版日常，P1 表示后续扩展；先复用已有动作与反应。完整 20 张场景卡见配套文档。')
    entries=[
      ('01 · 影子追逐 / P1','皮卡丘追巴大蝶的影子，经过睡着的卡比兽时一起放慢。',YELLOW),
      ('02 · 呼噜合奏 / P1','杰尼龟在呼噜间隙叫一声；卡比兽醒来，音符气泡立刻收起。',WATER),
      ('03 · 同伴午睡 / P0 日常','妙蛙种子先睡，已有些困的杰尼龟也停下，各占一块空地睡。',LAVENDER),
      ('04 · 桥头让路 / P1','皮卡丘和杰尼龟迎面停住，一只退让，再各自开心离开。',GREEN),
      ('05 · 追错了落叶 / P1','两只跟着同一片叶子跑向不同方向，停下互看，冒出问号。',FIRE),
      ('06 · 水边倒影 / P1','皮卡丘看倒影，巴大蝶掠过打散水纹；先惊讶，再好奇。',WATER),
      ('07 · 树荫搬家 / P1','卡比兽换了睡位，原先被遮住的伙伴也慢慢挪到新阴影里。',GREEN),
      ('08 · 借一点干燥 / P1 雨天','雨后巴大蝶靠近暖光晾翅，暖和后飞走，又回头绕一小圈。',FIRE),
    ]
    cw=(W-2*M-20)/2
    for i,(title,body,col) in enumerate(entries):
        x=M+(i%2)*(cw+20);y=123+(i//2)*102
        rect(x,y,cw,89)
        rect(x,y,5,89,col,r=2)
        txt(x+17,y+15,title,13,INK,True)
        para(x+17,y+39,cw-34,body,11,17)
    c.showPage()


def bubbles_and_camera():
    page_header(8,'可读性与收藏','气泡让意图可见，照片让发现留下','环境与身体动作先说话；气泡只补充玩家看不见的感受。')
    cw=(W-2*M-22)/2
    rect(M,123,cw,407)
    txt(M+20,143,'气泡是一层轻量“内心戏”',17,INK,True)
    rows=[('想去哪里','花 / 水滴 / 火焰','兴趣与行动方向',GREEN),('发生了什么','感叹号 / 惊讶','受到突发事件影响',FIRE),('现在的感受','爱心 / 音符 / Zzz','舒服、开心、困倦',LAVENDER)]
    for j,(a,b,d,col) in enumerate(rows):
        yy=181+j*66
        rect(M+20,yy,76,31,col,r=14);txt(M+29,yy+10,a,10.2,white,True)
        txt(M+110,yy+2,b,11.2,INK,True)
        txt(M+110,yy+23,d,10.2,MUTED)
    line(M+20,386,M+cw-20,386)
    para(M+20,402,cw-40,'全场同时最多显示 2-3 只的气泡。新事件优先于普通需求，同一只只有一个；相同气泡设冷却，离开视野不提示。气泡不变成催促玩家完成的任务标记。',11,17)
    txt(M+20,491,'首版：只做能解释当前故事的少量气泡。',10,GREEN,True)
    x=M+cw+22
    rect(x,123,cw,407)
    txt(x+20,143,'照片记录“谁和谁发生了什么”',17,INK,True)
    rect(x+20,179,cw-40,111,HexColor('#F0E8D7'))
    txt(x+37,195,'Moment  /  火光旁的晚安',13,INK,True)
    txt(x+37,222,'小火龙 · 皮卡丘 · 卡比兽',11,MUTED)
    txt(x+37,245,'黄昏 / 火堆已燃 / 伙伴围坐 / 有人睡着',10.3,MUTED)
    pill(x+37,266,'首次记录',FIRE,8.8)
    para(x+20,309,cw-40,'首版拍照保存当前画面与事件标签，记录首次发现。先让玩家能确认自己看到了什么，再增加构图、光线和稀有度评分。',11,17)
    line(x+20,387,x+cw-20,387)
    txt(x+20,404,'发现结构',11,INK,True)
    para(x+20,428,cw-40,'物种 → 行为 → 共同事件 / Moment\n首版保留小规模本地记录；关系长期记忆、完整图鉴、分享卡片与复杂评分后续扩展。',11,17)
    c.showPage()


def data_rules():
    page_header(10,'数据与调度','新增内容，主要是增配方','角色、兴趣点、动作序列和反应规则分开配置；事件只在条件合适时接续。')
    x=M; cw=359; rx=M+cw+20; rw=W-M-rx
    rect(x,121,cw,274,HexColor('#E7EFE3'))
    txt(x+18,138,'InteractionRecipe · 篝火配方示意',13,INK,True)
    code=[
      'id: campfire_ignite',
      'actor: charmander',
      'when: awake && reachable && !lit',
      'interest: dawn 0.65 / dusk 0.95',
      'reserve: ignition_slot',
      'sequence:',
      '  MoveTo → FaceTarget → Pause',
      '  Attack + FireFX → Set(lit, true)',
      'emit: CampfireLit {position, warmth}',
      'react: comfort_seekers → Gather',
      'finish: ReleaseSlot + Cooldown',
    ]
    for j,s in enumerate(code): txt(x+18,170+j*17,s,10.2,INK,j==0)
    txt(x+18,369,'示意数据；不是现有项目接口或已完成实现。',9,MUTED)
    cards=[
      ('Creature','性格 / 喜好 / 状态 / 已有动画能力'),
      ('InterestPoint','位置 / 槽位 / 标签 / 动态状态'),
      ('ActionSequence','移动 / 朝向 / 动画 / 特效 / 等待 / 状态写入'),
      ('ReactionRule','事件过滤 / 响应者 / 意愿权重 / 冷却'),
    ]
    for j,(a,b) in enumerate(cards):
        yy=121+j*69;rect(rx,yy,rw,58)
        txt(rx+16,yy+11,a,12,INK,True)
        txt(rx+16,yy+34,b,10.2,MUTED)
    rect(M,411,W-2*M,120,PANEL)
    txt(M+18,428,'调度必须保护“自然感”',14,INK,True)
    points=[
      ('先占位，再走过去','热点容量与扇形位置，避免叠模。'),
      ('只让少数伙伴接戏','距离、性格、可见性共同筛选。'),
      ('允许打断，也能收尾','超时 / 失去目标后释放占位并回归生活。'),
      ('一条因果链有上限','事件去重、冷却和链长限制，防止无限反应。'),
    ]
    for j,(a,b) in enumerate(points):
        xx=M+18+(j%2)*367; yy=458+(j//2)*33
        txt(xx,yy,a,10.8,INK,True);txt(xx+119,yy,b,9.7,MUTED)
    c.showPage()


def scope():
    page_header(12,'范围与验证','先验证：放着不动，也想再看一会儿','先把吃果、睡觉和互相接戏做得可信、可读、有变体，再把生态做大。')
    cw=(W-2*M-20)/2
    rect(M,122,cw,235,HexColor('#E7EFE3'))
    txt(M+20,143,'P0 · 第一版必须成立',18,INK,True)
    p0=[
      '一张地图，20 只居民：6 重点 + 14 泛型。',
      '约 6-8 只明显移动，同时最多两处小戏。',
      '日常：觅食、吃果、探索、疲惫、树荫睡醒。',
      '四条主戏：吃果 / 点火 / 润花 / 闻花接戏。',
      '清晨与黄昏；少量气泡与环境反馈。',
      '轻干预：扔果 / 摇树 / 备柴 / 拨花 / 晨昏。',
      '基础照片与首次发现的本地记录。',
    ]
    for j,t in enumerate(p0):txt(M+20,183+j*25,'· '+t,11,INK)
    x=M+cw+20
    rect(x,122,cw,235)
    txt(x+20,143,'后续 · 有证据再扩展',18,INK,True)
    future=[
      '雨、雾、风与更复杂的生态季节。',
      '持久关系记忆、更多居民和来访规则。',
      '有限设施布置：水盆、睡垫、发光石。',
      '完整图鉴、照片评分与分享卡片。',
      '更多涌现配方：果实争抢、遮雨、守夜。',
      '不纳入：战斗、抓捕、等级与重建造。',
    ]
    for j,t in enumerate(future):txt(x+20,183+j*25,'· '+t,11,MUTED)
    rect(M,373,W-2*M,159)
    txt(M+20,391,'建议验证清单  /  以下是设计目标，尚未实测',13,INK,True)
    checks=[
      ('自主性','不操作 3 分钟：能看到至少一条可辨认的连锁。'),
      ('可读性','观察者能说清“谁先做了什么，谁因此回应”。'),
      ('变体','同一触发重复 5 次：参与者、顺序或结尾有变化。'),
      ('稳定性','20 只同场观察 10 分钟：不叠模、不死锁、不无限响应。'),
      ('收藏感','新玩家能拍到一次 Moment，并在本地记录中找回。'),
    ]
    for j,(a,b) in enumerate(checks):
        yy=420+j*21; txt(M+20,yy,a,10.5,GREEN,True);txt(M+83,yy,b,10.5,INK)
    c.showPage()


def main():
    global c
    register_fonts()
    OUT.parent.mkdir(parents=True,exist_ok=True)
    c=canvas.Canvas(str(OUT),pagesize=(W,H),pageCompression=1)
    c.setTitle('共生之境 | 微缩生态箱庭玩法设计 v0.1')
    c.setAuthor('Codex · Game Design')
    c.setSubject('设计提案：少动画、强编排、数据驱动的宝可梦生态互动')
    cover()
    full_diagram(2,'核心体验','真正的奖励，是看懂这个小世界','约 70% 观察与生态沙盒，30% 拍照与发现；玩家改变条件，居民自己做出选择。','core-loop')
    full_diagram(3,'箱庭设计','场景要小，兴趣点要密','位置与路径是设计示意；居民会自主移动，地图通过清晨与黄昏变化呈现不同生活节奏。','scene-layout')
    residents()
    fruit_and_sleep()
    full_diagram(6,'生态故事 02','一团火，把各自生活的伙伴聚到一起','小火龙发起，火光改变环境；伙伴决定是否靠近，绕圈与入睡只是可能的结尾。','campfire-storyboard')
    scene_tracks()
    bubbles_and_camera()
    full_diagram(9,'系统架构','少动画 + 强编排 + 数据驱动','感知产生候选行动，编排负责表演，事件让旁观者接戏；所有故事最终回到自主生活。','interaction-architecture')
    data_rules()
    story_catalog()
    scope()
    c.save()
    print(OUT)


if __name__=='__main__': main()
