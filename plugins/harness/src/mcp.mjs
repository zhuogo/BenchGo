import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { delegationSchema } from './delegation.mjs';
// Spawned only by the native engine. Capabilities arrive through its private environment.
const mediaOnly = process.argv.includes('--media-only');
const privateURL = process.env.COMMANDER_DELEGATE_URL;
const headers = { authorization: 'Bearer ' + process.env.COMMANDER_DELEGATE_TOKEN, 'content-type': 'application/json' };
const transportId = randomUUID();
const mediaCalls = new Map();
const knownMediaTools = new Set();
const delegationTool = { name: 'commander_delegate', description: 'Delegate to another API-backed coding engine in this same project. Select provider, configured API provider ID and exact model ID. Repeated calls for the same task in this turn reuse the same child execution. Returns child result; if pending, call again with operation=result and sessionId to read it. Do not resubmit.', inputSchema: delegationSchema };

async function listTools() {
  try {
    const response = await fetch(new URL('/media/tools', privateURL), { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('BenchGo media tool discovery failed');
    const tools = (await response.json()).map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }));
    knownMediaTools.clear();
    for (const tool of tools) knownMediaTools.add(tool.name);
    return mediaOnly ? tools : [delegationTool, ...tools];
  } catch (error) {
    if (mediaOnly) throw error;
    return [delegationTool];
  }
}

async function toolCall(id, params) {
  if (!mediaOnly && params.name === delegationTool.name) {
    const response = await fetch(privateURL, { method: 'POST', headers, body: JSON.stringify(params.arguments), signal: AbortSignal.timeout(240000) });
    return { content: [{ type: 'text', text: JSON.stringify(await response.json()) }], isError: !response.ok };
  }
  if (!knownMediaTools.has(params.name)) {
    await listTools();
    if (!knownMediaTools.has(params.name)) throw new Error('Unsupported MCP method');
  }
  const controller = new AbortController();
  mediaCalls.set(id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(240000)]);
  try {
    const body = JSON.stringify({ name: params.name, args: params.arguments ?? {}, callId: transportId + ':' + JSON.stringify(id) });
    const response = await fetch(new URL('/media/call', privateURL), { method: 'POST', headers, body, signal });
    return { content: [{ type: 'text', text: JSON.stringify(await response.json()) }], isError: !response.ok };
  } finally {
    mediaCalls.delete(id);
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  void (async () => {
    let m;
    try {
      m = JSON.parse(line);
      if (m.method === 'notifications/cancelled') { mediaCalls.get(m.params?.requestId)?.abort(); return; }
      if (m.id === undefined) return;
      let result;
      if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'BenchGo', version: '0.2.0' } };
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: await listTools() };
      else if (m.method === 'tools/call') result = await toolCall(m.id, m.params);
      else throw new Error('Unsupported MCP method');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    } catch (error) { if (m?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: error.message } }) + '\n'); }
  })();
}
