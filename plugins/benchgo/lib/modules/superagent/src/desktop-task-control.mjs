import { taskStopped } from './task-lifecycle.mjs';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { recordDesktopTrigger } from './desktop-trigger.mjs';
import { ownsDesktopTask } from './desktop-task-owner.mjs';
import { isDesktopTaskManagementScope } from './desktop-task-management-authority.mjs';

/** Same trusted stop/input path for live control and an already authorized continuation. */
export function stopDesktopTask(database, taskId, triggerId, inputKey = `trigger:${triggerId}:task:${taskId}`) {
  database.recordTaskInput({ taskId, triggerId, kind: 'stop', idempotencyKey: inputKey });
  const task = database.cancelTask(taskId);
  const input = database.applyTaskStopInput(taskId, triggerId);
  return { operation: 'cancel', triggerId, task, input };
}

/** Controls retain the existing mandate; only the live owner turn supplies context. */
export function createDesktopTaskControl({ ctx, database }) {
  return {
    control({ id, operation, attentionId }, exec, { ownerAgent, threadId = 'main', ownerScope, managementScope } = {}) {
      if (!ownerAgent || exec?.agent !== ownerAgent) throw new Error('只有总助手当前会话可管理任务');
      if (!['supplement', 'cancel', 'pause', 'resume', 'answer'].includes(operation)) throw new Error('无效任务操作');
      if (operation === 'answer' && (typeof attentionId !== 'string' || !attentionId)) throw new Error('请先读取并明确选择原任务的问题');
      const instruction = currentHumanInstruction(ctx, ownerAgent);
      const message = instruction?.message;
      if (!message?.id || !(message.content || []).some(block => block.type === 'text' && block.text?.trim())) throw new Error('任务操作缺少当前原始用户文字指令');
      const task = database.getTask(id);
      if (!task) throw new Error('任务不存在');
      const source = task.mandate.source;
      const globalControl = ['cancel', 'pause', 'resume'].includes(operation) && isDesktopTaskManagementScope(managementScope);
      if (!globalControl && (!ownsDesktopTask(task, ownerScope ?? { threadId, sessionIds: [ownerAgent.id] })
        || (source.threadId || 'main') !== threadId || task.threadId !== `desktop:${source.sessionId}`)) throw new Error('任务不属于当前会话');
      exec.signal?.throwIfAborted();
      if (operation === 'answer') {
        const question = database.attentions(id).find(row => row.id === attentionId);
        if (!question) throw new Error('任务原问题不存在');
        const answer = database.answerDesktopAttention({ taskId: id, attentionId,
          instructionRevision: question.instructionRevision ?? task.instructionRevision, requestId: message.id,
          answer: { selected: [], custom: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') } });
        return { operation, taskId: id, attention: answer };
      }
      if (operation === 'supplement' && (task.status === 'completed' || taskStopped(task))) throw new Error('任务已完成或停止；请通过任务修订或关联调整处理新要求');
      if (operation === 'pause' && (task.status === 'completed' || taskStopped(task))) throw new Error('任务已完成或停止，不能暂停');
      const { trigger } = recordDesktopTrigger(database, { sessionId: ownerAgent.id, threadId, message });
      if (operation === 'resume') return { operation, triggerId: trigger.id, task: database.resumeTask(id) };
      // One owner instruction may control several explicitly selected Tasks,
      // including when it only has the current conversation's owner scope.
      const inputKey = `trigger:${trigger.id}:task:${id}`;
      if (operation === 'pause') {
        const task = database.pauseTask(id, { triggerId: trigger.id, inputKey });
        const input = database.taskInputs(id).find(row => row.triggerId === trigger.id);
        return { operation, triggerId: trigger.id, task, input };
      }
      if (operation === 'cancel') {
        return stopDesktopTask(database, id, trigger.id, inputKey);
      }
      // A model-session reset keeps the logical conversation and the original
      // mandate. Bind this explicit selection to its new Trigger stream only.
      if (source.sessionId !== ownerAgent.id && !database.subscriptions({ taskId: id, threadId: trigger.threadId }).length) {
        database.subscribe(id, trigger.threadId, { beforeTriggerId: trigger.id });
      }
      const delivery = database.deliverSubscribedMessage(trigger.id, { taskId: id });
      if (!delivery) throw new Error('任务没有活动订阅，补充未送达；请查询任务状态');
      return { operation, taskId: id, ...delivery };
    },
  };
}
