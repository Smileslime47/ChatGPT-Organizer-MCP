import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('compiled command preserves the executable entry point', async () => {
  const cli = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.ok(cli.startsWith('#!/usr/bin/env node\n'));
});

for (const entry of ['../dist/index.js', '../src/index.js']) {
for (const mode of [undefined, 'playwright', 'chrome']) {
test(`stdio handshake, discovery and validation through ${entry} (${mode ?? 'default standalone'})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'organizer-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL(entry, import.meta.url))], cwd: directory, env: { CHATGPT_DATA_DIR: directory, ...(mode ? { CHATGPT_TRANSPORT: mode } : {}) }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'organizer-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  assert.equal(tools.find(t => t.name === 'chatgpt_execute_plan').annotations.destructiveHint, true);
  const status = await client.callTool({ name: 'chatgpt_status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).browser_open, false);
  const missing = await client.callTool({ name: 'chatgpt_list_conversations', arguments: {} });
  assert.equal(missing.isError, true);
  assert.equal(JSON.parse(missing.content[0].text).code, 'LOGIN_REQUIRED');
  const invalid = await client.callTool({ name: 'chatgpt_get_conversation', arguments: { conversation_id: '../../api/auth/session' } });
  assert.equal(invalid.isError, true);
  assert.equal(stderr, '');
});
}
}
