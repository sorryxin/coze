/**
 * Coze 凭据。两种方式二选一：
 *  - pat：固定 PAT，最简单
 *  - jwt：用 client_id + 私钥签 JWT，换短期 access_token，过期自动重换
 *
 * JWT 方式下私钥不进本仓库：只在 .env 里写配置文件的路径，运行时读取。
 * 换 token 的流程参照 cozepy 的 JWTAuthApp.get_access_token。
 */
import { createPrivateKey, createSign, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface JwtConfig {
  clientId: string;
  privateKeyPem: string;
  /** 私钥对应的公钥 id，Coze 控制台生成的配置里叫 public_key_id */
  keyId: string | null;
  apiBase: string;
  wwwBase: string;
}

export interface TokenProvider {
  /** 返回可直接放进 Authorization 头的 token */
  getToken(): Promise<string>;
  /** 仅供日志：当前凭据来源 */
  describe(): string;
}

export class StaticTokenProvider implements TokenProvider {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async getToken(): Promise<string> {
    return this.token;
  }

  describe(): string {
    return 'pat';
  }
}

interface CachedToken {
  token: string;
  /** 毫秒时间戳 */
  expiresAt: number;
}

/** 提前 60 秒刷新，避免临界点被上游拒 */
const REFRESH_MARGIN_MS = 60_000;

export class JwtTokenProvider implements TokenProvider {
  private readonly cfg: JwtConfig;
  private cached: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;

  constructor(cfg: JwtConfig) {
    this.cfg = cfg;
  }

  describe(): string {
    return `jwt(client_id=${this.cfg.clientId.slice(0, 6)}…)`;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > now) {
      return this.cached.token;
    }
    if (this.inflight) {
      return (await this.inflight).token;
    }
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    const fresh = await this.inflight;
    this.cached = fresh;
    return fresh.token;
  }

  /** 强制作废缓存，用于上游返回 401 时重试一次 */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<CachedToken> {
    const assertion = this.signAssertion();
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', client_id: this.cfg.clientId });
    // Coze 的 JWT 授权要求用 JSON 提交，两种编码都试过更稳
    const res = await fetch(`${this.cfg.apiBase}/api/permission/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assertion}`,
      },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id: this.cfg.clientId,
        duration_seconds: 86399,
      }),
    });

    const text = await res.text();
    const data = parseJson(text) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_message?: string;
    } | null;

    if (!res.ok || !data?.access_token) {
      const detail = data?.error_message ?? data?.error ?? text.slice(0, 200);
      throw new Error(`Coze JWT 换 token 失败（HTTP ${res.status}）：${detail}`);
    }

    const ttlMs = typeof data.expires_in === 'number' ? data.expires_in * 1000 : 15 * 60 * 1000;
    void body;
    return { token: data.access_token, expiresAt: Date.now() + ttlMs };
  }

  /** 生成 JWT assertion；alg 用 RS256，header 里带 kid */
  private signAssertion(): string {
    const now = Math.floor(Date.now() / 1000);
    const header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' };
    if (this.cfg.keyId) header.kid = this.cfg.keyId;
    const payload = {
      iss: this.cfg.clientId,
      aud: 'api.coze.cn',
      iat: now,
      exp: now + 600,
      jti: createHash('sha256').update(`${this.cfg.clientId}:${now}:${Math.random()}`).digest('hex').slice(0, 32),
    };

    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const key = createPrivateKey(this.cfg.privateKeyPem);
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(key);
    return `${signingInput}.${base64urlBuffer(signature)}`;
  }
}

function base64url(text: string): string {
  return base64urlBuffer(Buffer.from(text, 'utf8'));
}

function base64urlBuffer(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 读取 cozepy 生成的 coze_oauth_config.json */
export function loadJwtConfigFromFile(path: string, apiBaseFallback: string): JwtConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    client_id?: string;
    private_key?: string;
    public_key_id?: string;
    coze_api_base?: string;
    coze_www_base?: string;
  };
  if (!raw.client_id || !raw.private_key) {
    throw new Error(`JWT 配置缺少 client_id 或 private_key：${path}`);
  }
  return {
    clientId: raw.client_id,
    privateKeyPem: raw.private_key,
    keyId: raw.public_key_id ?? null,
    apiBase: raw.coze_api_base ?? apiBaseFallback,
    wwwBase: raw.coze_www_base ?? 'https://www.coze.cn',
  };
}
