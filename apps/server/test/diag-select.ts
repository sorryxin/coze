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
  const res = await fetch(u, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      bot_id: BOT_ID, user_id: uid, stream: true,
      additional_messages: [{ role: 'user', content: text, content_type: 'text' }],
      additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }],
    }),
  });
  const raw = await res.text();
  const answers = [], notes = [];
  let conv = convId, chatId = null;
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created') { conv = p.conversation_id; chatId = p.id; }
    if (ev === 'conversation.message.completed') {
      if (p.type === 'answer') answers.push(String(p.content));
      else { try { notes.push(JSON.parse(String(p.content)).msg_type); } catch {} }
    }
    if (ev === 'conversation.chat.requires_action') notes.push('REQUIRES_ACTION');
  }
  return { answers, notes: [...new Set(notes)], conv, chatId };
}

const uid = `diag_sel_${Date.now()}`;
console.log('user_id =', uid, '\n');

const a = await send(uid, null, '初二数学，一次函数的图像');
console.log('[1] 开课     :', a.answers.map((s) => s.slice(0, 20)), a.notes);

// 分别试三种提交格式，看哪种能让链路继续（后续有 answer 输出）
const variants = [
  { label: '逗号无空格 "1,2,5"', text: '1,2,5' },
  { label: '带空格 "1 2 5"', text: '1 2 5' },
  { label: '中文解释 "我选1号2号和5号"', text: '我选1号、2号和5号' },
];

for (const v of variants) {
  const uidv = uid + '_' + v.label.length;
  const open = await send(uidv, null, '初二数学，一次函数的图像');
  const b = await send(uidv, open.conv, v.text);
  console.log(`[2] ${v.label}`);
  console.log('    选学生后:', b.answers.map((s) => s.slice(0, 40)), '| notes:', b.notes);
  if (b.answers.length === 0) {
    console.log('    → 选学生没有产生任何回答');
    continue;
  }
  const c = await send(uidv, b.conv, '谁来回答这道题？');
  console.log('    课中一轮:', c.answers.length ? c.answers.map((s) => s.slice(0, 60)) : '(空)', '| notes:', c.notes);
}
