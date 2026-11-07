import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadServerConfig, assertCozeReady } from './config.ts';
import { SessionStore } from './store.ts';
import { createApp } from './app.ts';

const here = dirname(fileURLToPath(import.meta.url));

// 读项目根的 .env。只补缺省值：真实环境变量优先，避免部署时被文件覆盖。
const envPath = resolve(here, '../../..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// dist/index.js 与 src/index.ts 的层级相同，前端产物在 ../../web/dist
const webRoot = resolve(here, '../../web/dist');
const config = loadServerConfig();

const missing = assertCozeReady(config.coze);
if (missing.length > 0) {
  console.error(`[shadow-classroom] COZE_MODE=coze 但缺少：${missing.join(', ')}`);
  console.error('[shadow-classroom] 要么补齐 .env，要么设 COZE_MODE=mock 先用本地剧本');
  process.exit(1);
}

const app = createApp({
  config,
  store: new SessionStore(),
  webRoot: existsSync(webRoot) ? webRoot : null,
});

app.listen(config.port, config.host, () => {
  const auth = config.coze.tokens ? config.coze.tokens.describe() : '(mock)';
  console.log(`[shadow-classroom] mode=${config.coze.mode} auth=${auth}  http://${config.host}:${config.port}`);
  if (!existsSync(webRoot)) {
    console.log('[shadow-classroom] 未找到前端产物（先 npm run build），当前只提供 API');
  }
});

const shutdown = () => {
  app.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
