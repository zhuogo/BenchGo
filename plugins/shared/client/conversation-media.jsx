import React, { useRef, useState } from 'react';
import { IconRefreshOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';
import { CustomSelect } from './custom-select.jsx';
import { FileSaveButton } from './file-save-button.jsx';
import { fileUrl, previewKind } from './preview-model.mjs';
import { ResourceIcon } from './resource-icon.jsx';
import { Button } from './ui/button.jsx';
import { useFeedbackStyle } from './ui/feedback-style.js';
import { Loading } from './ui/loading.jsx';
import css from './conversation-media.css';

export function conversationMediaKind(file) {
  const type = (file.mimeType || file.mediaType)?.split('/')[0].toLowerCase();
  const kind = type === 'audio' || type === 'video' ? type : file.kind || previewKind(file.filename || file.name);
  return kind === 'audio' || kind === 'video' ? kind : null;
}

function mediaUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  if (!/^(?:https?:\/\/|dsh-app:\/\/|\/(?!\/)|api\/)/iu.test(value)) return null;
  try {
    const url = /^https:\/\//iu.test(value) ? new URL(value) : fileUrl(value);
    return !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const playbackRates = [0.75, 1, 1.25, 1.5, 2].map(rate => ({ value: String(rate), label: `${rate}×` }));

function timeLabel(seconds) {
  const total = Math.floor(seconds);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function AudioCard({ file, url }) {
  useFeedbackStyle('benchgo-conversation-media-styles', css);
  const media = useRef(null);
  const [state, setState] = useState(url ? 'idle' : 'error');
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [rate, setRate] = useState('1');
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const name = file.name || file.filename || '音频';
  const action = state === 'error' ? 'retry' : ended ? 'replay' : playing ? 'pause' : 'play';
  const label = { retry: '重试播放', replay: '重新播放', pause: '暂停', play: '播放' }[action];
  const shownPosition = duration ? Math.min(position, duration) : 0;
  const canSeek = !!duration && state !== 'error';

  function failed() {
    setPlaying(false);
    setEnded(false);
    setState('error');
  }

  function toggle() {
    const player = media.current;
    if (!player.paused) {
      player.pause();
      return;
    }
    if (state === 'idle' || state === 'error') {
      setDuration(0);
      setPosition(0);
      setState('loading');
      player.src = url;
      player.load();
    } else if (player.ended) {
      player.currentTime = 0;
    }
    // Invoke play directly from the user gesture for Mobile WebKit.
    void player.play().catch(error => {
      if (error.name !== 'AbortError') failed();
    });
  }

  function seek(event) {
    jumpTo(Number(event.target.value));
  }

  function jumpTo(target) {
    media.current.currentTime = target;
    setPosition(target);
    setEnded(target >= duration && media.current.ended);
  }

  return <div className="bg-conversation-media bg-conversation-audio" data-kind="audio" data-state={state} aria-busy={state === 'loading' || undefined}>
    <audio ref={media} hidden preload="none" aria-label={name}
      onDurationChange={event => {
        const value = event.currentTarget.duration;
        setDuration(Number.isFinite(value) && value > 0 ? value : 0);
      }}
      onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onPlay={() => { setPlaying(true); setEnded(false); }}
      onPause={() => setPlaying(false)}
      onEnded={() => { setPlaying(false); setEnded(true); }}
      onCanPlay={() => setState('ready')}
      onPlaying={() => setState('ready')}
      onWaiting={event => { if (!event.currentTarget.paused && !event.currentTarget.ended) setState('loading'); }}
      onError={failed} />
    <Button variant="ghost" size="icon" className="bg-conversation-audio-play" aria-label={`${label} ${name}`}
      data-action={action} disabled={!url} onClick={toggle}>
      {action === 'retry' || action === 'replay' ? <IconRefreshOutlineMedium />
        : <span className="bg-conversation-audio-glyph" aria-hidden="true" />}
    </Button>
    <strong className="bg-conversation-audio-name" title={name}>{name}</strong>
    <input type="range" className="bg-conversation-audio-seek" aria-label="播放进度"
      aria-valuetext={`${timeLabel(shownPosition)} / ${duration ? timeLabel(duration) : '未知时长'}`}
      min={0} max={duration || 1} step="any" value={shownPosition} disabled={!canSeek}
      style={{ '--audio-progress': `${canSeek ? shownPosition / duration * 100 : 0}%` }} onChange={seek}
      onKeyDown={event => {
        const offset = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[event.key];
        if (offset === undefined) return;
        event.preventDefault();
        jumpTo(Math.min(duration, Math.max(0, media.current.currentTime + offset)));
      }} />
    <div className="bg-conversation-audio-meta">
      {state === 'error' ? <span role="alert">{url ? '音频暂时无法播放' : '音频地址不可用'}</span>
        : state === 'loading' ? <span role="status" aria-label="正在加载音频…">正在加载音频…</span>
        : <span>{timeLabel(shownPosition)} <span className="bg-conversation-audio-separator">/</span> {duration ? timeLabel(duration) : '–:––'}</span>}
    </div>
    <CustomSelect compact className="bg-conversation-audio-rate" aria-label="播放速度"
      aria-description={`当前 ${rate}×`} disabled={!url} value={rate} options={playbackRates} onChange={value => {
        const next = Number(value);
        media.current.defaultPlaybackRate = next;
        media.current.playbackRate = next;
        setRate(value);
      }} />
    {(url || file.downloadUrl) && <FileSaveButton file={{ ...file, mimeType: file.mimeType || file.mediaType }} label={`下载 ${name}`} />}
  </div>;
}

function VideoCard({ file, url }) {
  useFeedbackStyle('benchgo-conversation-media-styles', css);
  const [state, setState] = useState(url ? 'idle' : 'error');
  const media = useRef(null);
  const name = file.name || file.filename || '视频';

  function play() {
    const player = media.current;
    setState('loading');
    player.src = url;
    player.load();
    // Keep the play request in the original user gesture for Mobile WebKit.
    void player.play().catch(() => {});
  }

  return <div className="bg-conversation-media" data-kind="video" data-state={state} aria-busy={state === 'loading' || undefined}>
    <div className="bg-conversation-media-heading">
      <ResourceIcon name="video" size={22} />
      <strong title={name}>{name}</strong>
      {(url || file.downloadUrl) && <FileSaveButton file={{ ...file, mimeType: file.mimeType || file.mediaType }} label={`下载 ${name}`} />}
    </div>
    <div className="bg-conversation-media-stage">
      <video ref={media} controls preload="none" playsInline
        hidden={state !== 'ready'} aria-label={name} onCanPlay={() => setState('ready')} onPlaying={() => setState('ready')}
        onError={() => setState('error')} />
      {state === 'idle' && <Button variant="ghost" size="sm" onClick={play} aria-label={`播放 ${name}`}>播放视频</Button>}
      {state === 'loading' && <Loading compact label="正在加载视频…" />}
      {state === 'error' && <div className="bg-conversation-media-error">
        <span role="alert">{url ? '视频暂时无法播放' : '视频地址不可用'}</span>
        {url && <Button variant="ghost" size="sm" onClick={play} aria-label={`重试播放 ${name}`}>重试</Button>}
      </div>}
    </div>
  </div>;
}

export function ConversationMediaFile({ file }) {
  const kind = conversationMediaKind(file);
  if (!kind || file.local) return null;
  const url = mediaUrl(file.url);
  if (kind === 'audio') return <AudioCard key={url} file={file} url={url} />;
  return <VideoCard key={url} file={file} url={url} />;
}
