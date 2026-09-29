import { describe, expect, it } from 'vitest'
import {
  clampRectToImage,
  clampViewport,
  fitViewport,
  imageToScreen,
  pan,
  screenToImage,
  zoomAt,
} from './viewport'

describe('视口坐标映射', () => {
  it('screenToImage / imageToScreen 互为逆映射', () => {
    const v = { scale: 2.5, originX: 12, originY: -34 }
    for (const p of [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: -50, y: 999 },
    ]) {
      expect(imageToScreen(v, screenToImage(v, p))).toEqual(p)
    }
  })

  it('fit 后图像完整居中显示', () => {
    const v = fitViewport(2000, 1000, 800, 600)
    // 受宽度限制：(800-48)/2000 = 0.376
    expect(v.scale).toBeCloseTo(0.376, 5)
    const tl = imageToScreen(v, { x: 0, y: 0 })
    const br = imageToScreen(v, { x: 2000, y: 1000 })
    expect(tl.x).toBe(24)
    expect(br.x).toBe(776)
    expect(tl.y).toBe(112)
    expect(br.y).toBe(488)
  })

  it('以鼠标位置为锚点缩放：锚点对应的原图坐标不变', () => {
    const v = fitViewport(4000, 3000, 1000, 700)
    const anchor = { x: 712, y: 438 }
    const before = screenToImage(v, anchor)

    for (const factor of [1.2, 1.5, 0.8, 0.1, 10]) {
      const z = zoomAt(v, anchor, factor, 0.01, 16)
      const after = screenToImage(z, anchor)
      expect(after.x).toBeCloseTo(before.x, 9)
      expect(after.y).toBeCloseTo(before.y, 9)
    }
  })

  it('连续多次以不同位置为锚点缩放，映射始终一致', () => {
    let v = fitViewport(4000, 3000, 1000, 700)
    const probes = [
      { x: 100, y: 100, f: 1.3 },
      { x: 800, y: 500, f: 1.3 },
      { x: 300, y: 600, f: 0.7 },
      { x: 500, y: 200, f: 1.6 },
    ]
    for (const { x, y, f } of probes) {
      const anchor = { x, y }
      const before = screenToImage(v, anchor)
      v = zoomAt(v, anchor, f, 0.01, 16)
      const after = screenToImage(v, anchor)
      expect(after.x).toBeCloseTo(before.x, 9)
      expect(after.y).toBeCloseTo(before.y, 9)
    }
    // 任意抽点：整图四角在屏幕上的位置连续可逆
    const q = { x: 640, y: 220 }
    const back = imageToScreen(v, screenToImage(v, q))
    expect(back.x).toBeCloseTo(q.x, 10)
    expect(back.y).toBeCloseTo(q.y, 10)
  })

  it('缩放被限制在 [min,max] 内', () => {
    const v = { scale: 1, originX: 0, originY: 0 }
    const anchor = { x: 100, y: 100 }
    expect(zoomAt(v, anchor, 1000, 0.5, 8).scale).toBe(8)
    expect(zoomAt(v, anchor, 0.001, 0.5, 8).scale).toBe(0.5)
  })

  it('平移仅改变 origin；clampViewport 阻止把图完全拖走', () => {
    const v = { scale: 1, originX: 0, originY: 0 }
    const p = pan(v, 30, -12)
    expect(p).toEqual({ scale: 1, originX: 30, originY: -12 })

    const c = clampViewport({ scale: 1, originX: 99999, originY: 99999 }, 500, 400, 1000, 700)
    // 图像右边缘 (500+80)=580，不得超过屏幕右侧 + margin
    expect(c.originX).toBeLessThanOrEqual(80)
    expect(c.originY).toBeLessThanOrEqual(80)
  })

  it('clampRectToImage 裁剪越界选区', () => {
    expect(clampRectToImage({ x: -50, y: -50, width: 200, height: 200 }, 100, 100)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
    expect(clampRectToImage({ x: 80, y: 80, width: 100, height: 100 }, 100, 100)).toEqual({
      x: 80,
      y: 80,
      width: 20,
      height: 20,
    })
    expect(clampRectToImage({ x: 200, y: 0, width: 10, height: 10 }, 100, 100)).toBeNull()
  })
})
