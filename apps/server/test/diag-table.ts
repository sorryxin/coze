import { loadJwtConfigFromFile, JwtTokenProvider } from '../src/auth.ts';

const CONFIG = process.argv[2] ?? process.env.COZE_JWT_CONFIG!;
const SPACE_ID = process.argv[3];
const TABLE_ID = process.argv[4];
const cfg = loadJwtConfigFromFile(CONFIG, 'https://api.coze.cn');
const token = await new JwtTokenProvider(cfg).getToken();

const paths = [
  `https://api.coze.cn/v1/databases/${TABLE_ID}/records`,
  `https://api.coze.cn/v1/databases/${TABLE_ID}/records/search`,
  `https://api.coze.cn/v1/database/${TABLE_ID}/records/list`,
  `https://api.coze.cn/v1/tables/${TABLE_ID}/records/list`,
  `https://api.coze.cn/v1/memories/tables/${TABLE_ID}/records`,
];
for (const p of paths) {
  const res = await fetch(p, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_num: 1, page_size: 5 }),
  });
  const t = await res.text();
  console.log(`\n${p}\n  HTTP ${res.status} ${t.slice(0, 160)}`);
}
