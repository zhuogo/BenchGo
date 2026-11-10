import { ticketStopped } from './ticket-lifecycle.mjs';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { recordDesktopTrigger } from './desktop-trigger.mjs';
import { ownsDesktopTicket } from './desktop-ticket-owner.mjs';
import { isDesktopTicketManagementScope } from './desktop-ticket-management-authority.mjs';

/** Controls retain the existing mandate; only the live owner turn supplies context. */
export function createDesktopTicketControl({ ctx, database }) {
  return {
    control({ id, operation, attentionId }, exec, { ownerAgent, threadId = 'main', ownerScope, managementScope } = {}) {
      if (!ownerAgent || exec?.agent !== ownerAgent) throw new Error('只有总助手当前会话可管理工单');
      if (!['supplement', 'cancel', 'pause', 'resume', 'answer'].includes(operation)) throw new Error('无效工单操作');
      if (operation === 'answer' && (typeof attentionId !== 'string' || !attentionId)) throw new Error('请先读取并明确选择原工单的问题');
      const instruction = currentHumanInstruction(ctx, ownerAgent);
      const message = instruction?.message;
      if (!message?.id || !(message.content || []).some(block => block.type === 'text' && block.text?.trim())) throw new Error('工单操作缺少当前原始用户文字指令');
      const ticket = database.getTicket(id);
      if (!ticket) throw new Error('工单不存在');
      const source = ticket.mandate.source;
      const globalControl = ['cancel', 'pause', 'resume'].includes(operation) && isDesktopTicketManagementScope(managementScope);
      if (!globalControl && (!ownsDesktopTicket(ticket, ownerScope ?? { threadId, sessionIds: [ownerAgent.id] })
        || (source.threadId || 'main') !== threadId || ticket.threadId !== `desktop:${source.sessionId}`)) throw new Error('工单不属于当前会话');
      exec.signal?.throwIfAborted();
      if (operation === 'answer') {
        const question = database.attentions(id).find(row => row.id === attentionId);
        if (!question) throw new Error('工单原问题不存在');
        const answer = database.answerDesktopAttention({ ticketId: id, attentionId,
          instructionRevision: question.instructionRevision ?? ticket.instructionRevision, requestId: message.id,
          answer: { selected: [], custom: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') } });
        return { operation, ticketId: id, attention: answer };
      }
      if (operation === 'supplement' && (ticket.status === 'completed' || ticketStopped(ticket))) throw new Error('工单已完成或停止；请通过工单修订或关联调整处理新要求');
      if (operation === 'pause' && (ticket.status === 'completed' || ticketStopped(ticket))) throw new Error('工单已完成或停止，不能暂停');
      const { trigger } = recordDesktopTrigger(database, { sessionId: ownerAgent.id, threadId, message });
      if (operation === 'resume') return { operation, triggerId: trigger.id, ticket: database.resumeTicket(id) };
      const inputKey = globalControl ? `trigger:${trigger.id}:ticket:${id}` : `trigger:${trigger.id}`;
      if (operation === 'pause') {
        const ticket = database.pauseTicket(id, { triggerId: trigger.id, inputKey });
        const input = database.ticketInputs(id).find(row => row.triggerId === trigger.id);
        return { operation, triggerId: trigger.id, ticket, input };
      }
      if (operation === 'cancel') {
        database.recordTicketInput({ ticketId: id, triggerId: trigger.id, kind: 'stop', idempotencyKey: inputKey });
        const ticket = database.cancelTicket(id);
        const input = database.applyTicketStopInput(id, trigger.id);
        return { operation, triggerId: trigger.id, ticket, input };
      }
      // A model-session reset keeps the logical conversation and the original
      // mandate. Bind this explicit selection to its new Trigger stream only.
      if (source.sessionId !== ownerAgent.id && !database.subscriptions({ ticketId: id, threadId: trigger.threadId }).length) {
        database.subscribe(id, trigger.threadId, { beforeTriggerId: trigger.id });
      }
      const delivery = database.deliverSubscribedMessage(trigger.id, { ticketId: id });
      if (!delivery) throw new Error('工单没有活动订阅，补充未送达；请查询工单状态');
      return { operation, ticketId: id, ...delivery };
    },
  };
}
