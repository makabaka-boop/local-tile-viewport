/**
 * manifest 导入校验。
 *
 * 错误（error）会阻止导入；警告（warning）允许导入（例如网格中缺少的瓦片、
 * 或引用文件在用户选择中缺失），缺失内容在渲染层显示明确占位。
 */
import {
  TILE_SIZE,
  type LevelSpec,
  type ResolvedLevel,
  type ResolvedManifest,
  type ResolvedTile,
  type TileSpec,
  type ValidationIssue,
} from './types'

export interface ValidationResult {
  manifest: ResolvedManifest | null
  issues: ValidationIssue[]
}

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v)
const isPosInt = (v: unknown): v is number => isInt(v) && v > 0

export function validateManifest(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  const err = (
    code: ValidationIssue['code'],
    message: string,
    path?: string,
  ): void => {
    issues.push({ severity: 'error', code, message, path })
  }
  const warn = (
    code: ValidationIssue['code'],
    message: string,
    path?: string,
  ): void => {
    issues.push({ severity: 'warning', code, message, path })
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    err('NOT_OBJECT', 'manifest 必须是一个 JSON 对象')
    return { manifest: null, issues }
  }
  const raw = input as Record<string, unknown>

  if (!isPosInt(raw.width)) err('MISSING_FIELD', 'width 必须为正整数', 'width')
  if (!isPosInt(raw.height)) err('MISSING_FIELD', 'height 必须为正整数', 'height')
  if (raw.tileSize !== undefined && raw.tileSize !== TILE_SIZE) {
    err('BAD_TILE_SIZE', `tileSize 仅支持 ${TILE_SIZE}`, 'tileSize')
  }
  if (!Array.isArray(raw.levels) || raw.levels.length === 0) {
    err('NO_LEVELS', 'levels 必须是非空数组', 'levels')
    return { manifest: null, issues }
  }

  const hasBlocking = (): boolean => issues.some((i) => i.severity === 'error')
  if (hasBlocking()) return { manifest: null, issues }

  const rootWidth = raw.width as number
  const rootHeight = raw.height as number
  const levelSpecs: LevelSpec[] = []

  raw.levels.forEach((lv: unknown, li: number) => {
    const path = `levels[${li}]`
    if (typeof lv !== 'object' || lv === null || Array.isArray(lv)) {
      err('LEVEL_NOT_OBJECT', '层级必须是对象', path)
      return
    }
    const o = lv as Record<string, unknown>
    if (!isInt(o.level) || o.level < 0) {
      err('BAD_TYPE', `${path}.level 必须是非负整数`, `${path}.level`)
      return
    }
    if (!isPosInt(o.width)) {
      err('NON_POSITIVE_SIZE', `${path}.width 必须为正整数`, `${path}.width`)
    }
    if (!isPosInt(o.height)) {
      err('NON_POSITIVE_SIZE', `${path}.height 必须为正整数`, `${path}.height`)
    }
    if (!Array.isArray(o.tiles)) {
      err('BAD_TYPE', `${path}.tiles 必须是数组`, `${path}.tiles`)
      return
    }
    levelSpecs.push({
      level: o.level as number,
      width: o.width as number,
      height: o.height as number,
      tiles: o.tiles as TileSpec[],
    })
  })
  if (hasBlocking()) return { manifest: null, issues }

  // 层级编号：唯一、从 0 开始连续
  const sorted = [...levelSpecs].sort((a, b) => a.level - b.level)
  sorted.forEach((lv, i) => {
    if (lv.level !== i) {
      if (sorted.some((other, j) => j !== i && other.level === lv.level)) {
        err('DUPLICATE_LEVEL', `层级编号 ${lv.level} 重复`, `levels.level`)
      } else {
        err(
          'LEVEL_NUMBERING',
          `层级编号必须从 0 开始连续，期望 ${i}，实际 ${lv.level}`,
          `levels.level`,
        )
      }
    }
  })
  if (hasBlocking()) return { manifest: null, issues }

  // 尺寸单调性 + 与原图尺寸一致性
  sorted.forEach((lv, i) => {
    if (i > 0) {
      const prev = sorted[i - 1]
      if (lv.width < prev.width || lv.height < prev.height) {
        err(
          'NON_POSITIVE_SIZE',
          `层级 ${lv.level} 尺寸 (${lv.width}×${lv.height}) 不得小于层级 ${prev.level} (${prev.width}×${prev.height})`,
          `levels[${i}]`,
        )
      }
      if (lv.width === prev.width && lv.height === prev.height) {
        warn(
          'NON_POSITIVE_SIZE',
          `层级 ${lv.level} 与层级 ${prev.level} 尺寸完全相同`,
          `levels[${i}]`,
        )
      }
    }
  })
  const top = sorted[sorted.length - 1]
  if (top.width !== rootWidth || top.height !== rootHeight) {
    err(
      'NON_POSITIVE_SIZE',
      `原图尺寸 ${rootWidth}×${rootHeight} 必须与最高层级 ${top.level} 的 ${top.width}×${top.height} 一致`,
      'width',
    )
  }
  if (hasBlocking()) return { manifest: null, issues }

  const seenFileNames = new Set<string>()
  const resolvedLevels = new Map<number, ResolvedLevel>()

  for (const lv of sorted) {
    const cols = Math.ceil(lv.width / TILE_SIZE)
    const rows = Math.ceil(lv.height / TILE_SIZE)
    const tiles = new Map<string, ResolvedTile>()

    for (const [ti, t] of lv.tiles.entries()) {
      const path = `levels[${lv.level}].tiles[${ti}]`
      if (typeof t !== 'object' || t === null || Array.isArray(t)) {
        err('TILE_NOT_OBJECT', '瓦片必须是对象', path)
        continue
      }
      if (!isInt(t.x) || (t.x as number) < 0) {
        err('BAD_COORDINATE', `${path}.x 必须是非负整数`, `${path}.x`)
        continue
      }
      if (!isInt(t.y) || (t.y as number) < 0) {
        err('BAD_COORDINATE', `${path}.y 必须是非负整数`, `${path}.y`)
        continue
      }
      if (typeof t.file !== 'string' || t.file.length === 0) {
        err('BAD_TYPE', `${path}.file 必须是非空字符串（文件名需唯一）`, `${path}.file`)
        continue
      }
      const x = t.x as number
      const y = t.y as number
      if (x >= cols || y >= rows) {
        err(
          'OUT_OF_BOUNDS',
          `瓦片 (${x},${y}) 超出层级 ${lv.level} 网格 ${cols}×${rows}`,
          path,
        )
        continue
      }
      const expectedW = Math.min(TILE_SIZE, lv.width - x * TILE_SIZE)
      const expectedH = Math.min(TILE_SIZE, lv.height - y * TILE_SIZE)
      if (t.tileWidth !== undefined) {
        if (!isPosInt(t.tileWidth) || (t.tileWidth as number) > TILE_SIZE) {
          err('BAD_TYPE', `${path}.tileWidth 必须是 1..${TILE_SIZE} 的整数`, `${path}.tileWidth`)
          continue
        }
        if ((t.tileWidth as number) !== expectedW) {
          err(
            'EDGE_SIZE_MISMATCH',
            `瓦片 (${x},${y}) 宽度应为 ${expectedW}（边缘瓦片允许不足 256）`,
            `${path}.tileWidth`,
          )
          continue
        }
      }
      if (t.tileHeight !== undefined) {
        if (!isPosInt(t.tileHeight) || (t.tileHeight as number) > TILE_SIZE) {
          err('BAD_TYPE', `${path}.tileHeight 必须是 1..${TILE_SIZE} 的整数`, `${path}.tileHeight`)
          continue
        }
        if ((t.tileHeight as number) !== expectedH) {
          err(
            'EDGE_SIZE_MISMATCH',
            `瓦片 (${x},${y}) 高度应为 ${expectedH}（边缘瓦片允许不足 256）`,
            `${path}.tileHeight`,
          )
          continue
        }
      }
      const key = `${x}:${y}`
      if (tiles.has(key)) {
        err('DUPLICATE_TILE_POSITION', `层级 ${lv.level} 中瓦片位置 (${x},${y}) 重复`, path)
        continue
      }
      if (seenFileNames.has(t.file)) {
        err('DUPLICATE_FILENAME', `文件名 "${t.file}" 在 manifest 中不唯一`, `${path}.file`)
        continue
      }
      seenFileNames.add(t.file)
      tiles.set(key, {
        x,
        y,
        file: t.file,
        pixelWidth: expectedW,
        pixelHeight: expectedH,
      })
    }

    // 网格内缺失的瓦片 -> 警告（渲染为占位）
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!tiles.has(`${c}:${r}`)) {
          warn(
            'OUT_OF_BOUNDS',
            `层级 ${lv.level} 缺少瓦片 (${c},${r})，将显示占位`,
            `levels[${lv.level}].tiles`,
          )
        }
      }
    }

    resolvedLevels.set(lv.level, { level: lv.level, width: lv.width, height: lv.height, cols, rows, tiles })
  }

  if (hasBlocking()) return { manifest: null, issues }

  return {
    manifest: {
      width: rootWidth,
      height: rootHeight,
      tileSize: TILE_SIZE,
      maxLevel: top.level,
      levels: resolvedLevels,
    },
    issues,
  }
}

/** 从任意 JSON 文本解析并校验清单 */
export function parseManifest(text: string): ValidationResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return {
      manifest: null,
      issues: [
        {
          severity: 'error',
          code: 'NOT_OBJECT',
          message: `manifest 不是合法 JSON：${(e as Error).message}`,
        },
      ],
    }
  }
  return validateManifest(json)
}
