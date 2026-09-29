<script setup lang="ts">
/**
 * 瓦片画布：
 * - 拖动平移 / 以鼠标位置为锚点滚轮缩放，视口始终映射原图坐标；
 * - 可见瓦片由当前缩放比选择的层级提供；缺失/解码中显示明确占位；
 * - 已解码位图经 DecodePool（并发 4 + 内存 LRU）获取，
 *   迟到的旧层结果由世代 + TileBoard 双重防护，不会覆盖当前画面；
 * - Shift（或工具栏模式）下框选区域，emit 原图坐标。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { chooseLevel, visibleTiles, type VisibleTile } from './core/levels'
import {
  clampViewport,
  fitViewport,
  pan,
  screenToImage,
  zoomAt,
  type ImageRect,
  type ScreenPoint,
  type ViewportState,
} from './core/viewport'
import type { CanvasStatus, ResolvedManifest } from './core/types'
import { DecodePool, type TileLoadError } from './core/decodePool'
import { TileBoard } from './core/tileBoard'
import type { TileKey, TileSource } from './core/tileSource'
import {
  screenRectFromPoints,
  selectionToImage,
  type ImageSelection,
} from './core/selection'

const props = defineProps<{
  manifest: ResolvedManifest
  source: TileSource
  /** 位图缓存内存预算（字节） */
  byteBudget: number
  mode: 'pan' | 'select'
}>()

const emit = defineEmits<{
  (e: 'selection', sel: ImageSelection): void
  (e: 'status', s: CanvasStatus): void
  (e: 'error', msg: string): void
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const wrapRef = ref<HTMLDivElement | null>(null)
const screen = shallowRef({ w: 800, h: 600 })

let viewport: ViewportState = { scale: 1, originX: 0, originY: 0 }
const MIN_SCALE = 0.02
const MAX_SCALE = 16

const board = new TileBoard()
let pool: DecodePool | null = null
let rafHandle = 0
let disposed = false

const errorTiles = new Set<string>()
const missingTiles = new Set<string>()

const dragKind = shallowRef<'none' | 'pan' | 'select'>('none')
let dragStart: ScreenPoint = { x: 0, y: 0 }
let dragLast: ScreenPoint = { x: 0, y: 0 }
const dragCurrent = ref<ScreenPoint | null>(null)

// ---- 尺寸观察 ----
let resizeObs: ResizeObserver | null = null

onMounted(() => {
  const canvas = canvasRef.value!
  const wrap = wrapRef.value!

  pool = new DecodePool(props.source, props.byteBudget, 4, {
    onSettled: () => scheduleDraw(),
    onError: (err: TileLoadError) => {
      const id = `${err.key.level}/${err.key.x}/${err.key.y}`
      if (err.missing) missingTiles.add(id)
      else errorTiles.add(id)
      board.mark(err.key, err.missing ? 'missing' : 'error')
      emit('error', err.missing ? `缺少瓦片文件：${err.key.file}` : `瓦片解码失败：${err.message}`)
      scheduleDraw()
    },
  })

  const size = wrap.getBoundingClientRect()
  screen.value = { w: size.width, h: size.height }
  viewport = fitInitial(size.width, size.height)
  resizeCanvas(size.width, size.height)

  resizeObs = new ResizeObserver(() => {
    const r = wrap.getBoundingClientRect()
    screen.value = { w: r.width, h: r.height }
    resizeCanvas(r.width, r.height)
    scheduleDraw()
  })
  resizeObs.observe(wrap)

  canvas.addEventListener('wheel', onWheel, { passive: false })
  scheduleDraw()
})

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(rafHandle)
  resizeObs?.disconnect()
  canvasRef.value?.removeEventListener('wheel', onWheel)
  pool?.dispose()
})

// 调整内存预算只收缩/放宽 LRU，不丢弃其他状态
watch(
  () => props.byteBudget,
  (b) => {
    pool?.setByteBudget(b)
    scheduleDraw()
  },
)

function fitInitial(w: number, h: number): ViewportState {
  return fitViewport(props.manifest.width, props.manifest.height, w, h)
}

function resizeCanvas(w: number, h: number): void {
  const canvas = canvasRef.value!
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

// ---- 输入：滚轮（锚点缩放） ----
function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const rect = canvasRef.value!.getBoundingClientRect()
  const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  const factor = Math.exp(-e.deltaY * 0.0015)
  viewport = zoomAt(viewport, anchor, factor, MIN_SCALE, MAX_SCALE)
  scheduleDraw()
}

function eventPoint(e: MouseEvent | WheelEvent): ScreenPoint {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 && e.button !== 1) return
  const p = eventPoint(e)
  dragStart = p
  dragLast = p
  const wantSelect = e.button === 0 && (props.mode === 'select' || e.shiftKey)
  dragKind.value = wantSelect ? 'select' : 'pan'
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  if (wantSelect) dragCurrent.value = p
}

function onPointerMove(e: PointerEvent): void {
  if (dragKind.value === 'none') return
  const p = eventPoint(e)
  if (dragKind.value === 'pan') {
    viewport = pan(viewport, p.x - dragLast.x, p.y - dragLast.y)
    dragLast = p
    scheduleDraw()
  } else if (dragKind.value === 'select') {
    dragCurrent.value = p
  }
}

function onPointerUp(e: PointerEvent): void {
  if (dragKind.value === 'none') return
  const p = eventPoint(e)
  if (dragKind.value === 'select') {
    const rect = screenRectFromPoints(dragStart, p)
    if (rect.width >= 3 && rect.height >= 3) {
      const sel = selectionToImage(rect, viewport, props.manifest.width, props.manifest.height)
      if (sel) emit('selection', sel)
    }
  } else {
    // 平移结束时把视口限制回合理范围
    viewport = clampViewport(viewport, props.manifest.width, props.manifest.height, screen.value.w, screen.value.h)
    scheduleDraw()
  }
  dragKind.value = 'none'
  dragCurrent.value = null
  void e
}

function onDoubleClick(e: MouseEvent): void {
  const p = eventPoint(e)
  viewport = zoomAt(viewport, p, 1.8, MIN_SCALE, MAX_SCALE)
  scheduleDraw()
}

function zoomByButton(factor: number): void {
  viewport = zoomAt(
    viewport,
    { x: screen.value.w / 2, y: screen.value.h / 2 },
    factor,
    MIN_SCALE,
    MAX_SCALE,
  )
  scheduleDraw()
}

function resetView(): void {
  viewport = fitInitial(screen.value.w, screen.value.h)
  scheduleDraw()
}

defineExpose({ zoomByButton, resetView })

// ---- 渲染调度 ----
function scheduleDraw(): void {
  if (rafHandle || disposed) return
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0
    draw()
  })
}

function imageViewportRect(): ImageRect {
  const { w, h } = screen.value
  const tl = screenToImage(viewport, { x: 0, y: 0 })
  const br = screenToImage(viewport, { x: w, y: h })
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }
}

function draw(): void {
  const canvas = canvasRef.value
  if (!canvas || !pool) return
  const ctx = canvas.getContext('2d')!
  const { w, h } = screen.value
  const m = props.manifest

  ctx.fillStyle = '#15161a'
  ctx.fillRect(0, 0, w, h)

  const level = chooseLevel(m, viewport.scale)
  const view = imageViewportRect()
  const tiles = visibleTiles(m, level, view)

  // 用当前画面瓦片刷新槽位（二次防迟到覆盖），并以“缓存实况”决定要请求的瓦片：
  // 被 LRU 淘汰的位图槽位即使曾是 ready，也必须重新入队解码，不能卡在占位。
  const cx = view.x + view.width / 2
  const cy = view.y + view.height / 2
  const realTiles = tiles.filter((t) => t.tile.file !== '')
  board.setSlots(realTiles.map((t) => ({
    level: t.level,
    x: t.tile.x,
    y: t.tile.y,
    file: t.tile.file,
  })))

  const desired: Array<{ key: TileKey; priority: number }> = []

  let loading = 0
  let missing = 0
  let errors = 0

  for (const t of tiles) {
    const s = imageRectToScreen(t)
    const tileKey = { level: t.level, x: t.tile.x, y: t.tile.y, file: t.tile.file }
    const isManifestMissing = t.tile.file === ''
    const id = `${t.level}/${t.tile.x}/${t.tile.y}`
    const isMissing = isManifestMissing || missingTiles.has(id)
    const isError = !isMissing && errorTiles.has(id)
    const bitmap = isMissing || isError ? undefined : pool.getBitmap(tileKey)

    if (bitmap) {
      board.mark(tileKey, 'ready')
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(bitmap, s.x, s.y, s.width, s.height)
    } else if (isMissing) {
      board.mark(tileKey, 'missing')
      missing++
      drawPlaceholder(ctx, s, '缺失', 'rgba(224,168,61,0.18)', '#7a5d24')
    } else if (isError) {
      board.mark(tileKey, 'error')
      errors++
      drawPlaceholder(ctx, s, '错误', 'rgba(255,107,107,0.15)', '#7a3030')
    } else {
      // 缓存中没有（含被淘汰）：需要解码
      board.mark(tileKey, 'loading')
      loading++
      drawPlaceholder(ctx, s, '', 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0.12)')
      const dx = t.fullRect.x + t.fullRect.width / 2 - cx
      const dy = t.fullRect.y + t.fullRect.height / 2 - cy
      desired.push({ key: tileKey, priority: dx * dx + dy * dy })
    }
  }
  pool.setDesiredTiles(desired)

  // 图像边框
  const brImg = { x: m.width * viewport.scale, y: m.height * viewport.scale }
  const ox = viewport.originX
  const oy = viewport.originY
  ctx.strokeStyle = 'rgba(79,140,255,0.5)'
  ctx.lineWidth = 1
  ctx.strokeRect(ox, oy, brImg.x, brImg.y)

  // 框选矩形
  if (dragKind.value === 'select' && dragCurrent.value) {
    const r = screenRectFromPoints(dragStart, dragCurrent.value)
    ctx.fillStyle = 'rgba(79,140,255,0.18)'
    ctx.fillRect(r.x, r.y, r.width, r.height)
    ctx.strokeStyle = '#4f8cff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1)
    ctx.setLineDash([])
  }

  emit('status', {
    scale: viewport.scale,
    level,
    loading,
    missing,
    errors,
    cached: pool.getCache().length,
    cacheBytes: pool.getCache().sizeBytes,
  })
}

function imageRectToScreen(t: VisibleTile): ScreenRectLike {
  const x = t.fullRect.x * viewport.scale + viewport.originX
  const y = t.fullRect.y * viewport.scale + viewport.originY
  return {
    x,
    y,
    width: t.fullRect.width * viewport.scale,
    height: t.fullRect.height * viewport.scale,
  }
}

interface ScreenRectLike {
  x: number
  y: number
  width: number
  height: number
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  r: ScreenRectLike,
  label: string,
  fill: string,
  stroke: string,
): void {
  ctx.fillStyle = fill
  ctx.fillRect(r.x, r.y, r.width, r.height)
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1)
  // 对角线
  ctx.beginPath()
  ctx.moveTo(r.x, r.y)
  ctx.lineTo(r.x + r.width, r.y + r.height)
  ctx.moveTo(r.x + r.width, r.y)
  ctx.lineTo(r.x, r.y + r.height)
  ctx.stroke()
  if (label && r.width > 28 && r.height > 16) {
    ctx.fillStyle = 'rgba(230,231,234,0.85)'
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, r.x + r.width / 2, r.y + r.height / 2)
  }
}
</script>

<template>
  <div ref="wrapRef" class="canvas-wrap">
    <canvas
      ref="canvasRef"
      :class="{ crosshair: mode === 'select' }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @dblclick="onDoubleClick"
    ></canvas>
    <div class="zoom-tools">
      <button title="放大（以中心为锚点）" @click="zoomByButton(1.4)">＋</button>
      <button title="缩小（以中心为锚点）" @click="zoomByButton(1 / 1.4)">－</button>
      <button title="适合窗口" @click="resetView">⛶</button>
    </div>
  </div>
</template>

<style scoped>
.canvas-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
canvas {
  display: block;
  touch-action: none;
  cursor: grab;
}
canvas:active {
  cursor: grabbing;
}
canvas.crosshair {
  cursor: crosshair;
}
.zoom-tools {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.zoom-tools button {
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
  background: rgba(20, 21, 26, 0.85);
}
</style>
