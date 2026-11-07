import { MAX_STUDENTS, ROSTER, type ClassroomState, type ErrorCode, type PendingAction, type StudentBrief } from '@shadow/shared';

/** 待回答的中断问题。前端只认 actionId，chat_id / tool_call_id 全在服务端 */
export interface StoredAction {
  actionId: string;
  kind: Extract<PendingAction['kind'], string>;
  question: string;
  options: string[];
  multiple: boolean;
  conversationId: string;
  chatId: string;
  toolCallId: string;
  createdAt: number;
  consumed: boolean;
}

export interface ChatMessageRecord {
  id: string;
  role: 'teacher' | 'workflow';
  text: string;
  at: number;
  nodeTitle?: string;
}

export interface SessionRecord {
  sessionId: string;
  teacherId: string;
  /** Coze 用户变量挂在它身上；拼了 sessionId，等于「新课堂 = 全部变量归零」 */
  cozeUserId: string;
  conversationId: string | null;
  classroomState: ClassroomState;
  turn: number;
  /** 进行中的对话 id；非空时拒绝新的 chat，对应上游 4016 */
  inFlightChatId: string | null;
  pending: StoredAction | null;
  students: StudentBrief[];
  lastReportUrl: string | null;
  createdAt: number;
  lastActiveAt: number;
  closedAt: number | null;
  messages: ChatMessageRecord[];
  /** 本节是否已做过"残留课堂"探测，避免每次发消息都多打一次上游 */
  resetProbed?: boolean;
}

export class SessionError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, httpStatus: number, retryable = false) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

function nextId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function newSessionId(): string {
  return nextId('cls');
}

export function newActionId(): string {
  return nextId('act');
}

function emptyStudents(): StudentBrief[] {
  return ROSTER.map((s) => ({
    id: s.id,
    name: s.name,
    persona: '',
    mastery: null,
    confidence: null,
    engagement: null,
  }));
}

/**
 * 内存存储。一期刻意不落库：
 * - Coze 侧用户变量本就无法读回，权威状态只能靠本地状态机；
 * - 表无租户字段（P0-1），落库反而制造"看起来隔离了"的错觉。
 * 换成 Redis/Postgres 时只需替换本类的读写方法。
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(teacherId: string): SessionRecord {
    const sessionId = newSessionId();
    const now = Date.now();
    const record: SessionRecord = {
      sessionId,
      teacherId,
      /**
       * Coze 用户变量挂在这上面，且**按 user_id 跨对话持久化**。
       *
       * 早期版本拼了 sessionId（`${teacherId}:${sessionId}`），意图是"新课堂 = 变量归零"，
       * 但这样会打开一个全新的变量槽位：学生 slot_k/slot_ce、names、turn、classroom_state
       * 全是空的，而开课链路正是靠这些槽位驱动，导致课中轮次永远没有内容。
       *
       * 实测（2026-11-04）：同一个 user_id 连开两节课，第二节能读到上一节的 ON_CLASS
       * （返回"重开课堂请先结束当前课程"），证明变量确实跨对话保留。
       * 所以这里只按老师维度生成，让变量在课堂之间存续；
       * 换课堂时靠工作流自身的"结束当前课程 → 167887 置 NOT_STARTED"来归位。
       */
      cozeUserId: teacherId,
      conversationId: null,
      classroomState: 'NOT_STARTED',
      turn: 0,
      inFlightChatId: null,
      pending: null,
      students: emptyStudents(),
      lastReportUrl: null,
      createdAt: now,
      lastActiveAt: now,
      closedAt: null,
      messages: [],
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /** 所有需要校验归属的接口都走这里，避免各写一套 404/403 */
  mustGet(sessionId: string, teacherId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new SessionError('SESSION_NOT_FOUND', '课堂不存在或已过期', 404);
    }
    if (record.teacherId !== teacherId) {
      throw new SessionError('FORBIDDEN', '无权访问该课堂', 403);
    }
    return record;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  /** 单活跃课堂锁：P0-1（数据表无租户字段）未修之前，并发上课必然互相覆盖 */
  assertNoOtherActive(sessionId: string): void {
    for (const other of this.sessions.values()) {
      if (other.sessionId === sessionId) continue;
      if (other.closedAt !== null) continue;
      if (other.classroomState === 'ON_CLASS' || other.inFlightChatId !== null) {
        throw new SessionError(
          'CHAT_IN_PROGRESS',
          '当前已有其他课堂在进行中，数据表无租户隔离，请先结束那一节',
          409,
          true,
        );
      }
    }
  }

  /** 取过期的 action 并清理，过期和重复提交走同一个错误码 */
  takePending(record: SessionRecord, actionId: string, ttlMs: number): StoredAction {
    const pending = record.pending;
    if (!pending || pending.actionId !== actionId) {
      throw new SessionError('ACTION_EXPIRED', '该卡片已失效，请刷新课堂状态', 410);
    }
    if (pending.consumed || Date.now() - pending.createdAt > ttlMs) {
      record.pending = null;
      throw new SessionError('ACTION_EXPIRED', '该卡片已过期，请刷新课堂状态', 410);
    }
    return pending;
  }

  applyStudentsFromNames(record: SessionRecord, count: number): void {
    record.students = record.students.map((s, i) =>
      i < count ? { ...s, mastery: 0, confidence: 0, engagement: 0 } : { ...s, mastery: null, confidence: null, engagement: null },
    );
  }

  maxStudents(): number {
    return MAX_STUDENTS;
  }
}
