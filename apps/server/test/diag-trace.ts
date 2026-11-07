import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };

function parseEvents(raw) {
  const out = [];
  let conv = null;
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created') conv = p.conversation_id;
    out.push({ ev, p });
  }
  return { out, conv };
}

/**
 * 步骤序列，每一步都打印所有 message（含 verbose 内部状态）。
 * 目的：看清「选学生」之后到底跑到了哪些节点。
 */
const uid = process.argv[4] ?? `diag_trace_${Date.now()}`;
const name = process.argv[5] ?? 'Default';
console.log(`user_id=${uid} conversation_name=${name}`);

let convId = null;
const steps = ['初二数学，一次函数的图像', '1,3', '谁来回答这道题？'];

for (const [i, text] of steps.entries()) {
  const u = new URL('https://api.coze.cn/v3/chat');
  u.searchParams.set('bot_id', BOT_ID);
  if (convId) u.searchParams.set('conversation_id', convId);
  const res = await fetch(u, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      bot_id: BOT_ID, user_id: uid, stream: true,
      additional_messages: [{ role: 'user', content: text, content_type: 'text' }],
      additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: name }],
    }),
  });
  const raw = await res.text();
  const { out, conv } = parseEvents(raw);
  if (!convId) convId = conv;

  console.log(`\n########## step${i + 1}: 「${text}」 ##########`);
  for (const { ev, p } of out) {
    if (ev === 'conversation.message.completed') {
      if (p.type === 'answer') console.log(`  ANSWER: ${String(p.content).slice(0, 160)}`);
      else console.log(`  VERBOSE(${p.type}): ${String(p.content).slice(0, 200)}`);
    } else if (ev === 'conversation.chat.requires_action') {
      console.log(`  REQUIRES_ACTION tool_calls=${JSON.stringify(p.required_action?.submit_tool_outputs?.tool_calls)}`);
    } else if (ev === 'conversation.chat.completed' || ev === 'conversation.chat.failed') {
      console.log(`  ${ev} status=${p.status} err=${p.last_error?.msg ?? ''}code=${p.last_error?.code ?? ''}`);
    } else if (ev === 'error') {
      console.log(`  ERROR ${p.code} ${p.msg}`);
    }
  }
}
