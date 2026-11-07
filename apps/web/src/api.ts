/**
 * 前端唯一的数据入口。只认契约里的 5 个接口与 7 种 SSE 指令，
 * 不接触 Coze 的 chat_id / tool_call_id（由 BFF 隐藏）。
 */
import {
  API_PREFIX,
  type ActionKind,
  type ApiErrorBody,
  type ClassroomEvent,
  type ClassroomState,
  type SessionSnapshot,
  type StudentBrief,
} from '@shadow/shared';

const TEACHER_KEY = 'shadow.teacherId';

export function teacherId(): string {
  let id = localStorage.getItem(TEACHER_KEY);
  if (!id) {
    id = `teacher_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(TEACHER_KEY, id);
  }
  return id;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return { 'X-Teacher-Id': teacherId(), ...extra };
}

export class ApiError extends Error {
  readonly code: ApiErrorBody['code'];
  readonly retryable: boolean;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.retryable = body.retryable;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as ApiErrorBody;
    if (body && typeof body.code === 'string') return new ApiError(body);
  } catch {
    /* 非 JSON，走兜底 */
  }
  return new ApiError({
    code: res.status === 401 ? 'UNAUTHORIZED' : 'UPSTREAM_FAILED',
    message: text.slice(0, 200) || `HTTP ${res.status}`,
    retryable: false,
  });
}

export async function createSession(): Promise<{ sessionId: string; createdAt: string }> {
  const res = await fetch(`${API_PREFIX}/sessions`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ teacherId: teacherId() }),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getSnapshot(sessionId: string): Promise<SessionSnapshot> {
  const res = await fetch(`${API_PREFIX}/sessions/${sessionId}`, { headers: headers() });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function closeSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_PREFIX}/sessions/${sessionId}/close`, {
    method: 'POST',
    headers: headers(),
  });
  if (!res.ok) throw await parseError(res);
}

/**
 * 发消息 / 提交卡片共用的 SSE 读取。逐块解析 `event:` + `data:`，
 * 结束后调用 onDone。返回的 abort 用于取消。
 */
export async function streamRequest(
  path: string,
  body: unknown,
  onEvent: (event: ClassroomEvent) => void,
): Promise<void> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  if (!res.body) throw new ApiError({ code: 'UPSTREAM_FAILED', message: '无响应流', retryable: true });

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseBlock(block);
      if (parsed) onEvent(parsed);
      sep = buffer.indexOf('\n\n');
    }
  }

  const tail = parseBlock(buffer);
  if (tail) onEvent(tail);
}

function parseBlock(block: string): ClassroomEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      const v = line.slice(5);
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v);
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  if (raw === '[DONE]') return null;
  try {
    return JSON.parse(raw) as ClassroomEvent;
  } catch {
    return null;
  }
}

export type { ActionKind, ClassroomEvent, ClassroomState, StudentBrief };
