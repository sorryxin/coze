import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
const uid = `diag_kp_${Date.now()}`;

async function send(convId, text) {
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

function answers(t) {
  const out = [];
  for (const block of t.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    if (ev !== 'conversation.message.completed') continue;
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    try {
      const p = JSON.parse(data);
      if (p.type === 'answer') out.push(String(p.content));
    } catch {}
  }
  return out;
}

const a = await send(null, '初二数学，一次函数的图像');
console.log('开课回复：', answers(a.raw).map((s) => s.slice(0, 40)));
const b = await send(a.convId, '1,3');
console.log('开课就绪：', answers(b.raw));

// 用工作流自己列出的知识点原文，保证与 names 强相关
const probes = [
  '我们来讲一次函数的图像，先画出 y=2x+1 这条直线',
  '一次函数的图像是什么形状？',
  '谁知道一次函数的图像怎么画？',
];
for (const p of probes) {
  const r = await send(a.convId, p);
  const ans = answers(r.raw);
  console.log(`\n输入：${p}`);
  console.log('输出：', ans.length ? ans.map((s) => s.slice(0, 120)) : '(空)');
}
