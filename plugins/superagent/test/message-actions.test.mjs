import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/message-actions.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
function render({ panel = '', saved = null, usage, clipboard = async () => true } = {}) {
  let index = 0;
  const changes = [], calls = [];
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) }), useState: value => { const slot = index++; return [slot === 0 ? panel : value, next => changes.push([slot, next])]; }, useRef: () => ({ current: null }), useEffect() {} };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, document: { body: {} }, setTimeout: () => 1, clearTimeout() {}, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id === 'react-dom' ? { createPortal: content => content } : id === 'react' ? react : { writeClipboard: clipboard, useAnchoredPosition: () => null, useDismissOnOutsidePointer() {} } });
  const tree = module.exports.MessageActions({ row: { key: 'message:m', role: 'assistant', text: '结果', usage }, home: { threadId: 'side', history: { reactions: { 'message:m': saved } }, api: async (...args) => calls.push(args) } });
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
  return { nodes: walk(tree), calls, changes };
}
test('reaction toggle uses source-bound durable endpoint and never sends chat text', async () => {
  for (const saved of [null, '👍']) {
    const { nodes, calls } = render({ panel: 'reactions', saved });
    await nodes.find(node => node.props['aria-label'] === '回应 👍').props.onClick();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['messageReaction', { threadId: 'side', messageKey: 'message:m', emoji: saved ? null : '👍' }]]);
  }
});
test('copy uses plain message text and reports clipboard failure', async () => {
  let copied;
  const { nodes, changes } = render({ clipboard: async text => { copied = text; return false; } });
  await nodes.find(node => node.props['aria-label'] === '复制消息').props.onClick();
  assert.equal(copied, '结果');
  assert(changes.some(([slot, value]) => slot === 2 && value === '复制失败，请重试'));
});
test('usage keeps real zero and does not fabricate missing or invalid counts', () => {
  const missing = render({ panel: 'usage' });
  assert(missing.nodes.some(node => node.children.includes('未记录用量')));
  const present = render({ panel: 'usage', usage: { inputTokens: 0, outputTokens: 12, totalTokens: NaN, cacheReadTokens: -1 } });
  const values = present.nodes.filter(node => node.type === 'dd').flatMap(node => node.children);
  assert.deepEqual(values, ['0', '12']);
});
