import { describe, expect, it } from 'vitest'
import { chooseLevel, levelScales, visibleTiles } from './levels'
import { parseManifest } from './manifest'
import {
  exportSelectionJSON,
  screenRectFromPoints,
  selectionToImage,
} from './selection'
import { fitViewport, imageToScreen, zoomAt, type ViewportState } from './viewport'

/** 3 层：256×256 / 512×512 / 1024×1024，铺满瓦片 */
function pyramid(): ReturnType<typeof parseManifest>['manifest'] {
  const levels = [0, 1, 2].map((level) => {
    const size = 256 << level
    const n = 1 << level
    const tiles = []
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        tiles.push({ x, y, file: `L${level}_${x}_${y}.png` })
      }
    }
    return { level, width: size, height: size, tiles }
  })
  return parseManifest(JSON.stringify({ width: 1024, height: 1024, levels })).manifest
}

describe('层级选择', () => {
  it('缩放比变化时选择采样率最接近 1:1 的层', () => {
    const m = pyramid()!
    // level 2 是原图层（scaleToFull=1）：scale=1 时应选层 2
    expect(chooseLevel(m, 1)).toBe(2)
    // scale=0.5 时：层2屏幕像素=0.5/像素(半分辨率)，层1 scaleToFull=2 -> 1.0，选层 1
    expect(chooseLevel(m, 0.5)).toBe(1)
    // scale=0.25 -> 层0 为 1:1
    expect(chooseLevel(m, 0.25)).toBe(0)
    // scale=2 -> 层2 为 2:1 上采样（无更高层），仍选层 2
    expect(chooseLevel(m, 2)).toBe(2)
  })

  it('可见瓦片的矩形映射回原图坐标且倍率正确', () => {
    const m = pyramid()!
    // 视口看到原图 [0,0,513,513]，在层 1（每像素=2 原图像素）-> 2×2 瓦片
    const tiles = visibleTiles(m, 1, { x: 0, y: 0, width: 513, height: 513 })
    const files = tiles.map((t) => t.tile.file).sort()
    expect(files).toEqual(['L1_0_0.png', 'L1_0_1.png', 'L1_1_0.png', 'L1_1_1.png'])
    for (const t of tiles) {
      expect(t.scaleToFull).toBe(2)
    }
    const at11 = tiles.find((t) => t.tile.x === 1 && t.tile.y === 1)!
    expect(at11.fullRect).toEqual({ x: 512, y: 512, width: 512, height: 512 })
  })

  it('manifest 缺失瓦片也产出占位描述', () => {
    const json = {
      width: 512,
      height: 256,
      levels: [
        { level: 0, width: 512, height: 256, tiles: [{ x: 0, y: 0, file: 'only.png' }] },
      ],
    }
    const m = parseManifest(JSON.stringify(json)).manifest!
    const tiles = visibleTiles(m, 0, { x: 0, y: 0, width: 512, height: 256 })
    expect(tiles).toHaveLength(2)
    const missing = tiles.find((t) => t.tile.file === '')!
    expect(missing.tile.x).toBe(1)
  })

  it('levelScales 给出每层到原图的倍率', () => {
    const m = pyramid()!
    expect(levelScales(m).map((i) => i.scaleToFull)).toEqual([4, 2, 1])
  })
})

describe('框选导出原图坐标', () => {
  const IMG = 1024

  it('无论怎样平移缩放，导出的始终是原图坐标', () => {
    // 使用图像在屏幕上的中心区域做框选（保证不触碰图像边界裁剪）
    let v = fitViewport(IMG, IMG, 1000, 700)
    for (const anchor of [
      { x: 500, y: 300, f: 1.4 },
      { x: 300, y: 100, f: 1.4 },
      { x: 800, y: 600, f: 0.6 },
    ]) {
      v = zoomAt(v, anchor, anchor.f, 0.05, 8)
    }
    // 找到当前视口中心对应的原图点，在其周围取 ±100 屏幕像素的框
    const center = { x: 500, y: 350 }
    const screenA = { x: center.x - 100, y: center.y - 80 }
    const screenB = { x: center.x + 100, y: center.y + 80 }
    const rect = screenRectFromPoints(screenA, screenB)
    const sel = selectionToImage(rect, v, IMG, IMG)!

    // 与直接用公式计算的期望一致
    expect(sel.x).toBeCloseTo((screenA.x - v.originX) / v.scale, 9)
    expect(sel.y).toBeCloseTo((screenA.y - v.originY) / v.scale, 9)
    expect(sel.width).toBeCloseTo(200 / v.scale, 9)
    expect(sel.height).toBeCloseTo(160 / v.scale, 9)
    // 落在图像内部
    expect(sel.x).toBeGreaterThan(0)
    expect(sel.y).toBeGreaterThan(0)
    expect(sel.x + sel.width).toBeLessThan(IMG)
    expect(sel.y + sel.height).toBeLessThan(IMG)

    // 导出 JSON 内容一致、字段齐全且为原图坐标
    const json = JSON.parse(exportSelectionJSON(sel, IMG, IMG, new Date('2026-01-01T00:00:00Z')))
    expect(json.format).toBe('image-workbench-selection/1')
    expect(json.image).toEqual({ width: 1024, height: 1024 })
    expect(json.selection.x).toBeCloseTo(sel.x, 2)
    expect(json.selection.width).toBeCloseTo(sel.width, 2)
    expect(json.exportedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('同一原图区域在不同缩放/平移下框选，导出坐标保持不变', () => {
    // 原图中目标区域
    const target = { x: 300, y: 200, width: 240, height: 160 }
    const results: Array<{ x: number; y: number; width: number; height: number }> = []

    const scenarios: ViewportState[] = [
      { scale: 1, originX: 0, originY: 0 },
      { scale: 0.37, originX: 123.4, originY: -45.2 },
      { scale: 2.75, originX: -400, originY: -250 },
    ]
    for (const v of scenarios) {
      // 把目标矩形四角映射到屏幕再框选
      const a = imageToScreen(v, { x: target.x, y: target.y })
      const b = imageToScreen(v, {
        x: target.x + target.width,
        y: target.y + target.height,
      })
      const rect = screenRectFromPoints(a, b)
      const sel = selectionToImage(rect, v, IMG, IMG)!
      results.push(sel)
    }
    for (const r of results) {
      expect(r.x).toBeCloseTo(target.x, 6)
      expect(r.y).toBeCloseTo(target.y, 6)
      expect(r.width).toBeCloseTo(target.width, 6)
      expect(r.height).toBeCloseTo(target.height, 6)
    }
  })

  it('在 1:1 缩放下框选导出整数原图坐标', () => {
    const v = { scale: 1, originX: 0, originY: 0 }
    const rect = screenRectFromPoints({ x: 10, y: 20 }, { x: 110, y: 220 })
    const sel = selectionToImage(rect, v, IMG, IMG)!
    expect(sel).toEqual({ x: 10, y: 20, width: 100, height: 200 })
    const json = JSON.parse(exportSelectionJSON(sel, IMG, IMG))
    expect(json.selection).toEqual({ x: 10, y: 20, width: 100, height: 200 })
  })

  it('超出图像边界的选区被裁剪', () => {
    const v = { scale: 1, originX: 0, originY: 0 }
    const rect = screenRectFromPoints({ x: 900, y: 900 }, { x: 1200, y: 1200 })
    const sel = selectionToImage(rect, v, IMG, IMG)!
    expect(sel).toEqual({ x: 900, y: 900, width: 124, height: 124 })
  })

  it('完全在图像外的选区返回 null', () => {
    const v = { scale: 1, originX: 0, originY: 0 }
    const rect = screenRectFromPoints({ x: 2000, y: 2000 }, { x: 2100, y: 2100 })
    expect(selectionToImage(rect, v, IMG, IMG)).toBeNull()
  })
})
