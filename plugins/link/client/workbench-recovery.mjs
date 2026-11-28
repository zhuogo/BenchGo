const pollInterval = 5000;
const idlePollInterval = 15000;
const waitLimit = 180_000;

/** Keep the admitted page and its local drafts until the same host is ready. */
export function watchWorkbench(readStatus, { reload = () => location.reload(), root = document } = {}) {
  let instanceId, target, waitingSince, timer, running = false, failures = 0, notice, focus;
  let covered = [];
  const dismiss = () => {
    if (!notice) return;
    notice.remove();
    notice = undefined;
    for (const [element, inert] of covered) element.inert = inert;
    covered = [];
    focus?.focus();
  };
  const show = (message, action) => {
    if (!notice) {
      notice = root.createElement('div');
      notice.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:grid;place-content:center;justify-items:center;gap:12px;padding:24px;text-align:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#222);font:14px/1.6 var(--dsw-font-family,system-ui)';
      const text = root.createElement('p');
      text.style.cssText = 'max-width:38em;margin:0';
      text.setAttribute('role', 'status');
      const button = root.createElement('button');
      button.type = 'button';
      button.style.cssText = 'min-height:44px;padding:8px 16px;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;font:inherit;cursor:pointer';
      notice.append(text, button);
      focus = root.activeElement;
      covered = [...root.body.children].map(element => [element, element.inert]);
      for (const [element] of covered) element.inert = true;
      root.body.append(notice);
    }
    if (notice.firstChild.textContent !== message) notice.firstChild.textContent = message;
    const button = notice.lastChild;
    const newlyVisible = !!action && (button.hidden || button.textContent === '');
    button.hidden = !action;
    button.textContent = action === 'dismiss' ? '返回工作台' : '重试连接';
    button.onclick = action === 'dismiss' ? () => {
      dismiss();
      waitingSince = undefined;
      target = undefined;
      timer = setTimeout(poll, idlePollInterval);
    } : () => { waitingSince = Date.now(); void poll(); };
    if (newlyVisible) button.focus();
  };
  const poll = async () => {
    if (running) return;
    running = true;
    clearTimeout(timer);
    let message, action;
    try {
      const data = await readStatus();
      if (data === null || data?.installation !== 'server') { dismiss(); return; }
      const health = data.hostHealth;
      failures = 0;
      const restarted = !!(instanceId && health?.instanceId && instanceId !== health.instanceId);
      instanceId ??= health?.instanceId;
      const restarting = health?.restart === 'restarting';
      if (restarting || restarted) {
        waitingSince ??= Date.now();
        target ??= health.target;
      }
      if (restarting) {
        message = '远端正在重启，连接恢复后会自动返回';
      } else if (waitingSince !== undefined && health?.restart === 'failed') {
        instanceId = health.instanceId ?? instanceId;
        message = data.error || '服务器未加载目标功能包，请在设备中心查看服务日志。';
        action = 'dismiss';
      } else if (waitingSince !== undefined && health?.ready && (!target || data.current?.plugin === target) && !data.restartRequired) {
        dismiss();
        reload();
        return;
      } else if (waitingSince !== undefined) {
        message = health?.workbench && health?.requiresAssistant && !health.assistant
          ? '工作台已启动，正在等待总助手就绪' : '正在等待远端工作台就绪';
      }
    } catch {
      failures++;
      if (waitingSince !== undefined) message = '远端连接中断，正在重新连接';
    } finally {
      running = false;
    }
    if (message) {
      const timedOut = Date.now() - waitingSince >= waitLimit;
      show(timedOut && !action ? (message.includes('总助手') ? '总助手未就绪，请在设备中心查看服务日志。' : '远端工作台未恢复，请重试连接或在设备中心查看服务日志。') : message,
        action ?? (timedOut ? 'retry' : undefined));
      if (timedOut || action) return;
    }
    const delay = waitingSince === undefined ? Math.min(60_000, idlePollInterval * 2 ** Math.min(failures, 2)) : pollInterval;
    timer = setTimeout(poll, delay);
  };
  if (root.body) void poll();
  else root.addEventListener('DOMContentLoaded', poll, { once: true });
}
