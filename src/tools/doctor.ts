import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

function resultText(value: unknown): string {
  const result = CallToolResultSchema.parse(value);
  const content = result.content.find(item => item.type === 'text');
  if (!content || content.type !== 'text') throw new Error('Missing tool text response');
  return content.text;
}

const diagnosticCall = z.object({
  name: z.enum(['chatgpt_status', 'chatgpt_list_conversations', 'chatgpt_get_conversation',
    'chatgpt_list_projects', 'chatgpt_list_project_conversations', 'chatgpt_record_start',
    'chatgpt_record_finish', 'chatgpt_preview_changes', 'chatgpt_execute_plan']),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const client = new Client({ name: 'organizer-doctor', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../index.js', import.meta.url))],
  env: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)),
  stderr: 'inherit',
});
let rl: Interface | undefined;
try {
  await client.connect(transport);
  const opened = await client.callTool({ name: 'chatgpt_open_browser', arguments: {} });
  console.log(resultText(opened));
  if (opened.isError) process.exitCode = 1;
  else {
    console.log('按返回提示完成登录并关闭专用登录窗口。按回车连接并执行只读检查；输入 exit 退出。');
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    for await (const line of rl) {
      if (line.trim() === 'exit') break;
      if (line.startsWith('call ')) {
        try {
          const request = diagnosticCall.parse(JSON.parse(line.slice(5)));
          const result = await client.callTool(request);
          console.log(resultText(result));
        } catch { console.log('诊断指令无效。'); }
        continue;
      }
      const connected = await client.callTool({ name: 'chatgpt_open_browser', arguments: {} });
      if (connected.isError) { console.log(resultText(connected)); continue; }
      const status = await client.callTool({ name: 'chatgpt_status', arguments: {} });
      console.log(resultText(status));
      if (!z.object({ logged_in: z.boolean().optional() }).parse(JSON.parse(resultText(status))).logged_in) continue;
      const result = await client.callTool({ name: 'chatgpt_list_conversations', arguments: { limit: 1 } });
      if (result.isError) console.log(resultText(result));
      else {
        const data = z.object({ items: z.array(z.unknown()), total_hint: z.number().nullable(), total_is_exact: z.boolean() }).parse(JSON.parse(resultText(result)));
        console.log(JSON.stringify({ live_read_verified: true, returned_count: data.items.length, total_hint: data.total_hint, total_is_exact: data.total_is_exact }));
      }
    }
  }
} finally {
  rl?.close();
  await client.close();
}
