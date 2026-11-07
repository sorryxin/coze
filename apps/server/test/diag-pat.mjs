// 用 PAT 直连 Coze，测数据表能不能读，以及课中是否有输出
const PAT = process.env.COZE_PAT;
const BOT = process.env.COZE_BOT_ID;
const TABLE = process.argv[2] ?? '7703371797944746019';
const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

console.log('=== 1. 数据表读取 ===');
const tableAttempts = [
  { m: 'POST', p: `/v1/tables/${TABLE}/records/search`, b: { page_num: 1, page_size: 10 } },
  { m: 'POST', p: `/v1/tables/${TABLE}/records/batch_get`, b: { page_num: 1, page_size: 10 } },
  { m: 'POST', p: `/v1/databases/${TABLE}/records`, b: { page_num: 1, page_size: 10 } },
  { m: 'GET', p: `/v1/tables/${TABLE}/records?page_num=1&page_size=10` },
];
for (const a of tableAttempts) {
  const res = await fetch('https://api.coze.cn' + a.p, {
    method: a.m,
    headers: H,
    ...(a.b ? { body: JSON.stringify(a.b) } : {}),
  });
  const t = await res.text();
  console.log(`${a.m} ${a.p}\n  HTTP ${res.status} ${t.slice(0, 400)}`);
}

console.log('\n=== 2. 课中输出测试（PAT）===');
function parse(raw) {
  const answers = [], notes = [];
  let conv = null;
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created') conv = p.conversation_id;
    if (ev === 'conversation.message.completed') {
      if (p.type === 'answer') answers.push(String(p.content));
      else { try { notes.push(JSON.parse(String(p.content)).msg_type); } catch {} }
    }
  }
  return { answers, notes: [...new Set(notes)], conv };
}

async function send(uid, convId, text) {
  const u = new URL('https://api.coze.cn/v3/chat');
  u.searchParams.set('bot_id', BOT);
  if (convId) u.searchParams.set('conversation_id', convId);
  const res = await fetch(u, {
    method: 'POST',
    headers: { ...H, Accept: 'text/event-stream' },
    body: JSON.stringify({
      bot_id: BOT, user_id: uid, stream: true,
      additional_messages: [{ role: 'user', content: text, content_type: 'text' }],
      additional_params: [{ type: 'string', key: 'CONVERSATION_NAME', value: 'Default' }],
    }),
  });
  return parse(await res.text());
}

const uid = `pat_${Date.now()}`;
let conv = null;
for (const text of ['初二数学，一次函数的图像', '1,2,5', '谁来回答这道题？']) {
  const r = await send(uid, conv, text);
  conv = r.conv ?? conv;
  console.log(`「${text.slice(0, 20)}」 -> answer: ${r.answers.length ? JSON.stringify(r.answers.map((s) => s.slice(0, 50))) : '(空)'}  notes: ${r.notes}`);
}
