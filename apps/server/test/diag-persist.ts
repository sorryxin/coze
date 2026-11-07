import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };

async function send(uid, convId, text) {
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
  const answers = [];
  let newConv = convId;
  for (const block of t.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created' && !newConv) newConv = p.conversation_id;
    if (ev === 'conversation.message.completed' && p.type === 'answer') answers.push(String(p.content));
  }
  return { answers, convId: newConv };
}

const uid = process.argv[4] ?? `diag_persist_${Date.now()}`;
console.log('=== 用同一个 user_id 连开两节课 ===');
console.log('user_id =', uid);

// 第 1 节
let a = await send(uid, null, '初二数学，一次函数的图像');
console.log('\n[第1节] 开课:', a.answers.map((s) => s.slice(0, 40)));
let b = await send(uid, a.convId, '1,3');
console.log('[第1节] 选学生:', b.answers);

// 用完不结课，直接再开一节（换 conversation 但同 user_id）
let c = await send(uid, null, '初二数学，一次函数的图像');
console.log('\n[第2节] 开课:', c.answers.map((s) => s.slice(0, 60)));

// 再看第 2 节里选学生是否还有效
if (c.convId) {
  let d = await send(uid, c.convId, '1,3');
  console.log('[第2节] 选学生:', d.answers.map((s) => s.slice(0, 60)));
}
