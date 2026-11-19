import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVoiceConversationPrompt } from '../src/conversation-prompt.mjs';

test('conversation prompt is loaded from the shipped authoritative document', async () => {
  const document = await readFile(new URL('../prompts/conversation.md', import.meta.url), 'utf8');
  assert.equal(readVoiceConversationPrompt(), document.trim());
  assert.ok(readVoiceConversationPrompt().length > 0);
});

test('the same prompt reader observes updates without reimporting its module', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-voice-prompt-update-'));
  try {
    const source = join(directory, 'conversation.md');
    await writeFile(source, '  first prompt\n');
    assert.equal(readVoiceConversationPrompt(source), 'first prompt');
    await writeFile(source, 'updated prompt\n');
    assert.equal(readVoiceConversationPrompt(source), 'updated prompt');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('conversation prompt source failures are explicit instead of using an empty fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-voice-prompt-'));
  try {
    assert.throws(() => readVoiceConversationPrompt(join(directory, 'missing.md')), { code: 'VOICE_CONVERSATION_PROMPT_UNAVAILABLE' });
    const empty = join(directory, 'empty.md');
    await writeFile(empty, '  \n\t\n');
    assert.throws(() => readVoiceConversationPrompt(empty), { code: 'VOICE_CONVERSATION_PROMPT_INVALID' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
