/**
 * TileBoard：当前画面需要的瓦片槽位模型。
 *
 * 这是“迟到结果不得覆盖当前画面”的第二道防线（第一道在 DecodePool 的世代校验）：
 * 即使解码回调晚于层级切换返回，只要瓦片已不在当前槽位中，就不会被标记/绘制。
 * 纯 TS、无 DOM 依赖，便于单测。
 */
import { tileKeyString, type TileKey } from './tileSource'

export type SlotStatus = 'loading' | 'ready' | 'missing' | 'error'

export interface Slot {
  key: TileKey
  status: SlotStatus
}

export class TileBoard {
  private slots = new Map<string, Slot>()
  private epochValue = 0

  /** 当前画面世代，每次整板替换槽位时递增 */
  get epoch(): number {
    return this.epochValue
  }

  get size(): number {
    return this.slots.size
  }

  has(key: TileKey): boolean {
    return this.slots.has(tileKeyString(key))
  }

  get(key: TileKey): Slot | undefined {
    return this.slots.get(tileKeyString(key))
  }

  entries(): Slot[] {
    return [...this.slots.values()]
  }

  /**
   * 用新一批瓦片替换整板。
   * @param keys 当前画面需要的瓦片
   * @param isManifestMissing manifest 网格内本就没有该瓦片（占位，不发起解码）
   */
  setSlots(
    keys: TileKey[],
    isManifestMissing?: (key: TileKey) => boolean,
  ): void {
    this.epochValue++
    const next = new Map<string, Slot>()
    for (const key of keys) {
      const id = tileKeyString(key)
      const existing = this.slots.get(id)
      next.set(id, {
        key,
        status: existing?.status ?? (isManifestMissing?.(key) ? 'missing' : 'loading'),
      })
    }
    this.slots = next
  }

  /** 仅当瓦片仍在当前画面时更新其状态；返回是否被接受 */
  mark(key: TileKey, status: SlotStatus): boolean {
    const slot = this.slots.get(tileKeyString(key))
    if (!slot) return false
    slot.status = status
    return true
  }
}
