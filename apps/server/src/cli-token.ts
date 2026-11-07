/**
 * 换一次 token 并打印诊断信息，不打印 token 本身。
 * 用来在接真流前确认：私钥签名对不对、Coze 认不认这个 client_id、
 * 以及最重要的——这个授权到底拿没拿到 chat 能力。
 *
 * 用法：node --experimental-strip-types src/cli-token.ts <config.json 路径>
 */
import { loadJwtConfigFromFile, JwtTokenProvider } from './auth.ts';

const path = process.argv[2] ?? process.env.COZE_JWT_CONFIG;
if (!path) {
  console.error('用法：node --experimental-strip-types src/cli-token.ts <coze_oauth_config.json>');
  process.exit(1);
}

const cfg = loadJwtConfigFromFile(path, 'https://api.coze.cn');
const provider = new JwtTokenProvider(cfg);

try {
  const token = await provider.getToken();
  console.log(`[ok] 换到 token：${token.slice(0, 6)}…${token.slice(-4)}（长度 ${token.length}）`);
  console.log(`[ok] client_id=${cfg.clientId}  key_id=${cfg.keyId ?? '(无)'}`);

  // 用换到的 token 发一个无害请求，看权限够不够
  const probe = await fetch('https://api.coze.cn/v1/workspaces', {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`[probe] GET /v1/workspaces -> HTTP ${probe.status}`);
} catch (err) {
  console.error('[fail]', err instanceof Error ? err.message : err);
  process.exit(1);
}
