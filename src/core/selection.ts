/**
 * 框选区域与导出。
 *
 * 选择过程在屏幕坐标中进行，但导出时一律换算为原图（最顶层）坐标，
 * 并裁剪到原图边界。
 */
import {
  clampRectToImage,
  screenToImage,
  type ScreenPoint,
  type ViewportState,
} from './viewport'

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageSelection {
  x: number
  y: number
  width: number
  height: number
}

/** 两个屏幕角点 -> 规范化的屏幕矩形（宽高非负） */
export function screenRectFromPoints(a: ScreenPoint, b: ScreenPoint): ScreenRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** 屏幕矩形 -> 原图坐标矩形（裁剪到图像范围内；与视口缩放/平移无关） */
export function selectionToImage(
  screenRect: ScreenRect,
  v: ViewportState,
  imageWidth: number,
  imageHeight: number,
): ImageSelection | null {
  const a = screenToImage(v, { x: screenRect.x, y: screenRect.y })
  const b = screenToImage(v, {
    x: screenRect.x + screenRect.width,
    y: screenRect.y + screenRect.height,
  })
  const rect = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
  return clampRectToImage(rect, imageWidth, imageHeight)
}

export interface ExportPayload {
  format: 'image-workbench-selection/1'
  exportedAt: string
  image: { width: number; height: number }
  selection: {
    x: number
    y: number
    width: number
    height: number
  }
  /** 选择中心的原图坐标，便于校验 */
  center: { x: number; y: number }
}

export function buildExportPayload(
  sel: ImageSelection,
  imageWidth: number,
  imageHeight: number,
  now: Date = new Date(),
): ExportPayload {
  return {
    format: 'image-workbench-selection/1',
    exportedAt: now.toISOString(),
    image: { width: imageWidth, height: imageHeight },
    selection: {
      x: round(sel.x),
      y: round(sel.y),
      width: round(sel.width),
      height: round(sel.height),
    },
    center: {
      x: round(sel.x + sel.width / 2),
      y: round(sel.y + sel.height / 2),
    },
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** 导出 JSON 文本（2 空格缩进） */
export function exportSelectionJSON(
  sel: ImageSelection,
  imageWidth: number,
  imageHeight: number,
  now: Date = new Date(),
): string {
  return JSON.stringify(buildExportPayload(sel, imageWidth, imageHeight, now), null, 2)
}
