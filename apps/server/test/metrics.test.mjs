import { extractMetrics, applyMetrics } from '@shadow/shared';

const cases = [
  '__KCE__:K1,K2,K3,C1,C2,C3,E1,E2,E3',
  '__KCE__:35,32,30,40,42,38,58,55,61',
  '__KCE__:35,32,,55,50,,60,45,0',
  '__KCE__:35,35,3,55,50,45,60,0',
  '小星星：我来！\n__KCE__:35,32,30,40,42,38,58,55,61',
  '小星星：我来！',
  '__KCE__:,,,',
  '__KCE__:{"k":[10,20],"c":[1,2],"e":[3,4]}',
];

for (const c of cases) {
  const r = extractMetrics(c);
  console.log(`输入 ${JSON.stringify(c)}`);
  console.log(`  → 文本 ${JSON.stringify(r.text)}  指标 ${JSON.stringify(r.metrics)}`);
}

const students = [
  { id: 1, name: '小陈', persona: '', mastery: null, confidence: null, engagement: null },
  { id: 3, name: '小星星', persona: '', mastery: null, confidence: null, engagement: null },
];
console.log('\n挂载(含空值):', JSON.stringify(applyMetrics(students, { k: [35, 32, null], c: [40, 42, null], e: [58, 55, null] })));
