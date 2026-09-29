/**
 * 有内存上限的 LRU 位图缓存。
 *
 * - 以字节计预算（ImageBitmap 按 width*height*4 估算）；
 * - 读取（get）会更新最近使用顺序；
 * - 超预算时从最久未使用端淘汰，并调用 release（ImageBitmap.close）；
 * - 淘汰可被监听（测试用于检查淘汰是否发生、位图是否被释放）。
 */

export interface SizedBitmap {
  bitmap: ImageBitmap
  width: number
  height: number
}

export interface EvictionEntry<K> {
  key: K
  bitmap: ImageBitmap
  bytes: number
}

export class BitmapLRU<K = string> {
  private readonly map = new Map<K, SizedBitmap>()
  private bytes = 0
  private evictions: Array<(e: EvictionEntry<K>) => void> = []

  constructor(private byteBudget: number) {}

  get sizeBytes(): number {
    return this.bytes
  }

  get length(): number {
    return this.map.size
  }

  get budget(): number {
    return this.byteBudget
  }

  setBudget(bytes: number): void {
    this.byteBudget = Math.max(0, bytes)
    this.evict()
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get(key: K): ImageBitmap | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    // 刷新 LRU 顺序
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.bitmap
  }

  /** 不刷新顺序的读取（如后台预取） */
  peek(key: K): ImageBitmap | undefined {
    return this.map.get(key)?.bitmap
  }

  static byteCost(width: number, height: number): number {
    return width * height * 4
  }

  set(key: K, bitmap: ImageBitmap, width: number, height: number): void {
    if (this.map.has(key)) {
      const old = this.map.get(key)!
      this.bytes -= BitmapLRU.byteCost(old.width, old.height)
      this.map.delete(key)
      // 被同键覆盖：释放旧位图
      this.fireEviction({ key, bitmap: old.bitmap, bytes: BitmapLRU.byteCost(old.width, old.height) })
    }
    const cost = BitmapLRU.byteCost(width, height)
    this.map.set(key, { bitmap, width, height })
    this.bytes += cost
    this.evict()
  }

  delete(key: K): boolean {
    const entry = this.map.get(key)
    if (!entry) return false
    this.map.delete(key)
    this.bytes -= BitmapLRU.byteCost(entry.width, entry.height)
    this.fireEviction({
      key,
      bitmap: entry.bitmap,
      bytes: BitmapLRU.byteCost(entry.width, entry.height),
    })
    return true
  }

  clear(): void {
    for (const [key, entry] of this.map) {
      this.fireEviction({
        key,
        bitmap: entry.bitmap,
        bytes: BitmapLRU.byteCost(entry.width, entry.height),
      })
    }
    this.map.clear()
    this.bytes = 0
  }

  onEviction(fn: (e: EvictionEntry<K>) => void): () => void {
    this.evictions.push(fn)
    return () => {
      this.evictions = this.evictions.filter((f) => f !== fn)
    }
  }

  private fireEviction(e: EvictionEntry<K>): void {
    try {
      // 释放底层位图资源
      e.bitmap.close?.()
    } catch {
      // 某些环境的 ImageBitmap 没有 close；测试桩也可不实现
    }
    for (const fn of this.evictions) fn(e)
  }

  private evict(): void {
    while (this.bytes > this.byteBudget && this.map.size > 0) {
      const oldest = this.map.keys().next().value as K
      // delete() 会触发 fireEviction
      this.delete(oldest)
    }
  }
}
