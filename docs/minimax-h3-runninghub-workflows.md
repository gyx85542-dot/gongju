# MiniMax H3 RunningHub 工作流（1–5 张参考图）

按实际上传参考图数量选择对应工作流。每套工作流只接线对应数量的 `LoadImage`，避免空槽占位图污染生成结果。

核心节点：`MiniMaxH3ReferenceToVideo`（nodeId `136`）。

---

## 工作流一览

| 参考图数量 | 显示名称 | Workflow ID | 页面链接 |
|-----------|----------|-------------|---------|
| 1 | minimax一张参考图 | `2086455416275431426` | https://www.runninghub.cn/workflow/2086455416275431426 |
| 2 | minimax两张参考图 | `2086455204597288961` | https://www.runninghub.cn/workflow/2086455204597288961 |
| 3 | minimax三张参考图 | `2086455100414976002` | https://www.runninghub.cn/workflow/2086455100414976002 |
| 4 | minimax四张参考图 | `2086454955682127873` | https://www.runninghub.cn/workflow/2086454955682127873 |
| 5 | minimax五张参考图 | `2084134045826502657` | https://www.runninghub.cn/workflow/2084134045826502657 |

---

## 公共参数（5 套相同）

以下参数在每套工作流中都需要传（或使用默认值）：

| 参数名 | nodeId | fieldName | 类型 | 默认值 | 说明 |
|--------|--------|-----------|------|--------|------|
| 提示词 | `138` | `value` | textarea | `""` | `PrimitiveStringMultiline`，对应 MiniMax prompt |
| 时长 | `132` | `value` | number | `15` | 秒；`PrimitiveFloat` |
| 比例 | `115` | `aspect_ratio` | select | `9:16 (Portrait Widescreen)` | `ResolutionSelector` |
| 像素 | `115` | `megapixels` | select | `1` | 可选 `0.4` / `1` |

### 比例可选值

- `16:9 (Widescreen)`
- `9:16 (Portrait Widescreen)`
- `1:1 (Square)`
- `4:3 (Standard)`
- `3:4 (Portrait)`
- `21:9 (Ultra Widescreen)`
- `2:1`
- `1:2`

### 像素可选值

- `0.4`（更快预览）
- `1`（更高画质）

---

## 各套参考图参数

图片字段均为 `LoadImage.image`。调用 API 前需先上传资源，把返回的 `fileName`（或可用图片 URL，视 RunningHub 上传方式而定）写入 `fieldValue`。

### 1 张 · `2086455416275431426`

| 参数名 | nodeId | fieldName | 类型 | 接到 MiniMax |
|--------|--------|-----------|------|--------------|
| 参考图1 | `137` | `image` | image | `ref_images.ref_image_0` |

### 2 张 · `2086455204597288961`

| 参数名 | nodeId | fieldName | 类型 | 接到 MiniMax |
|--------|--------|-----------|------|--------------|
| 参考图1 | `137` | `image` | image | `ref_images.ref_image_0` |
| 参考图2 | `139` | `image` | image | `ref_images.ref_image_1` |

### 3 张 · `2086455100414976002`

| 参数名 | nodeId | fieldName | 类型 | 接到 MiniMax |
|--------|--------|-----------|------|--------------|
| 参考图1 | `137` | `image` | image | `ref_images.ref_image_0` |
| 参考图2 | `139` | `image` | image | `ref_images.ref_image_1` |
| 参考图3 | `152` | `image` | image | `ref_images.ref_image_2` |

### 4 张 · `2086454955682127873`

| 参数名 | nodeId | fieldName | 类型 | 接到 MiniMax |
|--------|--------|-----------|------|--------------|
| 参考图1 | `137` | `image` | image | `ref_images.ref_image_0` |
| 参考图2 | `139` | `image` | image | `ref_images.ref_image_1` |
| 参考图3 | `152` | `image` | image | `ref_images.ref_image_2` |
| 参考图4 | `154` | `image` | image | `ref_images.ref_image_3` |

### 5 张 · `2084134045826502657`

| 参数名 | nodeId | fieldName | 类型 | 接到 MiniMax |
|--------|--------|-----------|------|--------------|
| 参考图1 | `137` | `image` | image | `ref_images.ref_image_0` |
| 参考图2 | `139` | `image` | image | `ref_images.ref_image_1` |
| 参考图3 | `152` | `image` | image | `ref_images.ref_image_2` |
| 参考图4 | `154` | `image` | image | `ref_images.ref_image_3` |
| 参考图5 | `156` | `image` | image | `ref_images.ref_image_4` |

---

## RunningHub `nodeInfoList` 示例（2 张）

```json
{
  "apiKey": "<YOUR_API_KEY>",
  "workflowId": "2086455204597288961",
  "nodeInfoList": [
    { "nodeId": "137", "fieldName": "image", "fieldValue": "api/<uploaded-file-1>.png" },
    { "nodeId": "139", "fieldName": "image", "fieldValue": "api/<uploaded-file-2>.png" },
    { "nodeId": "138", "fieldName": "value", "fieldValue": "你的提示词，按顺序引用参考图标签" },
    { "nodeId": "132", "fieldName": "value", "fieldValue": 15 },
    { "nodeId": "115", "fieldName": "aspect_ratio", "fieldValue": "9:16 (Portrait Widescreen)" },
    { "nodeId": "115", "fieldName": "megapixels", "fieldValue": 1 }
  ]
}
```

N 张图时：`workflowId` 换成上表对应 ID，并只传该套的 N 个 `LoadImage` 字段 + 上述公共参数。

---

## 使用约定

1. **按张数选工作流**：上传几张就选「minimax N 张参考图」，不要用 5 图工作流只填 2 张。
2. **提示词标签**：按接线顺序引用（如 `<image_0>` / `<Picture 1>` 等，以你工作流实际 prompt 写法为准），只提实际有的参考图。
3. **图片必填**：该套暴露的每一张参考图都要上传；数量不对就换工作流，不要留空或塞占位图。
4. **本项目配置位置**：`data/runninghub.json`（RunningHub 设置页可改）。

---

## LoadImage nodeId 速查

| 槽位 | nodeId | 出现在 |
|------|--------|--------|
| 参考图1 | `137` | 1–5 张 |
| 参考图2 | `139` | 2–5 张 |
| 参考图3 | `152` | 3–5 张 |
| 参考图4 | `154` | 4–5 张 |
| 参考图5 | `156` | 仅 5 张 |
