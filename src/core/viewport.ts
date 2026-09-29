/**
 * 视口几何：屏幕坐标 <-> 原图（最顶层）坐标的双向映射。
 *
 * viewport 状态为 (scale, originX, originY)：原图点 (0,0) 在屏幕上的位置，
 * 以及屏幕像素 / 原图像素 的缩放比。
 */
export interface ViewportState {
  scale: number
  originX: number
  originY: number
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface ImageRect {
  x: number
  y: number
  width: number
  height: number
}

export function fitViewport(
  imageWidth: number,
  imageHeight: number,
  screenWidth: number,
  screenHeight: number,
  padding = 24,
): ViewportState {
  const scale = Math.min(
    (screenWidth - padding * 2) / imageWidth,
    (screenHeight - padding * 2) / imageHeight,
    // 不允许初始放大到超过设备像素能表达的范围太多
    8,
  )
  return {
    scale,
    originX: (screenWidth - imageWidth * scale) / 2,
    originY: (screenHeight - imageHeight * scale) / 2,
  }
}

export function screenToImage(v: ViewportState, p: ScreenPoint): ScreenPoint {
  return { x: (p.x - v.originX) / v.scale, y: (p.y - v.originY) / v.scale }
}

export function imageToScreen(v: ViewportState, p: ScreenPoint): ScreenPoint {
  return { x: p.x * v.scale + v.originX, y: p.y * v.scale + v.originY }
}

/**
 * 以屏幕上的锚点为中心缩放。
 * 锚点在缩放前后对应同一个原图坐标。
 */
export function zoomAt(
  v: ViewportState,
  anchor: ScreenPoint,
  factor: number,
  minScale: number,
  maxScale: number,
): ViewportState {
  const next = clampScale(v.scale * factor, minScale, maxScale)
  const realFactor = next / v.scale
  // imagePoint = (anchor - origin) / scale 保持不变：
  // anchor = origin' + imagePoint * scale'
  //        = origin' + (anchor - origin) * (scale'/scale)
  // => origin' = anchor - (anchor - origin) * realFactor
  return {
    scale: next,
    originX: anchor.x - (anchor.x - v.originX) * realFactor,
    originY: anchor.y - (anchor.y - v.originY) * realFactor,
  }
}

export function clampScale(scale: number, min: number, max: number): number {
  if (scale < min) return min
  if (scale > max) return max
  return scale
}

/** 平移（delta 为屏幕像素） */
export function pan(v: ViewportState, dx: number, dy: number): ViewportState {
  return { scale: v.scale, originX: v.originX + dx, originY: v.originY + dy }
}

/** 把视口限制在图像附近（避免图像被完全拖走） */
export function clampViewport(
  v: ViewportState,
  imageWidth: number,
  imageHeight: number,
  screenWidth: number,
  screenHeight: number,
  margin = 80,
): ViewportState {
  const w = imageWidth * v.scale
  const h = imageHeight * v.scale
  const minX = Math.min(0, screenWidth - w) - margin
  const maxX = margin
  const minY = Math.min(0, screenHeight - h) - margin
  const maxY = margin
  const clamp = (x: number, lo: number, hi: number) =>
    x < lo ? lo : x > hi ? hi : x
  return {
    scale: v.scale,
    originX: clamp(v.originX, minX, maxX),
    originY: clamp(v.originY, minY, maxY),
  }
}

/** 当前视口覆盖的原图矩形 */
export function visibleImageRect(
  v: ViewportState,
  screenWidth: number,
  screenHeight: number,
): ImageRect {
  const tl = screenToImage(v, { x: 0, y: 0 })
  const br = screenToImage(v, { x: screenWidth, y: screenHeight })
  return {
    x: tl.x,
    y: tl.y,
    width: br.x - tl.x,
    height: br.y - tl.y,
  }
}

/** 将一个原图矩形裁剪到图像边界内 */
export function clampRectToImage(
  rect: ImageRect,
  imageWidth: number,
  imageHeight: number,
): ImageRect | null {
  const x1 = Math.max(0, rect.x)
  const y1 = Math.max(0, rect.y)
  const x2 = Math.min(imageWidth, rect.x + rect.width)
  const y2 = Math.min(imageHeight, rect.y + rect.height)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}
