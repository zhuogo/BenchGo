import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Remove only this plugin's model-visible memory contribution, preserving source logs. */
export function createContextRedactor(agent, name, memory) {
  let previous;
  return () => {
    if (!memory?.redactForgottenContext) return;
    const revision = memory.forgottenRevision?.();
    if (revision !== undefined && revision === previous) return;
    const visible = new Set(agent.session.surface.nodes);
    for (const event of agent.session.snapshotEvents()) {
      if (!visible.has(event.seq) || event.type !== 'user/message' || event.data.source?.kind !== 'runtime-context') continue;
      let changed = false;
      const sections = event.data.source.sections?.map(section => {
        if (section.name !== name) return section;
        const parsed = JSON.parse(section.text);
        const cleaned = memory.redactForgottenContext(parsed);
        if (cleaned === parsed) return section;
        changed = true;
        return { ...section, text: JSON.stringify(cleaned) };
      });
      if (!changed) continue;
      const content = event.data.content.map(block => {
        if (block.type !== 'text') return block;
        let text = block.text;
        event.data.source.sections.forEach((section, index) => {
          if (section !== sections[index]) text = text.replace(section.text, () => sections[index].text);
        });
        return { ...block, text };
      });
      agent.session.append('user/message', createUserMessage({ source: { ...event.data.source, sections }, content }),
        { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
    }
    previous = revision;
  };
}
