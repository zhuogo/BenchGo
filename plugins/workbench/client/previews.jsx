import React from 'react';
import * as audio from 'benchgo-workbench-vendor:audio';
import * as video from 'benchgo-workbench-vendor:video';
import { ArtifactPreview } from '../../shared/client/artifact-preview.jsx';
import { contextFacade } from '../src/boundary.mjs';
import css from './previews.css';

export function workbenchFileUrl(service, scope, path) {
  if (!scope?.sessionId || typeof path !== 'string' || !path) throw new Error('请先打开文件所属的项目对话');
  const query = new URLSearchParams({ sessionId: scope.sessionId, path });
  return service.hostRouteUrl(`api/benchgo/workbench/media?${query}`);
}

export function WorkbenchFilePreview({ service, scope, path, title, kind }) {
  let url;
  try { url = workbenchFileUrl(service, scope, path); }
  catch (error) { return <div className="bg-workbench-preview-state" role="alert">{error.message}</div>; }
  return <div className="bg-workbench-preview"><style>{css}</style><ArtifactPreview embedded file={{ name: path.split(/[\\/]/).at(-1) || title, url, pdfUrl: false, kind }} /></div>;
}

/** One registry and lifecycle for built-in document and media viewers. */
export function mountWorkbenchPreviews(ctx, service) {
  const registry = new Proxy(service, { get(target, key) {
    if (key === 'registerFileViewer') return descriptor => {
      const { settings, ...builtin } = descriptor;
      if (descriptor.id === 'video') {
        builtin.title = '视频';
        builtin.priority = 40; // Ogg audio is claimed by the higher-priority audio viewer.
        builtin.component = props => <WorkbenchFilePreview {...props} service={service} kind="video" />;
      }
      return target.registerFileViewer(builtin);
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const face = contextFacade(ctx, { betterSidebar: registry });
  audio.apply(face);
  video.apply(face);
  for (const descriptor of [
    { id: 'benchgo-document', title: '文档', exts: ['docx', 'doc', 'odt', 'rtf'] },
    { id: 'benchgo-spreadsheet', title: '表格', exts: ['xlsx', 'xls', 'csv', 'tsv'] },
    { id: 'benchgo-presentation', title: '演示文稿', exts: ['pptx', 'ppt'] },
    { id: 'benchgo-pdf', title: 'PDF', exts: ['pdf'] },
  ]) ctx.effect(() => service.registerFileViewer({ ...descriptor, priority: 60, fetchStrategy: 'none', component: props => <WorkbenchFilePreview {...props} service={service} /> }));
}
