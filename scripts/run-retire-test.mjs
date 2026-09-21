// 知识退役替代端到端回归（fake-indexeddb + 真实 store）
// 覆盖：负责人发起退役（权限/替代文档/占用态校验）→ 管理员批准生效
// （退役标记 + 搜索/问答闸门 + 共享链接撤销 + 已解决缺口工单来源改指）→
// 替代文档不可访问时的申请引导判定 → 驳回 / 取消 → 撤销退役（引用恢复 +
// 链接与工单来源精确还原，记录保留）→ 批准时替代文档失效的并发校验。
// 运行：npm run test:retire
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useRetireStore } from '@/stores/retire'
import { useGapStore } from '@/stores/gap'
import { uid } from '@/utils/format'
import { RETIRE, isRetired } from '@/utils/retire'
import { canViewDoc } from '@/utils/permission'
import { canRequestAccess } from '@/utils/access'
import { shareStatus } from '@/utils/share'
import { GAP } from '@/utils/gap'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const retire = useRetireStore(pinia)
const gap = useGapStore(pinia)

const owner = { id: 'u-owner', name: '负责人', role: 'editor', avatar: 'FZ' }
const other = { id: 'u-other', name: '其他成员', role: 'editor', avatar: 'QT' }
const admin = { id: 'u-admin', name: '管理员', role: 'admin', avatar: 'GL' }
const viewer = { id: 'u-viewer', name: '只读', role: 'viewer', avatar: 'ZD' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const nowIso = () => new Date().toISOString()

await db.users.bulkAdd([owner, other, admin, viewer].map((u) => ({ ...u, email: '', title: '' })))

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '退役文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>正文</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: { title: '', body: '<p>正文</p>', categoryId: 'c', tagIds: [], visibility: 'public' } }],
    ...extra
  }
  d.versions[0].snapshot.title = d.title
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}
const getDoc = (id) => db.docs.get(id)
const getRet = (id) => db.retirements.get(id)

// ---------- 1. 发起校验 ----------
console.log('\n[1] 发起退役的权限与参数校验')
const d1 = await mkDoc()
const repl1 = await mkDoc({ title: '替代文档-1' })
let r = await retire.initiateRetire({ docId: d1.id, replacementId: repl1.id, reason: '' }, null)
assert(r.status === 'guest', '访客不能发起退役')
r = await retire.initiateRetire({ docId: d1.id, replacementId: repl1.id, reason: '' }, other)
assert(r.status === 'denied', '非负责人（且无管理员角色）不能退役他人文档')
r = await retire.initiateRetire({ docId: d1.id, replacementId: d1.id, reason: '' }, owner)
assert(r.status === 'bad-replacement' && r.reason === 'self', '替代文档不能是自身')
r = await retire.initiateRetire({ docId: d1.id, replacementId: 'doc-ghost', reason: '' }, owner)
assert(r.status === 'bad-replacement' && r.reason === 'missing', '替代文档必须存在')
const privateDoc = await mkDoc({ title: '他人私有文档', visibility: 'private', ownerId: other.id, editors: [other.id] })
r = await retire.initiateRetire({ docId: d1.id, replacementId: privateDoc.id, reason: '' }, owner)
assert(r.status === 'bad-replacement' && r.reason === 'no-access', '发起人不可见的文档不能作为替代')
r = await retire.initiateRetire({ docId: d1.id, replacementId: repl1.id, reason: '内容已合并' }, owner)
assert(r.status === 'ok' && r.retirement.status === RETIRE.PENDING, '负责人发起成功，进入待审批')
const ret1 = r.retirement
r = await retire.initiateRetire({ docId: d1.id, replacementId: repl1.id, reason: '' }, owner)
assert(r.status === 'duplicate', '同一文档已有待审批退役单时不可重复发起')
r = await retire.initiateRetire({ docId: repl1.id, replacementId: d1.id, reason: '' }, owner)
assert(r.status === 'bad-replacement' && r.reason === 'pending-retire', '替代文档有待审批退役单时不可互指')

// 评审中的文档不可发起退役
const d2 = await mkDoc()
await db.reviews.add({
  id: uid('rev'), docId: d2.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: d2.title, body: d2.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
})
await db.docs.update(d2.id, { publishState: PUBLISH.IN_REVIEW })
await kb.reloadDocs()
r = await retire.initiateRetire({ docId: d2.id, replacementId: repl1.id, reason: '' }, owner)
assert(r.status === 'in-review', '评审中的文档不可发起退役')

// ---------- 2. 取消与驳回 ----------
console.log('\n[2] 取消与驳回')
r = await retire.cancelRetire(ret1.id, other)
assert(r.status === 'denied', '非发起人非管理员不能取消')
r = await retire.cancelRetire(ret1.id, owner)
assert(r.status === 'ok' && r.retirement.status === RETIRE.CANCELLED, '发起人可取消待审批退役')
assert(!(await getDoc(d1.id)).retirement, '取消后文档无退役标记')

r = await retire.initiateRetire({ docId: d1.id, replacementId: repl1.id, reason: '再次申请' }, owner)
const ret2 = r.retirement
r = await retire.decideRetire(ret2.id, 'reject', '替代文档覆盖不全', owner)
assert(r.status === 'denied', '非管理员不能审批退役')
r = await retire.decideRetire(ret2.id, 'reject', '替代文档覆盖不全', admin)
assert(r.status === 'ok' && r.approved === false && r.retirement.status === RETIRE.REJECTED, '管理员驳回退役')
assert(!(await getDoc(d1.id)).retirement, '驳回后文档保持原状')
assert((await getRet(ret2.id)).decideNote.includes('覆盖不全'), '驳回备注留痕')

// ---------- 3. 批准生效：引用闸门 + 共享链接 + 工单来源 ----------
console.log('\n[3] 批准退役：搜索/问答闸门、共享链接撤销、工单答案来源改指')
const docA = await mkDoc({ title: '旧版部署手册' })
const replA = await mkDoc({ title: '新版部署手册' })
// 两条共享链接：一条有效（应被撤销）、一条此前已撤销（不应被动到）
const shareActive = { id: uid('share'), docId: docA.id, token: 'tok-active', permission: 'view', createdBy: owner.id, createdAt: nowIso(), expiresAt: null, revokedAt: null }
const shareOld = { id: uid('share'), docId: docA.id, token: 'tok-old', permission: 'edit', createdBy: owner.id, createdAt: nowIso(), expiresAt: null, revokedAt: nowIso() }
await db.shares.bulkAdd([shareActive, shareOld])
// 已解决缺口工单：答案来源指向 docA（应改指替代文档）；处理中工单不受影响
const ticketResolved = {
  id: uid('gap'), question: '如何部署服务？', detail: '', status: GAP.RESOLVED,
  createdBy: viewer.id, createdAt: nowIso(), claimedBy: owner.id, claimedAt: nowIso(),
  docId: docA.id, reviewId: null, groupId: null, resolvedAt: nowIso(),
  timeline: [{ action: 'create', by: viewer.id, note: '', at: nowIso() }]
}
const ticketOpen = {
  id: uid('gap'), question: '部署失败如何排查？', detail: '', status: GAP.CLAIMED,
  createdBy: viewer.id, createdAt: nowIso(), claimedBy: owner.id, claimedAt: nowIso(),
  docId: docA.id, reviewId: null, groupId: null, resolvedAt: null,
  timeline: [{ action: 'create', by: viewer.id, note: '', at: nowIso() }]
}
await db.gapTickets.bulkAdd([ticketResolved, ticketOpen])
await gap.reload()

r = await retire.initiateRetire({ docId: docA.id, replacementId: replA.id, reason: '全面换新' }, owner)
const ret3 = r.retirement
r = await retire.decideRetire(ret3.id, 'approve', '同意退役', admin)
assert(r.status === 'ok' && r.approved === true, '管理员批准，退役生效')
const docA1 = await getDoc(docA.id)
assert(isRetired(docA1) && docA1.retirement.retirementId === ret3.id, '文档打上退役标记（搜索/问答闸门关闭）')
assert(docA1.retirement.replacementId === replA.id, '退役标记记录替代文档')
assert(docA1.updatedAt === docA.updatedAt, '退役不改动正文与更新时间')
const sh1 = await db.shares.get(shareActive.id)
assert(shareStatus(sh1) === 'revoked' && sh1.revokeReason === 'retired' && sh1.retirementId === ret3.id, '有效共享链接被撤销并打退役标记')
const sh2 = await db.shares.get(shareOld.id)
assert(sh2.revokeReason !== 'retired', '此前已撤销的链接不被重复处理')
const t1 = await db.gapTickets.get(ticketResolved.id)
assert(t1.docId === replA.id && t1.timeline.some((t) => t.action === 'retire-repoint'), '已解决工单答案来源改指替代文档并留痕')
const t2 = await db.gapTickets.get(ticketOpen.id)
assert(t2.docId === docA.id && t2.status === GAP.CLAIMED, '未解决工单保持原状')
const ret3Done = await getRet(ret3.id)
assert(ret3Done.effect.revokedShareIds.length === 1 && ret3Done.effect.repointedTickets.length === 1, '处理结果随退役单留档（链接 1 条、工单 1 个）')
assert(ret3Done.timeline.some((t) => t.action === 'approve'), '退役单留有批准痕迹')

// 已退役文档不可再次发起；搜索/问答闸门判定
r = await retire.initiateRetire({ docId: docA.id, replacementId: repl1.id, reason: '' }, owner)
assert(r.status === 'already-retired', '已退役文档不可重复发起')
const searchHit = kb.docs.filter((d) => !isRetired(d) && d.id === docA.id)
assert(searchHit.length === 0, '搜索口径：已退役文档被排除')
assert(canViewDoc(docA1, viewer.id, null, null) === true, '已退役文档详情仍可直接阅读')

// ---------- 4. 替代文档不可访问 → 引导申请权限 ----------
console.log('\n[4] 替代文档不可访问时的申请引导')
const docB = await mkDoc({ title: '旧版薪酬说明', ownerId: other.id, editors: [other.id] })
const replPrivate = await mkDoc({ title: '新版薪酬说明（保密）', visibility: 'private', ownerId: other.id, editors: [other.id] })
// 替代文档可见性校验对管理员同样生效：不能指定发起者自己不可见的文档
r = await retire.initiateRetire({ docId: docB.id, replacementId: replPrivate.id, reason: '' }, admin)
assert(r.status === 'bad-replacement' && r.reason === 'no-access', '管理员也不能指定自己不可见的替代文档')
// 负责人（可见替代文档）发起 → 管理员批准
r = await retire.initiateRetire({ docId: docB.id, replacementId: replPrivate.id, reason: '换新' }, other)
assert(r.status === 'ok', '负责人发起成功（替代文档为受限文档）')
const ret4 = r.retirement
r = await retire.decideRetire(ret4.id, 'approve', '', admin)
assert(r.status === 'ok' && r.approved === true, '管理员批准，退役生效')
// 只读成员访问替代文档：不可见 → 引导申请访问权限
const replDoc = await getDoc(replPrivate.id)
assert(canViewDoc(replDoc, viewer.id, null, null) === false, '只读成员对受限替代文档不可见')
assert(canRequestAccess(replDoc, viewer.id, viewer.role) === true, '引导路径：只读成员可申请访问权限')
assert(canViewDoc(replDoc, other.id, null, null) === true, '替代文档拥有者不受影响')

// ---------- 5. 撤销退役：引用恢复 + 链接/工单来源还原 + 记录保留 ----------
console.log('\n[5] 撤销退役')
r = await retire.revokeRetire(ret3.id, '', other)
assert(r.status === 'denied', '非发起人非管理员不能撤销退役')
r = await retire.revokeRetire(ret3.id, '恢复使用', owner)
assert(r.status === 'ok' && r.retirement.status === RETIRE.REVOKED, '发起人撤销退役成功')
const docA2 = await getDoc(docA.id)
assert(!isRetired(docA2), '文档退役标记已撤下（恢复搜索/问答引用）')
const sh1r = await db.shares.get(shareActive.id)
assert(shareStatus(sh1r) === 'active' && !sh1r.revokeReason, '因退役撤销的共享链接被还原')
const t1r = await db.gapTickets.get(ticketResolved.id)
assert(t1r.docId === docA.id && t1r.timeline.some((t) => t.action === 'retire-restore'), '工单答案来源恢复为原文档并留痕')
const ret3Revoked = await getRet(ret3.id)
assert(ret3Revoked.status === RETIRE.REVOKED && ret3Revoked.revokeNote === '恢复使用', '退役单保留为已撤销记录')
assert(ret3Revoked.effect.restoredShares === 1 && ret3Revoked.effect.restoredTickets === 1, '还原结果随单留档')
assert(ret3Revoked.timeline.some((t) => t.action === 'initiate') && ret3Revoked.timeline.some((t) => t.action === 'approve') && ret3Revoked.timeline.some((t) => t.action === 'revoke'), '发起/批准/撤销全程留痕')
r = await retire.revokeRetire(ret3.id, '', owner)
assert(r.status === 'changed', '已撤销的退役单不可重复撤销')

// ---------- 6. 批准时替代文档失效的并发校验 ----------
console.log('\n[6] 批准时替代文档失效')
const docC = await mkDoc()
const replC = await mkDoc()
r = await retire.initiateRetire({ docId: docC.id, replacementId: replC.id, reason: '' }, owner)
const ret6 = r.retirement
await db.docs.delete(replC.id) // 审批期间替代文档被删除
await kb.reloadDocs()
r = await retire.decideRetire(ret6.id, 'approve', '', admin)
assert(r.status === 'replacement-missing', '替代文档被删除时批准失败')
assert((await getRet(ret6.id)).status === RETIRE.PENDING, '退役单保持待审批，可驳回或取消')
assert(!(await getDoc(docC.id)).retirement, '文档未打退役标记')

const docD = await mkDoc()
const replD = await mkDoc()
r = await retire.initiateRetire({ docId: docD.id, replacementId: replD.id, reason: '' }, owner)
const ret7 = r.retirement
// 审批期间替代文档自身被退役
await db.docs.update(replD.id, { retirement: { retirementId: 'ret-x', replacementId: docD.id, reason: '', by: admin.id, at: nowIso() } })
await kb.reloadDocs()
r = await retire.decideRetire(ret7.id, 'approve', '', admin)
assert(r.status === 'replacement-retired', '替代文档自身已退役时批准失败')
assert(!(await getDoc(docD.id)).retirement, '文档仍未退役')

// ---------- 7. 孤儿单自愈 ----------
console.log('\n[7] 文档删除后待审批退役单自动取消')
const docE = await mkDoc()
const replE = await mkDoc()
r = await retire.initiateRetire({ docId: docE.id, replacementId: replE.id, reason: '' }, owner)
const ret8 = r.retirement
await db.docs.delete(docE.id)
await kb.reloadDocs()
// 模拟重新加载触发自愈
retire.loaded = false
await retire.loadAll()
const ret8After = await getRet(ret8.id)
assert(ret8After.status === RETIRE.CANCELLED && ret8After.timeline.some((t) => t.action === 'auto_cancel'), '文档已删除的待审批单自动取消并留痕')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
