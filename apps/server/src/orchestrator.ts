/**
 * 编排层：把「上游事件流」翻译成「前端 SSE 指令流」。
 *
 * 真实 Coze 与 mock 实现同一个 UpstreamSource 接口，因此 SSE 归一、
 * 状态推进、卡片生成、学生指标这几块逻辑只有一份，切换模式不需要改前端。
 */
import {
  SIGNALS,
  applyMetrics,
  detectSystemBanner,
  extractHint,
  extractMetrics,
  extractReportUrl,
  type ActionKind,
  type ClassroomEvent,
  type ClassroomState,
  type StudentBrief,
} from '@shadow/shared';
import type { SessionStore, SessionRecord, StoredAction } from './store.ts';
import { newActionId } from './store.ts';
import type { CozeConfig, ServerConfig } from './config.ts';
import { CozeClient, CozeHttpError, parseQuestionPayload, type ToolCall, type UpstreamEvent } from './coze.ts';

/** 上游抽象：真实 Coze 和 mock 剧本都实现它 */
export interface UpstreamSource {
  start(args: {
    session: SessionRecord;
    text: string;
    signal: AbortSignal;
  }): AsyncGenerator<UpstreamEvent>;
  resume(args: {
    session: SessionRecord;
    chatId: string;
    toolCallId: string;
    answer: string;
    signal: AbortSignal;
    action: RunContext['action'];
  }): AsyncGenerator<UpstreamEvent>;
}

/** 事件流里的气泡累积器：delta 追加、completed 覆盖 */
interface BubbleState {
  text: string;
}

export interface RunContext {
  store: SessionStore;
  server: ServerConfig;
  source: UpstreamSource;
  /** 推 SSE。返回 false 表示前端已断开 */
  emit: (event: ClassroomEvent) => void;
  signal: AbortSignal;
  /** 回答中断问题时的卡片信息；发消息时为空 */
  action?: {
    kind: string;
    question: string;
    options: string[];
    multiple: boolean;
    chatId: string;
    toolCallId: string;
    conversationId: string;
  };
}

export class Orchestrator {
  private readonly ctx: RunContext;
  private readonly bubbles = new Map<string, BubbleState>();
  private conversationId: string | null = null;
  /** 本轮最后一条 answer 文本，用于识别中断对应哪张卡片 */
  private lastAnswerText = '';

  constructor(ctx: RunContext) {
    this.ctx = ctx;
  }

  async run(mode: 'chat' | 'action', session: SessionRecord, input: { text?: string; answer?: string; chatId?: string; toolCallId?: string }): Promise<void> {
    const { emit } = this.ctx;
    this.conversationId = session.conversationId;

    emit({ type: 'meta', sessionId: session.sessionId, conversationId: session.conversationId });

    // 开课前先复位：若这个 user_id 上一节课没走完结课，classroom_state 会卡在 ON_CLASS，
    // 上游只会回一句"重开课堂请先结束当前课程"，用户就卡死了。
    // 这里主动发一句"下课"，让工作流走到 167887 把状态置回 NOT_STARTED。
    if (mode === 'chat' && session.classroomState !== 'ON_CLASS') {
      await this.tryResetStaleClass(session);
    }

    const iterator =
      mode === 'chat'
        ? this.ctx.source.start({ session, text: input.text ?? '', signal: this.ctx.signal })
        : this.ctx.source.resume({
            session,
            chatId: input.chatId ?? '',
            toolCallId: input.toolCallId ?? '',
            answer: input.answer ?? '',
            signal: this.ctx.signal,
            action: this.ctx.action,
          });

    try {
      for await (const event of iterator) {
        if (this.ctx.signal.aborted) return;
        const shouldStop = this.handle(event, session);
        if (shouldStop) return;
      }
      // 上游正常结束但没发 done
      this.finish(session);
    } catch (err) {
      for (const mapped of mapUpstreamError(err)) emit(mapped);
      emit({ type: 'done' });
    } finally {
      session.inFlightChatId = null;
      session.lastActiveAt = Date.now();
    }
  }

  /**
   * 发一句"下课"探测上游状态。
   * 只有卡在 ON_CLASS 时才会返回"是否生成报告？"；此时状态已被 167887 置回 NOT_STARTED，
   * 直接丢弃这次中断即可（不弹卡片、不续跑），接着让用户原本的消息正常走。
   * 未开班时上游会回"请先开始课程…"，同样忽略。
   */
  private async tryResetStaleClass(session: SessionRecord): Promise<void> {
    if (session.resetProbed) return;
    session.resetProbed = true;
    try {
      let sawReportQuestion = false;
      for await (const event of this.ctx.source.start({ session, text: '下课', signal: this.ctx.signal })) {
        if (event.kind === 'message_completed' && event.type === 'answer' && event.text.includes('是否生成报告')) {
          sawReportQuestion = true;
        }
        if (event.kind === 'requires_action' || event.kind === 'chat_completed' || event.kind === 'done') break;
      }
      if (sawReportQuestion) {
        // 清掉中断留下的 pending，前端不该看到这张卡片
        session.pending = null;
        session.classroomState = 'NOT_STARTED';
      }
    } catch {
      // 探测失败不挡主流程
    }
  }

  /** 返回 true 表示事件流到此为止 */
  private handle(event: UpstreamEvent, session: SessionRecord): boolean {
    const { emit } = this.ctx;

    switch (event.kind) {
      case 'chat_created': {
        if (event.conversationId) {
          this.conversationId = event.conversationId;
          session.conversationId = event.conversationId;
        }
        session.inFlightChatId = event.chatId;
        emit({ type: 'meta', sessionId: session.sessionId, conversationId: this.conversationId });
        return false;
      }

      case 'in_progress':
        return false;

      case 'message_delta': {
        // 这里只累积，不推给前端。
        // 原因：输出节点可能在流式文本里夹带 __KCE__ 指标行，只有在整段收齐后
        // 才能可靠地剥离；逐字推送会把标记露出来，还会留下一个一直在闪的流式光标。
        // 代价是气泡从"逐字出现"变成"整段出现"，对短句没有感知差异。
        const bubble = this.bubbles.get(event.messageId) ?? { text: '' };
        bubble.text += event.text;
        this.bubbles.set(event.messageId, bubble);
        return false;
      }

      case 'message_completed': {
        // 非 answer 类型的 message（function_call / verbose）不进气泡
        if (event.type && event.type !== 'answer') return false;

        const bubble = this.bubbles.get(event.messageId) ?? { text: '' };
        bubble.text = event.text || bubble.text;
        this.bubbles.set(event.messageId, bubble);
        if (bubble.text.trim()) this.lastAnswerText = bubble.text;

        // 工作流可在正文末尾附一行 __KCE__:{...}；剥离后推纯净文本，指标单独走 state
        const { text: cleanText, metrics } = extractMetrics(bubble.text);

        if (metrics) {
          session.students = applyMetrics(visibleStudents(session), metrics);
          emit({
            type: 'state',
            classroomState: session.classroomState,
            turn: session.turn,
            students: visibleStudents(session),
            lastReportUrl: session.lastReportUrl,
          });
        }

        // 整段只有标记时（剥离后为空）就不推空气泡
        if (cleanText.trim() !== '') {
          // 问答卡片的问题文本由卡片自己渲染，绝不进对话流
          if (
            cleanText.includes('选择本次课堂参与的学生') ||
            cleanText.includes('是否生成报告') ||
            cleanText.includes('是否删除数据')
          ) {
            return false;
          }

          // 系统提示（固定文案）走覆盖层，绝不进对话流
          const banner = detectSystemBanner(cleanText);
          if (banner) {
            emit({
              type: 'banner',
              title: banner.title,
              detail: banner.detail,
              mode: cleanText.includes(SIGNALS.classStarted) ? 'transient' : 'persistent',
            });
            this.advanceState(cleanText, session);
            return false;
          }

          // 学生台词的"提示"（判定/类型/误解）收进可展开区，不当作台词
          const hint = extractHint(cleanText);
          if (hint) {
            emit({ type: 'hint', name: hint.name, text: hint.hint });
            return false;
          }

          emit({
            type: 'message',
            messageId: event.messageId,
            text: cleanText,
            from: 'workflow',
            nodeTitle: event.nodeTitle,
          });
        }
        this.advanceState(cleanText, session);
        return false;
      }

      case 'requires_action': {
        // 本轮没发 done 就先中断了，这里收尾，交给前端提交 action
        session.inFlightChatId = null;
        this.openAction(session, event.chatId, event.toolCalls);
        return true;
      }

      case 'chat_completed': {
        if (event.conversationId) {
          this.conversationId = event.conversationId;
          session.conversationId = event.conversationId;
        }
        session.inFlightChatId = null;
        return this.finish(session);
      }

      case 'chat_failed':
      case 'error': {
        session.inFlightChatId = null;
        emit(mapCozeCode(event.code, event.msg));
        emit({ type: 'done' });
        return true;
      }

      case 'done':
        session.inFlightChatId = null;
        return this.finish(session);

      default:
        return false;
    }
  }

  /** 收尾：推一次权威快照再 done，前端以这次为准 */
  private finish(session: SessionRecord): boolean {
    this.ctx.emit({
      type: 'state',
      classroomState: session.classroomState,
      turn: session.turn,
      students: visibleStudents(session),
      lastReportUrl: session.lastReportUrl,
    });
    this.ctx.emit({ type: 'done' });
    return true;
  }

  /**
   * 一期拿不到用户变量，只能靠已知文案推进状态（design-decisions §5）。
   * 状态推进放在 message_completed 之后，避免半句话误判。
   */
  private advanceState(text: string, session: SessionRecord): void {
    const { emit } = this.ctx;
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.includes(SIGNALS.classStarted)) {
      if (session.classroomState !== 'ON_CLASS') {
        session.classroomState = 'ON_CLASS';
        emit({
          type: 'state',
          classroomState: 'ON_CLASS',
          turn: session.turn,
          students: visibleStudents(session),
          lastReportUrl: session.lastReportUrl,
        });
      }
      return;
    }

    if (trimmed.includes(SIGNALS.reportPrefix)) {
      const url = extractReportUrl(trimmed);
      if (url && url !== session.lastReportUrl) {
        session.lastReportUrl = url;
        emit({
          type: 'state',
          classroomState: session.classroomState,
          turn: session.turn,
          students: visibleStudents(session),
          lastReportUrl: url,
        });
      }
      return;
    }

    // 课中每轮结束 turn 自增，与 Coze 的 195846 对齐（turn 从 1 开始）
    if (session.classroomState === 'ON_CLASS' && !isFixedNotice(trimmed)) {
      session.turn += 1;
    }
  }

  /** 把 requires_action 变成前端卡片，返回 kind；返回 null 表示这张卡片我们处理不了 */
  private openAction(session: SessionRecord, chatId: string, toolCalls: ToolCall[]): ActionKind | null {
    const toolCall = toolCalls[0];
    if (!toolCall) return null;

    // 真流的 tool_call 是 {id:"", type:"reply_message", function:null}，没有 arguments。
    // 问题文案来自同轮最后一条已完成的 message（问答节点自己推的那条）。
    const fromArguments = parseQuestionPayload(toolCall);
    const rawQuestion = (fromArguments?.question || this.lastAnswerText || '').trim();
    const kind = detectKind(rawQuestion);
    if (!kind) {
      this.ctx.emit({
        type: 'error',
        code: 'UPSTREAM_FAILED',
        message: `上游中断了一个无法识别的提问：${rawQuestion.slice(0, 60) || '(空)'}`,
        retryable: false,
      });
      return null;
    }
    const question = kind === 'pick_students' ? rawQuestion : cleanQuestion(rawQuestion);

    // 选学生文案里带 persona，解析出来写进 session，前端据此渲染卡片
    if (kind === 'pick_students') {
      const roster = parseRoster(rawQuestion);
      if (roster.length > 0) {
        session.students = session.students.map((s) => {
          const hit = roster.find((r) => r.id === s.id);
          return hit ? { ...s, name: hit.name, persona: hit.persona } : s;
        });
      }
    }

    // 选学生的编号和选项由前端自带（ROSTER），其它问答节点用固定的是/否
    const options =
      kind === 'pick_students' ? [] : fromArguments?.options.length ? fromArguments.options : ['是', '否'];

    const pending: StoredAction = {
      actionId: newActionId(),
      kind,
      question,
      options,
      multiple: kind === 'pick_students' ? true : Boolean(fromArguments?.multiple),
      conversationId: this.conversationId ?? session.conversationId ?? '',
      chatId,
      // tool_call.id 实测是空串，submit_tool_outputs 里照原样回传即可
      toolCallId: toolCall.id ?? '',
      createdAt: Date.now(),
      consumed: false,
    };
    session.pending = pending;
    session.inFlightChatId = chatId;

    if (kind === 'confirm_report' || kind === 'confirm_cleanup') {
      // 167887 在问报告之前就把 classroom_state 置回 NOT_STARTED
      session.classroomState = 'NOT_STARTED';
    }

    this.ctx.emit({
      type: 'action',
      actionId: pending.actionId,
      kind,
      question,
      options: pending.options,
      multiple: pending.multiple,
      // 选学生卡片用真实名册（含 persona）；其它卡片不需要
      roster: kind === 'pick_students' ? session.students.map((s) => ({ id: s.id, name: s.name, persona: s.persona })) : undefined,
    });
    return kind;
  }
}

function detectKind(question: string): ActionKind | null {
  if (question.includes('选择本次课堂参与的学生')) return 'pick_students';
  if (question.includes('生成报告')) return 'confirm_report';
  if (question.includes('删除数据')) return 'confirm_cleanup';
  return null;
}

/**
 * 真流的问答节点会把选项拼进同一段文案：
 *   "是否生成报告？\n- 是\n- 否\n"
 * 卡片里已经有独立按钮，这里把选项尾巴去掉，只留问题本身。
 */
export function cleanQuestion(raw: string): string {
  const firstLine = raw.split('\n').map((s) => s.trim()).find((s) => s !== '') ?? raw;
  return firstLine.replace(/^[-*•]\s*/, '').trim();
}

/**
 * 从选学生文案里解析出「编号 = 姓名（persona）」。
 * 真流文案形如：1 = 小陈（沉稳学霸）　2 = 小新（害羞少女）…
 * 解析不到就返回空数组，前端用内置名册兜底。
 */
export function parseRoster(text: string): Array<{ id: number; name: string; persona: string }> {
  const out: Array<{ id: number; name: string; persona: string }> = [];
  const re = /(\d+)\s*=\s*([^（(　\s]+)\s*(?:[（(]([^）)]*)[）)])?/g;
  for (const m of text.matchAll(re)) {
    const id = Number(m[1]);
    const name = m[2]?.trim() ?? '';
    if (!Number.isInteger(id) || id < 1 || id > 20 || !name) continue;
    if (out.some((s) => s.id === id)) continue;
    out.push({ id, name, persona: (m[3] ?? '').trim() });
  }
  return out.sort((a, b) => a.id - b.id);
}


/** 固定提示文案不参与 turn 计数 */
function isFixedNotice(text: string): boolean {
  return (
    text.includes(SIGNALS.alreadyOnClass) ||
    text.includes(SIGNALS.needCourseInfo) ||
    text.includes(SIGNALS.offTopic) ||
    text.includes(SIGNALS.greeting)
  );
}

/**
 * 只有"已入选"的学生出现在右侧面板。
 * 判定依据是 selected 标记（选学生卡片提交时写入），不是指标是否非空——
 * 指标本身目前拿不到真实值，恒为 null。
 */
export function visibleStudents(session: SessionRecord): StudentBrief[] {
  return session.students.filter((s) => (s as { selected?: boolean }).selected === true);
}

function mapCozeCode(code: number | null, msg: string): ClassroomEvent {
  if (code === 4016) {
    return { type: 'error', code: 'CHAT_IN_PROGRESS', message: '上一轮还在生成，请稍候', retryable: true };
  }
  if (code === 4000) {
    return { type: 'error', code: 'BAD_REQUEST', message: `上游配置错误：${msg}`, retryable: false };
  }
  if (code === 4100 || code === 4101 || code === 4013) {
    return { type: 'error', code: 'UNAUTHORIZED', message: '上游鉴权失败（PAT 失效或权限不足）', retryable: false };
  }
  if (code === 4200 || code === 4290) {
    return { type: 'error', code: 'UPSTREAM_RATE_LIMITED', message: '上游限流，请稍后重试', retryable: true };
  }
  return { type: 'error', code: 'UPSTREAM_FAILED', message: msg || '上游执行失败', retryable: true };
}

function mapUpstreamError(err: unknown): ClassroomEvent[] {
  if (err instanceof CozeHttpError) {
    if (err.code === 4016) return [mapCozeCode(4016, err.message)];
    return [mapCozeCode(err.code, `HTTP ${err.status}: ${err.message}`)];
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return [{ type: 'error', code: 'UPSTREAM_TIMEOUT', message: '上游长时间无响应，已中断', retryable: true }];
  }
  return [
    {
      type: 'error',
      code: 'UPSTREAM_FAILED',
      message: err instanceof Error ? err.message : '未知错误',
      retryable: true,
    },
  ];
}

/* ------------------------------------------------------------------ */

export function createCozeSource(cfg: CozeConfig): UpstreamSource {
  const client = new CozeClient(cfg);
  return {
    start({ session, text, signal }) {
      return client.startChat({
        cozeUserId: session.cozeUserId,
        conversationId: session.conversationId,
        text,
        metaData: { sessionId: session.sessionId, turn: String(session.turn) },
        signal,
      });
    },
    resume({ session, chatId, toolCallId, answer, signal }) {
      // 问答节点的 tool_call 不可用（见 coze.ts 注释），走「普通消息续聊」
      return client.continueWithAnswer({
        cozeUserId: session.cozeUserId,
        conversationId: session.conversationId ?? '',
        chatId,
        toolCallId,
        answer,
        signal,
      });
    },
  };
}
