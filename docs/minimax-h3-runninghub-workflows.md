# MiniMax H3 RunningHub 工作流（全能视频 1–5 图）

按实际上传参考图数量选择对应工作流。图片写入 `MiniMaxH3MediaLoaderFantastic`（nodeId `374`）的 `media_state`，由 `MiniMaxH3ReferenceSplitter` 拆到对应数量的 `ref_image_*` 槽位。

核心节点：`MiniMaxH3UnifiedToVideo`（nodeId `373`）。

---

## 工作流一览

| 参考图数量 | 显示名称 | Workflow ID | 页面链接 |
|-----------|----------|-------------|---------|
| 1 | MiniMaxH3-全能视频单图 | `2090106771615608834` | https://www.runninghub.cn/workflow/2090106771615608834 |
| 2 | MiniMaxH3-全能视频双图 | `2090106849847762945` | https://www.runninghub.cn/workflow/2090106849847762945 |
| 3 | MiniMaxH3-全能视频三图 | `2090086174114271234` | https://www.runninghub.cn/workflow/2090086174114271234 |
| 4 | MiniMaxH3-全能视频4图 | `2090106926330896386` | https://www.runninghub.cn/workflow/2090106926330896386 |
| 5 | MiniMaxH3-全能视频5图 | `2090107013543063554` | https://www.runninghub.cn/workflow/2090107013543063554 |

---

## 公共参数（5 套相同）

| 参数名 | nodeId | fieldName | 类型 | 默认值 | 说明 |
|--------|--------|-----------|------|--------|------|
| 提示词 | `413` | `value` | textarea | `""` | `PrimitiveStringMultiline` |
| 时长 | `417` | `value` | number | `15` | 秒；`PrimitiveFloat` |
| 比例 | `384` | `aspect_ratio` | select | `16:9 (Widescreen)` | `MiniMaxH3ResolutionSelector` |
| 大小 | `384` | `aspect_ratio.size` | select | `1344×768` | 与比例配套的像素尺寸 |

### 比例可选值

- `16:9 (Widescreen)`
- `9:16 (Portrait Widescreen)`
- `1:1 (Square)`
- `4:3 (Standard)`
- `3:4 (Portrait)`
- `21:9 (Ultra Widescreen)`
- `2:1`
- `1:2`

---

## 参考图

所有参考图都上传到 node `374`，字段 `media_state`。本项目会把 N 个图片槽位组装成 Media Loader 需要的 JSON 数组。

调用 API 前先上传资源，把返回的 `fileName` 写成 `"<fileName> [input]"`。

N 张图时：`workflowId` 换成上表对应 ID，并上传该套要求的 N 张参考图。

---

## 使用约定

1. **按张数选工作流**：上传几张就选对应「全能视频 N 图」，不要用 5 图工作流只填 2 张。
2. **提示词标签**：按顺序引用（如 `<Picture 1>`），只提实际有的参考图。
3. **图片必填**：该套暴露的每一张参考图都要上传。
4. **本项目配置位置**：`data/runninghub.json`（RunningHub 设置页可改）。
