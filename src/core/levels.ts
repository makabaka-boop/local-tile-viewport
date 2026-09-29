/**
 * 层级选择与可见瓦片计算。
 *
 * 任一层级 L 的坐标换算到原图（最顶层）坐标的倍率：
 *   fullX = levelX * (imageWidth / levelWidth_L)
 */
import { TILE_SIZE, type ResolvedManifest, type ResolvedTile } from './types'
import type { ImageRect } from './viewport'

export interface LevelScaleInfo {
  level: number
  /** 该层 1 像素对应多少原图像素 */
  scaleToFull: number
  width: number
  height: number
}

export function levelScales(m: ResolvedManifest): LevelScaleInfo[] {
  const infos: LevelScaleInfo[] = []
  for (let level = 0; level <= m.maxLevel; level++) {
    const lv = m.levels.get(level)!
    infos.push({
      level,
      scaleToFull: m.width / lv.width,
      width: lv.width,
      height: lv.height,
    })
  }
  return infos
}

/**
 * 根据视口缩放比（屏幕像素/原图像素）选择最合适的层级：
 * 让瓦片在屏幕上尽量接近 1:1，优先选择采样倍率 |log2| 最小者，
 * 倍率 > 1（上采样）与 < 1（下采样）之间偏好轻微下采样。
 */
export function chooseLevel(m: ResolvedManifest, viewportScale: number): number {
  const infos = levelScales(m)
  let best = infos[0]
  let bestScore = Infinity
  for (const info of infos) {
    // 该层一像素在屏幕上的像素数
    const screenPixelsPerTilePixel = viewportScale * info.scaleToFull
    // 与 1 的对数距离；轻微惩罚上采样以优先使用更粗层
    const up = screenPixelsPerTilePixel > 1 ? 0.01 : 0
    const score = Math.abs(Math.log2(screenPixelsPerTilePixel)) + up
    if (score < bestScore) {
      bestScore = score
      best = info
    }
  }
  return best.level
}

export interface VisibleTile {
  tile: ResolvedTile
  level: number
  /** 该瓦片在原图坐标系中的矩形（可能为小数倍率） */
  fullRect: ImageRect
  scaleToFull: number
}

/** 计算指定层级在给定原图矩形内可见的瓦片；priority 越小越靠近视口中心 */
export function visibleTiles(
  m: ResolvedManifest,
  level: number,
  view: ImageRect,
): VisibleTile[] {
  const lv = m.levels.get(level)
  if (!lv) return []
  const mult = m.width / lv.width
  const x1 = Math.max(0, Math.floor(view.x / mult / TILE_SIZE))
  const y1 = Math.max(0, Math.floor(view.y / mult / TILE_SIZE))
  const x2 = Math.min(lv.cols - 1, Math.floor((view.x + view.width) / mult / TILE_SIZE))
  const y2 = Math.min(lv.rows - 1, Math.floor((view.y + view.height) / mult / TILE_SIZE))

  const out: VisibleTile[] = []
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const tile = lv.tiles.get(`${x}:${y}`)
      if (!tile) {
        // manifest 网格中缺失的瓦片：产出占位描述（无 tile 实体）
        out.push({
          tile: {
            x,
            y,
            file: '',
            pixelWidth: Math.min(TILE_SIZE, lv.width - x * TILE_SIZE),
            pixelHeight: Math.min(TILE_SIZE, lv.height - y * TILE_SIZE),
          },
          level,
          scaleToFull: mult,
          fullRect: {
            x: x * TILE_SIZE * mult,
            y: y * TILE_SIZE * mult,
            width: Math.min(TILE_SIZE, lv.width - x * TILE_SIZE) * mult,
            height: Math.min(TILE_SIZE, lv.height - y * TILE_SIZE) * mult,
          },
        })
        continue
      }
      out.push({
        tile,
        level,
        scaleToFull: mult,
        fullRect: {
          x: x * TILE_SIZE * mult,
          y: y * TILE_SIZE * mult,
          width: tile.pixelWidth * mult,
          height: tile.pixelHeight * mult,
        },
      })
    }
  }
  return out
}
