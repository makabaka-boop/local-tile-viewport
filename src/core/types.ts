/**
 * 核心领域类型定义。
 *
 * 约定：
 * - 所有瓦片均为 256×256，只有右/下边缘瓦片允许不足；
 * - level 0 为最粗（缩略图）层，层级越高像素尺寸越大（通常每层 2×）；
 * - 原图坐标 = 最顶层（levelMax）层坐标。
 */

export const TILE_SIZE = 256

/** manifest 中对单个层级的描述 */
export interface LevelSpec {
  /** 层级编号，必须从 0 开始连续递增且唯一 */
  level: number
  /** 该层级像素宽度（必须为正数） */
  width: number
  /** 该层级像素高度（必须为正数） */
  height: number
  /** 该层的瓦片描述 */
  tiles: TileSpec[]
}

/** manifest 中对单个瓦片的描述 */
export interface TileSpec {
  /** 瓦片列号（从 0 开始） */
  x: number
  /** 瓦片行号（从 0 开始） */
  y: number
  /**
   * 用户选择的本地文件名（相对清单的路径也按文件名匹配）。
   * 整个 manifest 内必须唯一；缺失文件不致命，渲染为占位瓦片。
   */
  file: string
  /** 可选：显式宽度，省略时按 256（边缘为剩余像素）处理 */
  tileWidth?: number
  /** 可选：显式高度 */
  tileHeight?: number
}

/** 多分辨率 manifest */
export interface Manifest {
  /** 清单格式名，用于基本识别 */
  kind?: string
  /** 原图逻辑宽度，必须与最高层级像素宽度一致 */
  width: number
  /** 原图逻辑高度，必须与最高层级像素高度一致 */
  height: number
  tileSize?: number
  levels: LevelSpec[]
}

/** 校验通过后的瓦片（含其在该层内的像素尺寸） */
export interface ResolvedTile {
  x: number
  y: number
  file: string
  pixelWidth: number
  pixelHeight: number
}

/** 校验通过后的层级 */
export interface ResolvedLevel {
  level: number
  width: number
  height: number
  cols: number
  rows: number
  /** 键 `x:y` -> 瓦片 */
  tiles: Map<string, ResolvedTile>
}

/** 完整的已校验数据集 */
export interface ResolvedManifest {
  width: number
  height: number
  tileSize: number
  maxLevel: number
  levels: Map<number, ResolvedLevel>
}

/** 导入校验产生的问题 */
export interface ValidationIssue {
  severity: 'error' | 'warning'
  code:
    | 'NOT_OBJECT'
    | 'MISSING_FIELD'
    | 'BAD_TYPE'
    | 'BAD_TILE_SIZE'
    | 'NO_LEVELS'
    | 'LEVEL_NOT_OBJECT'
    | 'DUPLICATE_LEVEL'
    | 'LEVEL_NUMBERING'
    | 'NON_POSITIVE_SIZE'
    | 'TILE_NOT_OBJECT'
    | 'BAD_COORDINATE'
    | 'OUT_OF_BOUNDS'
    | 'EDGE_SIZE_MISMATCH'
    | 'DUPLICATE_TILE_POSITION'
    | 'DUPLICATE_FILENAME'
  message: string
  path?: string
}

/** 画布向界面汇报的实时状态 */
export interface CanvasStatus {
  scale: number
  level: number
  loading: number
  missing: number
  errors: number
  cached: number
  cacheBytes: number
}
