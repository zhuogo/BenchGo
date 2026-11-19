const MAX_SOURCE = 65536;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const string = (value, name, max = 1000) => typeof value === 'string' && value.length <= max ? value : fail(`${name}必须是 ${max} 字以内的文本`);
const list = (value, name, max) => Array.isArray(value) && value.length <= max ? value : fail(`${name}必须是最多 ${max} 项的列表`);
const identifier = (value, name) => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) && !dangerous.has(value) ? value : fail(`${name}不是有效标识`);

/** Deliberately a versioned subset, not the OpenTiny component/expression protocol. */
export function parseInteractive(source) {
  if (source.length > MAX_SOURCE) fail('交互内容超过 64 KB，请让助手缩小数据范围');
  const value = JSON.parse(source, (key, val) => dangerous.has(key) ? fail('交互内容包含不支持的字段') : val);
  if (!isObject(value) || value.version !== 1) fail('不支持的交互格式，请使用 BenchGo UI version 1');
  const blocks = list(value.blocks, '内容', 12).map((block, index) => {
    if (!isObject(block)) fail('交互内容格式不正确');
    const result = { id: identifier(block.id || `block-${index}`, '内容标识'), type: block.type, title: string(block.title || '', '标题', 200) };
    if (block.type === 'form') {
      const ids = new Set();
      result.fields = list(block.fields, '表单字段', 30).map(field => {
        if (!isObject(field)) fail('表单字段格式不正确');
        const id = identifier(field.id, '字段标识');
        if (ids.has(id)) fail('表单字段标识重复'); ids.add(id);
        if (!['text', 'textarea', 'number', 'select', 'checkbox', 'date'].includes(field.type)) fail(`不支持的字段类型：${field.type}`);
        const next = { id, type: field.type, label: string(field.label, '字段名称', 200), required: field.required === true };
        if (field.placeholder !== undefined) next.placeholder = string(field.placeholder, '输入提示', 200);
        if (field.type === 'select') next.options = options(field.options);
        for (const key of ['min', 'max', 'step']) if (field[key] !== undefined) {
          if (typeof field[key] !== 'number' || !Number.isFinite(field[key]) || (key === 'step' && field[key] <= 0)) fail('数值范围无效');
          next[key] = field[key];
        }
        if (next.min > next.max) fail('最小值不能超过最大值');
        return next;
      });
      result.submitLabel = string(block.submitLabel || '发送答复', '按钮文字', 80);
    } else if (block.type === 'choices') result.options = options(block.options);
    else if (block.type === 'table') {
      result.columns = list(block.columns, '表格列', 12).map(col => string(col, '列名', 120));
      result.rows = list(block.rows, '表格数据', 200).map(row => {
        if (!Array.isArray(row) || row.length !== result.columns.length) fail('表格列数与数据不一致');
        return row.map(cell => cell === null ? null : typeof cell === 'number' && Number.isFinite(cell) ? cell : string(cell, '单元格', 1000));
      });
    } else if (block.type === 'chart') {
      if (!['bar', 'line'].includes(block.kind)) fail('图表仅支持 bar 或 line');
      result.kind = block.kind; result.unit = string(block.unit || '', '单位', 40);
      result.data = list(block.data, '图表数据', 100).map(point => {
        if (!isObject(point) || typeof point.value !== 'number' || !Number.isFinite(point.value)) fail('图表数值必须是真实有限数值');
        return { label: string(point.label, '数据名称', 120), value: point.value };
      });
    } else fail(`不支持的交互组件：${String(block.type || '未指定')}`);
    return result;
  });
  if (new Set(blocks.map(block => block.id)).size !== blocks.length) fail('内容标识重复');
  return { version: 1, title: string(value.title || '', '标题', 200), blocks };
}

function options(value) {
  const result = list(value, '选项', 30).map(option => {
    if (!isObject(option)) fail('选项格式不正确');
    return { label: string(option.label, '选项名称', 200), value: string(option.value, '选项值', 500) };
  });
  if (new Set(result.map(option => option.value)).size !== result.length) fail('选项值重复');
  return result;
}

/** Preserve ordinary fences verbatim; never activate a schema nested in a code example. */
export function splitInteractive(text, streaming = false) {
  const segments = []; let prose = '', position = 0;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (let i = 0; i < lines.length; i++) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(lines[i]);
    const tag = /^\s*<(benchgo-ui|schemaJson)>\s*(?:\r?\n)?$/.exec(lines[i]);
    if (!opening && !tag) { prose += lines[i]; position += lines[i].length; continue; }
    const language = opening?.[2].trim();
    const interactive = tag || ['benchgo-ui', 'schemaJson'].includes(language);
    const start = position; let raw = lines[i], body = '', complete = false;
    for (i++; i < lines.length; i++) {
      const close = tag ? new RegExp(`^\\s*</${tag[1]}>\\s*$`).test(lines[i].trimEnd())
        : new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`).test(lines[i].trimEnd());
      raw += lines[i];
      if (close) { complete = true; break; }
      body += lines[i];
    }
    position += raw.length;
    if (!interactive) { prose += raw; continue; }
    if (prose) { segments.push({ kind: 'markdown', text: prose }); prose = ''; }
    segments.push({ kind: 'interactive', text: body, complete, loading: !complete && streaming, key: start });
  }
  if (prose) segments.push({ kind: 'markdown', text: prose });
  return segments;
}

export const hasInteractive = text => typeof text === 'string' && splitInteractive(text).some(row => row.kind === 'interactive');

export function validateForm(block, draft) {
  const values = Object.create(null);
  for (const field of block.fields) {
    const value = draft[field.id] ?? (field.type === 'checkbox' ? false : '');
    if (field.required && (value === false || String(value).trim() === '')) fail(`请填写${field.label}`);
    if (field.type === 'checkbox') { values[field.id] = value === true; continue; }
    if (value === '') { values[field.id] = ''; continue; }
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) fail(`${field.label}超出有效数值范围`);
      if (field.step !== undefined && Math.abs((number - (field.min ?? 0)) / field.step - Math.round((number - (field.min ?? 0)) / field.step)) > 1e-8) fail(`${field.label}不符合步长 ${field.step}`);
      values[field.id] = number;
    } else {
      const text = string(value, field.label, 8000);
      if (field.type === 'select' && !field.options.some(option => option.value === text)) fail(`${field.label}包含无效选项`);
      if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text)) fail(`${field.label}不是有效日期`);
      values[field.id] = text;
    }
  }
  return values;
}

export function responseText(document, block, values) {
  const text = `交互答复：${document.title || block.title || '回复'}\n${JSON.stringify({ blockId: block.id, title: block.title, values })}`;
  if (text.length > 32000) fail('答复过长，请缩短输入后重试');
  return text;
}
