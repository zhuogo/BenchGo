import React, { useId, useSyncExternalStore } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { notificationSound } from './notification-sound.mjs';

export function NotificationSoundToggle({ sound = notificationSound }) {
  const snapshot = useSyncExternalStore(sound.subscribe, sound.getSnapshot);
  const id = useId();
  const text = snapshot.enabled ? {
    locked: '已开启，等待浏览器允许播放', unlocking: '正在启用声音…', ready: '已开启',
    error: `${snapshot.error || '提示音播放失败'}。关闭后重新开启可重试`,
  }[snapshot.state] : '已静音';
  const status = [text, snapshot.preferenceError].filter(Boolean).join('。');
  function toggle() {
    const enabled = !sound.getSnapshot().enabled;
    sound.setEnabled(enabled);
    if (enabled) void sound.unlock(true);
  }
  return <>
    <Tooltip label={`回复提示音 · ${status}`}>
      <Button variant="ghost" size="icon" className="ba-sound-toggle" aria-label="回复提示音" aria-pressed={snapshot.enabled}
        aria-describedby={id} data-notification-sound-settings onClick={toggle}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path className="ba-sound-bell" d="M18 8a6 6 0 0 0-12 0c0 6-2 7-3 9h18c-1-2-3-3-3-9m-8 12a2 2 0 0 0 4 0" />
          <path className="ba-sound-slash" d="m4 3 16 18" />
        </svg>
      </Button>
    </Tooltip>
    <span id={id} className="bg:sr-only" role="status">{status}</span>
  </>;
}
