import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const walk = node => node && typeof node === 'object' && node.props ? [node, ...(node.children || []).flatMap(walk)] : [];
function harness(file, initial) {
  let cursor = 0; const hooks = [...initial];
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), useId: () => 'test', useEffect() {}, useRef(value) { const at = cursor++; return hooks[at] ||= { current: value }; }, useState(value) { const at = cursor++; if (!(at in hooks)) hooks[at] = typeof value === 'function' ? value() : value; return [hooks[at], next => { hooks[at] = typeof next === 'function' ? next(hooks[at]) : next; }]; } };
  const module = { exports: {} }, ArtifactPreview = () => null;
  runInNewContext(transformSync(readFileSync(new URL('../client/' + file, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, { module, exports: module.exports, requestAnimationFrame: callback => callback(), require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id === 'react' ? react : { ArtifactPreview } });
  return { render(name) { cursor = 0; return walk(module.exports[name]({ api() {} })); }, ArtifactPreview };
}
test('artifact names open the shared preview and returning restores the trigger', () => {
  const file = { name: 'report.docx', url: 'api/file', bytes: 42 }, page = { artifacts: [file], total: 1 };
  const h = harness('artifacts.jsx', ['document', page, false, '']);
  const nodes = h.render('Artifacts');
  const details = nodes.find(node => node.type?.name === 'FileDetails');
  let focused = false;
  details.props.onOpen({ currentTarget: { focus() { focused = true; } } });
  const preview = h.render('Artifacts').find(node => node.type === h.ArtifactPreview);
  assert.equal(preview.props.file, file);
  preview.props.onClose();
  assert.equal(focused, true);
  assert.equal(h.render('Artifacts').some(node => node.type === h.ArtifactPreview), false);
});
test('system file selection reuses preview without a second text-read request', () => {
  const file = { name: 'report.xlsx', path: 'report.xlsx', url: 'api/system-file', type: 'file', bytes: 42 };
  const h = harness('system-files.jsx', ['', 0, { entries: [file] }, '']);
  const entry = h.render('SystemFiles').find(node => node.props.className === 'ba-system-entry');
  entry.props.onClick({ currentTarget: { focus() {} } });
  assert.equal(h.render('SystemFiles').find(node => node.type === h.ArtifactPreview).props.file, file);
});
