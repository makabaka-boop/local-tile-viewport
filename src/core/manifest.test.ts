import { describe, expect, it } from 'vitest'
import { parseManifest, validateManifest } from './manifest'
import { TILE_SIZE } from './types'

/** 构造一个合法的两层金字塔：512×300 / 1024×600 */
function validManifest(): unknown {
  const mkLevel = (level: number, w: number, h: number) => {
    const cols = Math.ceil(w / TILE_SIZE)
    const rows = Math.ceil(h / TILE_SIZE)
    const tiles = []
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        tiles.push({ x, y, file: `L${level}_${x}_${y}.png` })
      }
    }
    return { level, width: w, height: h, tiles }
  }
  return {
    width: 1024,
    height: 600,
    levels: [mkLevel(0, 512, 300), mkLevel(1, 1024, 600)],
  }
}

describe('manifest 校验', () => {
  it('接受合法金字塔并推导网格与边缘瓦片尺寸', () => {
    const { manifest, issues } = validateManifest(validManifest())
    expect(manifest).not.toBeNull()
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    // 顶层 1024×600：4 列 × 3 行
    const top = manifest!.levels.get(1)!
    expect(top.cols).toBe(4)
    expect(top.rows).toBe(3)
    expect(top.tiles.get('3:2')!.pixelWidth).toBe(256)
    expect(top.tiles.get('0:2')!.pixelHeight).toBe(88)
    // 粗层 512×300：2 列 × 2 行，底行高 44
    expect(manifest!.levels.get(0)!.tiles.get('1:1')!.pixelHeight).toBe(44)
    expect(manifest!.maxLevel).toBe(1)
    expect(manifest!.width).toBe(1024)
  })

  it('拒绝非对象与非法 JSON', () => {
    expect(validateManifest([]).manifest).toBeNull()
    expect(validateManifest(null).manifest).toBeNull()
    const r = parseManifest('{ oops')
    expect(r.manifest).toBeNull()
    expect(r.issues[0].code).toBe('NOT_OBJECT')
  })

  it('拒绝非连续/重复层级编号', () => {
    const m = validManifest() as any
    m.levels[1].level = 2
    expect(validateManifest(m).issues.some((i) => i.code === 'LEVEL_NUMBERING')).toBe(true)
    const m2 = validManifest() as any
    m2.levels[1].level = 0
    expect(validateManifest(m2).issues.some((i) => i.code === 'DUPLICATE_LEVEL')).toBe(true)
  })

  it('拒绝原图尺寸与最高层级不一致', () => {
    const m = validManifest() as any
    m.height = 999
    const r = validateManifest(m)
    expect(r.manifest).toBeNull()
    expect(r.issues.some((i) => i.code === 'NON_POSITIVE_SIZE')).toBe(true)
  })

  it('拒绝越界坐标与错误的边缘尺寸', () => {
    const m = validManifest() as any
    m.levels[0].tiles.push({ x: 9, y: 0, file: 'oob.png' })
    expect(validateManifest(m).issues.some((i) => i.code === 'OUT_OF_BOUNDS')).toBe(true)

    const m2 = validManifest() as any
    m2.levels[0].tiles[0].tileWidth = 200 // 非边缘瓦片必须 256
    expect(validateManifest(m2).issues.some((i) => i.code === 'EDGE_SIZE_MISMATCH')).toBe(true)
  })

  it('边缘瓦片显式尺寸必须等于剩余像素', () => {
    const m = validManifest() as any
    // 顶层底行瓦片高 88；写成 89 应失败
    const edge = m.levels[1].tiles.find((t: any) => t.x === 0 && t.y === 2)
    edge.tileHeight = 89
    expect(validateManifest(m).issues.some((i) => i.code === 'EDGE_SIZE_MISMATCH')).toBe(true)
  })

  it('拒绝同层重复位置与跨层重复文件名', () => {
    const m = validManifest() as any
    m.levels[0].tiles.push({ x: 0, y: 0, file: 'dup_pos.png' })
    expect(validateManifest(m).issues.some((i) => i.code === 'DUPLICATE_TILE_POSITION')).toBe(true)

    const m2 = validManifest() as any
    m2.levels[1].tiles[0].file = m2.levels[0].tiles[0].file
    expect(validateManifest(m2).issues.some((i) => i.code === 'DUPLICATE_FILENAME')).toBe(true)
  })

  it('网格中缺少瓦片只产生警告（占位），不阻止导入', () => {
    const m = validManifest() as any
    m.levels[0].tiles = m.levels[0].tiles.filter((t: any) => !(t.x === 1 && t.y === 0))
    const { manifest, issues } = validateManifest(m)
    expect(manifest).not.toBeNull()
    const warn = issues.find((i) => i.severity === 'warning')
    expect(warn).toBeDefined()
    expect(manifest!.levels.get(0)!.tiles.has('1:0')).toBe(false)
  })

  it('单像素图像也合法（最小边缘瓦片 1×1）', () => {
    const m = { width: 1, height: 1, levels: [{ level: 0, width: 1, height: 1, tiles: [{ x: 0, y: 0, file: 'one.png' }] }] }
    const { manifest } = validateManifest(m)
    expect(manifest!.levels.get(0)!.tiles.get('0:0')!.pixelWidth).toBe(1)
  })
})
