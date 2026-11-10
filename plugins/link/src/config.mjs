import { isIP } from 'node:net';
import { hostname } from 'node:os';

export const LINK_DEFAULTS = Object.freeze({ enabled: true, host: '0.0.0.0', port: 48721, publicUrl: '' });
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效的 ${name}`);
  return value.trim();
};
export const validateLinkName = value => text(value, '设备名称', 100);
export const defaultLinkTransport = () => ({ ...LINK_DEFAULTS, name: hostname().trim().slice(0, 100) || 'BenchGo' });
export const LINK_TRANSPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['enabled', 'host', 'port', 'publicUrl', 'name'],
  properties: {
    enabled: { type: 'boolean', const: true, description: 'Link 随模块常驻，停用请使用模块管理' },
    host: { type: 'string', minLength: 1, description: 'IP 地址或 localhost' },
    port: { type: 'integer', minimum: 0, maximum: 65535 },
    publicUrl: { type: 'string', description: '空字符串或不含路径的 HTTPS origin' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
  },
};
export const LINK_RELAY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['nodes'],
  properties: { nodes: { type: 'array', maxItems: 8, items: {
    type: 'object', additionalProperties: false, required: ['id', 'url', 'priority', 'enabled'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 128 },
      url: { type: 'string', minLength: 1, maxLength: 2048 },
      token: { type: 'string', minLength: 6, maxLength: 256, writeOnly: true },
      priority: { type: 'integer' }, enabled: { type: 'boolean' },
    },
  } } },
};

export function validateLinkTransport(input, prior) {
  const value = { ...prior };
  for (const key of ['enabled', 'host', 'port', 'publicUrl']) if (input[key] !== undefined) value[key] = input[key];
  if (typeof value.enabled !== 'boolean') throw new Error('启用状态必须是布尔值');
  value.enabled = true;
  if (!isIP(value.host) && value.host !== 'localhost') throw new Error('监听地址必须是 IP 或 localhost');
  if (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535) throw new Error('端口必须在 0 至 65535 之间');
  if (typeof value.publicUrl !== 'string') throw new Error('公网地址无效');
  value.publicUrl = value.publicUrl.trim().replace(/\/$/, '');
  if (value.publicUrl) {
    const url = new URL(value.publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请输入 HTTPS 公网地址，例如 https://desk.example.com，不包含子路径');
    value.publicUrl = url.origin;
  }
  if (input.name !== undefined) value.name = validateLinkName(input.name);
  return value;
}

export function normalizeLinkRelayPool(nodes, previousNodes = []) {
  if (!Array.isArray(nodes) || nodes.length > 8) throw new Error('中继池节点数量无效');
  return nodes.map((node, index) => {
    const previous = previousNodes.find(item => item.id === node.id);
    const url = text(node.url || previous?.url, '中继地址', 2048), token = text(node.token || previous?.token, '中继主机密钥', 256);
    let parsed; try { parsed = new URL(url); } catch { throw new Error('中继地址无效'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== url || parsed.username || parsed.password) throw new Error('中继必须使用独立 HTTPS origin');
    if (token.length < 6) throw new Error('中继主机密钥至少需要 6 个字符');
    return { id: text(node.id || `relay-${index + 1}`, '中继 ID', 128), url, token, priority: Number.isInteger(node.priority) ? node.priority : index, enabled: node.enabled !== false };
  });
}
