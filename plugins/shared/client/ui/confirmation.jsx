import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog.jsx';
import { Button } from './button.jsx';
import { useFeedbackStyle } from './feedback-style.js';
import css from './confirmation.css';

function Confirmation({ request, settle }) {
  const cancel = useRef(null);
  useFeedbackStyle('benchgo-confirmation-styles', css);
  return <Dialog open onOpenChange={open => { if (!open) settle(request, false); }}>
    <DialogContent className="bg-confirmation" onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={event => { if (request.opener?.isConnected) { event.preventDefault(); request.opener.focus({ preventScroll: true }); } }}>
      <DialogTitle>{request.title || '确认操作'}</DialogTitle>
      <DialogDescription>{request.description || '请确认是否继续。'}</DialogDescription>
      <footer className="bg-confirmation-actions"><Button ref={cancel} variant="ghost" onClick={() => settle(request, false)}>{request.cancelLabel || '取消'}</Button><Button variant={request.destructive ? 'destructive' : 'default'} onClick={() => settle(request, true)}>{request.confirmLabel || '确认'}</Button></footer>
    </DialogContent>
  </Dialog>;
}

/** A local, awaited decision. Closing or unmounting always cancels. */
export function useConfirmation() {
  const [request, setRequest] = useState(null);
  const pending = useRef(null);
  const mounted = useRef(true);
  const confirm = useCallback(options => new Promise(resolve => {
    if (!mounted.current) { resolve(false); return; }
    pending.current?.resolve(false);
    const next = { ...(typeof options === 'string' ? { description: options } : options), resolve, opener: document.activeElement };
    pending.current = next;
    setRequest(next);
  }), []);
  const settle = useCallback((current, result) => {
    if (pending.current !== current) return;
    pending.current = null;
    setRequest(null);
    current.resolve(result);
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.resolve(false); pending.current = null; }; }, []);
  return [confirm, request ? <Confirmation request={request} settle={settle} /> : null];
}
