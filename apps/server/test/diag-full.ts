import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };

async function step(uid, convId, text, label) {
  const u = new URL('https://api.coze.cn/v3/chat');
  u.searchParams.set('bot_id', BOT_ID);
  if (convId) u.searchParams.set('conversation_id', convId);
  const res = await fetch(u, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      bot_id: BOT_ID, user_id: uid, stream: true,
      additional_messages: [{ role: 'user', content: text, content_type: 'text' }],
      additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }],
    }),
  });
  const raw = await res.text();
  let conv = convId;
  console.log(`\n########## ${label}: 「${text}」 ##########`);
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created') conv = p.conversation_id;
    if (ev === 'conversation.message.completed') {
      if (p.type === 'answer') console.log(`  ANSWER(id=${p.id}): ${JSON.stringify(String(p.content).slice(0, 300))}`);
      else console.log(`  VERBOSE(${p.type}): ${String(p.content).slice(0, 150)}`);
    }
    if (ev === 'conversation.chat.requires_action') console.log('  *** REQUIRES_ACTION');
  }
  return conv;
}

const uid = `full_${Date.now()}`;
let conv = await step(uid, null, '初二数学，一次函数的图像', '1 开课');
conv = await step(uid, conv, '1,3', '2 选学生');
conv = await step(uid, conv, '谁来回答这道题？', '3 课中');
conv = await step(uid, conv, '小星星你说说看', '4 课中(点名)');
