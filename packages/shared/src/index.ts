/**
 * 前后端共享契约。任何一边单独改这里的类型，另一边编译就会红。
 * 对应 docs/integration-contracts.md §3 / §4，差异以 docs/design-decisions.md 为准。
 */

/** Coze 工作流里 classroom_state 的取值域（NOT_STARTED / ON_CLASS 两个写入节点见 design-decisions §1） */
export type ClassroomState = 'NOT_STARTED' | 'ON_CLASS' | 'ENDED';

/** 前端唯一需要认识的三张问答卡片。kind 由 BFF 依据 Coze 节点 id 判定，前端不接触 action 原始数据 */
export type ActionKind = 'pick_students' | 'confirm_report' | 'confirm_cleanup';

export interface StudentBrief {
  /** Coze 学生 id（1~6），与 181544 的选择编号一致 */
  id: number;
  name: string;
  persona: string;
  /** 知识点掌握度 0~100；未开课时为 null */
  mastery: number | null;
  /** 课堂信心 0~100 */
  confidence: number | null;
  /** 课堂参与度 0~100 */
  engagement: number | null;
}

/** 学生名册固定 6 人（181544 文案 + 152987 ROSTER），persona 真值来自数据库，前端只用这里的展示名 */
export const ROSTER: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: '小陈' },
  { id: 2, name: '小新' },
  { id: 3, name: '小星星' },
  { id: 4, name: '赵六' },
  { id: 5, name: '钱七' },
  { id: 6, name: '孙八' },
];

/**
 * 槽位硬约束：195160 / 118288 / 158008 / 110656 全部只处理前 3 个槽位，
 * 第 4 人起在数据层就被丢弃（design-decisions §3.4），所以 UI 必须卡在 3 人。
 */
export const MAX_STUDENTS = 3;

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CLOSED'
  | 'CHAT_IN_PROGRESS'
  | 'ACTION_EXPIRED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_FAILED'
  | 'UPSTREAM_RATE_LIMITED';

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

/** 新建课堂 */
export interface CreateSessionRequest {
  teacherId: string;
  subject?: string;
  grade?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  createdAt: string;
}

/** 发一条消息 */
export interface ChatRequest {
  text: string;
  clientMsgId: string;
}

/** 回答中断问题 */
export interface ActionRequest {
  answer: string;
}

/** 状态快照，用于刷新 / 多标签对齐 */
export interface SessionSnapshot {
  sessionId: string;
  classroomState: ClassroomState;
  turn: number;
  pendingAction: PendingAction | null;
  students: StudentBrief[];
  lastReportUrl: string | null;
  createdAt: string;
  lastActiveAt: string;
}

export interface PendingAction {
  actionId: string;
  kind: ActionKind;
  question: string;
  options?: string[];
  multiple?: boolean;
}

export interface CloseSessionResponse {
  sessionId: string;
  endedAt: string;
}

/* ------------------------------------------------------------------ */
/* SSE 指令：BFF 把上游事件归一成这 7 种，前端只实现这 7 种            */
/* ------------------------------------------------------------------ */

export type ClassroomEvent =
  | { type: 'meta'; sessionId: string; conversationId: string | null }
  | {
      type: 'delta';
      messageId: string;
      text: string;
      /** 该气泡归属：老师自己说的 = teacher，Coze 工作流产出 = workflow */
      from: Speaker;
    }
  | {
      type: 'message';
      messageId: string;
      text: string;
      from: Speaker;
      nodeTitle?: string;
    }
  | {
      type: 'action';
      actionId: string;
      kind: ActionKind;
      question: string;
      options?: string[];
      multiple?: boolean;
      /** 选学生卡片专用：上游文案里解析出的真实名册（含 persona） */
      roster?: Array<{ id: number; name: string; persona: string }>;
    }
  | {
      type: 'state';
      classroomState: ClassroomState;
      turn?: number;
      students?: StudentBrief[];
      lastReportUrl?: string | null;
    }
  | {
      /** 系统提示覆盖层：整屏展示，不进入对话流 */
      type: 'banner';
      title: string;
      detail: string;
      /** transient = 短暂展示后自动消失；persistent = 需要用户操作才消失 */
      mode: 'transient' | 'persistent';
    }
  | {
      /** 学生台词下方的「提示」内容，默认收起，点击展开 */
      type: 'hint';
      /** 归属学生名，用于挂到对应气泡下 */
      name: string | null;
      text: string;
    }
  | { type: 'error'; code: ErrorCode; message: string; retryable: boolean }
  | { type: 'done' };

/** 气泡来源。老师消息由 BFF 立即回显，不需要等 Coze */
export type Speaker = 'teacher' | 'workflow';

/* ------------------------------------------------------------------ */
/* 上游文案 -> 状态推进信号                                            */
/* 文案取自 YAML 里的 output 节点，见 design-decisions §1 / §5          */
/* ------------------------------------------------------------------ */

export const SIGNALS = {
  /** 137670 */
  initializing: '正在初始化课堂',
  /** 197096 */
  classStarted: '课堂已经开始 老师请开课',
  /** 163003 前缀，正文是「报告的PDF下载地址:{{url}}」 */
  reportPrefix: '报告的PDF下载地址:',
  /** 176948 */
  alreadyOnClass: '重开课堂请先结束当前课程',
  /** 114146 */
  needCourseInfo: '请先开始课程',
  /** 111114 */
  offTopic: '模拟中暂时不支持课程外的内容',
  /** 179886 */
  greeting: '你好呀 我是影子课堂',
} as const;

/**
 * 固定文案（系统提示）——不应进入对话流，而要作为整屏覆盖层展示。
 * 返回覆盖层标题和说明；不是系统提示则返回 null。
 */
export function detectSystemBanner(text: string): { title: string; detail: string } | null {
  const t = text.trim();
  if (!t) return null;
  if (t.includes(SIGNALS.classStarted)) {
    return { title: '课堂已经开始', detail: '老师请开课' };
  }
  if (t.includes(SIGNALS.alreadyOnClass)) {
    return { title: '当前还有一节课没有结束', detail: '请先结束当前课程，再开始新的课堂' };
  }
  if (t.includes(SIGNALS.needCourseInfo)) {
    return { title: '还没有开始课程', detail: '请先输入学科、年级与核心知识点' };
  }
  if (t.includes(SIGNALS.offTopic)) {
    return { title: '课堂进行中', detail: '暂时不支持课程外的内容，请继续课堂' };
  }
  if (t.includes(SIGNALS.greeting)) {
    return { title: '影子课堂', detail: '输入学科、年级与核心知识点即可开始模拟课堂' };
  }
  // 问答卡片的问题文本不进对话流（卡片自己会显示）
  if (t.includes('选择本次课堂参与的学生') || t.includes('是否生成报告') || t.includes('是否删除数据')) {
    return null;
  }
  if (t.includes(SIGNALS.initializing)) {
    return { title: '正在初始化课堂', detail: '抽取学科 · 知识点分析 · 学生建档' };
  }
  return null;
}

/** 三个 question 节点的原始 question 文案 -> kind */
export const QUESTION_KIND_MAP: ReadonlyArray<{ match: string; kind: ActionKind }> = [
  { match: '请选择本次课堂参与的学生', kind: 'pick_students' },
  { match: '是否生成报告', kind: 'confirm_report' },
  { match: '是否删除数据', kind: 'confirm_cleanup' },
];

export function detectActionKind(question: string): ActionKind | null {
  for (const entry of QUESTION_KIND_MAP) {
    if (question.includes(entry.match)) return entry.kind;
  }
  return null;
}

/** 「报告的PDF下载地址:https://xxx」 -> https://xxx */
export function extractReportUrl(text: string): string | null {
  if (!text.includes(SIGNALS.reportPrefix)) return null;
  const after = text.slice(text.indexOf(SIGNALS.reportPrefix) + SIGNALS.reportPrefix.length);
  const hit = /https?:\/\/\S+/.exec(after);
  return hit ? hit[0].replace(/[)\]），。]+$/, '') : null;
}

/* ------------------------------------------------------------------ */
/* 指标标记                                                            */
/*                                                                     */
/* Coze 不提供读用户变量的接口，数据表也读不到，所以 K/C/E 必须由工作流  */
/* 自己输出到对话里。约定格式（空值允许留空）：                          */
/*   __KCE__:K1,K2,K3,C1,C2,C3,E1,E2,E3                                 */
/* 例：__KCE__:35,32,,55,50,,60,45,0                                    */
/* 槽位顺序 = 学生顺序（工作流已按 student_id 重排）。                   */
/* BFF 截获后剥离该行，不渲染成气泡。                                    */
/* ------------------------------------------------------------------ */

export const METRICS_MARKER = '__KCE__:';

export interface MetricsPayload {
  /** 与输入同长度；null 表示该槽位为空 */
  k: Array<number | null>;
  c: Array<number | null>;
  e: Array<number | null>;
}

function toNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 返回剥离标记后的正文，以及解析出的指标（没有标记则为 null） */
export function extractMetrics(text: string): { text: string; metrics: MetricsPayload | null } {
  const idx = text.indexOf(METRICS_MARKER);
  if (idx < 0) return { text, metrics: null };

  const head = text.slice(0, idx);
  const tail = text.slice(idx + METRICS_MARKER.length);
  const nl = tail.indexOf('\n');
  const line = (nl >= 0 ? tail.slice(0, nl) : tail).trim();
  const rest = nl >= 0 ? tail.slice(nl + 1) : '';
  const cleaned = (head + rest).replace(/\n{3,}/g, '\n\n').trimEnd();

  // 支持两种写法：逗号分隔的 9 个数，或 {"k":[...],"c":[...],"e":[...]}
  if (line.startsWith('{')) {
    const data = (() => {
      try {
        return JSON.parse(line) as Partial<MetricsPayload>;
      } catch {
        return null;
      }
    })();
    if (!data || !Array.isArray(data.k) || !Array.isArray(data.c) || !Array.isArray(data.e)) {
      return { text: cleaned, metrics: null };
    }
    return { text: cleaned, metrics: { k: data.k, c: data.c, e: data.e } };
  }

  const parts = line.split(/[,，]/).map((s) => s.trim());
  if (parts.length < 3) return { text: cleaned, metrics: null };

  // 期望 9 段：K1~3 / C1~3 / E1~3；不足则补空，多出的忽略
  const k = [toNum(parts[0]), toNum(parts[1]), toNum(parts[2])];
  const c = [toNum(parts[3]), toNum(parts[4]), toNum(parts[5])];
  const e = [toNum(parts[6]), toNum(parts[7]), toNum(parts[8])];
  if (k.every((v) => v === null) && c.every((v) => v === null) && e.every((v) => v === null)) {
    return { text: cleaned, metrics: null };
  }
  return { text: cleaned, metrics: { k, c, e } };
}

/** 把槽位顺序的指标挂到学生上：第 i 个槽位对应第 i 个入座学生 */
export function applyMetrics(
  students: StudentBrief[],
  metrics: MetricsPayload,
): StudentBrief[] {
  // 0 是合法分数，只跳过 null/undefined（槽位为空）
  const pick = (v: number | null | undefined, fallback: number | null): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  return students.map((s, i) => ({
    ...s,
    mastery: pick(metrics.k[i], s.mastery),
    confidence: pick(metrics.c[i], s.confidence),
    engagement: pick(metrics.e[i], s.engagement),
  }));
}

/**
 * 学生台词的"提示"（zhushi）——来自工作流的判定/类型/误解评注。
 * 形如「小陈：【判定】无效 【类型】— 【误解】—」，不是台词，要收进可展开的提示里。
 */
export function extractHint(text: string): { name: string | null; hint: string } | null {
  const t = text.trim();
  const m = /^([^\s：:]{1,6})\s*[：:]\s*(【判定】[\s\S]*)$/.exec(t);
  if (m) return { name: m[1] ?? null, hint: m[2]!.trim() };
  if (t.startsWith('【判定】')) return { name: null, hint: t };
  return null;
}

export const API_PREFIX = '/api/classroom';
export const MAX_MESSAGE_LENGTH = 2000;
