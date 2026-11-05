import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { normalizeTicketTitle, TICKET_TITLE_MAX_CHARS } from '../src/ticket-title.mjs';

test('ticket titles retain the AI label and cap it at ten Unicode characters', () => {
  assert.equal(TICKET_TITLE_MAX_CHARS, 10);
  assert.equal(normalizeTicketTitle('今日新闻摘要', '调查今天新闻的完整任务'), '今日新闻摘要');
  assert.equal(normalizeTicketTitle('一二三四五六七八九十十一'), '一二三四五六七八九十');
  const title = normalizeTicketTitle('😀一二三四五六七八九十');
  assert.equal(title, '😀一二三四五六七八九');
  assert.equal(Array.from(title).length, TICKET_TITLE_MAX_CHARS);
});

test('legacy missing titles use a short display fallback without changing task requirements', () => {
  const ticket = { target: '请调研今天的国内外新闻并整理六到十条摘要', acceptance: '注明来源和时间，保持六到十条，并且不要求产物文件。' };
  const before = structuredClone(ticket);
  const title = normalizeTicketTitle(undefined, ticket.target);
  assert.equal(title, Array.from(ticket.target).slice(0, 10).join(''));
  assert.deepEqual(ticket, before);
  assert.equal(normalizeTicketTitle(' \n\t ', ticket.target), title);
  assert.equal(normalizeTicketTitle(null, null), '未命名工单');
});

test('ticket titles collapse whitespace and remove control characters before limiting', () => {
  assert.equal(normalizeTicketTitle(' \t今日\n新闻\u0000摘要\u007f '), '今日 新闻 摘要');
  assert.equal(normalizeTicketTitle(123, '  任务\r\n进展  '), '任务 进展');
});

test('persisted titles stay separate from full target and acceptance, including legacy rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-ticket-title-'));
  const filename = join(directory, 'assistant.db');
  let database = createAssistantOrchestrationStore({ filename });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const target = '请调研2026年11月4日新闻热点，提供六到十条中文摘要并注明来源与时间。';
  const acceptance = '政治经济、科技和社会民生均需覆盖；区分多源与单源；无需生成文件。';
  const ticket = database.createTicket({ threadId: 'thread', title: '😀一二三四五六七八九十', target, acceptance, mandate: {} });
  assert.equal(ticket.title, '😀一二三四五六七八九');
  const renamed = database.updateTicket(ticket.id, { title: '今日新闻摘要汇总与来源核对' });
  assert.equal(renamed.title, '今日新闻摘要汇总与来');
  assert.equal(renamed.instructionRevision, ticket.instructionRevision);
  database.close();
  const raw = new DatabaseSync(filename);
  try {
    const saved = raw.prepare('SELECT title,target,acceptance FROM sa_tickets WHERE id=?').get(ticket.id);
    assert.equal(saved.title, renamed.title);
    assert.equal(saved.target, target);
    assert.equal(saved.acceptance, acceptance);
    raw.prepare("UPDATE sa_tickets SET title='' WHERE id=?").run(ticket.id);
  } finally { raw.close(); }
  database = createAssistantOrchestrationStore({ filename });
  const legacy = database.getTicket(ticket.id);
  assert.equal(legacy.title, Array.from(target).slice(0, 10).join(''));
  assert.equal(legacy.target, target);
  assert.equal(legacy.acceptance, acceptance);
  assert.equal(legacy.mandate.target, target);
  assert.equal(legacy.mandate.acceptance, acceptance);
});
