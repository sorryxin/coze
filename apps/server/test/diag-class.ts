import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
const uid = `diag_class_${Date.now()}`;

async function send({ convId, text }) {
  const u = new URL('https://api.coze.cn/v3/chat');
  u.searchParams.set('bot_id', BOT_ID);
  if (convId) u.searchParams.set('conversation_id', convId);
  const r = await fetch(u, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      bot_id: BOT_ID, user_id: uid, stream: true,
      additional_messages: [{ role: 'user', content: text, content_type: 'text' }],
      additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }],
    }),
  });
  const t = await r.text();
  return { raw: t, convId: /"conversation_id":"(\d+)"/.exec(t)?.[1] };
}

function show(label, t) {
  console.log(`\n===== ${label} (len=${t.length}) =====`);
  let n = 0;
  for (const block of t.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    if (n++ > 25) continue;
    let p = null;
    try { p = JSON.parse(data); } catch { console.log(`${ev} :: ${data.slice(0, 160)}`); continue; }
    if (ev?.includes('message.')) console.log(`${ev} type=${p.type} ${JSON.stringify(String(p.content ?? '').slice(0, 120))}`);
    else if (ev === 'error') console.log(`error ${p.code} ${p.msg}`);
    else if (ev === 'conversation.chat.requires_action') console.log(`requires_action ${JSON.stringify(p.required_action?.submit_tool_outputs?.tool_calls)}`);
    else console.log(`${ev} status=${p.status} err=${p.last_error?.msg ?? ''}`);
  }
}

const a = await send({ text: '初二数学，一次函数的图像' });
show('开课', a.raw);
const b = await send({ convId: a.convId, text: '1,3' });
show('选学生 1,3', b.raw);
const c = await send({ convId: a.convId, text: '谁来回答这道题？' });
show('课中：谁来回答这道题？', c.raw);
const d = await send({ convId: a.convId, text: '很好，小陈说得对' });
show('课中：表扬', d.raw);
