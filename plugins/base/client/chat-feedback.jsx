import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { IconCloseOutlineRegular, IconPaperPlaneOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { resourceRequestId } from '../../link/client/resource-state.mjs';
import mark from '../../../assets/brand/benchgo-mark.svg';
import { feedbackCategories, feedbackLimit, feedbackPath } from '../shared/feedback.mjs';
import css from './chat-feedback.css';

const mascot = `data:image/svg+xml,${encodeURIComponent(mark)}`;
const title = '给 BenchGo 留张便签';

export function ChatFeedbackDialog({ visible, close }) {
  const formId = useId();
  const [category, setCategory] = useState('bug');
  const [text, setText] = useState('');
  const [state, setState] = useState({});
  const sending = useRef(false);
  const attempt = useRef(null);
  const length = Array.from(text).length;

  const dismiss = () => {
    if (sending.current) return;
    if (state.ticketId) setState({});
    close();
  };

  async function submit(event) {
    event.preventDefault();
    const message = text.trim();
    if (sending.current || !message || length > feedbackLimit) return;
    sending.current = true;
    setState({ busy: true });
    if (attempt.current?.category !== category || attempt.current?.text !== message) {
      attempt.current = { category, text: message, requestId: resourceRequestId() };
    }
    try {
      const response = await fetch(new URL(feedbackPath.slice(1), document.baseURI), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(attempt.current), signal: AbortSignal.timeout(16_000),
      });
      if (response.status === 429) {
        setState({ error: '提交太频繁，请稍等片刻再试。' });
        return;
      }
      if (!response.ok) throw new Error('Feedback rejected');
      const { ticketId } = await response.json();
      if (!Number.isSafeInteger(ticketId) || ticketId < 1) throw new Error('Missing feedback receipt');
      setText('');
      setCategory('bug');
      attempt.current = null;
      setState({ ticketId });
    } catch {
      setState({ error: '暂时没能送达。内容已保留，请稍后重试。' });
    } finally {
      sending.current = false;
    }
  }

  return <Modal open={visible} onClose={dismiss} title={title} className="bg-chat-feedback" headless>
    <header className="bg-chat-feedback-header">
      <div><h2>给 BenchGo 留张<span>便签</span></h2><p>说说哪里不顺手，或分享一个想法。</p></div>
      <img className="bg-chat-feedback-mascot" src={mascot} alt="" width="62" height="44" />
      <button className="bg-chat-feedback-close" type="button" aria-label="关闭" onClick={dismiss} disabled={state.busy}><IconCloseOutlineRegular size={16} /></button>
    </header>
    {state.ticketId ? <div className="bg-chat-feedback-body bg-chat-feedback-receipt">
      <div role="status"><strong>便签已送达</strong><p>工单 #{state.ticketId}</p></div>
      <button className="bg-chat-feedback-send" onClick={dismiss} type="button">完成</button>
    </div> : <form className="bg-chat-feedback-body" onSubmit={submit} aria-busy={state.busy || undefined}>
      <fieldset disabled={state.busy}>
        <legend>反馈类型</legend>
        <div className="bg-chat-feedback-categories">
          {Object.entries(feedbackCategories).map(([key, label]) => <label key={key}>
            <input type="radio" name={formId} value={key} checked={category === key} onChange={() => { setCategory(key); setState({}); }} />
            <span>{label}</span>
          </label>)}
        </div>
      </fieldset>
      <label htmlFor={formId}>反馈内容</label>
      <div className="bg-chat-feedback-note">
        <textarea id={formId} data-modal-autofocus value={text} required readOnly={state.busy}
          aria-invalid={length > feedbackLimit || undefined} aria-describedby={`${formId}-count`}
          onChange={event => { setText(event.target.value); if (state.error) setState({}); }} placeholder="写下你遇到的情况，或希望我们改进的地方…" />
        <small id={`${formId}-count`} data-over={length > feedbackLimit}>{length} / {feedbackLimit}</small>
      </div>
      {state.error && <p className="bg-chat-feedback-error" role="alert">{state.error}</p>}
      <footer>
        <small>匿名发送 · 仅提交你填写的内容</small>
        <button type="submit" className="bg-chat-feedback-send" disabled={state.busy || !text.trim() || length > feedbackLimit}>
          <IconPaperPlaneOutlineRegular size={16} />{state.busy ? '发送中…' : '发送反馈'}
        </button>
      </footer>
    </form>}
  </Modal>;
}

export function mountChatFeedback(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });
  const listeners = new Set();
  let visible = false;
  const setVisible = next => {
    if (next === visible) return;
    visible = next;
    for (const listener of listeners) listener();
  };
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const getSnapshot = () => visible;
  function FeedbackOverlay() {
    const open = useSyncExternalStore(subscribe, getSnapshot);
    return <ChatFeedbackDialog visible={open} close={() => setVisible(false)} />;
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'benchgo-feedback' }, FeedbackOverlay));
  // The upstream header action and bare /feedback command share this service.
  ctx.inject(['feedbackUi'], scope => scope.effect(() => {
    const service = scope.feedbackUi;
    const original = service.openSession;
    const open = () => setVisible(true);
    service.openSession = open;
    return () => { if (service.openSession === open) service.openSession = original; };
  }));
}
