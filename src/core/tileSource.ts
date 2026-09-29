/**
 * 瓦片数据源：把用户选择的本地 File 映射到 manifest 瓦片。
 * 文件只存在于浏览器内存（File/Blob），绝不上传。
 */

export interface TileKey {
  level: number
  x: number
  y: number
  /** manifest 中声明的文件名 */
  file: string
}

export interface LoadedTile {
  bitmap: ImageBitmap
  width: number
  height: number
}

export function tileKeyString(k: TileKey): string {
  return `${k.level}/${k.x}/${k.y}`
}

/** manifest 引用了文件，但用户没有选中对应文件 */
export class TileMissingError extends Error {
  constructor(public file: string) {
    super(`缺少瓦片文件：${file}`)
    this.name = 'TileMissingError'
  }
}

export interface TileSource {
  /**
   * 解码一个瓦片。实现应响应 AbortSignal（快速缩放后旧任务会被中止）。
   * 文件缺失时 reject TileMissingError。
   */
  load(key: TileKey, signal: AbortSignal): Promise<LoadedTile>
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] || p
}

/** 基于本地 File 列表的数据源 */
export class FileTileSource implements TileSource {
  private readonly files = new Map<string, File>()

  constructor(fileList: Iterable<File>) {
    for (const f of fileList) {
      // 纯文件名
      this.files.set(f.name, f)
      // webkitdirectory 选择目录时，File 带相对路径（如 "tiles/L0_0_0.png"）
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath
      if (rel) {
        const normalized = rel.replace(/^[^/]+\//, '') // 去掉浏览器给的根目录名
        if (normalized) this.files.set(normalized, f)
        const base = basename(normalized)
        if (!this.files.has(base)) this.files.set(base, f)
      }
    }
  }

  get size(): number {
    return this.files.size
  }

  hasFile(name: string): boolean {
    return this.files.has(name) || this.files.has(basename(name))
  }

  async load(key: TileKey, signal: AbortSignal): Promise<LoadedTile> {
    const file = this.files.get(key.file) ?? this.files.get(basename(key.file))
    if (!file) throw new TileMissingError(key.file)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

    const bitmap = await createImageBitmap(file)
    if (signal.aborted) {
      bitmap.close()
      throw new DOMException('Aborted', 'AbortError')
    }
    return { bitmap, width: bitmap.width, height: bitmap.height }
  }
}
