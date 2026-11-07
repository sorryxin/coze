// 走 BFF 全链路，检查 __KCE__ 是否被剥离、指标是否挂到学生上
const BASE = 'http://127.0.0.1:8787';
const TEACHER = process.argv[2] ?? `t_${Date.now()}`;
const H = { 'x-teacher-id': TEACHER, 'content-type': 'application/json' };

async function sse(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
    if (!data || data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch {}
  }
  return events;
}

const created = await fetch(BASE + '/api/classroom/sessions', {
  method: 'POST', headers: H, body: JSON.stringify({ teacherId: TEACHER }),
}).then((r) => r.json());
const base = '/api/classroom/sessions/' + created.sessionId;
console.log('teacher =', TEACHER);

let ev = await sse(base + '/chat', { text: '初二数学，一次函数的图像', clientMsgId: 'm1' });
console.log('\n[开课]', ev.filter((e) => e.type === 'message').map((e) => e.text.slice(0, 30)));

const act = ev.find((e) => e.type === 'action');
if (!act) { console.log('没有选学生卡片'); process.exit(1); }

ev = await sse(base + '/actions/' + act.actionId, { answer: '1,3' });
console.log('[选学生]', ev.filter((e) => e.type === 'message').map((e) => e.text.slice(0, 30)));
const st0 = ev.find((e) => e.type === 'state');
console.log('  学生:', JSON.stringify(st0?.students?.map((s) => [s.id, s.mastery, s.confidence, s.engagement])));

ev = await sse(base + '/chat', { text: '谁来回答这道题？', clientMsgId: 'm2' });
console.log('\n[课中]');
for (const e of ev) {
  if (e.type === 'message') console.log('  message:', JSON.stringify(e.text.slice(0, 80)));
  if (e.type === 'state') console.log('  state students:', JSON.stringify(e.students?.map((s) => [s.id, s.mastery, s.confidence, s.engagement])));
}

const snap = await fetch(BASE + base, { headers: H }).then((r) => r.json());
console.log('\n[快照] 轮次', snap.turn, '学生:', JSON.stringify(snap.students.map((s) => [s.id, s.mastery, s.confidence, s.engagement])));
