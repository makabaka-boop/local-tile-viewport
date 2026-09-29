import { describe, expect, it } from 'vitest'
import { BitmapLRU } from './bitmapCache'
import { DecodePool, MAX_CONCURRENCY } from './decodePool'
import type { TileKey } from './tileSource'
import { ControllableDecoder, FakeBitmap } from '../test/controllableDecoder'

const key = (level: number, x: number, y: number, file = `L${level}_${x}_${y}.png`): TileKey => ({
  level,
  x,
  y,
  file,
})

/** 256×256 RGBA = 262144 字节 */
const TILE_BYTES = 256 * 256 * 4

describe('BitmapLRU 内存上限', () => {
  it('超预算时淘汰最久未使用的位图并 close', () => {
    const lru = new BitmapLRU<string>(TILE_BYTES * 2)
    const b1 = new FakeBitmap(256, 256)
    const b2 = new FakeBitmap(256, 256)
    const b3 = new FakeBitmap(256, 256)
    lru.set('a', b1 as unknown as ImageBitmap, 256, 256)
    lru.set('b', b2 as unknown as ImageBitmap, 256, 256)
    // 访问 a，使 b 成为最旧
    expect(lru.get('a')).toBeTruthy()
    lru.set('c', b3 as unknown as ImageBitmap, 256, 256)
    expect(lru.has('b')).toBe(false)
    expect(b2.closed).toBe(true)
    expect(lru.has('a')).toBe(true)
    expect(lru.has('c')).toBe(true)
    expect(lru.sizeBytes).toBe(TILE_BYTES * 2)
  })

  it('单个位图超过预算：放入后也会立即被淘汰', () => {
    const lru = new BitmapLRU<string>(TILE_BYTES - 1)
    const b = new FakeBitmap(256, 256)
    lru.set('x', b as unknown as ImageBitmap, 256, 256)
    expect(lru.length).toBe(0)
    expect(b.closed).toBe(true)
  })

  it('setBudget 收缩预算会立即淘汰', () => {
    const lru = new BitmapLRU<string>(TILE_BYTES * 3)
    const bitmaps = [0, 1, 2].map((i) => {
      const b = new FakeBitmap(256, 256)
      lru.set(String(i), b as unknown as ImageBitmap, 256, 256)
      return b
    })
    lru.setBudget(TILE_BYTES)
    expect(lru.length).toBe(1)
    expect(bitmaps[0].closed).toBe(true)
    expect(bitmaps[1].closed).toBe(true)
    expect(bitmaps[2].closed).toBe(false)
  })
})

describe('DecodePool 并发与世代', () => {
  it('同时最多 4 个在解码，其余排队', () => {
    const dec = new ControllableDecoder()
    const pool = new DecodePool(dec, TILE_BYTES * 100)
    const keys = Array.from({ length: 10 }, (_, i) => ({
      key: key(1, i, 0),
      priority: i,
    }))
    pool.setDesiredTiles(keys)
    expect(pool.inflightCount).toBe(MAX_CONCURRENCY)
    expect(pool.queuedCount).toBe(6)
    pool.dispose()
  })

  it('按优先级出队，全部成功后进入缓存并通知', async () => {
    const dec = new ControllableDecoder()
    const settled: string[] = []
    const pool = new DecodePool(dec, TILE_BYTES * 100, MAX_CONCURRENCY, {
      onSettled: (k) => settled.push(k.file),
    })
    const keys = Array.from({ length: 6 }, (_, i) => ({
      key: key(1, i, 0, `p${5 - i}.png`),
      priority: 5 - i, // p0 的 priority 最小
    }))
    pool.setDesiredTiles(keys)
    // 前 4 个飞行中应是优先级最小的 p0..p3
    expect(dec.started.slice(0, 4).map((k) => k.file)).toEqual([
      'p0.png',
      'p1.png',
      'p2.png',
      'p3.png',
    ])
    // 排空：每完成一批飞行任务，池会启动排队中的后续任务
    for (let guard = 0; guard < 10 && dec.pendingCount > 0; guard++) {
      for (const p of [...dec.pending].filter((p) => !p.settled)) dec.resolve(p)
      await dec.flush()
    }
    expect(settled).toHaveLength(6)
    expect(pool.getBitmap(key(1, 0, 0, 'p5.png'))).toBeTruthy()
  })

  it('快速缩放后：旧层迟到的解码结果被丢弃，位图被释放，不覆盖当前画面', async () => {
    const dec = new ControllableDecoder()
    dec.ignoreAbortSignals = true // 模拟不可取消、迟到返回的解码器
    const settled: string[] = []
    const pool = new DecodePool(dec, TILE_BYTES * 100, MAX_CONCURRENCY, {
      onSettled: (k) => settled.push(`${k.level}/${k.x}/${k.y}`),
    })
    // 先请求粗层 0
    pool.setDesiredTiles([
      { key: key(0, 0, 0, 'coarse.png'), priority: 0 },
      { key: key(0, 1, 0, 'coarse2.png'), priority: 1 },
    ])
    const coarseJob = dec.find('coarse.png')!
    expect(coarseJob).toBeDefined()

    // 用户立刻放大，切换到层 1
    pool.setDesiredTiles([
      { key: key(1, 0, 0, 'fine.png'), priority: 0 },
      { key: key(1, 1, 0, 'fine2.png'), priority: 1 },
      { key: key(1, 2, 0, 'fine3.png'), priority: 2 },
      { key: key(1, 3, 0, 'fine4.png'), priority: 3 },
    ])
    // 旧任务已被 abort（即使解码器忽略，池侧也有世代防护）
    expect(coarseJob.signal.aborted).toBe(true)

    // 旧层解码“迟到”地返回成功结果：
    const lateBitmap = dec.resolve(coarseJob)
    await dec.flush()
    expect(settled).not.toContain('0/0/0')
    // 旧位图不应进入缓存，且必须被立即释放（close）
    expect(pool.getCache().has('0/0/0')).toBe(false)
    expect(lateBitmap.closed).toBe(true)

    // 新层任务完成 -> 正常入缓存
    for (const p of [...dec.pending].filter((p) => p.key.level === 1)) dec.resolve(p)
    await dec.flush()
    expect(settled).toContain('1/0/0')
    expect(pool.getCache().has('1/0/0')).toBe(true)
  })

  it('取消队列中不再需要的任务，空出并发槽', () => {
    const dec = new ControllableDecoder()
    const pool = new DecodePool(dec, TILE_BYTES * 100)
    pool.setDesiredTiles(
      Array.from({ length: 8 }, (_, i) => ({ key: key(0, i, 0, `a${i}.png`), priority: i })),
    )
    expect(pool.inflightCount).toBe(4)
    expect(pool.queuedCount).toBe(4)
    // 只要前两个飞行中的瓦片
    pool.setDesiredTiles([
      { key: key(0, 0, 0, 'a0.png'), priority: 0 },
      { key: key(0, 1, 0, 'a1.png'), priority: 1 },
    ])
    // 排队的 a4..a7 全部被移除；飞行中 a2/a3 被 abort
    expect(pool.queuedCount).toBe(0)
    const abortedFiles = dec.pending.filter((p) => p.signal.aborted).map((p) => p.key.file)
    expect(abortedFiles.sort()).toEqual(['a2.png', 'a3.png'])
  })

  it('缓存淘汰后再请求会重新解码', async () => {
    const dec = new ControllableDecoder()
    // 预算只够 1 块瓦片
    const pool = new DecodePool(dec, TILE_BYTES)
    pool.setDesiredTiles([{ key: key(0, 0, 0, 't0.png'), priority: 0 }])
    dec.resolve(dec.find('t0.png')!)
    await dec.flush()
    expect(pool.getCache().has('0/0/0')).toBe(true)

    pool.setDesiredTiles([{ key: key(0, 1, 0, 't1.png'), priority: 0 }])
    dec.resolve(dec.find('t1.png')!)
    await dec.flush()
    expect(pool.getCache().has('0/1/0')).toBe(true)
    expect(pool.getCache().has('0/0/0')).toBe(false) // t0 被淘汰释放

    pool.setDesiredTiles([{ key: key(0, 0, 0, 't0.png'), priority: 0 }])
    await dec.flush()
    // t0 重新发起了解码
    expect(dec.started.filter((k) => k.file === 't0.png')).toHaveLength(2)
  })

  it('解码完成顺序被打乱时，结果按各自 key 落位，不会张冠李戴', async () => {
    const dec = new ControllableDecoder()
    const settled: string[] = []
    const pool = new DecodePool(dec, TILE_BYTES * 100, MAX_CONCURRENCY, {
      onSettled: (k) => settled.push(k.file),
    })
    pool.setDesiredTiles(
      Array.from({ length: 6 }, (_, i) => ({
        key: key(1, i, 0, `tile${i}.png`),
        priority: i,
      })),
    )
    const byName = (n: string) => dec.find(n)!

    // 故意乱序兑现：先完成最后一个，再完成第一个……
    dec.resolve(byName('tile3.png'))
    await dec.flush()
    dec.resolve(byName('tile0.png'))
    await dec.flush()
    expect(pool.getCache().has('1/3/0')).toBe(true)
    expect(pool.getCache().has('1/0/0')).toBe(true)
    expect(pool.getCache().has('1/1/0')).toBe(false)
    // 每个位图必须能按正确 key 取回（位图内部不含 key，靠池落位）
    expect(pool.getBitmap(key(1, 3, 0, 'tile3.png'))).toBeTruthy()
    expect(pool.getBitmap(key(1, 0, 0, 'tile0.png'))).toBeTruthy()

    // 排空其余
    for (let guard = 0; guard < 10 && dec.pendingCount > 0; guard++) {
      const rest = [...dec.pending].filter((p) => !p.settled)
      // 逆序兑现
      rest.reverse().forEach((p) => dec.resolve(p))
      await dec.flush()
    }
    expect(settled.length).toBe(6)
    for (let i = 0; i < 6; i++) expect(pool.getCache().has(`1/${i}/0`)).toBe(true)
  })

  it('缺文件与解码失败通过 onError 报告为占位状态', async () => {
    const dec = new ControllableDecoder()
    dec.setFailMissing(true)
    const errors: Array<{ missing: boolean; file: string }> = []
    const pool = new DecodePool(dec, TILE_BYTES * 10, MAX_CONCURRENCY, {
      onError: (e) => errors.push({ missing: e.missing, file: e.key.file }),
    })
    pool.setDesiredTiles([{ key: key(0, 0, 0, 'miss:tile.png'), priority: 0 }])
    dec.resolve(dec.find('miss:tile.png')!)
    await dec.flush()
    expect(errors).toEqual([{ missing: true, file: 'miss:tile.png' }])
  })
})
