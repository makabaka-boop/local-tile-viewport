/**
 * 测试用可控解码器：每个瓦片的解码可被外部以任意顺序“兑现”，
 * 用于打乱完成顺序、模拟快速缩放后的迟到旧层结果。
 */
import {
  type LoadedTile,
  type TileKey,
  type TileSource,
} from '../core/tileSource'

export class FakeBitmap {
  closed = false
  constructor(
    public width: number,
    public height: number,
  ) {}
  close(): void {
    this.closed = true
  }
}

export interface PendingDecode {
  key: TileKey
  signal: AbortSignal
  resolve: (v: LoadedTile) => void
  reject: (e: unknown) => void
  settled: boolean
}

export class ControllableDecoder implements TileSource {
  pending: PendingDecode[] = []
  started: TileKey[] = []
  /** 已开始并最终完成（resolve）的瓦片 */
  completed: TileKey[] = []
  /** 已开始并被 reject 的瓦片 */
  failed: TileKey[] = []
  abortedStarts = 0
  private failMissing = false
  /** 可选：对指定文件名模拟解码失败 */
  failingFiles = new Set<string>()
  /**
   * 为 true 时忽略 AbortSignal：abort 不会 reject，外部仍可手动 resolve，
   * 用于模拟“解码不可取消、旧层结果迟到返回”的真实解码器。
   */
  ignoreAbortSignals = false

  setFailMissing(v: boolean): void {
    this.failMissing = v
  }

  load(key: TileKey, signal: AbortSignal): Promise<LoadedTile> {
    this.started.push(key)
    return new Promise<LoadedTile>((resolve, reject) => {
      const entry: PendingDecode = { key, signal, resolve, reject, settled: false }
      if (signal.aborted && !this.ignoreAbortSignals) {
        this.abortedStarts++
        entry.settled = true
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      if (!this.ignoreAbortSignals) {
        signal.addEventListener(
          'abort',
          () => {
            if (entry.settled) return
            entry.settled = true
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true },
        )
      }
      this.pending.push(entry)
    })
  }

  /** 按 key 找到一个未决任务（默认取最早的） */
  find(fileOrKey: string | TileKey, level?: number): PendingDecode | undefined {
    return this.pending.find((p) => {
      if (p.settled) return false
      if (typeof fileOrKey === 'string') return p.key.file === fileOrKey
      return (
        p.key.level === (level ?? fileOrKey.level) &&
        p.key.x === fileOrKey.x &&
        p.key.y === fileOrKey.y
      )
    })
  }

  /** 以任意顺序兑现：传入要完成的 pending（可以故意乱序），返回造出的位图 */
  resolve(entry: PendingDecode, width = 256, height = 256): FakeBitmap {
    if (entry.settled) throw new Error('该解码任务已结束')
    if (this.failingFiles.has(entry.key.file)) {
      entry.settled = true
      this.failed.push(entry.key)
      entry.reject(new Error(`解码失败: ${entry.key.file}`))
      return new FakeBitmap(0, 0)
    }
    if (this.failMissing && entry.key.file.startsWith('miss:')) {
      entry.settled = true
      this.failed.push(entry.key)
      entry.reject(Object.assign(new Error('缺少瓦片文件'), { name: 'TileMissingError', file: entry.key.file }))
      return new FakeBitmap(0, 0)
    }
    entry.settled = true
    this.completed.push(entry.key)
    const bmp = new FakeBitmap(width, height)
    entry.resolve({
      bitmap: bmp as unknown as ImageBitmap,
      width,
      height,
    })
    return bmp
  }

  rejectEntry(entry: PendingDecode, err: unknown): void {
    if (entry.settled) throw new Error('该解码任务已结束')
    entry.settled = true
    this.failed.push(entry.key)
    entry.reject(err)
  }

  get pendingCount(): number {
    return this.pending.filter((p) => !p.settled).length
  }

  /** 让微任务执行（promise 链式 settle 需要） */
  flush(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0))
  }
}
