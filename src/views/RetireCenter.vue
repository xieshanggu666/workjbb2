<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useRetireStore } from '@/stores/retire'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull } from '@/utils/format'
import {
  RETIRE, retireStatusLabel, retireStatusCls, retireTimelineLabel,
  canDecideRetire, canCancelRetire, canRevokeRetire
} from '@/utils/retire'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const retireStore = useRetireStore()

const tab = ref('approve') // approve | mine | all
const busyId = ref('')
const noteMap = ref({})

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

const approveList = computed(() =>
  auth.user?.role === 'admin' ? retireStore.sorted.filter((r) => r.status === RETIRE.PENDING) : []
)
const mineList = computed(() => retireStore.initiatedBy(auth.user?.id))
const allList = computed(() => retireStore.sorted)
const list = computed(() => {
  if (tab.value === 'approve') return approveList.value
  if (tab.value === 'mine') return mineList.value
  return allList.value
})
const counts = computed(() => ({
  approve: approveList.value.length,
  mine: mineList.value.length,
  all: allList.value.length
}))

function docTitle(id) {
  return docById.value[id]?.title || '文档已删除'
}

// 批准生效时的处理结果摘要（已退役/已撤销单）
function effectText(r) {
  const e = r.effect
  if (!e) return ''
  const parts = []
  parts.push('撤销共享链接 ' + (e.revokedShareIds?.length || 0) + ' 条')
  parts.push('迁移工单答案来源 ' + (e.repointedTickets?.length || 0) + ' 个')
  if (r.status === RETIRE.REVOKED) {
    parts.push('撤销退役时已还原链接 ' + (e.restoredShares || 0) + ' 条、工单来源 ' + (e.restoredTickets || 0) + ' 个')
  }
  return parts.join(' · ')
}

async function decide(r, decision) {
  if (busyId.value) return
  busyId.value = r.id
  try {
    const res = await retireStore.decideRetire(r.id, decision, (noteMap.value[r.id] || '').trim(), auth.user)
    if (res.status === 'replacement-missing') {
      alert('批准失败：替代文档已被删除，请驳回该申请并通知发起人重新指定。')
    } else if (res.status === 'replacement-retired') {
      alert('批准失败：替代文档自身也已退役，请驳回该申请并通知发起人重新指定。')
    } else if (res.status === 'doc-missing') {
      alert('批准失败：文档已被删除。')
    } else if (res.status !== 'ok') {
      alert('操作失败：退役单状态已变化，请刷新后重试。')
    }
  } finally {
    busyId.value = ''
  }
}

async function cancel(r) {
  if (!confirm('确定取消本次退役申请？文档保持原状。')) return
  const res = await retireStore.cancelRetire(r.id, auth.user)
  if (res.status !== 'ok') alert('操作失败：退役单状态已变化')
}

async function revoke(r) {
  if (busyId.value) return
  if (!confirm('确定撤销退役？文档将恢复搜索与问答引用，被退役撤销的共享链接与工单答案来源将同步还原。')) return
  busyId.value = r.id
  try {
    const res = await retireStore.revokeRetire(r.id, (noteMap.value[r.id] || '').trim(), auth.user)
    if (res.status === 'doc-missing') {
      alert('撤销失败：文档已被删除，无可恢复对象。')
    } else if (res.status === 'denied') {
      alert('仅退役发起人或管理员可撤销退役。')
    } else if (res.status !== 'ok') {
      alert('操作失败：退役单状态已变化，请刷新后重试。')
    }
  } finally {
    busyId.value = ''
  }
}

onMounted(async () => {
  await Promise.all([kb.loadAll(), auth.loadUsers(), retireStore.loadAll()])
  if (approveList.value.length) tab.value = 'approve'
  else if (mineList.value.length) tab.value = 'mine'
  else tab.value = 'all'
})
</script>

<template>
  <div class="ret-page">
    <header class="head">
      <h2>🪦 知识退役</h2>
      <p class="sub">
        负责人在文档详情页发起退役并指定替代文档，管理员批准后：旧文档退出全局搜索与智能问答引用、
        共享链接同步撤销、已解决缺口工单的答案来源改指替代文档；读者访问旧文档时会被引导至替代文档
        （无权限时引导申请访问）。已退役可随时撤销，引用、共享链接与工单来源同步还原，记录全程保留。
      </p>
      <div class="head-row">
        <div class="tabs">
          <button v-if="auth.user?.role === 'admin'" :class="{ on: tab === 'approve' }" @click="tab = 'approve'">待审批 <em>{{ counts.approve }}</em></button>
          <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我发起的 <em>{{ counts.mine }}</em></button>
          <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部记录 <em>{{ counts.all }}</em></button>
        </div>
      </div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🪦</div>
      {{ tab === 'approve' ? '暂无待审批的退役申请' : tab === 'mine' ? '你还没有发起过退役，可在文档详情页发起' : '暂无退役记录' }}
    </div>

    <div v-else class="ret-list">
      <div v-for="r in list" :key="r.id" class="ret card">
        <div class="ret-top">
          <div class="ret-main">
            <span class="ret-flow">
              <span class="ret-doc" @click="docById[r.docId] && router.push('/docs/' + r.docId)">《{{ docTitle(r.docId) }}》</span>
              <span class="arrow">退役 → 替代</span>
              <span class="ret-doc repl" @click="docById[r.replacementId] && router.push('/docs/' + r.replacementId)">《{{ docTitle(r.replacementId) }}》</span>
            </span>
          </div>
          <div class="ret-side">
            <span class="st" :class="retireStatusCls(r.status)">{{ retireStatusLabel(r.status) }}</span>
            <span class="ret-time">{{ formatDate(r.createdAt) }}</span>
          </div>
        </div>

        <div class="ret-docs">
          <div class="rd">
            <span class="rd-k">退役文档</span>
            <DocPill v-if="docById[r.docId]" :doc="docById[r.docId]" />
            <span v-else class="rd-missing">文档已删除</span>
          </div>
          <div class="rd">
            <span class="rd-k">替代文档</span>
            <DocPill v-if="docById[r.replacementId]" :doc="docById[r.replacementId]" />
            <span v-else class="rd-missing">替代文档已删除</span>
          </div>
        </div>

        <p v-if="r.reason" class="note">退役原因：“{{ r.reason }}”</p>

        <div class="ret-info">
          <span class="dim">{{ userName(r.initiatedBy) }} 发起</span>
          <span v-if="r.decidedAt" class="dim">{{ userName(r.decidedBy) }} 于 {{ formatDate(r.decidedAt) }} 审批</span>
          <span v-if="r.revokedAt" class="dim">{{ userName(r.revokedBy) }} 于 {{ formatDate(r.revokedAt) }} 撤销退役</span>
        </div>
        <p v-if="r.decideNote" class="dnote">审批备注：“{{ r.decideNote }}”</p>
        <p v-if="effectText(r)" class="effect">🔄 {{ effectText(r) }}</p>
        <p v-if="r.status === RETIRE.REVOKED && r.revokeNote" class="dnote">撤销备注：“{{ r.revokeNote }}”</p>

        <!-- 管理员审批 -->
        <div v-if="canDecideRetire(r, auth.user?.id, auth.user?.role)" class="decide-box">
          <input v-model="noteMap[r.id]" class="note-in" placeholder="审批备注（可选，将写入退役记录）" />
          <div class="decide-actions">
            <button class="btn sm" :disabled="busyId === r.id" @click="decide(r, 'reject')">✕ 驳回</button>
            <button class="btn sm ok-solid" :disabled="busyId === r.id" @click="decide(r, 'approve')">✓ 批准退役</button>
          </div>
        </div>

        <!-- 发起人 / 管理员取消待审批申请 -->
        <div v-if="canCancelRetire(r, auth.user?.id, auth.user?.role)" class="row-actions">
          <button class="btn sm ghost" @click="cancel(r)">取消退役申请</button>
        </div>

        <!-- 撤销退役：恢复引用并还原共享链接/工单来源 -->
        <div v-if="canRevokeRetire(r, auth.user?.id, auth.user?.role)" class="decide-box">
          <input v-model="noteMap[r.id]" class="note-in" placeholder="撤销备注（可选，将写入退役记录）" />
          <div class="decide-actions">
            <button class="btn sm" :disabled="busyId === r.id" @click="revoke(r)">↩ 撤销退役</button>
          </div>
        </div>

        <details class="timeline">
          <summary>查看退役记录（{{ (r.timeline || []).length }}）</summary>
          <div v-for="(t, i) in r.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ retireTimelineLabel(t.action) }}</span>
            <span class="tl-who">{{ userName(t.by) }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ret-page { max-width: 900px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.head-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }

.ret-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.ret { padding: 16px 20px; }
.ret-top { display: flex; justify-content: space-between; gap: 14px; }
.ret-main { min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ret-flow { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; flex-wrap: wrap; }
.ret-flow .arrow { color: var(--text-3); font-weight: 400; font-size: 12px; }
.ret-doc { cursor: pointer; }
.ret-doc:hover { color: var(--primary); }
.ret-doc.repl { color: #15803d; }
.ret-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-retired { background: #e2e8f0; color: #475569; }
.st-wait { background: var(--primary-weak); color: var(--primary); }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.ret-time { color: var(--text-3); font-size: 12px; }

.ret-docs { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.rd { display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: var(--panel-2); }
.rd-k { font-size: 12px; color: var(--text-3); width: 56px; flex-shrink: 0; }
.rd-missing { font-size: 13px; color: var(--text-3); }

.note { margin: 10px 0 0; font-size: 13px; color: var(--text-2); }
.ret-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 13px; }
.dim { color: var(--text-3); font-size: 12px; }
.dnote { margin: 6px 0 0; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.effect { margin: 8px 0 0; font-size: 12.5px; color: #0e7490; background: #ecfeff; border: 1px solid #a5f3fc; border-radius: 8px; padding: 8px 12px; }

.decide-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.note-in { flex: 1; min-width: 200px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; outline: none; }
.note-in:focus { border-color: var(--primary); }
.decide-actions { display: flex; gap: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.row-actions { margin-top: 10px; }

.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 170px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
