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
      additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: `conv_${uid}` }],
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
      else {
        try {
          const inner = JSON.parse(String(p.content));
          verbose.push(inner.msg_type);
        } catch { verbose.push(String(p.content).slice(0, 30)); }
      }
    }
  }
  return { answers, verbose, convId: newConv };
}

const uid = `diag_seq_${Date.now()}`;
const convName = `conv_${uid}`;
console.log('user_id =', uid, ' CONVERSATION_NAME =', convName);

const steps = ['初二数学，一次函数的图像', '1,3', '我们来讲一次函数的图像，先画出 y=2x+1 这条直线', '谁来回答这道题？'];
let convId = null;
for (const [i, text] of steps.entries()) {
  const r = await send(uid, convId, text);
  convId = r.convId;
  console.log(`\n[step${i + 1}] 输入「${text.slice(0, 30)}」convId=${convId}`);
  console.log('  answer:', r.answers.length ? r.answers.map((s) => s.slice(0, 60)) : '(空)');
  console.log('  verbose:', [...new Set(r.verbose)]);
}

// 换一个新 conversation（同 user_id），再发课中消息，看变量是否跨会话延续
console.log('\n--- 换新 conversation，同 user_id ---');
const r2 = await send(uid, null, '谁来回答这道题？');
console.log('  answer:', r2.answers.length ? r2.answers.map((s) => s.slice(0, 80)) : '(空)');
console.log('  verbose:', [...new Set(r2.verbose)]);
