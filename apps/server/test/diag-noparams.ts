import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };

function parse(raw) {
  const events = [];
  let conv = null;
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created') conv = p.conversation_id;
    events.push({ ev, p });
  }
  return { events, conv };
}

async function send({ uid, convId, text, withParams }) {
  const u = new URL('https://api.coze.cn/v3/chat');
  u.searchParams.set('bot_id', BOT_ID);
  if (convId) u.searchParams.set('conversation_id', convId);
  const body = {
    bot_id: BOT_ID, user_id: uid, stream: true,
    additional_messages: [{ role: 'user', content: text, content_type: 'text' }],
  };
  if (withParams) body.additional_params = [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }];
  const res = await fetch(u, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return parse(await res.text());
}

function summarize(label, events) {
  const answers = [], notes = [];
  for (const { ev, p } of events) {
    if (ev === 'conversation.message.completed') {
      if (p.type === 'answer') answers.push(String(p.content));
      else { try { notes.push(JSON.parse(String(p.content)).msg_type); } catch {} }
    }
    if (ev === 'conversation.chat.requires_action') notes.push('REQUIRES_ACTION');
  }
  console.log(`\n[${label}]`);
  console.log('  answer:', answers.length ? answers.map((s) => s.slice(0, 60)) : '(空)');
  console.log('  notes :', [...new Set(notes)]);
  return answers;
}

// 对照组：完全不传 additional_params
for (const withParams of [false, true]) {
  const uid = `diag_np_${Date.now()}_${withParams ? 'p' : 'n'}`;
  console.log(`\n############ additional_params = ${withParams} ############`);
  const a = await send({ uid, convId: null, text: '初二数学，一次函数的图像', withParams });
  summarize('开课', a.events);
  const b = await send({ uid, convId: a.conv, text: '1,2,5', withParams });
  summarize('选学生 1,2,5', b.events);
  const c = await send({ uid, convId: b.conv ?? a.conv, text: '谁来回答这道题？', withParams });
  summarize('课中一轮', c.events);
}
