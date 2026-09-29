# 图像工作台 · Image Workbench

一个基于 **Vue 3 + TypeScript + Canvas** 的多分辨率（金字塔）瓦片图像工作台。
用户在浏览器中选择一份多分辨率 manifest 与其引用的**本地图片文件**——文件只在本机读取，
**绝不上传**。支持拖动平移、以鼠标位置为锚点缩放、缺失瓦片占位、框选区域并导出**原图坐标 JSON**。

## 功能与设计要点

- **本地优先**：图片通过 `File` + `createImageBitmap` 在浏览器内解码，无网络请求、无上传。
- **多分辨率金字塔**：瓦片固定 **256×256**，仅右边缘/下边缘允许不足（例如 256×48）。
- **导入校验**：层级编号连续唯一、层级尺寸单调且最高层与原图尺寸一致、瓦片坐标不越界、
  边缘尺寸必须等于剩余像素、文件名在整个 manifest 内唯一；网格内缺失瓦片与未选择的文件
  不会阻断导入，而在画布上显示明确的「缺失」占位。
- **视口始终映射原图坐标**：
  - 视口状态 `(scale, originX, originY)` 给出屏幕↔原图的严格互逆映射；
  - 滚轮缩放以**鼠标所在屏幕点为锚点**（锚点对应的原图坐标在缩放前后不变）；
  - 拖动只改变 origin；双击以鼠标点为锚点放大。
- **解码并发上限 4**：`DecodePool` 维护最多 4 个并发解码，其余按距视口中心的距离排队。
- **有内存上限的 LRU**：位图按 `width×height×4` 估算字节数，超预算从最久未使用端淘汰，
  淘汰即 `ImageBitmap.close()` 释放；预算可在侧栏实时调整。
- **快速缩放不错乱画面**：
  1. 每次画面需要的瓦片集合变化都递增“世代（epoch）”，旧世代任务被 abort；
  2. 即使底层解码器不可取消、旧层结果**迟到**返回，也会被世代校验丢弃并 `close()`，绝不写入缓存；
  3. 画布还有 `TileBoard` 槽位二次校验：不在当前画面的瓦片不会被标记/绘制。
- **框选导出**：框选在屏幕坐标进行，导出时经视口逆映射换算为**原图（最高层）坐标**，
  裁剪到图像边界，输出 JSON（可复制或下载）。

## manifest 格式

```json
{
  "width": 1024,
  "height": 600,
  "tileSize": 256,
  "levels": [
    {
      "level": 0,
      "width": 512,
      "height": 300,
      "tiles": [
        { "x": 0, "y": 0, "file": "tiles/L0_0_0.png" }
      ]
    },
    {
      "level": 1,
      "width": 1024,
      "height": 600,
      "tiles": [
        { "x": 0, "y": 0, "file": "tiles/L1_0_0.png" }
      ]
    }
  ]
}
```

规则：

- `level` 从 **0** 开始连续（0 为最粗层，数字越大越精细，最高层像素尺寸 = 原图尺寸）；
- `width/height` 必须为正整数，且层级间不得缩小；
- 瓦片 `(x, y)` 从 0 开始，必须落在 `ceil(width/256) × ceil(height/256)` 网格内；
- 非边缘瓦片必须为 256×256；边缘瓦片尺寸为剩余像素（可省略 `tileWidth/tileHeight`，
  系统自动推导；若显式给出则必须精确匹配）；
- `file` 在整个 manifest 内**唯一**，可写纯文件名或相对路径，按文件名匹配所选文件。

## 操作

| 操作 | 效果 |
| --- | --- |
| 鼠标拖动 / 中键拖动 | 平移 |
| 滚轮 | 以鼠标位置为锚点缩放 |
| 双击 | 以鼠标位置为锚点放大 |
| 工具栏「框选」或 **Shift + 拖动** | 框选区域，右侧导出原图坐标 JSON |

导出示例：

```json
{
  "format": "image-workbench-selection/1",
  "exportedAt": "2026-09-29T00:00:00.000Z",
  "image": { "width": 1024, "height": 600 },
  "selection": { "x": 300, "y": 200, "width": 240, "height": 160 },
  "center": { "x": 420, "y": 280 }
}
```

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest 单元测试
npm run typecheck  # vue-tsc 类型检查
npm run build      # 生产构建到 dist/
```

## 测试策略

`src/test/controllableDecoder.ts` 提供一个**可延迟、可手动按任意顺序兑现**的解码器，
单元测试覆盖：

- manifest 的层级尺寸/坐标/边缘尺寸/文件名唯一性校验与缺失瓦片告警；
- 以鼠标为锚点缩放时锚点原图坐标不变（缩放锚点）、多次连续缩放映射仍互逆；
- 同一原图区域在不同缩放/平移下框选，导出坐标恒等（导出坐标）；
- LRU 超预算淘汰最久未使用位图并释放、调小预算立即淘汰、淘汰后重新请求会重新解码；
- 并发恰好为 4、优先级出队；
- 故意打乱完成顺序时结果按各自 key 落位；
- 快速缩放后旧层迟到结果（解码器忽略 abort）被丢弃且位图被 `close`，不污染当前画面。

## Docker（固定验收）

仓库提供可运行的 Docker Compose：`verify` 为一次性测试服务，`web` 为静态托管的工作台。

按顺序执行验收：

```bash
docker compose config --quiet
docker compose build
docker compose run --rm verify
```

`verify` 通过（类型检查 + 全部测试）后启动界面：

```bash
docker compose up web
# 浏览器访问 http://localhost:5173
```

## 目录结构

```
src/
  core/              框架无关的纯 TS 核心逻辑（含全部单元测试）
    types.ts         领域类型
    manifest.ts      manifest 解析与校验
    viewport.ts      屏幕 <-> 原图坐标映射 / 锚点缩放
    levels.ts        层级选择与可见瓦片计算
    bitmapCache.ts   有内存上限的 LRU（淘汰释放位图）
    tileSource.ts    本地文件数据源（createImageBitmap）
    decodePool.ts    并发 4 + 世代防过期 的解码池
    tileBoard.ts     当前画面槽位（二次防迟到覆盖）
    selection.ts     框选 -> 原图坐标 -> 导出 JSON
  test/              可控（可延迟/乱序）测试解码器
  WorkbenchCanvas.vue  Canvas 渲染与交互
  App.vue              导入 / 校验 / 状态栏 / 导出界面
```
