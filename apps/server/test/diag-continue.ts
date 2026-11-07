import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
const uid = `diag_cont_${Date.now()}`;

function summarize(t, limit = 10) {
  const out = [];
  let n = 0;
  for (const block of t.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    if (n++ > limit) continue;
    let p = null;
    try { p = JSON.parse(data); } catch { out.push(`${ev} ${data.slice(0, 150)}`); continue; }
    if (ev?.includes('message.')) out.push(`${ev} type=${p.type} ${String(p.content ?? '').slice(0, 70)}`);
    else if (ev === 'error') out.push(`error ${p.code} ${p.msg}`);
    else if (ev === 'conversation.chat.requires_action') out.push(`requires_action tool_calls=${JSON.stringify(p.required_action?.submit_tool_outputs?.tool_calls)}`);
    else out.push(`${ev} ${p.status ?? ''} ${p.last_error?.msg ?? ''}`);
  }
  return out;
}

// 1) 开课（会停在选学生中断）
const u = new URL('https://api.coze.cn/v3/chat');
u.searchParams.set('bot_id', BOT_ID);
const r1 = await fetch(u, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    bot_id: BOT_ID, user_id: uid, stream: true,
    additional_messages: [{ role: 'user', content: '初二数学，一次函数的图像', content_type: 'text' }],
    additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }],
  }),
});
const t1 = await r1.text();
const convId = /"conversation_id":"(\d+)"/.exec(t1)?.[1];
console.log('=== 开课 ===');
console.log(summarize(t1).join('\n'));
console.log('convId=', convId);

// 2) 把回答当作普通用户消息，继续同一个会话
const u2 = new URL('https://api.coze.cn/v3/chat');
u2.searchParams.set('bot_id', BOT_ID);
u2.searchParams.set('conversation_id', convId ?? '');
const r2 = await fetch(u2, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    bot_id: BOT_ID, user_id: uid, stream: true,
    additional_messages: [{ role: 'user', content: '1,3', content_type: 'text' }],
    additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }],
  }),
});
const t2 = await r2.text();
console.log('\n=== 用普通消息续聊 ===');
console.log('HTTP', r2.status, r2.headers.get('content-type'), 'len', t2.length);
console.log(summarize(t2).join('\n'));
