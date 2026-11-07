/**
 * 课堂状态机。前端只做「乐观推进 + 以 BFF 快照为准」，
 * 因为 Coze 的用户变量读不回来（design-decisions §5）。
 */
import {
  SIGNALS,
  detectActionKind,
  type ActionKind,
  type ClassroomEvent,
  type ClassroomState,
  type StudentBrief,
} from '@shadow/shared';

export type Phase =
  | 'IDLE' // 已建课堂，等第一句
  | 'INITIALIZING' // 收到「正在初始化课堂」
  | 'PICKING_STUDENTS' // 选学生卡片
  | 'ON_CLASS'
  | 'ENDING' // 报告 / 清理卡片
  | 'ENDED';

export interface Bubble {
  id: string;
  from: 'teacher' | 'workflow';
  text: string;
  streaming: boolean;
}

export interface Card {
  actionId: string;
  kind: ActionKind;
  question: string;
  options: string[];
  multiple: boolean;
  submitted: boolean;
  /** 选学生卡片用：上游解析出的真实名册 */
  roster: Array<{ id: number; name: string; persona: string }>;
}
const LOCAL_BUBBLE_ID = 'local_user';

export interface ClassroomModel {
  phase: Phase;
  classroomState: ClassroomState;
  turn: number;
  students: StudentBrief[];
  bubbles: Bubble[];
  card: Card | null;
  reportUrl: string | null;
  busy: boolean;
  notice: { kind: 'error' | 'info'; text: string } | null;
  /** 整屏系统提示（不进对话流） */
  banner: { title: string; detail: string; mode: 'transient' | 'persistent' } | null;
  /** 学生台词的提示（默认收起），按学生名归属 */
  hints: Record<string, string>;
}

export const initialModel: ClassroomModel = {
  phase: 'IDLE',
  classroomState: 'NOT_STARTED',
  turn: 0,
  students: [],
  bubbles: [],
  card: null,
  reportUrl: null,
  busy: false,
  notice: null,
  banner: null,
  hints: {},
};

export type ModelAction =
  | { type: 'local_user'; text: string }
  | { type: 'sending'; busy: boolean }
  | { type: 'event'; event: ClassroomEvent }
  | { type: 'card_submitted'; actionId: string }
  | { type: 'card_dismissed' }
  | { type: 'notice'; kind: 'error' | 'info'; text: string }
  | { type: 'clear_notice' }
  | { type: 'snapshot'; classroomState: ClassroomState; turn: number; students: StudentBrief[]; reportUrl: string | null; card: Card | null }
  | { type: 'enter_scene' }
  | { type: 'banner_dismissed' }
  | { type: 'ended' };

function upsertBubble(bubbles: Bubble[], id: string, from: Bubble['from'], text: string, streaming: boolean): Bubble[] {
  const idx = bubbles.findIndex((b) => b.id === id);
  if (idx < 0) return [...bubbles, { id, from, text, streaming }];
  const next = bubbles.slice();
  const prev = bubbles[idx]!;
  next[idx] = { ...prev, text, streaming };
  return next;
}

/** 一句话里带的状态信号（文案取自 YAML 的 output 节点） */
function phaseFromText(text: string, current: Phase): Phase {
  if (text.includes(SIGNALS.initializing)) return 'INITIALIZING';
  if (text.includes(SIGNALS.classStarted)) return 'ON_CLASS';
  if (text.includes(SIGNALS.reportPrefix)) return 'ENDING';
  return current;
}

export function reducer(model: ClassroomModel, action: ModelAction): ClassroomModel {
  switch (action.type) {
    case 'local_user': {
      // 老师气泡整段替换：一次本地输入只对应一条气泡，不追加、不按文本去重
      const rest = model.bubbles.filter((b) => b.id !== LOCAL_BUBBLE_ID);
      const bubbles: Bubble[] = [
        ...rest,
        { id: LOCAL_BUBBLE_ID, from: 'teacher', text: action.text, streaming: false },
      ];
      return {
        ...model,
        phase: model.phase === 'IDLE' ? 'INITIALIZING' : model.phase,
        bubbles,
        notice: null,
      };
    }

    case 'sending':
      return { ...model, busy: action.busy };

    case 'event': {
      const next = applyEvent(model, action.event);
      return next;
    }

    case 'card_submitted':
      // 提交即收走卡片（contract §4.3：置灰后不得继续可点）
      if (!model.card || model.card.actionId !== action.actionId) return model;
      return { ...model, card: null, busy: true };

    case 'card_dismissed':
      return { ...model, card: null };

    case 'notice':
      return { ...model, notice: { kind: action.kind, text: action.text }, busy: false };

    case 'clear_notice':
      return { ...model, notice: null };

    case 'snapshot': {
      const phase: Phase =
        action.card
          ? action.card.kind === 'pick_students'
            ? 'PICKING_STUDENTS'
            : 'ENDING'
          : action.classroomState === 'ON_CLASS'
            ? 'ON_CLASS'
            : model.phase === 'ON_CLASS'
              ? 'ENDING'
              : model.phase;
      return {
        ...model,
        classroomState: action.classroomState,
        turn: action.turn,
        students: action.students,
        reportUrl: action.reportUrl ?? model.reportUrl,
        card: action.card,
        phase,
      };
    }

    case 'ended':
      return { ...model, phase: 'ENDED', card: null, busy: false };

    case 'enter_scene':
      // 进入教室时丢弃备课阶段的对话，课堂从「选完学生」开始记录
      return { ...model, bubbles: [], banner: null };

    case 'banner_dismissed':
      return { ...model, banner: null };

    default:
      return model;
  }
}

/** 最近一条学生台词的人名（形如「小陈：……」），用于把提示归属到学生 */
function lastWorkflowSpeaker(model: ClassroomModel): string | null {
  for (let i = model.bubbles.length - 1; i >= 0; i -= 1) {
    const b = model.bubbles[i]!;
    if (b.from !== 'workflow') continue;
    const m = /^\s*([^\s：:]{1,6})\s*[：:]/.exec(b.text);
    if (m) return m[1] ?? null;
  }
  return null;
}

function applyEvent(model: ClassroomModel, event: ClassroomEvent): ClassroomModel {
  switch (event.type) {
    case 'meta':
      return model;

    case 'delta':
      return {
        ...model,
        bubbles: upsertBubble(model.bubbles, event.messageId, event.from, event.text, true),
      };

    case 'message': {
      // 多人可能同时发言：保留每位学生最近一句 + 老师最近一句，不按总条数截断
      const next = upsertBubble(model.bubbles, event.messageId, event.from, event.text, false);
      const keep: Bubble[] = [];
      const seen = new Set<string>();
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const b = next[i]!;
        if (b.from === 'teacher') {
          if (!seen.has('__teacher__')) {
            seen.add('__teacher__');
            keep.unshift(b);
          }
          continue;
        }
        const m = /^\s*([^\s：:]{1,6})\s*[：:]/.exec(b.text);
        const key = m ? m[1]! : '__anon__';
        if (!seen.has(key)) {
          seen.add(key);
          keep.unshift(b);
        }
      }
      if (event.from === 'teacher') return { ...model, bubbles: keep };
      return { ...model, bubbles: keep, phase: phaseFromText(event.text, model.phase) };
    }

    case 'banner':
      return {
        ...model,
        banner: { title: event.title, detail: event.detail, mode: event.mode },
        busy: false,
      };

    case 'hint':
      return {
        ...model,
        // 归属到具体学生；解析不出名字时挂到最近一条学生台词上
        hints: {
          ...model.hints,
          [event.name ?? lastWorkflowSpeaker(model) ?? '_']: event.text,
        },
      };

    case 'action': {
      const kind = event.kind ?? detectActionKind(event.question);
      if (!kind) return model;
      // 选学生卡片自己展示名册，上游那条长文案不进对话流，避免和卡片重复
      const bubbles =
        kind === 'pick_students'
          ? model.bubbles.filter((b) => !b.text.includes('选择本次课堂参与的学生'))
          : model.bubbles;
      return {
        ...model,
        bubbles,
        busy: false,
        card: {
          actionId: event.actionId,
          kind,
          question: event.question,
          options: event.options ?? [],
          multiple: Boolean(event.multiple),
          submitted: false,
          roster: event.roster ?? [],
        },
        phase: kind === 'pick_students' ? 'PICKING_STUDENTS' : 'ENDING',
      };
    }

    case 'state': {
      // 清理卡片之后的 state 意味着这一节真的走完了
      const finished = !model.card && model.phase === 'ENDING' && !event.classroomState.includes('ON_CLASS');
      const nextPhase: Phase = finished
        ? 'ENDED'
        : event.classroomState === 'ON_CLASS'
          ? 'ON_CLASS'
          : model.card
            ? model.phase
            : model.phase === 'ON_CLASS' || model.phase === 'ENDING' || model.phase === 'PICKING_STUDENTS'
              ? 'ENDING'
              : model.phase;
      // 收尾/结束阶段不再保留场景对白与学生标签
      const clearing = nextPhase === 'ENDING' || nextPhase === 'ENDED';
      return {
        ...model,
        classroomState: event.classroomState,
        turn: event.turn ?? model.turn,
        students: clearing ? [] : (event.students ?? model.students),
        reportUrl: event.lastReportUrl ?? model.reportUrl,
        bubbles: clearing && nextPhase === 'ENDED' ? [] : model.bubbles,
        phase: nextPhase,
      };
    }

    case 'error':
      return {
        ...model,
        busy: false,
        notice: { kind: 'error', text: `${event.message}${event.retryable ? '（可重试）' : ''}` },
      };

    case 'done':
      // done 里不再改 busy：上层请求结束才是唯一可靠信号，避免与服务端事件竞争导致卡死
      return model;

    default:
      return model;
  }
}
