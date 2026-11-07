// 用真实 HTTP 复验 BFF；UI 的渲染逻辑由浏览器截图另行确认
const BASE = 'http://127.0.0.1:8787';
const H = { 'x-teacher-id': 't1', 'content-type': 'application/json' };

async function sse(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await res.text();
  return text
    .split('\n\n')
    .map((b) => b.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''))
    .filter((s) => s && s !== '[DONE]')
    .map((s) => JSON.parse(s));
}

function summarize(evs) {
  return evs.map((e) => {
    if (e.type === 'delta') return 'delta';
    if (e.type === 'message') return `msg(${e.from}): ${e.text.slice(0, 26)}`;
    if (e.type === 'action') return `ACT:${e.kind}`;
    if (e.type === 'state') return `state:${e.classroomState}/turn=${e.turn}/students=${(e.students ?? []).length}`;
    if (e.type === 'error') return `ERR:${e.code}:${e.message}`;
    return e.type;
  });
}

const created = await fetch(BASE + '/api/classroom/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ teacherId: 't1' }),
}).then((r) => r.json());
const base = '/api/classroom/sessions/' + created.sessionId;
console.log('== 1. 开场');
let ev = await sse(base + '/chat', { text: '初二数学，一次函数的图像', clientMsgId: 'm1' });
console.log(summarize(ev).filter((s) => s !== 'delta').join(' | '));

console.log('== 2. 校验：选 4 人应被拒');
const a1 = ev.find((e) => e.type === 'action');
const bad = await fetch(BASE + base + '/actions/' + a1.actionId, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ answer: '1,2,3,4' }),
});
console.log('HTTP', bad.status, JSON.stringify(await bad.json()));

console.log('== 3. 选 2 人');
ev = await sse(base + '/actions/' + a1.actionId, { answer: '1,3' });
console.log(summarize(ev).filter((s) => s !== 'delta').join(' | '));

console.log('== 4. 课中两轮');
for (const text of ['谁来回答这道题？', '很好，小陈说得对']) {
  ev = await sse(base + '/chat', { text, clientMsgId: 'x' });
  console.log(summarize(ev).filter((s) => s !== 'delta').join(' | '));
}

console.log('== 5. 下课');
ev = await sse(base + '/chat', { text: '今天就上到这里，下课', clientMsgId: 'm3' });
console.log(summarize(ev).filter((s) => s !== 'delta').join(' | '));

console.log('== 6. 生成报告');
const rep = ev.find((e) => e.type === 'action');
ev = await sse(base + '/actions/' + rep.actionId, { answer: '是' });
console.log(summarize(ev).filter((s) => s !== 'delta').join(' | '));

console.log('== 7. 清理数据');
const clean = ev.find((e) => e.type === 'action');
ev = await sse(base + '/actions/' + clean.actionId, { answer: '是' });
console.log(summarize(ev).filter((s) => s !== 'delta').join(' | '));

console.log('== 8. 快照');
console.log(JSON.stringify(await fetch(BASE + base, { headers: H }).then((r) => r.json()), null, 1));

console.log('== 9. 401 与 403');
const noAuth = await fetch(BASE + base);
console.log('无身份:', noAuth.status, (await noAuth.json()).code);
const other = await fetch(BASE + base, { headers: { 'x-teacher-id': 't2' } });
console.log('他人身份:', other.status, (await other.json()).code);
