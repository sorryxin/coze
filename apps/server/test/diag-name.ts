import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };

// 用不同的 CONVERSATION_NAME 试启动节点参数是否真的生效
async function send(uid, convId, text, convName) {
  const u = new URL('https://api.coze.cn/v3/chat');
  u.searchParams.set('bot_id', BOT_ID);
  if (convId) u.searchParams.set('conversation_id', convId);
  const r = await fetch(u, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      bot_id: BOT_ID, user_id: uid, stream: true,
      additional_messages: [{ role: 'user', content: text, content_type: 'text' }],
      additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: convName }],
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

const uid = `diag_name_${Date.now()}`;
const name = 'ShadowClass';
console.log('user_id =', uid, 'name =', name);
let convId = null;
for (const text of ['初二数学，一次函数的图像', '1,3', '谁来回答这道题？']) {
  const r = await send(uid, convId, text, name);
  convId = r.convId;
  console.log(`「${text.slice(0, 20)}」->`, r.answers.length ? r.answers.map((s) => s.slice(0, 50)) : '(空)');
}
