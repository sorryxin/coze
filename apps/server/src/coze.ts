/**
 * Coze /v3/chat 协议层。
 *
 * 为什么不用 /v1/workflow/run：该流是 chatflow，依赖 12 个 global_variable_user，
 * 且含 3 个 question 节点。工作流执行接口没有 user 维度，也没有 requires_action 续跑。
 *
 * 这里只做「协议」：拼请求、解析 SSE 行、把上游事件转成内部 UpstreamEvent。
 * 业务语义（状态推进、卡片、学生指标）在 orchestrator 里。
 */
import type { CozeConfig } from './config.ts';

export interface ChatStartArgs {
  cozeUserId: string;
  conversationId: string | null;
  text: string;
  /** 排障用，最多 16 对，value ≤512 */
  metaData?: Record<string, string>;
  signal: AbortSignal;
}

export interface SubmitToolOutputArgs {
  cozeUserId: string;
  conversationId: string;
  chatId: string;
  toolCallId: string;
  answer: string;
  signal: AbortSignal;
}

/** 上游 10 种事件里我们关心的字段，其余原样丢弃 */
export type UpstreamEvent =
  | { kind: 'chat_created'; conversationId: string | null; chatId: string }
  | { kind: 'in_progress' }
  | { kind: 'message_delta'; messageId: string; text: string; nodeTitle?: string }
  | { kind: 'message_completed'; messageId: string; text: string; nodeTitle?: string; type: string }
  | { kind: 'requires_action'; chatId: string; toolCalls: ToolCall[] }
  | { kind: 'chat_completed'; conversationId: string | null }
  | { kind: 'chat_failed'; code: number | null; msg: string }
  | { kind: 'error'; code: number | null; msg: string }
  | { kind: 'done' };

export interface ToolCall {
  /** 实测问答节点的 tool_call.id 是空串，不能再拿它当唯一标识 */
  id: string;
  type: string;
  function?: { name: string; arguments: string } | null;
}

export class CozeHttpError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly logId: string | null;

  constructor(status: number, code: number | null, logId: string | null, message: string) {
    super(message);
    this.name = 'CozeHttpError';
    this.status = status;
    this.code = code;
    this.logId = logId;
  }
}

export class CozeClient {
  private readonly cfg: CozeConfig;

  constructor(cfg: CozeConfig) {
    this.cfg = cfg;
  }

  /** 创建对话并开始流式生成。返回事件流；调用方负责 AbortSignal 与读空闲超时 */
  async *startChat(args: ChatStartArgs): AsyncGenerator<UpstreamEvent> {
    const query = new URLSearchParams({ bot_id: this.cfg.botId });
    if (args.conversationId) query.set('conversation_id', args.conversationId);

    const body: Record<string, unknown> = {
      bot_id: this.cfg.botId,
      user_id: args.cozeUserId,
      stream: true,
      additional_messages: [{ role: 'user', content: args.text, content_type: 'text' }],
      additional_params: this.startNodeParams(),
    };
    if (args.metaData) body.meta_data = args.metaData;

    yield* this.stream(`${this.cfg.apiBase}/v3/chat?${query.toString()}`, body, args.signal);
  }

  /**
   * 中断后续跑。
   *
   * 实测（2026-11）：问答节点产生的 requires_action 里 tool_call 是
   * {id:"", type:"reply_message", function:null}，没有可用的 id；
   * 而 /v3/chat/submit_tool_outputs 无论怎么填都返回 4000 Request parameter error。
   *
   * 真正可行的是：把答案当作一条普通用户消息，带着同一个 conversation_id 再发一次 /v3/chat，
   * 工作流会从提问节点之后继续执行。已验证可越过 181544 进入开课链路。
   */
  async *continueWithAnswer(args: SubmitToolOutputArgs): AsyncGenerator<UpstreamEvent> {
    const query = new URLSearchParams({ bot_id: this.cfg.botId });
    if (args.conversationId) query.set('conversation_id', args.conversationId);

    const body: Record<string, unknown> = {
      bot_id: this.cfg.botId,
      user_id: args.cozeUserId,
      stream: true,
      additional_messages: [{ role: 'user', content: args.answer, content_type: 'text' }],
      additional_params: this.startNodeParams(),
    };

    yield* this.stream(`${this.cfg.apiBase}/v3/chat?${query.toString()}`, body, args.signal);
  }

  /** 官方文档里的中断续跑接口。当前问答节点用不了，保留给将来出现真正的 function 型 tool_call */
  async *submitToolOutputs(args: SubmitToolOutputArgs): AsyncGenerator<UpstreamEvent> {
    const body = {
      bot_id: this.cfg.botId,
      user_id: args.cozeUserId,
      conversation_id: args.conversationId,
      chat_id: args.chatId,
      stream: true,
      tool_outputs: [{ tool_call_id: args.toolCallId, output: args.answer }],
    };
    const url = `${this.cfg.apiBase}/v3/chat/submit_tool_outputs?${new URLSearchParams({
      conversation_id: args.conversationId,
    }).toString()}`;
    yield* this.stream(url, body, args.signal);
  }

  /**
   * JWT 模式下 token 可能已过期，401 时作废缓存重试一次。
   * 只重试一次：再失败就是权限问题，重试没有意义。
   */
  private async send(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
    if (!this.cfg.tokens) throw new CozeHttpError(401, null, null, '缺少 Coze 凭据');

    const attempt = async (): Promise<Response> => {
      const token = await this.cfg.tokens!.getToken();
      return fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      });
    };

    const first = await attempt();
    if (first.status !== 401) return first;

    const provider = this.cfg.tokens;
    if ('invalidate' in provider && typeof provider.invalidate === 'function') {
      provider.invalidate();
      return attempt();
    }
    return first;
  }

  /** start 节点的 CONVERSATION_NAME；159331 清空会话历史就是按这个名字找的 */
  private startNodeParams(): unknown[] {
    return [
      {
        type: 'string',
        key: 'CONVERSATION_NAME',
        value: this.cfg.conversationName,
      },
    ];
  }

  private async *stream(
    url: string,
    body: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<UpstreamEvent> {
    const res = await this.send(url, body, signal);

    if (!res.ok) {
      const text = await safeText(res);
      const parsed = tryJson(text) as { code?: number; msg?: string } | null;
      const logId = res.headers.get('x-tt-logid') ?? res.headers.get('x-request-id');
      throw new CozeHttpError(res.status, parsed?.code ?? null, logId, parsed?.msg ?? text.slice(0, 300));
    }
    if (!res.body) throw new CozeHttpError(res.status, null, null, '上游没有返回事件流');

    let eventName = '';
    let dataBuf: string[] = [];
    let finished = false;

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE 用空行分隔事件；上游有的字段跨 chunk，必须按行累积
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const rawLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line === '') {
          if (dataBuf.length > 0) {
            const event = parseEvent(eventName, dataBuf.join('\n'));
            eventName = '';
            dataBuf = [];
            if (event) {
              yield event;
              if (event.kind === 'done') finished = true;
            }
          }
          if (finished) return;
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const value = line.slice(5);
          dataBuf.push(value.startsWith(' ') ? value.slice(1) : value);
        }
        // 其余行（id:/retry:/注释）按规范忽略
        nl = buffer.indexOf('\n');
      }
    }

    if (dataBuf.length > 0) {
      const event = parseEvent(eventName, dataBuf.join('\n'));
      if (event) yield event;
    }
    if (!finished) yield { kind: 'done' };
  }
}

function parseEvent(eventName: string, data: string): UpstreamEvent | null {
  if (data.trim() === '[DONE]') return { kind: 'done' };

  const payload = tryJson(data) as Record<string, unknown> | null;
  if (!payload) return null;

  // 实测：/v3/chat 的 data 就是事件对象本身（没有 {event, data} 包装层）
  const raw = payload;
  const name = eventName || String(raw.event ?? '');

  switch (name) {
    case 'conversation.chat.created': {
      const chat = raw as { id?: string; conversation_id?: string };
      return chat.id
        ? { kind: 'chat_created', conversationId: chat.conversation_id ?? null, chatId: chat.id }
        : null;
    }
    case 'conversation.chat.in_progress':
      return { kind: 'in_progress' };
    case 'conversation.message.delta': {
      const msg = raw as { id?: string; content?: string; type?: string };
      if (!msg.id || !msg.content) return null;
      return { kind: 'message_delta', messageId: msg.id, text: msg.content };
    }
    case 'conversation.message.completed': {
      const msg = raw as { id?: string; content?: string; type?: string };
      if (!msg.id) return null;
      return {
        kind: 'message_completed',
        messageId: msg.id,
        text: msg.content ?? '',
        type: msg.type ?? '',
      };
    }
    case 'conversation.chat.requires_action': {
      const chat = raw as { id?: string; required_action?: { submit_tool_outputs?: { tool_calls?: ToolCall[] } } };
      const toolCalls = chat.required_action?.submit_tool_outputs?.tool_calls ?? [];
      if (!chat.id || toolCalls.length === 0) return null;
      return { kind: 'requires_action', chatId: chat.id, toolCalls };
    }
    case 'conversation.chat.completed': {
      const chat = raw as { conversation_id?: string };
      return { kind: 'chat_completed', conversationId: chat.conversation_id ?? null };
    }
    case 'conversation.chat.failed': {
      const chat = raw as { last_error?: { code?: number; msg?: string } };
      return {
        kind: 'chat_failed',
        code: chat.last_error?.code ?? null,
        msg: chat.last_error?.msg ?? 'chat failed',
      };
    }
    case 'error':
      return {
        kind: 'error',
        code: typeof payload.code === 'number' ? payload.code : null,
        msg: typeof payload.msg === 'string' ? payload.msg : 'upstream error',
      };
    case 'done':
      return { kind: 'done' };
    default:
      // conversation.audio.delta 等一律丢弃（一期不做语音）
      return null;
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** question 节点的 tool_call 里没有 arguments，问题文案来自同轮最后一条 message */
export interface QuestionPayload {
  question: string;
  options: string[];
  multiple: boolean;
}

export function parseQuestionPayload(toolCall: ToolCall): QuestionPayload | null {
  // 真流上问答节点的 tool_call 是 {id:"", type:"reply_message", function:null}，
  // 没有 arguments 可解析；保留这个函数只为兼容其他类型的中断。
  const raw = toolCall.function?.arguments;
  if (!raw) return null;
  const data = tryJson(raw) as Record<string, unknown> | null;
  if (!data) return null;

  const question = typeof data.question === 'string' ? data.question : '';
  const rawOptions = Array.isArray(data.options) ? data.options : [];
  const options = rawOptions
    .map((o) => (typeof o === 'string' ? o : typeof (o as { name?: unknown })?.name === 'string' ? String((o as { name: string }).name) : ''))
    .filter((s) => s !== '');

  return { question, options, multiple: Boolean(data.multiple ?? false) };
}
