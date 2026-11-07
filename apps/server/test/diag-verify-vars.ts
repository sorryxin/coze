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
  const answers = [], verbose = [];
  let conv = convId;
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let p;
    try { p = JSON.parse(data); } catch { continue; }
    if (ev === 'conversation.chat.created' && !conv) conv = p.conversation_id;
    if (ev === 'conversation.message.completed') {
      if (p.type === 'answer') answers.push(String(p.content));
      else { try { verbose.push(JSON.parse(String(p.content)).msg_type); } catch {} }
    }
  }
  return { answers, verbose, conv };
}

// 实验组：跳过一次，用同一个 user_id 再开课
// 如果"重开课堂请先结束当前课程"出现，说明 classroom_state 确实被写成了 ON_CLASS
const uid = `diag_verify_${Date.now()}`;
console.log('实验：验证选学生后 classroom_state 是否被写成 ON_CLASS\n');

const a = await send(uid, null, '初二数学，一次函数的图像');
console.log('1. 开课        :', a.answers.map((s) => s.slice(0, 24)));

const b = await send(uid, a.conv, '1,3');
console.log('2. 选学生 1,3  :', b.answers, '| verbose:', [...new Set(b.verbose)]);

// 关键：跳过课中，直接再说一次"开课"，看状态机怎么判
const c = await send(uid, b.conv, '初二数学，一次函数的图像');
console.log('3. 再说开课    :', c.answers.map((s) => s.slice(0, 40)));
console.log('   → 若为「重开课堂请先结束当前课程」，说明 classroom_state 已经是 ON_CLASS（变量写成功）');
console.log('   → 若为「正在初始化课堂」，说明 classroom_state 还是 NOT_STARTED（变量没写进去）');

// 再验一次：直接说下课，看是否走"提示是否生成报告"（需要 ON_CLASS）
const d = await send(uid, b.conv, '今天就上到这里，下课');
console.log('4. 说下课      :', d.answers.map((s) => s.slice(0, 60)));
