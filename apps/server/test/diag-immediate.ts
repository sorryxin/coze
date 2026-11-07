import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const BOT_ID = process.argv[3] ?? process.env.COZE_BOOT_ID!;
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };

const log = [];
function L(s) { log.push(s); console.log(s); }

function parse(raw) {
  const events = [];
  let conv = null, chatId = null;
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created') { conv = p.conversation_id; chatId = p.id; }
    events.push({ ev, p });
  }
  return { events, conv, chatId };
}

async function startChat({ uid, convId, text }) {
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
  return parse(await res.text());
}

const uid = `diag_imm_${Date.now()}`;
L(`user_id=${uid}`);

// 第 1 步：开课，期望停在选学生中断
const a = await startChat({ uid, convId: null, text: '初二数学，一次函数的图像' });
L('\n=== step1 开课 ===');
for (const { ev, p } of a.events) {
  if (ev === 'conversation.message.completed' && p.type === 'answer') L(`  ANSWER: ${String(p.content).slice(0, 40)}`);
  if (ev === 'conversation.chat.requires_action') L(`  *** REQUIRES_ACTION chatId=${p.id} status=${p.status}`);
  if (ev === 'conversation.chat.completed') L(`  chat.completed status=${p.status}`);
}
L(`  convId=${a.conv} chatId=${a.chatId}`);

// 第 2 步：立刻提交 1,2,5（同一 conversation）
L('\n=== step2 立刻提交 1,2,5 ===');
const b = await startChat({ uid, convId: a.conv, text: '1,2,5' });
for (const { ev, p } of b.events) {
  if (ev === 'conversation.message.completed') {
    if (p.type === 'answer') L(`  ANSWER: ${String(p.content).slice(0, 120)}`);
    else { try { L(`  verbose: ${JSON.parse(String(p.content)).msg_type}`); } catch {} }
  }
  if (ev === 'conversation.chat.requires_action') L(`  *** REQUIRES_ACTION`);
  if (ev === 'error') L(`  ERROR ${p.code} ${p.msg}`);
}

// 第 3 步：再发一句课中内容，看链路是否活了
L('\n=== step3 课中一轮 ===');
const c = await startChat({ uid, convId: a.conv, text: '谁来回答这道题？' });
for (const { ev, p } of c.events) {
  if (ev === 'conversation.message.completed') {
    if (p.type === 'answer') L(`  ANSWER: ${String(p.content).slice(0, 120)}`);
    else { try { L(`  verbose: ${JSON.parse(String(p.content)).msg_type}`); } catch {} }
  }
  if (ev === 'error') L(`  ERROR ${p.code} ${p.msg}`);
}
