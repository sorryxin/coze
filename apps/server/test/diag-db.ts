import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const TABLE_ID = process.argv[3];
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const attempts = [
  // Coze 表格的正式读写接口
  { m: 'POST', p: `/v1/tables/${TABLE_ID}/records/search`, b: { page_num: 1, page_size: 10 } },
  { m: 'POST', p: `/v1/tables/${TABLE_ID}/records/batch_get`, b: { page_num: 1, page_size: 10 } },
  { m: 'GET', p: `/v1/tables/${TABLE_ID}/records?page_num=1&page_size=10` },
  // 老接口再试一次，带 space_id
  { m: 'POST', p: `/v1/databases/${TABLE_ID}/records`, b: { page_num: 1, page_size: 10, space_id: '7457134344411873343' } },
  { m: 'GET', p: `/v1/databases/${TABLE_ID}` },
  { m: 'GET', p: `/v1/tables/${TABLE_ID}` },
];

for (const a of attempts) {
  try {
    const res = await fetch('https://api.coze.cn' + a.p, {
      method: a.m,
      headers: H,
      ...(a.b ? { body: JSON.stringify(a.b) } : {}),
    });
    const t = await res.text();
    console.log(`\n${a.m} ${a.p}`);
    console.log(`  HTTP ${res.status}  ${t.slice(0, 500)}`);
  } catch (e) {
    console.log(`\n${a.m} ${a.p}\n  FAIL ${e}`);
  }
}
