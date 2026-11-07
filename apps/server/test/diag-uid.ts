import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOOT_ID!;
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
  const verbose = [];
  let newConv = convId;
  for (const block of t.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created' && !newConv) newConv = p.conversation_id;
    if (ev === 'conversation.message.completed') {
      if (p.type === 'answer') answers.push(String(p.content));
      else verbose.push(String(p.content).slice(0, 80));
    }
  }
  return { answers, verbose, convId: newConv };
}

// 关键：同一个 user_id 换新 conversation，变量应当延续
const uid = process.argv[4] ?? `diag_uid_${Date.now()}`;
console.log('user_id =', uid);

const a = await send(uid, null, '初二数学，一次函数的图像');
console.log('\n[会话A] 开课:', a.answers.map((s) => s.slice(0, 30)));
const b = await send(uid, a.convId, '1,3');
console.log('[会话A] 选学生:', b.answers);

console.log('\n[会话A] 课中一轮（变量应已就位）');
for (const text of ['我们来讲一次函数的图像，先画出 y=2x+1 这条直线', '谁来回答这道题？']) {
  const r = await send(uid, a.convId, text);
  console.log(`  输入「${text}」`);
  console.log('    answer:', r.answers.length ? r.answers.map((s) => s.slice(0, 80)) : '(空)');
  if (r.verbose.length) console.log('    verbose:', [...new Set(r.verbose)]);
}
