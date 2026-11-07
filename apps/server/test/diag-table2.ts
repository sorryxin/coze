import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const TABLE_ID = process.argv[3];
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();

const url = `https://api.coze.cn/v1/databases/${TABLE_ID}/records`;
const bodies = [
  { page_num: 1, page_size: 10 },
  {},
  { page_num: 1, page_size: 10, filter: {} },
];

for (const body of bodies) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await res.text();
  console.log(`\nbody=${JSON.stringify(body)}\n  HTTP ${res.status} ${t.slice(0, 400)}`);
}

// GET 也试一下
const g = await fetch(`${url}?page_num=1&page_size=10`, { headers: { Authorization: `Bearer ${token}` } });
console.log(`\nGET HTTP ${g.status} ${(await g.text()).slice(0, 300)}`);
