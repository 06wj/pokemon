# Pokémon Viewer · [English](README.md)

基于 [Hilo3D](https://hilo3d.js.org)、React 和 TypeScript 的浏览器端 3D 宝可梦查看器，包含第一世代 151 种宝可梦、骨骼动画、材质预设及按属性匹配的栖息地场景。应用界面为中文。

[在线演示](https://06wj.github.io/pokemon/)

## 项目概览

![完整应用界面，展示原生材质的妙蛙花](docs/screenshots/venusaur-original.jpg)

- 151 个普通形态模型、869 段动画，以 GLB 资源按需加载。
- 六种材质预设：原生、卡通、像素、黄金、晶釉、幻彩泡泡。像素模式通过固定像素网格、四档明暗、有序抖色和有限色阶表现复古画面。像素与晶釉分别沿用 `glass`、`silver` URL 参数，以兼容旧链接。
- 六套按宝可梦属性匹配的栖息地场景，包含环境光与粒子效果。
- 支持 WebGPU 和 WebGL2，可手动切换渲染后端。
- 适配桌面与移动端的模型选择、动画播放、环绕、缩放及全屏控制。

## 材质示例

以下为妙蛙花在三种材质下的 WebGPU 实机截图，使用相同视角，仅裁取模型区域。

| 卡通 | 黄金 | 幻彩 |
| --- | --- | --- |
| ![卡通材质的妙蛙花](docs/screenshots/venusaur-toon-detail.jpg) | ![黄金材质的妙蛙花](docs/screenshots/venusaur-gold-detail.jpg) | ![幻彩材质的妙蛙花](docs/screenshots/venusaur-iridescent-detail.jpg) |

卡通与像素同时作用于栖息地，共用原色、法线和深度渲染通路。像素模式在小尺寸目标上对每格进行九点采样，并按深度保留前后遮挡；明暗阈值采用短距离过渡并减弱有序抖色，以降低闪动。像素网格以最近邻方式放大，并在色调映射后再次对齐，保持方形边缘清晰。桌面像素块约 4 CSS 像素，窄屏保持 2 像素。模型统一按待机姿态的高度缩放，宽翅膀与长尾巴不再触发宽度或深度缩小限制。界面文字保留原始分辨率，切换材质保留骨骼动画与表情图集。

## 操作与 URL 参数

- 按显示名称或图鉴编号搜索，从列表选择模型。
- 拖动环绕；鼠标滚轮或双指手势缩放。
- 打开动作菜单选择模型支持的动画；切换模型时保留其支持的当前动作。
- 桌面快捷键：**← / →** 切换模型，**R** 重置视角，**⌘ / Ctrl + K** 聚焦搜索。动作菜单支持方向键、Enter 和 Esc。
- 点击 **WebGPU / WebGL2** 标识切换后端。页面会重新加载，保留模型与材质，重置视角与动作。

示例：[`?backend=webgpu&material=toon#003`](https://06wj.github.io/pokemon/?backend=webgpu&material=toon#003)。

| 参数 | 可选值 | 默认值 |
| --- | --- | --- |
| `backend` | `auto`、`webgpu`、`webgl2` | 自动选择 |
| `material` | `original`、`toon`、`glass`、`gold`、`silver`、`iridescent` | `original` |
| URL hash | 图鉴编号，如 `#003` | `#001` |

WebGPU 的支持情况和画面表现取决于浏览器与 GPU。如出现异常，可切换至 [WebGL2](https://06wj.github.io/pokemon/?backend=webgl2#003)。WebGPU 开始初始化后发生的错误会显示在页面中，不会静默切换后端。

## 技术实现

- **技术栈：** Hilo3D `2.0.0-alpha.4`、React 19、TypeScript 7、Vite 8。
- **应用层：** React 管理选择状态、交互控件与 URL；`PokemonStageController` 管理三维场景及渲染生命周期。
- **模型资源：** GLB 内嵌骨骼动画与贴图，按网格精简骨骼引用；WebGL2 使用 CPU 蒙皮兼容路径。
- **材质与光照：** 材质适配层、HDR 环境光、卡通渲染，以及栖息地专用水面与粒子效果。
- **资源交付：** 符合条件的不透明颜色贴图使用 JPEG，不降低分辨率；其余 PNG，包括法线、数据与表情贴图，保留原始字节。模型及 WebGPU 着色器编译器按需加载。

## 资源来源

本项目为非官方技术展示，与宝可梦相关权利方无隶属或背书关系。角色及相关资产的权利归各自所有者，本仓库不授予这些资产的使用权。

- 物种与属性数据：[官方繁中宝可梦图鉴](https://tw.portal-pokemon.com/play/pokedex/)。
- 环境光：[Poly Haven HDRI 来源说明](public/environments/CREDITS.md)。
- 生成背景：ImageGen，见[提示词与资源说明](public/backdrops/README.md)。

## 开发指南

### 本地运行

建议使用 **Node.js 22.18+**，以支持完整工具链和资源测试。已导出的模型包含在仓库中；只有重新制作资源时才需要 Blender。

```bash
npm ci
npm run dev
```

```bash
npm run typecheck
node scripts/test-viewer-location.mjs
node scripts/test-animation-selection.mjs
npm run test:toon
npm run build
npm run preview
```

构建产物写入 `dist/`，采用相对路径，可部署在仓库子目录下。部署时保留生成的 `.wasm` 文件，WebGPU 着色器编译器会按需加载。发布清单只包含运行所需的模型与动作信息，不输出 source map。README 截图位于 `public/` 之外，不增加演示页面的发布体积。

查看器使用 Hilo3D `2.0.0-alpha.7` 的 `shadowUpdateMode: 'full'`，让动画阴影切片在同一帧内完整刷新，不再受分页更新预算延迟。

卡通渲染缓存网格筛选结果，一次 MRT 绘制同时输出原色和原生表面属性。原色缓冲采用 sRGB 8 位存储，合成后的 HDR 场景和描边分辨率保持不变。适配器组合当前固定版本的 Hilo3D 公开着色器源码，升级引擎时需一并审查。显式实例化和不兼容的光栅状态保留独立的原色、法线绘制路径。触摸优先设备使用 1024 阴影，桌面设备使用 2048。

### 项目结构

```text
src/app/          应用生命周期、选择状态与 URL
src/components/   图鉴、材质面板与无障碍浏览控制
src/content/      宝可梦、栖息地、材质主题与模型清单
src/hilo/         渲染、动画、水面、粒子与材质适配
public/           发布模型、栖息地、背景与环境光资源
scripts/          Blender 导出、资源优化与验证
docs/screenshots/ README 使用的浏览器截图
```

### 重新生成与验证资源

原始 Blender 文件需自行准备到 `source/Gen1/`；`source/` 已被 Git 忽略。使用 **Blender 5.1**，在仓库根目录执行：

```bash
blender --background --factory-startup --python scripts/export-gen1.py -- --ids 001 003 005
# 导出全部模型，或继续尚未完成的导出：
blender --background --factory-startup --python scripts/export-gen1.py -- --all --skip-existing
```

导出保留骨骼动画和内嵌贴图、精简每网格骨骼引用，并更新 `src/content/animatedModels.json`。已有模型可运行 `python3 scripts/gen1_skinning.py --all` 精简。栖息地建模流程位于 `scripts/create-habitats.py`。

```bash
python3 scripts/test-gen1-skinning.py
npm run models:validate
# 需要 Python 3 + Pillow，无需 Blender：
npm run assets:optimize -- --ids 003
# 不传 --ids 则处理全部发布资源。
```

优化脚本仅把满足误差限制、体积更小的不透明颜色贴图转为 JPEG：不降分辨率，使用 4:4:4 色度采样，其余 PNG 与图标不动。GLB 内相同图片共享存储，不改材质或几何数据。JPEG 属于有损压缩，新资源仍需在两个后端与目标设备上检查画面。

原件备份在 `source/asset-optimization/originals/`；[逐文件报告](scripts/asset-optimization-report.json) 记录备份路径、大小与输出哈希。请另外保存本地备份。重复执行会跳过哈希未变的资源，避免二次有损压缩。有原始备份时，可用 `npm run assets:optimize -- --restore-quantized-pngs` 恢复旧版本量化过的 PNG。蒙皮等价测试 `node scripts/test-skin-equivalence.mjs /原始/models/路径` 同时要求贴图字节相同，应在 JPEG 转换前使用，不适合跨转换比较。

### 发布

将 GitHub Pages 的 Source 设为 **GitHub Actions**。仓库自带的[发布工作流](.github/workflows/deploy-pages.yml) 会在推送到 `master` 后构建并发布，无需应用服务器。
