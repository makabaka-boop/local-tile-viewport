import { describe, expect, it } from 'vitest'
import { TileBoard } from './tileBoard'
import type { TileKey } from './tileSource'

const k = (level: number, x: number, y: number): TileKey => ({
  level,
  x,
  y,
  file: `L${level}_${x}_${y}.png`,
})

describe('TileBoard 槽位防护', () => {
  it('切换槽位后旧瓦片的迟到状态更新被拒绝', () => {
    const board = new TileBoard()
    board.setSlots([k(0, 0, 0), k(0, 1, 0)])
    const epoch0 = board.epoch
    expect(board.mark(k(0, 0, 0), 'ready')).toBe(true)

    // 用户快速放大 -> 换板
    board.setSlots([k(1, 0, 0), k(1, 1, 0)])
    expect(board.epoch).toBe(epoch0 + 1)

    // 旧层瓦片迟到的 ready：拒绝，不能影响当前画面
    expect(board.mark(k(0, 0, 0), 'ready')).toBe(false)
    expect(board.has(k(0, 0, 0))).toBe(false)
    // 新层瓦片正常接收
    expect(board.mark(k(1, 0, 0), 'ready')).toBe(true)
    expect(board.get(k(1, 0, 0))!.status).toBe('ready')
  })

  it('同位置瓦片在换板后保留 ready 状态，其他回到 loading', () => {
    const board = new TileBoard()
    board.setSlots([k(1, 0, 0)])
    board.mark(k(1, 0, 0), 'ready')
    // 视口微调仍请求同一瓦片 + 一个新瓦片
    board.setSlots([k(1, 0, 0), k(1, 0, 1)])
    expect(board.get(k(1, 0, 0))!.status).toBe('ready')
    expect(board.get(k(1, 0, 1))!.status).toBe('loading')
  })

  it('manifest 缺失瓦片初始即为 missing 占位', () => {
    const board = new TileBoard()
    board.setSlots([k(0, 0, 0), k(0, 1, 0)], (key) => key.x === 1)
    expect(board.get(k(0, 0, 0))!.status).toBe('loading')
    expect(board.get(k(0, 1, 0))!.status).toBe('missing')
  })
})
