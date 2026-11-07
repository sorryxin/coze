/**
 * 配置。真值一律来自环境变量，私钥/PAT 绝不进日志、不进前端 bundle。
 *
 * 鉴权二选一：
 *   COZE_AUTH=pat + COZE_PAT
 *   COZE_AUTH=jwt + COZE_JWT_CONFIG=<coze_oauth_config.json 的路径>
 */
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  JwtTokenProvider,
  StaticTokenProvider,
  loadJwtConfigFromFile,
  type TokenProvider,
} from './auth.ts';

/** 项目根：src/config.ts 与 dist/config.js 都在 apps/server 下，向上三级 */
function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

export interface CozeConfig {
  mode: 'mock' | 'coze';
  auth: 'pat' | 'jwt';
  apiBase: string;
  botId: string;
  tokens: TokenProvider | null;
  publishStatus: 'published_online' | 'unpublished_draft';
  /** start 节点参数 CONVERSATION_NAME，159331 按它找会话 */
  conversationName: string;
}

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function loadConfig(): CozeConfig {
  const mode = env('COZE_MODE', 'mock') === 'coze' ? 'coze' : 'mock';
  const auth = env('COZE_AUTH', 'pat') === 'jwt' ? 'jwt' : 'pat';
  const apiBase = env('COZE_API_BASE', 'https://api.coze.cn').replace(/\/+$/, '');
  const publishStatus =
    env('COZE_PUBLISH_STATUS', 'unpublished_draft') === 'published_online'
      ? 'published_online'
      : 'unpublished_draft';

  let tokens: TokenProvider | null = null;
  if (mode === 'coze') {
    if (auth === 'jwt') {
      const raw = env('COZE_JWT_CONFIG');
      if (raw) {
        // 相对路径按项目根解析，方便整包拷到别的电脑
        const abs = isAbsolute(raw) ? raw : resolve(projectRoot(), raw);
        tokens = new JwtTokenProvider(loadJwtConfigFromFile(abs, apiBase));
      }
    } else {
      const pat = env('COZE_PAT');
      if (pat) tokens = new StaticTokenProvider(pat);
    }
  }

  return {
    mode,
    auth,
    apiBase,
    botId: env('COZE_BOT_ID'),
    tokens,
    publishStatus,
    conversationName: env('COZE_CONVERSATION_NAME', 'Default'),
  };
}

export function assertCozeReady(cfg: CozeConfig): string[] {
  if (cfg.mode !== 'coze') return [];
  const missing: string[] = [];
  if (!cfg.botId) missing.push('COZE_BOT_ID');
  if (!cfg.tokens) {
    missing.push(cfg.auth === 'jwt' ? 'COZE_JWT_CONFIG' : 'COZE_PAT');
  }
  return missing;
}

export interface ServerConfig {
  port: number;
  host: string;
  coze: CozeConfig;
  upstreamIdleMs: number;
  upstreamConnectMs: number;
  clientIdleMs: number;
  actionTtlMs: number;
}

export function loadServerConfig(): ServerConfig {
  return {
    port: Number(env('PORT', '8787')),
    host: env('HOST', '127.0.0.1'),
    coze: loadConfig(),
    upstreamIdleMs: Number(env('UPSTREAM_IDLE_MS', '120000')),
    upstreamConnectMs: Number(env('UPSTREAM_CONNECT_MS', '30000')),
    clientIdleMs: Number(env('CLIENT_IDLE_MS', '150000')),
    actionTtlMs: Number(env('ACTION_TTL_MS', String(24 * 60 * 60 * 1000))),
  };
}
