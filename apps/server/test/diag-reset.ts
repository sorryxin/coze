import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOOT_ID!;
const UID = process.argv[4]; // 要复位的 teacherId / user_id
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };

async function send(text) {
  const u = new URL('https://api.coze.cn/v3/chat');
  u.searchParams.set('bot_id', BOT_ID);
  const res = await fetch(u, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      bot_id: BOT_ID, user_id: UID, stream: true,
      additional_messages: [{ role: 'user', content: text, content_type: 'text' }],
      additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }],
    }),
  });
  const raw = await res.text();
  const answers = [];
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    try {
      const p = JSON.parse(data);
      if (ev === 'conversation.message.completed' && p.type === 'answer') answers.push(String(p.content));
    } catch {}
  }
  return answers;
}

for (const t of ['下课', '是', '是', '否']) {
  const a = await send(t);
  console.log(`「${t}」 -> ${a.length ? a.map((x) => x.slice(0, 60)) : '(空)'}`);
  await new Promise((r) => setTimeout(r, 3000));
}
