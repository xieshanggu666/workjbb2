// 知识退役替代：状态常量、权限判定与留痕工具（均为纯函数，便于复用与测试）
// 流程：负责人为文档发起退役并指定替代文档（pending）→ 管理员审批：
// 批准（approved）→ 旧文档退出搜索与问答引用、共享链接同步撤销、已解决缺口工单的
// 答案来源改指替代文档；驳回（rejected）文档保持原状。发起人/管理员可取消（cancelled）
// 流转中的退役；已退役可由负责人/管理员撤销（revoked）：恢复搜索与问答引用、还原被退役
// 撤销的共享链接与工单答案来源，退役记录全程保留不删除。
import { ROLE, isGuestUser } from './permission'

// 退役单状态
export const RETIRE = {
  PENDING: 'pending', // 待审批：负责人已发起，等待管理员审批
  APPROVED: 'approved', // 已退役：审批通过，文档退出搜索/问答引用并指定替代文档
  REJECTED: 'rejected', // 已驳回：管理员不批准本次退役，文档保持原状
  CANCELLED: 'cancelled', // 已取消：发起人（或管理员）在审批前取消
  REVOKED: 'revoked' // 已撤销退役：恢复引用并还原共享链接/工单来源，记录保留
}

// 文档是否已退役（批准后在 doc.retirement 上留标记：搜索/问答的统一闸门）
export function isRetired(doc) {
  return !!doc?.retirement
}

// 退役单是否仍在流转中（可审批/可取消）
export function isRetireOpen(ret) {
  return !!ret && ret.status === RETIRE.PENDING
}

export function retireStatusLabel(status) {
  return {
    pending: '待审批',
    approved: '已退役',
    rejected: '已驳回',
    cancelled: '已取消',
    revoked: '已撤销退役'
  }[status] || status
}

export function retireStatusCls(status) {
  return {
    pending: 'st-pending',
    approved: 'st-retired',
    rejected: 'st-no',
    cancelled: 'st-off',
    revoked: 'st-wait'
  }[status] || ''
}

// 发起退役：登录成员且为文档负责人（拥有者）或管理员；已退役文档不可重复发起。
// 评审中/交接中/已有待审批退役单等占用态在 store 事务内复核。
export function canInitiateRetire(doc, userId, role) {
  if (!doc || isGuestUser(userId) || isRetired(doc)) return false
  return role === ROLE.ADMIN || doc.ownerId === userId
}

// 审批退役（批准/驳回）：仅管理员，且退役单仍待审批
export function canDecideRetire(ret, userId, role) {
  return isRetireOpen(ret) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 取消退役：发起人或管理员，且退役单仍待审批
export function canCancelRetire(ret, userId, role) {
  return isRetireOpen(ret) && !isGuestUser(userId) && (ret.initiatedBy === userId || role === ROLE.ADMIN)
}

// 撤销退役：发起人或管理员，且退役单已批准生效（文档恢复引用，共享链接/工单来源同步还原）
export function canRevokeRetire(ret, userId, role) {
  return !!ret && ret.status === RETIRE.APPROVED && !isGuestUser(userId) &&
    (ret.initiatedBy === userId || role === ROLE.ADMIN)
}

// 退役留痕动作文案（退役单 timeline 全程保留）
export function retireTimelineLabel(action) {
  return {
    initiate: '发起文档退役',
    approve: '管理员批准 · 文档退役生效',
    reject: '管理员驳回',
    cancel: '取消退役申请',
    revoke: '撤销退役 · 恢复引用',
    auto_cancel: '文档已删除 · 退役申请自动取消'
  }[action] || action
}
