import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry, REVIEW } from '@/utils/review'
import { GAP } from '@/utils/gap'
import { isGrantActive } from '@/utils/access'
import { canViewDoc, GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { RETIRE, isRetireOpen, canInitiateRetire } from '@/utils/retire'
import { isHandoverOpen } from '@/utils/handover'
import { useKbStore } from './kb'

// 知识退役替代 store：
// 负责人发起文档退役并指定替代文档（pending）→ 管理员批准后在同一事务内统一生效：
// - 引用闸门：doc.retirement 打上退役标记，搜索与智能问答不再命中/引用该文档；
// - 共享链接：文档上仍有效的共享链接逐条撤销（revokeReason='retired' 标记，撤销退役时据此还原）；
// - 缺口工单：已解决工单的答案来源改指替代文档并留痕（撤销退役时按 effect 记录还原）。
// 发起人/管理员可取消待审批的退役；已退役可撤销（revoked），引用、链接、工单来源同步恢复，
// 退役单与 timeline 全程保留。批准执行时事务内复核文档/替代文档状态，不一致即失败不写入。
export const useRetireStore = defineStore('retire', () => {
  const retirements = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
    // 首次加载时自愈「文档已删除但退役单仍待审批」的历史单
    await reconcileOrphans()
  }

  async function reload() {
    retirements.value = await db.retirements.toArray()
  }

  const sorted = computed(() =>
    [...retirements.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  function byId(id) {
    return retirements.value.find((r) => r.id === id) || null
  }

  // 文档当前待审批的退役单（同一文档同时只允许一个流转中退役单）
  function pendingOf(docId) {
    return retirements.value.find((r) => r.docId === docId && isRetireOpen(r)) || null
  }

  // 文档当前生效的退役单（与 doc.retirement.retirementId 对应）
  function activeOf(docId) {
    return retirements.value.find((r) => r.docId === docId && r.status === RETIRE.APPROVED) || null
  }

  // 我发起的
  function initiatedBy(userId) {
    return sorted.value.filter((r) => r.initiatedBy === userId)
  }

  // 侧栏角标：待管理员审批的退役单数
  function pendingCountFor(role) {
    if (role !== ROLE.ADMIN) return 0
    return retirements.value.filter((r) => isRetireOpen(r)).length
  }

  // 事务内查询用户在文档上的有效限时授权（替代文档可见性判定与详情页同一口径）
  async function findActiveGrant(docId, userId) {
    if (!userId || userId === GUEST_ID) return null
    const reqs = await db.accessRequests
      .where('docId').equals(docId)
      .filter((r) => r.applicantId === userId).toArray()
    return reqs.find((r) => isGrantActive(r)) || null
  }

  // 负责人发起退役：指定替代文档与退役原因。
  // 返回 { status: 'ok', retirement } | 'guest' | 'missing' | 'denied' | 'already-retired'
  //      | 'duplicate' | 'in-review' | 'in-handover' | 'bad-replacement'（reason 细分原因）
  async function initiateRetire({ docId, replacementId, reason }, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    if (isGuestUser(userId)) return { status: 'guest' }
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.retirements, db.reviews, db.handovers, db.accessRequests, async () => {
      // 事务内重读：归属与占用态以库中最新数据为准，防止多窗口并发发起
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (!canInitiateRetire(doc, userId, role)) {
        result = { status: doc.retirement ? 'already-retired' : 'denied' }
        return
      }
      const dup = await db.retirements
        .where('docId').equals(docId)
        .filter((r) => isRetireOpen(r)).first()
      if (dup) { result = { status: 'duplicate', retirement: dup }; return }
      // 评审中/交接中的文档先完结对应流程再退役，避免状态交错
      const pendingReview = await db.reviews
        .where('docId').equals(docId)
        .filter((rv) => rv.status === REVIEW.PENDING).first()
      if (pendingReview) { result = { status: 'in-review', review: pendingReview }; return }
      const openHandover = await db.handovers
        .filter((h) => isHandoverOpen(h) && (h.docIds || []).includes(docId)).first()
      if (openHandover) { result = { status: 'in-handover', handover: openHandover }; return }

      // 替代文档校验：必须存在、不是自身、未退役、无流转中退役单，且发起人可见
      // （不能把自己都看不到的文档指定为替代，避免把读者引导到错误目标）
      if (!replacementId || replacementId === docId) {
        result = { status: 'bad-replacement', reason: replacementId === docId ? 'self' : 'missing' }
        return
      }
      const repl = await db.docs.get(replacementId)
      if (!repl) { result = { status: 'bad-replacement', reason: 'missing' }; return }
      if (repl.retirement) { result = { status: 'bad-replacement', reason: 'retired' }; return }
      const replPending = await db.retirements
        .where('docId').equals(replacementId)
        .filter((r) => isRetireOpen(r)).first()
      if (replPending) { result = { status: 'bad-replacement', reason: 'pending-retire' }; return }
      const grant = await findActiveGrant(replacementId, userId)
      if (!canViewDoc(repl, userId, null, grant)) { result = { status: 'bad-replacement', reason: 'no-access' }; return }

      const retirement = {
        id: uid('ret'),
        docId,
        replacementId,
        reason: String(reason || '').trim(),
        status: RETIRE.PENDING,
        initiatedBy: userId,
        createdAt: nowIso,
        decidedBy: null,
        decidedAt: null,
        decideNote: '',
        // 批准生效时的处理结果留档（撤销退役时据此精确还原）
        effect: null,
        revokedBy: null,
        revokedAt: null,
        revokeNote: '',
        timeline: [buildTimelineEntry('initiate', userId, reason, nowIso)]
      }
      await db.retirements.add(retirement)
      result = { status: 'ok', retirement }
    })

    await reload()
    return result
  }

  // 管理员审批：approve 批准生效 / reject 驳回。
  // 批准路径在同一事务内：① 复核退役单/文档/替代文档状态 → ② 文档打退役标记 →
  // ③ 撤销仍有效的共享链接（打退役标记）→ ④ 已解决缺口工单答案来源改指替代文档 →
  // ⑤ 处理结果写入退役单 effect 留档。任一步异常整体回滚，不留部分生效。
  async function decideRetire(id, decision, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    if (currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    const nowIso = new Date().toISOString()
    const decideNote = String(note || '').trim()
    let result = { status: 'error' }

    try {
      await db.transaction('rw', db.retirements, db.docs, db.shares, db.gapTickets, async () => {
        const ret = await db.retirements.get(id)
        if (!ret) { result = { status: 'missing' }; return }
        if (!isRetireOpen(ret)) { result = { status: 'changed', retirement: ret }; return }

        if (decision === 'reject') {
          const rejected = {
            ...ret,
            status: RETIRE.REJECTED,
            decidedBy: userId,
            decidedAt: nowIso,
            decideNote,
            timeline: [...(ret.timeline || []), buildTimelineEntry('reject', userId, decideNote, nowIso)]
          }
          await db.retirements.put(rejected)
          result = { status: 'ok', approved: false, retirement: rejected }
          return
        }

        // ① 复核：文档仍存在且未退役；替代文档仍存在且未退役（期间被删/被退役则失败）
        const doc = await db.docs.get(ret.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }
        if (doc.retirement) { result = { status: 'changed', retirement: ret }; return }
        const repl = await db.docs.get(ret.replacementId)
        if (!repl) { result = { status: 'replacement-missing' }; return }
        if (repl.retirement) { result = { status: 'replacement-retired' }; return }

        // ② 文档打退役标记：搜索/问答引用闸门即时关闭（不改动正文与更新时间）
        await db.docs.update(doc.id, {
          retirement: {
            retirementId: ret.id,
            replacementId: ret.replacementId,
            reason: ret.reason,
            by: userId,
            at: nowIso
          }
        })

        // ③ 同步撤销仍有效的共享链接：标记退役来源，撤销退役时据此精确还原
        const revokedShareIds = []
        const shares = await db.shares.where('docId').equals(doc.id).toArray()
        for (const s of shares) {
          if (s.revokedAt) continue
          await db.shares.update(s.id, { revokedAt: nowIso, revokeReason: 'retired', retirementId: ret.id })
          revokedShareIds.push(s.id)
        }

        // ④ 已解决缺口工单：答案来源改指替代文档并留痕（问答页回填来源同步指向新文档）
        const repointedTickets = []
        const tickets = await db.gapTickets.where('docId').equals(doc.id).toArray()
        for (const t of tickets) {
          if (t.status !== GAP.RESOLVED) continue
          await db.gapTickets.update(t.id, {
            docId: ret.replacementId,
            timeline: [...(t.timeline || []), buildTimelineEntry('retire-repoint', userId, '答案来源文档《' + (doc.title || doc.id) + '》已退役，来源改指替代文档《' + (repl.title || repl.id) + '》', nowIso)]
          })
          repointedTickets.push({ ticketId: t.id, fromDocId: doc.id })
        }

        // ⑤ 退役单生效：处理结果随单留档
        const approved = {
          ...ret,
          status: RETIRE.APPROVED,
          decidedBy: userId,
          decidedAt: nowIso,
          decideNote,
          effect: { revokedShareIds, repointedTickets },
          timeline: [...(ret.timeline || []), buildTimelineEntry('approve', userId, decideNote, nowIso)]
        }
        await db.retirements.put(approved)
        result = { status: 'ok', approved: true, retirement: approved }
      })
    } catch (e) {
      // 生效途中异常：事务已整体回滚（无任何部分生效），按失败处理由调用方提示重试
      result = { status: 'error' }
    }

    // 联动刷新：文档退役标记/共享链接/工单来源均已变化
    const { useGapStore } = await import('./gap')
    const gap = useGapStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.loaded ? gap.reload() : Promise.resolve()])
    return result
  }

  // 发起人/管理员取消待审批的退役
  async function cancelRetire(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.retirements, async () => {
      const ret = await db.retirements.get(id)
      if (!ret) { result = { status: 'missing' }; return }
      if (!isRetireOpen(ret)) { result = { status: 'changed', retirement: ret }; return }
      if (isGuestUser(userId) || (ret.initiatedBy !== userId && role !== ROLE.ADMIN)) {
        result = { status: 'denied' }; return
      }
      const updated = {
        ...ret,
        status: RETIRE.CANCELLED,
        timeline: [...(ret.timeline || []), buildTimelineEntry('cancel', userId, '', nowIso)]
      }
      await db.retirements.put(updated)
      result = { status: 'ok', retirement: updated }
    })

    await reload()
    return result
  }

  // 撤销退役：文档恢复搜索/问答引用，被退役撤销的共享链接与工单答案来源同步还原。
  // 仅还原本退役单 effect 留档的处理项，期间被人工改动的工单/链接不受影响；
  // 退役单置为已撤销（revoked），记录与 timeline 全程保留。
  async function revokeRetire(id, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    if (isGuestUser(userId)) return { status: 'guest' }
    const nowIso = new Date().toISOString()
    const revokeNote = String(note || '').trim()
    let result = { status: 'error' }

    await db.transaction('rw', db.retirements, db.docs, db.shares, db.gapTickets, async () => {
      const ret = await db.retirements.get(id)
      if (!ret) { result = { status: 'missing' }; return }
      if (ret.status !== RETIRE.APPROVED) { result = { status: 'changed', retirement: ret }; return }
      if (ret.initiatedBy !== userId && role !== ROLE.ADMIN) { result = { status: 'denied' }; return }
      const doc = await db.docs.get(ret.docId)
      // 文档已删除：无可恢复对象，退役单保持已生效作为历史记录
      if (!doc) { result = { status: 'doc-missing' }; return }
      // 文档当前退役标记须来自本退役单（否则状态已被其他流程改变）
      if (doc.retirement?.retirementId !== ret.id) { result = { status: 'changed', retirement: ret }; return }

      // ① 恢复引用：撤下退役标记，搜索/问答重新命中
      await db.docs.update(doc.id, { retirement: null })

      // ② 还原共享链接：仅还原因本退役单撤销的链接（revokeReason='retired' 且属于本单）
      let restoredShares = 0
      const shares = await db.shares.where('docId').equals(doc.id).toArray()
      for (const s of shares) {
        if (s.revokeReason !== 'retired' || s.retirementId !== ret.id) continue
        await db.shares.update(s.id, { revokedAt: null, revokeReason: null, retirementId: null })
        restoredShares++
      }

      // ③ 还原工单答案来源：按 effect 留档逐个回指；期间已被改写的工单跳过不覆盖
      let restoredTickets = 0
      for (const item of ret.effect?.repointedTickets || []) {
        const t = await db.gapTickets.get(item.ticketId)
        if (!t || t.docId !== ret.replacementId) continue
        await db.gapTickets.update(t.id, {
          docId: item.fromDocId,
          timeline: [...(t.timeline || []), buildTimelineEntry('retire-restore', userId, '文档退役已撤销，答案来源恢复为原文档《' + (doc.title || doc.id) + '》', nowIso)]
        })
        restoredTickets++
      }

      const revoked = {
        ...ret,
        status: RETIRE.REVOKED,
        revokedBy: userId,
        revokedAt: nowIso,
        revokeNote,
        effect: { ...(ret.effect || {}), restoredShares, restoredTickets },
        timeline: [...(ret.timeline || []), buildTimelineEntry('revoke', userId, revokeNote, nowIso)]
      }
      await db.retirements.put(revoked)
      result = { status: 'ok', retirement: revoked }
    })

    const { useGapStore } = await import('./gap')
    const gap = useGapStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.loaded ? gap.reload() : Promise.resolve()])
    return result
  }

  // 自愈「文档已删除但退役单仍待审批」的孤儿单：自动取消并留痕（首次加载执行一次）
  async function reconcileOrphans() {
    const orphans = retirements.value.filter((r) => isRetireOpen(r))
    if (!orphans.length) return
    const nowIso = new Date().toISOString()
    let changed = false
    await db.transaction('rw', db.retirements, db.docs, async () => {
      for (const r of orphans) {
        const doc = await db.docs.get(r.docId)
        if (doc) continue
        const fresh = await db.retirements.get(r.id)
        if (!fresh || !isRetireOpen(fresh)) continue
        await db.retirements.put({
          ...fresh,
          status: RETIRE.CANCELLED,
          timeline: [...(fresh.timeline || []), buildTimelineEntry('auto_cancel', 'system', '文档已删除，退役申请自动取消', nowIso)]
        })
        changed = true
      }
    })
    if (changed) await reload()
  }

  return {
    retirements, loaded, loadAll, reload, sorted, byId,
    pendingOf, activeOf, initiatedBy, pendingCountFor,
    initiateRetire, decideRetire, cancelRetire, revokeRetire, reconcileOrphans
  }
})
