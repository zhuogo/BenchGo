import React, { useSyncExternalStore } from 'react';
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button } from '../../shared/client/ui/button.jsx';
import { notificationSound } from './notification-sound.mjs';

export function NotificationSoundSettings({ sound = notificationSound }) {
  const snapshot = useSyncExternalStore(sound.subscribe, sound.getSnapshot);
  const text = !snapshot.enabled ? '已静音' : ({ locked: '点击试听，启用声音', unlocking: '正在启用…', ready: '已开启', error: '播放失败，请重试' })[snapshot.state];
  return <section className="ba-notification-sound" aria-label="回复提示音" data-notification-sound-settings>
    <div className="ba-notification-sound-row">
      <div className="ba-notification-sound-copy"><h2>回复提示音</h2><p>收到新回复或主动通知时，播放轻提示音。</p></div>
      <Switch label="播放提示音" checked={snapshot.enabled} onChange={enabled => { sound.setEnabled(enabled); if (enabled) void sound.unlock(); }} />
    </div>
    <div className="ba-notification-sound-footer"><span role="status">{text}</span><Button variant="ghost" size="sm" type="button" aria-label="试听提示音" disabled={!snapshot.enabled || snapshot.state === 'unlocking'} onClick={() => void sound.unlock(true)}>试听</Button></div>
    {snapshot.error && <p className="ba-error" role="alert">{snapshot.error}</p>}
  </section>;
}
