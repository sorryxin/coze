/**
 * HTTP 层。零框架：Node 内置 http 足够，也避免多一层 SSE 透传的坑。
 *
 * 路由（前缀 /api/classroom）：
 *   POST /sessions                        开一节新课
 *   GET  /sessions/:id                    状态快照
 *   POST /sessions/:id/chat               发一条消息（SSE）
 *   POST /sessions/:id/actions/:actionId  回答中断问题（SSE）
 *   POST /sessions/:id/close              结课
 *   GET  /healthz                         探活 + 当前模式
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import {
  API_PREFIX,
  MAX_MESSAGE_LENGTH,
  MAX_STUDENTS,
  type ActionKind,
  type ApiErrorBody,
  type ClassroomEvent,
  type CreateSessionRequest,
  type ErrorCode,
  type SessionSnapshot,
} from '@shadow/shared';
import type { ServerConfig } from './config.ts';
import { SessionError, SessionStore, type SessionRecord } from './store.ts';
import { Orchestrator, createCozeSource, visibleStudents, type UpstreamSource } from './orchestrator.ts';
import { createMockSource } from './mock-source.ts';

export interface AppDeps {
  config: ServerConfig;
  store: SessionStore;
  /** 静态资源目录；不存在时只提供 API */
  webRoot: string | null;
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  SESSION_NOT_FOUND: 404,
  SESSION_CLOSED: 409,
  CHAT_IN_PROGRESS: 409,
  ACTION_EXPIRED: 410,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_FAILED: 502,
  UPSTREAM_RATE_LIMITED: 429,
};

function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'CHAT_IN_PROGRESS',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_FAILED',
  'UPSTREAM_RATE_LIMITED',
]);

export function createApp(deps: AppDeps) {
  const { config, store } = deps;
  const source: UpstreamSource =
    config.coze.mode === 'coze' ? createCozeSource(config.coze) : createMockSource();

  return createServer((req, res) => {
    handle(req, res, deps, source).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const body = toErrorBody(err);
      sendJson(res, STATUS_BY_CODE[body.code] ?? 500, body);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppDeps,
  source: UpstreamSource,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true, mode: deps.config.coze.mode });
    return;
  }

  if (pathname.startsWith(API_PREFIX)) {
    await handleApi(req, res, deps, source, pathname.slice(API_PREFIX.length));
    return;
  }

  await serveStatic(req, res, deps.webRoot, pathname);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppDeps,
  source: UpstreamSource,
  sub: string,
): Promise<void> {
  const { store, config } = deps;
  const method = req.method ?? 'GET';
  const parts = sub.split('/').filter(Boolean);

  // 一期没有账号体系，用请求头传老师身份；接账号后改为从会话取
  const teacherId = header(req, 'x-teacher-id');
  if (!teacherId) {
    sendError(res, 'UNAUTHORIZED', '缺少 X-Teacher-Id');
    return;
  }

  // POST /sessions
  if (parts.length === 1 && parts[0] === 'sessions' && method === 'POST') {
    const body = await readJson<CreateSessionRequest>(req);
    if (!body || typeof body.teacherId !== 'string' || body.teacherId === '') {
      sendError(res, 'BAD_REQUEST', 'teacherId 必填');
      return;
    }
    if (body.teacherId !== teacherId) {
      sendError(res, 'FORBIDDEN', 'teacherId 与登录身份不一致');
      return;
    }
    const record = store.create(body.teacherId);
    sendJson(res, 201, {
      sessionId: record.sessionId,
      createdAt: new Date(record.createdAt).toISOString(),
    });
    return;
  }

  if (parts[0] !== 'sessions' || !parts[1]) {
    sendError(res, 'BAD_REQUEST', `未知路径：${sub}`);
    return;
  }

  const sessionId = parts[1];
  const session = store.mustGet(sessionId, teacherId);
  const action = parts[2];

  // GET /sessions/:id
  if (parts.length === 2 && method === 'GET') {
    sendJson(res, 200, snapshot(session));
    return;
  }

  // POST /sessions/:id/close
  if (action === 'close' && parts.length === 3 && method === 'POST') {
    if (session.closedAt === null) {
      session.closedAt = Date.now();
      session.pending = null;
      session.inFlightChatId = null;
    }
    sendJson(res, 200, {
      sessionId: session.sessionId,
      endedAt: new Date(session.closedAt).toISOString(),
    });
    return;
  }

  if (session.closedAt !== null) {
    sendError(res, 'SESSION_CLOSED', '该课堂已结课，请新开一节');
    return;
  }

  // POST /sessions/:id/chat
  if (action === 'chat' && parts.length === 3 && method === 'POST') {
    const body = await readJson<{ text?: string; clientMsgId?: string }>(req);
    const text = (body?.text ?? '').trim();
    if (!text) {
      sendError(res, 'BAD_REQUEST', '消息不能为空');
      return;
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      sendError(res, 'BAD_REQUEST', `消息不能超过 ${MAX_MESSAGE_LENGTH} 字`);
      return;
    }
    if (session.inFlightChatId !== null) {
      sendError(res, 'CHAT_IN_PROGRESS', '上一轮还在生成，请稍候', true);
      return;
    }
    if (session.pending) {
      sendError(res, 'CHAT_IN_PROGRESS', '请先回答上方的卡片', true);
      return;
    }
    // 单活跃课堂锁是 P0-1 的临时方案，默认关闭：多人同时验收/演示会被误伤。
    // 上生产前设 ENFORCE_SINGLE_CLASS=1 打开。
    if (process.env.ENFORCE_SINGLE_CLASS === '1') store.assertNoOtherActive(session.sessionId);

    const chatId = `local_${Date.now().toString(36)}`;
    session.inFlightChatId = chatId;
    session.messages.push({ id: `t_${chatId}`, role: 'teacher', text, at: Date.now() });

    await streamSse(req, res, config, (emit, signal) => {
      // 老师消息由前端本地回显；这里不再推一次，否则会重复出现两个气泡
      return new Orchestrator({ store, server: config, source, emit, signal }).run('chat', session, {
        text,
      });
    });
    return;
  }

  // POST /sessions/:id/actions/:actionId
  if (action === 'actions' && parts.length === 4 && method === 'POST') {
    const actionId = parts[3] ?? '';
    const body = await readJson<{ answer?: string }>(req);
    const answer = (body?.answer ?? '').trim();

    const pending = store.takePending(session, actionId, config.actionTtlMs);
    const validated = validateAnswer(pending.kind, answer, pending.options);
    if (!validated.ok) {
      sendError(res, 'BAD_REQUEST', validated.reason);
      return;
    }

    pending.consumed = true;
    session.pending = null;
    session.inFlightChatId = pending.chatId;

    if (pending.kind === 'pick_students') {
      const ids = validated.ids ?? [];
      // 只记录"谁入选了"，三个指标的数值拿不到：
      // Coze 没有读用户变量（slot_k*/slot_ce*）的接口，学期中也不会把数值输出到对话里。
      // 早期版本在此填 0 让界面"看起来有数"，那是假的，已去掉。
      // 真实数值需要工作流在输出节点追加结构化标记后由 orchestrator 截获（见 README）。
      for (const student of session.students) {
        const chosen = ids.includes(student.id);
        student.mastery = null;
        student.confidence = null;
        student.engagement = null;
        (student as { selected?: boolean }).selected = chosen;
      }
    }

    await streamSse(req, res, config, (emit, signal) =>
      new Orchestrator({
        store,
        server: config,
        source,
        emit,
        signal,
        action: {
          kind: pending.kind,
          question: pending.question,
          options: pending.options,
          multiple: pending.multiple,
          chatId: pending.chatId,
          toolCallId: pending.toolCallId,
          conversationId: pending.conversationId,
        },
      }).run('action', session, {
        answer: validated.value,
        chatId: pending.chatId,
        toolCallId: pending.toolCallId,
      }),
    );
    return;
  }

  sendError(res, 'BAD_REQUEST', `未知路径：${sub}`);
}

/* ------------------------------------------------------------------ */

type Validation =
  | { ok: true; value: string; ids?: number[] }
  | { ok: false; reason: string };

/** 提交值必须落在该 kind 的取值域内，不得透传给上游 */
function validateAnswer(kind: string, answer: string, options: string[]): Validation {
  if (kind === 'pick_students') {
    const tokens = answer.split(/[,，\s]+/).filter(Boolean);
    const ids: number[] = [];
    for (const token of tokens) {
      const n = Number(token);
      if (!Number.isInteger(n) || n < 1 || n > 6) {
        return { ok: false, reason: `学生编号只能是 1~6，收到「${token}」` };
      }
      if (!ids.includes(n)) ids.push(n);
    }
    if (ids.length === 0) return { ok: false, reason: '至少选择 1 名学生' };
    // 数据层只处理 3 个槽位，多选会被静默丢弃，这里必须提前拦
    if (ids.length > MAX_STUDENTS) {
      return { ok: false, reason: `最多选择 ${MAX_STUDENTS} 名学生（槽位硬约束）` };
    }
    return { ok: true, value: ids.join(','), ids };
  }

  const allowed = options.length > 0 ? options : ['是', '否'];
  if (!allowed.includes(answer)) {
    return { ok: false, reason: `只能回答 ${allowed.join(' / ')}` };
  }
  return { ok: true, value: answer };
}

async function streamSse(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  run: (emit: (event: ClassroomEvent) => void, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 必须关缓冲，否则 delta 会被中间层攒着一起吐
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const controller = new AbortController();
  let closed = false;

  const onClose = () => {
    if (closed) return;
    closed = true;
    controller.abort();
  };
  req.on('aborted', onClose);
  res.on('close', () => {
    if (!res.writableEnded) onClose();
  });

  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), config.clientIdleMs);
  };
  resetIdle();

  const emit = (event: ClassroomEvent) => {
    if (closed || res.writableEnded) return;
    resetIdle();
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await run(emit, controller.signal);
  } catch (err) {
    const body = toErrorBody(err);
    emit({ type: 'error', code: body.code, message: body.message, retryable: body.retryable });
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (!closed && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

function snapshot(session: SessionRecord): SessionSnapshot {
  const pending = session.pending;
  return {
    sessionId: session.sessionId,
    classroomState: session.classroomState,
    turn: session.turn,
    pendingAction: pending
      ? {
          actionId: pending.actionId,
          kind: pending.kind as ActionKind,
          question: pending.question,
          options: pending.options,
          multiple: pending.multiple,
        }
      : null,
    students: visibleStudents(session),
    lastReportUrl: session.lastReportUrl,
    createdAt: new Date(session.createdAt).toISOString(),
    lastActiveAt: new Date(session.lastActiveAt).toISOString(),
  };
}

function toErrorBody(err: unknown): ApiErrorBody {
  if (err instanceof SessionError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return {
    code: 'UPSTREAM_FAILED',
    message: err instanceof Error ? err.message : '未知错误',
    retryable: true,
  };
}

function sendError(
  res: ServerResponse,
  code: ErrorCode,
  message: string,
  retryable = RETRYABLE.has(code),
): void {
  const body: ApiErrorBody = { code, message, retryable };
  sendJson(res, statusFor(code), body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // 消息上限 2000 字，1MB 足够；防止恶意大包
    if (size > 1024 * 1024) throw new SessionError('BAD_REQUEST', '请求体过大', 400);
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new SessionError('BAD_REQUEST', '请求体不是合法 JSON', 400);
  }
}

/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  webRoot: string | null,
  pathname: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { code: 'BAD_REQUEST', message: 'method not allowed', retryable: false });
    return;
  }

  if (!webRoot) {
    sendJson(res, 404, {
      code: 'SESSION_NOT_FOUND',
      message: '未构建前端，请先 npm run build',
      retryable: false,
    });
    return;
  }

  const root = resolve(webRoot);
  const safePath = normalize(pathname).replace(/^[/\\]+/, '');
  let filePath = resolve(join(root, safePath || 'index.html'));

  // 目录穿越防护
  if (!filePath.startsWith(root)) {
    sendJson(res, 403, { code: 'FORBIDDEN', message: 'forbidden', retryable: false });
    return;
  }

  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) {
    // MPA：无扩展名的路径交给 index.html；带扩展名的资源确实不存在就 404
    if (extname(filePath) !== '') {
      sendJson(res, 404, { code: 'SESSION_NOT_FOUND', message: 'not found', retryable: false });
      return;
    }
    filePath = join(root, 'index.html');
  }

  const data = await readFile(filePath).catch(() => null);
  if (!data) {
    sendJson(res, 404, { code: 'SESSION_NOT_FOUND', message: 'not found', retryable: false });
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': filePath.includes(`${join('assets')}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}
