import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2];
const BOT_ID = process.argv[3];
const UID = process.argv[4] ?? `diag_${Date.now()}`;
const TEXT = process.argv[5] ?? '初二数学，一次函数的图像';

const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();

const url = new URL('https://api.coze.cn/v3/chat');
url.searchParams.set('bot_id', BOT_ID);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  },
  body: JSON.stringify({
    bot_id: BOT_ID,
    user_id: UID,
    stream: true,
    additional_messages: [{ role: 'user', content: TEXT, content_type: 'text' }],
    additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }],
  }),
});

console.log('UID', UID);
const raw = await res.text();

const events = [];
for (const block of raw.split('\n\n')) {
  const lines = block.split('\n');
  const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
  const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  if (!ev && !data) continue;
  events.push({ ev, data });
}

const counts = {};
for (const e of events) counts[e.ev] = (counts[e.ev] ?? 0) + 1;
console.log('事件计数', JSON.stringify(counts));

for (const e of events) {
  if (e.data === '[DONE]') continue;
  let p;
  try {
    p = JSON.parse(e.data);
  } catch {
    continue;
  }
  if (e.ev === 'conversation.message.completed' || e.ev === 'conversation.message.delta') {
    if (p.type === 'answer') console.log(`  [${e.ev}] answer: ${String(p.content).slice(0, 50)}`);
    else console.log(`  [${e.ev}] type=${p.type} content=${String(p.content).slice(0, 200)}`);
  } else if (e.ev === 'conversation.chat.requires_action') {
    console.log('  [requires_action] 完整 payload:');
    console.log(JSON.stringify(p, null, 2));
  } else if (e.ev === 'conversation.chat.completed' || e.ev === 'conversation.chat.failed') {
    console.log(`  [${e.ev}] status=${p.status} last_error=${JSON.stringify(p.last_error)}`);
  } else {
    console.log(`  [${e.ev}] id=${p.id} conv=${p.conversation_id}`);
  }
}
