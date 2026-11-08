import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { recordDesktopTrigger } from './desktop-trigger.mjs';
import { ownsDesktopTicket } from './desktop-ticket-owner.mjs';

/** Controls retain the existing mandate; only the live owner turn supplies context. */
export function createDesktopTicketControl({ ctx, database }) {
  return {
    control({ id, operation, attentionId }, exec, { ownerAgent, threadId = 'main', ownerScope } = {}) {
      if (!ownerAgent || exec?.agent !== ownerAgent) throw new Error('只有总助手当前会话可管理工单');
      if (!['supplement', 'cancel', 'answer'].includes(operation)) throw new Error('无效工单操作');
      if (operation === 'answer' && (typeof attentionId !== 'string' || !attentionId)) throw new Error('请先读取并明确选择原工单的问题');
      const instruction = currentHumanInstruction(ctx, ownerAgent);
      const message = instruction?.message;
      if (!message?.id || !(message.content || []).some(block => block.type === 'text' && block.text?.trim())) throw new Error('工单操作缺少当前原始用户文字指令');
      const ticket = database.getTicket(id);
      if (!ticket) throw new Error('工单不存在');
      const source = ticket.mandate.source;
      if (!ownsDesktopTicket(ticket, ownerScope ?? { threadId, sessionIds: [ownerAgent.id] })
        || (source.threadId || 'main') !== threadId || ticket.threadId !== `desktop:${source.sessionId}`) throw new Error('工单不属于当前会话');
      exec.signal?.throwIfAborted();
      if (operation === 'answer') {
        const question = database.attentions(id).find(row => row.id === attentionId);
        if (!question) throw new Error('工单原问题不存在');
        const answer = database.answerDesktopAttention({ ticketId: id, attentionId,
          instructionRevision: question.instructionRevision ?? ticket.instructionRevision, requestId: message.id,
          answer: { selected: [], custom: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') } });
        return { operation, ticketId: id, attention: answer };
      }
      if (operation === 'supplement' && ['completed', 'failed', 'closed', 'cancelled', 'cancelling'].includes(ticket.status)) throw new Error('工单已停止；请通过工单修订或重开处理新要求');
      const { trigger } = recordDesktopTrigger(database, { sessionId: ownerAgent.id, threadId, message });
      if (operation === 'cancel') {
        database.recordTicketInput({ ticketId: id, triggerId: trigger.id, kind: 'stop', idempotencyKey: `trigger:${trigger.id}` });
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
