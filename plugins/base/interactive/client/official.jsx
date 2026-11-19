import React from 'react';
import { InteractiveReply } from './reply.jsx';
import { hasInteractive } from './protocol.mjs';
import { sendInteractive } from './send.mjs';

/** Public turn extension preserves the official assistant renderer and its child-slot ownership. */
export function mountInteractiveClient(ctx) {
  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'benchgo-interactive', order: 10,
  }, function InteractiveTurn({ turn, sessionId, useSession }) {
    const running = useSession(value => value.running);
    const steps = (turn.steps || []).map(step => step.data?.get('assistant-step')).filter(Boolean);
    const blocks = steps.flatMap((step, index) => (step.blocks || []).filter(block => block.kind === 'text' && hasInteractive(block.text)).map((block, blockIndex) => ({ ...block, key: `${index}:${blockIndex}`, streaming: step.status === 'running' })));
    if (!blocks.length) return null;
    return <div aria-label="交互回复">{blocks.map(block => <InteractiveReply key={block.key} text={block.text} onlyCards streaming={block.streaming} disabled={running} onSubmit={(text, request) => sendInteractive(ctx.sessions, sessionId, text, request)} />)}</div>;
  })));
}
