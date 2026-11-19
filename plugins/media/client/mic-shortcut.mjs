/** Bare M outside text input: mute during a call; otherwise tap dictates and hold talks, then sends. */
export const MIC_SHORTCUT_KEYS = ['M'];
const CODE = 'KeyM', HOLD_MS = 350;

/** Mounted composers offer themselves as dictation targets; the visible one under focus wins. */
export function createMicTargets() {
  const rows = new Set();
  return {
    add(row) { rows.add(row); return () => rows.delete(row); },
    resolve(element) {
      const visible = [...rows].filter(row => row.element()?.getClientRects?.().length);
      const owner = element?.closest?.('[data-conversation-session]');
      const row = owner && visible.find(item => owner.contains(item.element())) || (visible.length === 1 ? visible[0] : null);
      return row?.actions() || null;
    },
  };
}

export function installMicShortcut({ shortcuts, controller, targets, environment = globalThis.window, holdMs = HOLD_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let press = null;
  const unregister = shortcuts.registerFixed({ id: 'voice.microphone', label: () => '语音：通话中静音；其余轻按转文本，按住说话松开发送', keys: MIC_SHORTCUT_KEYS, bindings: [{ code: CODE, modifiers: [] }], group: 'input' });
  const unobserve = shortcuts.observeFixedInput(input => {
    if (input.type !== 'keydown' || input.gesture.code !== CODE) return;
    const { gesture, context } = input;
    if (press) {
      // Auto-repeat of a press this shortcut owns must never reach the page.
      if (gesture.repeat) { input.consume(); return; }
      // A fresh press means the release was never seen: stop without sending.
      end(current => current.target.stop()); input.consume(); return;
    }
    // In text input M is a letter; with modifiers it belongs to other commands.
    if (gesture.repeat || gesture.composing || gesture.defaultPrevented || gesture.control || gesture.alt || gesture.shift || gesture.meta || context.region !== 'page') return;
    const state = controller.state.getSnapshot();
    if (state.mode === 'call') {
      if (context.modal !== null && context.modal !== 'voice-call' || state.phase === 'starting') return;
      input.consume(); controller.toggleMute(); return;
    }
    if (context.modal !== null) return;
    const target = targets.resolve(context.target);
    if (!target) return;
    if (state.mode === 'dictation') {
      if (state.sessionId !== target.sessionId) return;
      input.consume(); target.stop(); return;
    }
    if (!target.ready()) return;
    input.consume();
    // Capture starts with the press so held speech is not clipped; the release decides what it becomes.
    const current = { target, held: false };
    current.timer = setTimer(() => { current.held = true; }, holdMs);
    press = current; target.start();
  });
  const end = action => { const current = press; if (!current) return; press = null; clearTimer(current.timer); action(current); };
  const keyup = event => { if (event.code === CODE) end(current => current.held ? current.target.send() : current.target.keep()); };
  // A release the window never sees must not send: stop, and keep the words as a draft.
  const blur = () => end(current => current.target.stop());
  environment.addEventListener('keyup', keyup, true);
  environment.addEventListener('blur', blur);
  return () => { end(current => current.target.stop()); unobserve(); unregister(); environment.removeEventListener('keyup', keyup, true); environment.removeEventListener('blur', blur); };
}
