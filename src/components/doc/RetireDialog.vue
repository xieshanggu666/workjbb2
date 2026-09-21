<script setup>
import { ref, computed, watch } from 'vue'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useAccessStore } from '@/stores/access'
import { useRetireStore } from '@/stores/retire'
import { canViewDoc } from '@/utils/permission'
import { isRetired } from '@/utils/retire'

// 发起文档退役：指定替代文档与退役原因，提交后进入管理员审批。
// 替代文档候选：当前用户可见、未退役、无流转中退役单、且不是本文档。
const props = defineProps({ open: Boolean, doc: Object })
const emit = defineEmits(['close', 'done'])

const kb = useKbStore()
const auth = useAuthStore()
const accessStore = useAccessStore()
const retireStore = useRetireStore()

const replacementId = ref('')
const reason = ref('')
const busy = ref(false)
const error = ref('')

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))

// 候选替代文档：可见 + 非本文档 + 未退役 + 无待审批退役单
const candidates = computed(() =>
  kb.docs
    .filter((d) => d.id !== props.doc?.id)
    .filter((d) => !isRetired(d))
    .filter((d) => !retireStore.pendingOf(d.id))
    .filter((d) => canViewDoc(d, auth.user?.id, null, accessStore.grantOf(d.id, auth.user?.id)))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

function reset() {
  replacementId.value = ''
  reason.value = ''
  error.value = ''
  busy.value = false
}

async function submit() {
  if (busy.value) return
  if (!replacementId.value) { error.value = '请选择替代文档'; return }
  busy.value = true
  error.value = ''
  try {
    const res = await retireStore.initiateRetire(
      { docId: props.doc.id, replacementId: replacementId.value, reason: reason.value.trim() },
      auth.user
    )
    if (res.status === 'ok') {
      emit('done', res.retirement)
      emit('close')
      return
    }
    if (res.status === 'bad-replacement') {
      error.value = {
        self: '替代文档不能是本文档自身',
        missing: '替代文档不存在或已被删除',
        retired: '替代文档本身已退役，请另选文档',
        'pending-retire': '替代文档也有退役申请在审批中，请另选文档',
        'no-access': '你对该替代文档没有访问权限，请另选文档'
      }[res.reason] || '替代文档不可用，请另选文档'
    } else if (res.status === 'duplicate') {
      error.value = '该文档已有待审批的退役申请'
    } else if (res.status === 'in-review') {
      error.value = '文档正在评审中，请待评审完结后再发起退役'
    } else if (res.status === 'in-handover') {
      error.value = '文档正在责任交接中，请待交接完结后再发起退役'
    } else if (res.status === 'already-retired') {
      error.value = '文档已处于退役状态'
    } else if (res.status === 'guest') {
      error.value = '请先登录后再发起退役'
    } else if (res.status === 'denied') {
      error.value = '仅文档负责人或管理员可发起退役'
    } else {
      error.value = '发起失败，请稍后重试'
    }
  } finally {
    busy.value = false
  }
}

watch(() => props.open, (v) => { if (v) reset() })
</script>

<template>
  <teleport to="body">
    <div v-if="open" class="mask" @click.self="emit('close')">
      <div class="dialog" @click.stop>
        <div class="dialog-head">
          <h3>🪦 发起文档退役</h3>
          <button class="x" @click="emit('close')">✕</button>
        </div>

        <div class="retire-doc">
          退役文档：<b>《{{ doc?.title }}》</b>
        </div>
        <p class="hint">
          管理员批准后，本文档将退出<b>全局搜索</b>与<b>智能问答引用</b>，仍有效的共享链接会被撤销，
          已解决缺口工单的答案来源将改指替代文档；详情页保留并引导读者前往替代文档。退役可随时撤销并全程留痕。
        </p>

        <div class="f-row">
          <label class="f-k">替代文档</label>
          <select v-model="replacementId" class="f-sel">
            <option value="" disabled>选择接替本文档的文档</option>
            <option v-for="d in candidates" :key="d.id" :value="d.id">{{ d.title }}</option>
          </select>
        </div>
        <div v-if="replacementId && docById[replacementId]" class="repl-preview">
          读者将被引导至：《{{ docById[replacementId].title }}》
        </div>
        <div class="f-row col">
          <label class="f-k">退役原因</label>
          <textarea v-model="reason" rows="3" maxlength="300" placeholder="说明退役背景（将写入退役记录，并向读者展示）"></textarea>
        </div>

        <div v-if="error" class="err">{{ error }}</div>

        <div class="acts">
          <button class="btn ghost" @click="emit('close')">取消</button>
          <button class="btn primary" :disabled="busy || !replacementId" @click="submit">
            {{ busy ? '提交中…' : '提交退役申请' }}
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(15, 20, 30, 0.45); display: grid; place-items: center; z-index: 100; }
.dialog { width: 520px; max-width: 92vw; background: #fff; border-radius: 14px; padding: 20px 24px; box-shadow: var(--shadow); }
.dialog-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.dialog-head h3 { margin: 0; }
.x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--text-3); }
.retire-doc { font-size: 14px; margin-bottom: 8px; }
.hint { color: var(--text-3); font-size: 12px; line-height: 1.7; margin: 0 0 14px; }
.f-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.f-row.col { flex-direction: column; align-items: stretch; }
.f-k { font-size: 13px; color: var(--text-2); width: 64px; flex-shrink: 0; }
.f-row.col .f-k { width: auto; }
.f-sel { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 13px; background: #fff; outline: none; }
.f-sel:focus { border-color: var(--primary); }
.repl-preview { margin: -4px 0 10px 74px; font-size: 12px; color: var(--primary); }
textarea { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
textarea:focus { border-color: var(--primary); }
.err { color: var(--danger); font-size: 13px; margin: 4px 0 10px; }
.acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
</style>
