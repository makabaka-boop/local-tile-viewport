/**
 * 瓦片解码池：
 * - 解码并发上限（默认 4）；
 * - 已解码位图存入有内存上限的 LRU，淘汰即释放；
 * - 快速缩放后，旧层的在队任务会被取消，迟到结果不会进入当前画面
 *   （完成时按“目标世代”校验，调用方也可用 TileBoard 做二次防护）；
 * - 完成/失败通过回调通知调用方重绘。
 */
import { BitmapLRU } from './bitmapCache'
import {
  tileKeyString,
  type LoadedTile,
  type TileKey,
  type TileMissingError,
  type TileSource,
} from './tileSource'

export const MAX_CONCURRENCY = 4

export interface TileLoadError {
  key: TileKey
  missing: boolean
  message: string
}

interface Job {
  key: TileKey
  epoch: number
  controller: AbortController
  /** 距离视口中心的优先级，越小越优先 */
  priority: number
  settled: boolean
}

export interface DecodePoolEvents {
  /** 一个瓦片解码完成且已进入缓存（也可能因世代过旧被忽略） */
  onSettled?: (key: TileKey) => void
  onError?: (err: TileLoadError) => void
}

export class DecodePool {
  private cache: BitmapLRU<string>
  private active = new Map<string, Job>()
  private queued: Job[] = []
  private inflight = 0
  /** 单调递增的世代；每次 setDesiredTiles 递增，旧世代任务完成后被丢弃 */
  private epoch = 0

  constructor(
    private source: TileSource,
    byteBudget: number,
    private maxConcurrency = MAX_CONCURRENCY,
    private events: DecodePoolEvents = {},
  ) {
    this.cache = new BitmapLRU<string>(byteBudget)
  }

  getCache(): BitmapLRU<string> {
    return this.cache
  }

  setByteBudget(bytes: number): void {
    this.cache.setBudget(bytes)
  }

  get inflightCount(): number {
    return this.inflight
  }

  get queuedCount(): number {
    return this.queued.length
  }

  get currentEpoch(): number {
    return this.epoch
  }

  /**
   * 更新当前画面需要的瓦片集合。
   * - 命中缓存：什么都不做；
   * - 已在解码：更新其世代（保留它，防止刚发起的任务被误杀）；
   * - 其余：入队；
   * - 不再需要的在队任务：取消；旧世代且已在飞行中的任务：中止。
   */
  setDesiredTiles(keys: Array<{ key: TileKey; priority: number }>): number {
    this.epoch++
    const wanted = new Set(keys.map(({ key }) => tileKeyString(key)))
    const byKey = new Map(keys.map((e) => [tileKeyString(e.key), e]))

    // 取消不再需要的任务
    for (const [id, job] of this.active) {
      if (wanted.has(id)) {
        job.epoch = this.epoch
        const prio = byKey.get(id)?.priority
        if (prio !== undefined) job.priority = prio
        continue
      }
      if (job.settled) {
        this.active.delete(id)
      } else {
        this.cancelJob(job, id)
      }
    }

    let enqueued = 0
    for (const { key, priority } of keys) {
      const id = tileKeyString(key)
      if (this.cache.has(id)) continue
      if (this.active.has(id)) continue
      const job: Job = {
        key,
        epoch: this.epoch,
        controller: new AbortController(),
        priority,
        settled: false,
      }
      this.active.set(id, job)
      this.queued.push(job)
      enqueued++
    }
    this.queued.sort((a, b) => a.priority - b.priority)
    this.pump()
    return enqueued
  }

  getBitmap(key: TileKey): ImageBitmap | undefined {
    return this.cache.get(tileKeyString(key))
  }

  /** 全部取消并清空缓存（切换数据集 / 销毁时） */
  dispose(): void {
    this.epoch++
    for (const [id, job] of this.active) this.cancelJob(job, id)
    this.queued = []
    this.cache.clear()
  }

  private cancelJob(job: Job, id: string): void {
    job.controller.abort()
    this.active.delete(id)
    const qi = this.queued.indexOf(job)
    if (qi >= 0) this.queued.splice(qi, 1)
  }

  private pump(): void {
    while (this.inflight < this.maxConcurrency && this.queued.length > 0) {
      const job = this.queued.shift()!
      this.inflight++
      void this.run(job)
    }
  }

  private async run(job: Job): Promise<void> {
    const id = tileKeyString(job.key)
    let result: LoadedTile
    try {
      result = await this.source.load(job.key, job.controller.signal)
    } catch (e) {
      this.inflight = Math.max(0, this.inflight - 1)
      this.active.delete(id)
      if ((e as DOMException)?.name === 'AbortError') {
        // 正常的过期取消，不通知
      } else {
        this.events.onError?.({
          key: job.key,
          missing: (e as TileMissingError)?.name === 'TileMissingError',
          message: (e as Error).message || String(e),
        })
      }
      this.pump()
      return
    }

    this.inflight = Math.max(0, this.inflight - 1)
    job.settled = true
    this.active.delete(id)

    // 关键防护：快速缩放后迟到的旧层解码不得进入缓存/当前画面
    if (job.epoch !== this.epoch) {
      result.bitmap.close?.()
      this.pump()
      return
    }
    this.cache.set(id, result.bitmap, result.width, result.height)
    this.events.onSettled?.(job.key)
    this.pump()
  }
}
