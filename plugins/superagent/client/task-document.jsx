import React from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

export function TaskMarkdown({ text }) {
  return <div className="ba-task-markdown"><MarkdownText text={text || ''} labels={labels} /></div>;
}

export function TaskDocument({ title, icon = 'document', meta, children }) {
  return <section className="ba-task-document" aria-label={title}><header className="ba-task-document-head"><h3><UIIcon name={icon} size={18} />{title}</h3>{meta && <span className="ba-task-version">{meta}</span>}</header><div className="ba-task-document-content">{children}</div></section>;
}
