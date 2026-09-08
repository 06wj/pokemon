# 共生之境 · 设计与实现

原始提案日期：2026-09-07；当前实现持续更新。

本目录保留最初的玩法提案、流程图、场景布局、分镜与氛围概念图。P0 已形成可玩的箱庭，并追加雨雪、积雪与火水电等生活细节；功能现状和验证范围见[当前实现](implementation-status.md)。原始提案与 PDF 保留当时的设计方向，不作为全部功能已完成的清单。

## 阅读顺序

1. [当前实现与验证状态](implementation-status.md)：先确认目前可玩内容和仍待验证的部分。
2. [原始设计册 PDF](../../output/pdf/living-diorama-design-v0.1.pdf)：用于通读、讨论和分享。
3. [完整玩法提案](living-diorama-gameplay.md)：包含角色、玩法、动作编排、范围与建议验收标准。
4. 下方的 SVG 图：可独立编辑、放大和用于后续实现讨论；PNG 为同内容预览。

## 核心设计方向

- 核心体验：观察约 20 只宝可梦在小箱庭中觅食、进食、玩耍与休息，轻轻改变条件，看它们接住彼此的动作，并记录珍贵瞬间。
- 六只重点居民：妙蛙种子、小火龙、杰尼龟、皮卡丘、巴大蝶、卡比兽；另外 14 只分布在花丛、水域、树荫与暖石，参与日常生活和通用回应。
- 六种基础动画：Idle、Walk、Run、Attack、Happy、Sleep。Sleep 已确认可用。
- 内容方法：少动画、强编排、数据驱动；单只的动作序列有清楚节奏，多只之间通过可感知事件和自主反应接戏。
- 首版重点：水果觅食与分享、树荫午睡、篝火聚集、吸水喷水润花、闻花与伙伴反应、动态气泡；基础拍照与发现记录承接奖励。
- 天气已追加晴、雨、雪与渐进积雪；少量生态设施、长期关系记忆，以及更丰富的图鉴和分享卡片仍属后续方向。

## 设计图

| 图 | 可编辑版本 | 图片版本 |
| --- | --- | --- |
| 核心玩法循环 | [SVG](images/core-loop.svg) | [PNG](images/core-loop.png) |
| 水果、需求与日常生活循环 | [SVG](images/daily-life-flow.svg) | [PNG](images/daily-life-flow.png) |
| 自主行为与动作编排 | [SVG](images/interaction-architecture.svg) | [PNG](images/interaction-architecture.png) |
| 箱庭热点与互动关系 | [SVG](images/scene-layout.svg) | [PNG](images/scene-layout.png) |
| 篝火互动分镜 | [SVG](images/campfire-storyboard.svg) | [PNG](images/campfire-storyboard.png) |
| 箱庭氛围概念 | - | [PNG](images/concept-art.png) |

概念图采用独立原创宠物造型，表达二十只居民的拟议空间与生活氛围；文档中的功能角色可映射到项目宝可梦。它不代表现有实机效果或已经具备的动画质量。流程图中的参数、时长与范围是设计建议，需要后续可玩原型验证。

更多可组合的小戏见 [互动场景目录](interaction-catalog.md)。

## 维护

当前行为、实现范围和测试结果更新在[实现状态](implementation-status.md)中；原始提案和 PDF 保留历史评审版本。图像生成方式与原始提示词记录在 [概念图提示词](image-prompts.md)。PDF 由 [构建脚本](build_design_pdf.py) 生成。
