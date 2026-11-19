import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRuntimeSetting, runtimeSettingFields, runtimeSettingSchemas, writeRuntimeSetting } from '../shared/runtime-setting-fields.mjs';

const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

function validField(value, field) {
  if (field.kind === 'boolean') return typeof value === 'boolean';
  if (field.kind === 'choice') return typeof value === 'string' && Object.hasOwn(field.choices, value);
  return Number.isSafeInteger(value) && value >= field.min && value <= field.max;
}

function validateFields(value, fields, path = '') {
  if (!plainObject(value)) throw new Error('Harness 配置需要对象字段 ' + path);
  for (const [key, child] of Object.entries(value)) {
    const field = path ? path + '.' + key : key;
    if (!Object.hasOwn(fields, key)) throw new Error('Harness 配置不支持字段 ' + field);
    if (fields[key].kind) {
      if (!validField(child, fields[key])) throw new Error(fields[key].label + '的值无效');
    } else validateFields(child, fields[key], field);
  }
}

export function createRuntimeSettings({ directory } = {}) {
  if (!directory) throw new TypeError('directory is required');
  const path = join(directory, 'harness-settings.json');
  const normalizeTool = tool => {
    if (typeof tool !== 'string' || !Object.hasOwn(runtimeSettingSchemas, tool)) throw new Error('不支持的 Harness');
    return tool;
  };
  const validateShape = (tool, input) => {
    if (!plainObject(input) || Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new Error('Harness 配置必须为不超过 256 KiB 的对象');
    validateFields(input, runtimeSettingSchemas[tool]);
  };
  const validate = (tool, input) => {
    validateShape(tool, input);
    if (tool === 'codex') {
      const config = input.config ?? {};
      if (config.model_auto_compact_token_limit > config.model_context_window) throw new Error('自动压缩阈值不能超过上下文窗口');
    }
    return structuredClone(input);
  };
  const read = async () => {
    try {
      const text = await readFile(path, 'utf8');
      const value = JSON.parse(text);
      if (value.version !== 1 || !plainObject(value.configs)) throw new Error('Harness 设置文件格式错误');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, configs: {} };
      throw error;
    }
  };
  const write = async value => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = path + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, path);
    } finally {
      await handle?.close();
      await rm(temp, { force: true });
    }
  };
  let queue = Promise.resolve();
  const exclusive = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  return {
    async validate(tool, input) { return validate(normalizeTool(tool), input); },
    async get(tool) {
      tool = normalizeTool(tool);
      await queue;
      const state = await read();
      return validate(tool, state.configs[tool] ?? {});
    },
    save(tool, input, changedFields) {
      return exclusive(async () => {
        tool = normalizeTool(tool);
        const state = await read();
        if (changedFields === undefined) {
          state.configs[tool] = validate(tool, input);
        } else {
          validateShape(tool, input);
          const fields = runtimeSettingFields[tool];
          if (!Array.isArray(changedFields) || !changedFields.length || changedFields.length > fields.length) {
            throw new Error('Harness 配置包含无效的修改字段');
          }
          const selected = fields.filter(field => changedFields.includes(field.key));
          if (selected.length !== changedFields.length) throw new Error('Harness 配置包含无效的修改字段');
          const config = validate(tool, state.configs[tool] ?? {});
          for (const field of selected) writeRuntimeSetting(config, field.path, readRuntimeSetting(input, field.path));
          state.configs[tool] = validate(tool, config);
        }
        await write(state);
        return structuredClone(state.configs[tool]);
      });
    },
  };
}
