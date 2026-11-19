import React, { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { ImageGallery } from '../../shared/client/image-gallery.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import { useFeedbackStyle } from '../../shared/client/ui/feedback-style.js';
import css from './conversation-images.css';

function LoadAttachment({ attachment, loadImage, report, attempt }) {
  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => loadImage(attachment)).then(
      url => { if (current) report(attachment.attachmentId, { loadImage, url, attempt }); },
      () => { if (current) report(attachment.attachmentId, { loadImage, attempt }); },
    );
    return () => { current = false; };
  }, [attachment, loadImage, report, attempt]);
  return null;
}

function MessageGallery({ images, loadImage, align }) {
  useFeedbackStyle('benchgo-conversation-images-styles', css);
  const [results, setResults] = useState(() => new Map());
  const [attempt, setAttempt] = useState(0);
  const report = useCallback((id, result) => {
    setResults(previous => new Map(previous).set(id, result));
  }, []);
  const available = [];
  const pending = new Map();
  const urls = new Set();
  let failed = false;
  for (const { attachment, preview, label } of images) {
    const id = attachment?.attachmentId;
    const previous = results.get(id);
    const result = previous?.loadImage === loadImage ? previous : undefined;
    const url = preview?.url || result?.url || (attachment && loadImage.peek?.(attachment));
    if (url) {
      if (urls.has(url)) continue;
      urls.add(url);
      const name = preview?.name ?? attachment?.name;
      available.push({ id, url, name, alt: label || name, mimeType: attachment?.mediaType });
    } else if (result?.attempt === attempt) {
      failed = true;
    } else if (attachment) {
      pending.set(id, attachment);
    }
  }
  return <div className="bg-conversation-images" data-align={align}>
    {[...pending].map(([id, attachment]) => <LoadAttachment key={id} attachment={attachment}
      loadImage={loadImage} report={report} attempt={attempt} />)}
    {available.length > 0 && <ImageGallery allowBlob images={available} />}
    {pending.size > 0 && <Loading compact label="正在加载图片…" />}
    {failed && <div className="bg-conversation-images-error" role="status"><span>图片加载失败</span>
      <Button variant="ghost" size="sm" aria-label="重试加载图片" onClick={() => setAttempt(value => value + 1)}>重试</Button>
    </div>}
  </div>;
}

function ConversationImages({ images, loadImage, align, compact, thumbnail, renderFactorySlot }) {
  if (!images.length) return null;
  if (thumbnail) return renderFactorySlot('conversation.images.content', { images, loadImage, align, compact, thumbnail });
  return <MessageGallery images={images} loadImage={loadImage} align={align} />;
}

const userGalleryGroups = new WeakMap();
const emptyGroup = { images: [] };
const emptySnapshot = () => emptyGroup;
const noSubscription = () => () => {};

function userGalleryGroup(owner) {
  const existing = userGalleryGroups.get(owner);
  if (existing) return existing;
  const members = new Map(), listeners = new Set();
  let snapshot = emptyGroup;
  const group = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(node, images) {
      if (images) members.set(node, images);
      else members.delete(node);
      const ordered = [...members.keys()].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      snapshot = { first: ordered[0], images: ordered.flatMap(node => members.get(node)) };
      for (const listener of listeners) listener();
    },
  };
  userGalleryGroups.set(owner, group);
  return group;
}

function UserMessageImages({ images, loadImage, align }) {
  const [seat, setSeat] = useState(null);
  const anchor = useCallback(node => {
    if (!node) return;
    const owner = node.closest('[data-message-attachments]');
    setSeat({ node, group: owner && userGalleryGroup(owner) });
  }, []);
  const group = seat?.group;
  const message = useSyncExternalStore(group?.subscribe || noSubscription, group?.getSnapshot || emptySnapshot);
  useLayoutEffect(() => { group?.update(seat.node, images); }, [group, seat, images]);
  useLayoutEffect(() => () => { group?.update(seat.node); }, [group, seat]);
  // The official user renderer emits one image slot per attachment and owns the surrounding files.
  const visible = seat && (group ? message.first === seat.node && message.images.length > 0 : images.length > 0);
  return <div ref={anchor} className="bg-user-conversation-images" hidden={!visible}>
    {visible && <MessageGallery images={group ? message.images : images} loadImage={loadImage} align={align} />}
  </div>;
}

/** The owning session supplies the same authorized loader in every chat surface. */
export function mountConversationImages(ctx) {
  for (const name of ['conversation.chat.message.images', 'conversation.chat.user.images', 'conversation.trajectory.images', 'tool.call.images']) {
    const renderer = name === 'conversation.chat.user.images' ? UserMessageImages : ConversationImages;
    ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: 0 }, renderer)));
  }
}
