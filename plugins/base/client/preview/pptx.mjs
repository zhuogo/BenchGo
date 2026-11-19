import { PptxViewer } from '@aiden0z/pptx-renderer';

// This classic-script entry runs only inside the opaque-origin preview frame.
// No dependency code or presentation DOM is evaluated in the workbench realm.
const id = document.currentScript?.dataset.previewId;
const container = document.getElementById('slides');
let viewer, controller, started = false;
const send = value => parent.postMessage({ type: 'benchgo:pptx', id, ...value }, '*');
const cleanup = () => { controller?.abort(); viewer?.destroy(); viewer = undefined; };
addEventListener('pagehide', cleanup, { once: true });
document.addEventListener('click', event => {
  if (event.target?.closest?.('a')) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener('submit', event => event.preventDefault(), true);
addEventListener('message', async event => {
  if (event.source !== parent || event.data?.id !== id) return;
  if (event.data.type === 'benchgo:pptx-theme') {
    document.body.style.background = event.data.dark === true ? '#252525' : '#eee';
    return;
  }
  if (event.data.type !== 'benchgo:pptx-open' || started) return;
  started = true;
  const bytes = event.data.bytes;
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 25 * 1024 * 1024) { send({ state: 'error', message: '演示文稿超过快览大小限制，请下载查看' }); return; }
  controller = new AbortController();
  try {
    viewer = new PptxViewer(container, {
      externalMedia: 'block', pdfjs: false, fitMode: 'contain', scrollContainer: document.scrollingElement,
      zipLimits: { maxEntries: 4096, maxEntryUncompressedBytes: 32 * 1024 * 1024, maxTotalUncompressedBytes: 64 * 1024 * 1024, maxMediaBytes: 48 * 1024 * 1024, maxConcurrency: 2 },
      embeddedFontLimits: { maxTotalDecompressedBytes: 8 * 1024 * 1024 },
    });
    await viewer.open(bytes, { signal: controller.signal, lazySlides: true, lazyMedia: true, renderMode: 'list', listOptions: { windowed: true, initialSlides: 2, batchSize: 2 } });
    send({ state: viewer.slideCount ? 'ready' : 'empty', count: viewer.slideCount, width: viewer.slideWidth, height: viewer.slideHeight });
  } catch {
    cleanup();
    send({ state: 'error', message: '演示文稿无法读取，可能已损坏、加密或超出快览限制，请下载原文件查看' });
  }
});
if (id && container) send({ state: 'waiting' });
