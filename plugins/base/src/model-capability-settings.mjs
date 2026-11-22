import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { isModelCapability, normalizeModelCapabilities } from '../shared/model-capabilities.mjs';

const field = value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
const tags = value => Array.isArray(value) && value.length <= 32 && value.every(isModelCapability);

export function createModelCapabilitySettings(directory) {
  const path = directory && join(directory, 'model-capabilities.json');
  const read = async () => {
    if (!path) return [];
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every(row => field(row?.providerId) && field(row?.modelId) && tags(row?.capabilities))) throw Error('模型能力配置格式无效');
      return value.entries.map(row => ({ ...row, capabilities: normalizeModelCapabilities(row.capabilities) }));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    async list(providerId) {
      return (await read()).filter(row => row.providerId === providerId).map(({ modelId, capabilities }) => ({ modelId, capabilities }));
    },
    async save(providerId, modelId, capabilities) {
      if (!path) throw Object.assign(Error('模型能力配置存储尚未就绪'), { status: 503 });
      if (!field(providerId) || !field(modelId) || (capabilities !== null && !tags(capabilities))) throw Error('模型能力配置无效');
      return withFileLock(path, async () => {
        const entries = (await read()).filter(row => row.providerId !== providerId || row.modelId !== modelId);
        const selected = capabilities === null ? null : normalizeModelCapabilities(capabilities);
        if (selected !== null) entries.push({ providerId, modelId, capabilities: selected });
        await writeFileAtomic(path, JSON.stringify({ version: 1, entries }, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 });
        return { modelId, capabilities: selected };
      });
    },
  };
}
