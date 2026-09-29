import { describe, expect, it } from 'vitest'
import { FileTileSource, type TileKey } from './tileSource'

function fakeFile(name: string, rel = ''): File {
  const f = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  if (rel) Object.defineProperty(f, 'webkitRelativePath', { value: rel })
  return f
}

const k = (file: string): TileKey => ({ level: 0, x: 0, y: 0, file })

describe('FileTileSource 本地文件映射', () => {
  it('按纯文件名匹配', () => {
    const src = new FileTileSource([fakeFile('a.png'), fakeFile('b.png')])
    expect(src.size).toBe(2)
    expect(src.hasFile('a.png')).toBe(true)
    expect(src.hasFile('nope.png')).toBe(false)
  })

  it('manifest 使用相对路径时按 basename 兜底匹配', () => {
    const src = new FileTileSource([fakeFile('L0_0_0.png')])
    expect(src.hasFile('tiles/pyramid/L0_0_0.png')).toBe(true)
  })

  it('webkitRelativePath 选择目录时同时登记相对路径与 basename', () => {
    const src = new FileTileSource([
      fakeFile('L0_0_0.png', 'mytiles/L0_0_0.png'),
      fakeFile('L1_0_0.png', 'mytiles/sub/L1_0_0.png'),
    ])
    expect(src.hasFile('L0_0_0.png')).toBe(true)
    expect(src.hasFile('mytiles/L0_0_0.png')).toBe(true)
    expect(src.hasFile('sub/L1_0_0.png')).toBe(true)
  })

  it('缺失文件以 TileMissingError 拒绝（占位的依据）', async () => {
    const src = new FileTileSource([fakeFile('a.png')])
    await expect(
      src.load(k('ghost.png'), new AbortController().signal),
    ).rejects.toMatchObject({ name: 'TileMissingError', file: 'ghost.png' })
  })

  it('已中止的信号在文件存在时以 AbortError 拒绝（node 无 createImageBitmap 时也先于解码检查）', async () => {
    const src = new FileTileSource([fakeFile('a.png')])
    await expect(src.load(k('a.png'), AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
