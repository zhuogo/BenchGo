import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import terminalCss from '@xterm/xterm/css/xterm.css';
import { DeviceLoading } from './device-loading.jsx';

export function ServerTerminal({ runtime, device, allowResize, onReconnect }) {
  const pane = useRef(null);
  const [title, setTitle] = useState('');
  const [failure, setFailure] = useState(null);
  const [closed, setClosed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false, finished = false, terminal, observer, subscription, timer, id;
    let writes = Promise.resolve();
    const target = input => ({ deviceId: device.id, id, ...input });
    const close = () => {
      if (!id) return;
      const input = target();
      id = undefined;
      return runtime.call('serverTerminalClose', input).catch(() => {});
    };
    const fail = error => {
      if (!disposed && !finished) {
        finished = true;
        setFailure(error);
        setClosed(true);
        if (terminal) terminal.options.disableStdin = true;
        clearTimeout(timer);
        observer?.disconnect();
        void close();
      }
    };
    setTitle(''); setFailure(null); setClosed(false);
    const start = async () => {
      const session = await runtime.call('serverTerminal', { deviceId: device.id });
      id = session.id;
      if (disposed) { await close(); return; }
      setTitle(session.title || device.name);
      pane.current.hidden = false;
      const fit = new FitAddon();
      terminal = new Terminal({ scrollback: 2000, fontFamily: 'Consolas, ui-monospace, monospace', fontSize: 13, theme: { background: '#16181d', foreground: '#f4f4f5' } });
      terminal.loadAddon(fit);
      terminal.open(pane.current);
      terminal.focus();
      let size;
      const resize = () => {
        fit.fit();
        const { cols, rows } = terminal;
        const next = `${cols}x${rows}`;
        if (!allowResize || next === size || !cols || !rows) return;
        size = next;
        void runtime.call('serverTerminalResize', target({ cols, rows })).catch(fail);
      };
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(pane.current);
      subscription = terminal.onData(data => {
        writes = writes.then(() => !disposed && !finished && runtime.call('serverTerminalWrite', target({ data }))).catch(fail);
      });
      let offset = 0;
      const poll = async () => {
        const update = await runtime.call('serverTerminalRead', target({ offset }));
        if (disposed || finished) return;
        if (update.output) terminal.write(update.output);
        offset = update.offset;
        if (update.closed) {
          finished = true;
          terminal.options.disableStdin = true;
          observer.disconnect();
          setClosed(true);
          void close();
        } else timer = setTimeout(() => void poll().catch(fail), 200);
      };
      await poll();
    };
    void start().catch(fail);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer?.disconnect(); subscription?.dispose(); terminal?.dispose();
      void close();
    };
  }, [runtime, device.id, device.name, allowResize, attempt]);

  return <>
    <style>{terminalCss}</style>
    {title && <p className="dc-note">{title}</p>}
    {!title && !failure && <DeviceLoading label="正在连接 SSH…" />}
    <div className="dc-terminal-screen" ref={pane} hidden={!title} />
    {failure && <p className="dc-error" role="alert">{failure.message}</p>}
    {closed && <div className="dc-actions">
      {!failure && <p className="dc-note" role="status">终端已关闭</p>}
      {failure?.code === 'SSH_AUTH_REQUIRED' && onReconnect
        ? <button type="button" className="dc-button dc-primary" onClick={onReconnect}>重新认证 SSH</button>
        : <button type="button" className="dc-button" onClick={() => setAttempt(value => value + 1)}>重新连接终端</button>}
    </div>}
  </>;
}
