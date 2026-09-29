<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import WorkbenchCanvas from './WorkbenchCanvas.vue'
import { parseManifest } from './core/manifest'
import type { CanvasStatus, ResolvedManifest, ValidationIssue } from './core/types'
import { FileTileSource, type TileSource } from './core/tileSource'
import { exportSelectionJSON, type ImageSelection } from './core/selection'

// 默认 128 MB 位图缓存上限（估算 RGBA 字节）
const DEFAULT_BUDGET = 128 * 1024 * 1024
const byteBudget = ref(DEFAULT_BUDGET)

const manifest = shallowRef<ResolvedManifest | null>(null)
const source = shallowRef<TileSource | null>(null)
const issues = ref<ValidationIssue[]>([])
const importedName = ref('')
const fileCount = ref(0)
// 每次导入 manifest 或重新选择瓦片文件都递增，强制重建画布（池持有 source 引用）
const sessionNonce = ref(0)

const mode = ref<'pan' | 'select'>('pan')
const status = ref<CanvasStatus | null>(null)
const toast = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined

const currentSelection = ref<ImageSelection | null>(null)
const exportText = ref('')

const errors = computed(() => issues.value.filter((i) => i.severity === 'error'))
const warnings = computed(() => issues.value.filter((i) => i.severity === 'warning'))

function showToast(msg: string): void {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 3500)
}

async function onManifestPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importedName.value = file.name
  const text = await file.text()
  const result = parseManifest(text)
  issues.value = result.issues
  if (result.manifest) {
    manifest.value = result.manifest
    source.value = null
    fileCount.value = 0
    currentSelection.value = null
    exportText.value = ''
    sessionNonce.value++
    showToast(`清单已校验：${result.manifest.maxLevel + 1} 个层级，请选择瓦片文件目录`)
  } else {
    manifest.value = null
    source.value = null
  }
  input.value = ''
}

async function onTilesPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return
  if (!manifest.value) {
    showToast('请先选择并通过校验的 manifest')
    return
  }
  const src = new FileTileSource(files)
  fileCount.value = src.size
  source.value = src
  sessionNonce.value++
  showToast(`已载入 ${src.size} 个本地文件（不会上传）`)
  input.value = ''
}

/** 引用了但未选中的瓦片文件名 */
const missingFiles = computed<string[]>(() => {
  if (!manifest.value || !source.value) return []
  const set = new Set<string>()
  for (const lv of manifest.value.levels.values()) {
    for (const t of lv.tiles.values()) {
      if (!(source.value as FileTileSource).hasFile(t.file)) set.add(t.file)
    }
  }
  return [...set].sort()
})

function onSelection(sel: ImageSelection): void {
  currentSelection.value = sel
  exportText.value = exportSelectionJSON(sel, manifest.value!.width, manifest.value!.height)
}

function onStatus(s: CanvasStatus): void {
  status.value = s
}

function onCanvasError(msg: string): void {
  showToast(msg)
}

function downloadExport(): void {
  if (!exportText.value) return
  const blob = new Blob([exportText.value], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'selection.json'
  a.click()
  URL.revokeObjectURL(url)
}

async function copyExport(): Promise<void> {
  if (!exportText.value) return
  await navigator.clipboard.writeText(exportText.value)
  showToast('原图坐标 JSON 已复制到剪贴板')
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// nonce 变化时强制重建画布组件，确保池/板/错误状态干净
const sessionKey = computed(() => `${sessionNonce.value}`)
</script>

<template>
  <header class="topbar">
    <div class="brand">🧩 图像工作台 <span class="sub">多分辨率瓦片 · 本地浏览 · 原图坐标导出</span></div>
    <div class="imports">
      <label class="file-btn">
        ① 选择 manifest
        <input type="file" accept=".json,application/json" @change="onManifestPicked" />
      </label>
      <label class="file-btn" :class="{ disabled: !manifest }">
        ② 选择瓦片文件（可多选/目录）
        <input
          type="file"
          accept="image/*"
          multiple
          webkitdirectory
          @change="onTilesPicked"
        />
      </label>
      <label class="file-btn" :class="{ disabled: !manifest }">
        ②′ 或多选图片
        <input type="file" accept="image/*" multiple @change="onTilesPicked" />
      </label>
    </div>
    <div class="modes">
      <button :class="{ primary: mode === 'pan' }" @click="mode = 'pan'">✋ 平移</button>
      <button :class="{ primary: mode === 'select' }" @click="mode = 'select'">▱ 框选</button>
    </div>
  </header>

  <div class="body">
    <aside class="sidebar">
      <section v-if="!manifest">
        <h3>开始</h3>
        <p class="hint">
          文件仅在浏览器本地读取，<b>不会上传</b>。<br />
          manifest 为 JSON，瓦片为 256×256（右/下边缘可不足）。
        </p>
        <details>
          <summary>manifest 示例</summary>
          <pre class="sample">{
  "width": 1024,
  "height": 600,
  "levels": [
    {
      "level": 0,
      "width": 512, "height": 300,
      "tiles": [
        { "x": 0, "y": 0, "file": "L0_0_0.png" }
      ]
    },
    { "level": 1, "width": 1024, "height": 600,
      "tiles": [
        { "x": 0, "y": 0, "file": "L1_0_0.png" }
      ]
    }
  ]
}</pre>
        </details>
      </section>

      <section v-else>
        <h3>数据集</h3>
        <div class="kv"><span>manifest</span><b :title="importedName">{{ importedName }}</b></div>
        <div class="kv"><span>原图</span><b>{{ manifest.width }} × {{ manifest.height }}</b></div>
        <div class="kv"><span>层级数</span><b>{{ manifest.maxLevel + 1 }}</b></div>
        <div class="kv"><span>瓦片大小</span><b>{{ manifest.tileSize }} px</b></div>
        <div class="kv"><span>已选文件</span><b>{{ fileCount }}</b></div>

        <h3>校验</h3>
        <div v-if="errors.length" class="issue-block bad">
          <div v-for="(i, n) in errors" :key="'e' + n" class="issue">✗ {{ i.message }}</div>
        </div>
        <div v-if="warnings.length" class="issue-block warn">
          <div v-for="(i, n) in warnings.slice(0, 12)" :key="'w' + n" class="issue">
            ⚠ {{ i.message }}
          </div>
          <div v-if="warnings.length > 12" class="issue">…另有 {{ warnings.length - 12 }} 条</div>
        </div>
        <div v-if="!errors.length && !warnings.length" class="ok">✓ 校验通过</div>

        <template v-if="source">
          <h3>缺失文件（占位显示）</h3>
          <div v-if="missingFiles.length" class="missing-list">
            <div v-for="f in missingFiles.slice(0, 20)" :key="f" class="missing-file">▫ {{ f }}</div>
            <div v-if="missingFiles.length > 20">…另有 {{ missingFiles.length - 20 }} 个</div>
          </div>
          <div v-else class="ok">✓ manifest 引用文件均已提供</div>

          <h3>内存缓存上限</h3>
          <div class="budget-row">
            <input
              v-model.number="byteBudget"
              type="range"
              :min="8 * 1024 * 1024"
              :max="512 * 1024 * 1024"
              :step="8 * 1024 * 1024"
            />
            <div class="kv"><span>上限</span><b>{{ fmtBytes(byteBudget) }}</b></div>
            <div class="kv" v-if="status">
              <span>已用</span>
              <b :class="{ hot: status.cacheBytes > byteBudget * 0.9 }">
                {{ fmtBytes(status.cacheBytes) }}（{{ status.cached }} 块）
              </b>
            </div>
          </div>
        </template>
      </section>
    </aside>

    <main class="stage">
      <WorkbenchCanvas
        v-if="manifest && source"
        :key="sessionKey"
        :manifest="manifest"
        :source="source"
        :byte-budget="byteBudget"
        :mode="mode"
        @selection="onSelection"
        @status="onStatus"
        @error="onCanvasError"
      />
      <div v-else class="empty-stage">
        <div class="empty-card">
          <div class="big">🖼</div>
          <p>先在顶部选择 <b>manifest</b>，再选择其引用的<b>本地瓦片文件</b>。</p>
          <p class="dim">所有处理在本机完成，文件不离开浏览器。</p>
          <div v-if="errors.length" class="issue-block bad left">
            <div v-for="(i, n) in errors" :key="n" class="issue">✗ {{ i.message }}</div>
          </div>
        </div>
      </div>

      <div v-if="manifest && source && status" class="hud">
        <span>层级 L{{ status.level }}/{{ manifest.maxLevel }}</span>
        <span>缩放 {{ status.scale.toFixed(3) }}×</span>
        <span v-if="status.loading" class="loading-dot">解码中 {{ status.loading }}</span>
        <span v-if="status.missing" class="warn-text">缺失 {{ status.missing }}</span>
        <span v-if="status.errors" class="bad-text">错误 {{ status.errors }}</span>
        <span class="dim">滚轮缩放（鼠标锚点）· 拖动平移 · Shift+拖动 或框选模式导出</span>
      </div>
    </main>

    <aside class="sidebar right" :class="{ disabled: !currentSelection }">
      <section>
        <h3>框选导出（原图坐标）</h3>
        <template v-if="currentSelection">
          <div class="kv"><span>x</span><b>{{ Math.round(currentSelection.x) }}</b></div>
          <div class="kv"><span>y</span><b>{{ Math.round(currentSelection.y) }}</b></div>
          <div class="kv"><span>width</span><b>{{ Math.round(currentSelection.width) }}</b></div>
          <div class="kv"><span>height</span><b>{{ Math.round(currentSelection.height) }}</b></div>
          <pre class="export-json">{{ exportText }}</pre>
          <div class="export-actions">
            <button class="primary" @click="downloadExport">下载 JSON</button>
            <button @click="copyExport">复制</button>
          </div>
        </template>
        <p v-else class="hint">
          切换到“框选”模式（或按住 Shift 拖动），在画面上拉出矩形，
          这里即输出映射到原图坐标的 JSON。
        </p>
      </section>
    </aside>
  </div>

  <transition name="fade">
    <div v-if="toast" class="toast">{{ toast }}</div>
  </transition>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.brand {
  font-weight: 600;
}
.brand .sub {
  font-weight: 400;
  color: var(--text-dim);
  font-size: 12px;
  margin-left: 8px;
}
.imports {
  display: flex;
  gap: 8px;
}
.file-btn {
  position: relative;
  font-size: 13px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  cursor: pointer;
}
.file-btn:hover {
  border-color: var(--accent);
}
.file-btn.disabled {
  opacity: 0.45;
  pointer-events: none;
}
.file-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.modes {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.sidebar {
  width: 300px;
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 14px;
  overflow-y: auto;
}
.sidebar.right {
  border-right: none;
  border-left: 1px solid var(--border);
}
.sidebar h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin: 16px 0 8px;
}
.sidebar h3:first-child {
  margin-top: 0;
}
.kv {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding: 3px 0;
}
.kv span {
  color: var(--text-dim);
}
.hint {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-dim);
}
.sample {
  font-size: 11px;
  background: #16171b;
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
}
.issue-block {
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 8px;
}
.issue-block.bad {
  background: rgba(255, 107, 107, 0.1);
  border: 1px solid rgba(255, 107, 107, 0.35);
}
.issue-block.warn {
  background: rgba(224, 168, 61, 0.08);
  border: 1px solid rgba(224, 168, 61, 0.3);
}
.issue-block.left {
  text-align: left;
}
.ok {
  color: #6fcf97;
  font-size: 13px;
}
.missing-list {
  font-size: 12px;
  color: var(--warn);
  line-height: 1.6;
  max-height: 180px;
  overflow-y: auto;
}
.budget-row input {
  width: 100%;
}
.hot {
  color: var(--warn);
}

.stage {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
}
.empty-stage {
  flex: 1;
  display: grid;
  place-items: center;
}
.empty-card {
  text-align: center;
  color: var(--text-dim);
  max-width: 440px;
}
.empty-card .big {
  font-size: 56px;
}
.dim {
  color: var(--text-dim);
  font-size: 12px;
}

.hud {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: flex;
  gap: 14px;
  align-items: center;
  background: rgba(20, 21, 26, 0.85);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 12px;
  pointer-events: none;
}
.loading-dot {
  color: var(--accent);
}
.warn-text {
  color: var(--warn);
}
.bad-text {
  color: var(--danger);
}

.export-json {
  background: #16171b;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font-size: 11px;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.export-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.sidebar.right.disabled {
  opacity: 0.85;
}

.toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: #11131a;
  border: 1px solid var(--accent);
  padding: 10px 18px;
  border-radius: 8px;
  font-size: 13px;
  z-index: 10;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
