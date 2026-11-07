/**
 * mock 上游：按 YAML 里的真实分支文案与节点顺序回放，让整条链路（含三张问答卡片）
 * 在没有 Coze 凭据时也能跑通并被验收。它不是"假 UI 数据"——它产出的仍是
 * 标准 UpstreamEvent，走过的代码路径与真实 Coze 完全一致。
 *
 * 剧本对应 docs/design-decisions.md §1 的拓扑。
 */
import { ROSTER } from '@shadow/shared';
import type { UpstreamEvent, ToolCall } from './coze.ts';
import type { UpstreamSource } from './orchestrator.ts';
import type { SessionRecord } from './store.ts';

export type { UpstreamSource };

interface Timing {
  deltaMs: number;
  gapMs: number;
}

const FAST: Timing = { deltaMs: 26, gapMs: 90 };
const SLOW: Timing = { deltaMs: 42, gapMs: 200 };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

let seq = 0;
function messageId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

function questionToolCall(question: string, options: string[], multiple: boolean): ToolCall {
  return {
    id: `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    type: 'function',
    function: {
      name: 'ask_question',
      arguments: JSON.stringify({ question, options, multiple }),
    },
  };
}

const STUDENT_QUESTION =
  '请选择本次课堂参与的学生（可多选）。回复学生编号，多个用逗号或空格分隔，例如 `1,3,5`：\n' +
  ROSTER.map((s) => `${s.id} = ${s.name}`).join('　');

interface Script {
  /** 老师这句话的意图：由关键字粗判，够 mock 用 */
  kind: 'init' | 'in_class' | 'end' | 'chitchat' | 'greeting';
}

function classify(text: string, session: SessionRecord): Script {
  const t = text.trim();
  if (/下课|结束|就到这里|今天就上到这里/.test(t)) return { kind: 'end' };
  if (/^(你好|hi|hello|在吗)/i.test(t)) return { kind: 'greeting' };
  if (session.classroomState === 'ON_CLASS') {
    const hasSubject = /数学|语文|英语|物理|化学|生物|历史|地理|政治|科学/.test(t);
    const hasKnowledge = /知识点|定理|公式|函数|方程|向量|古诗|语法|电路|细胞|氧化/.test(t);
    if (hasSubject && hasKnowledge) return { kind: 'init' };
    return { kind: 'in_class' };
  }
  // 未开课：够长就当作课程信息；太短会走"信息不足"分支
  return text.trim().length < 6 ? { kind: 'chitchat' } : { kind: 'init' };
}

export function createMockSource(): UpstreamSource {
  return {
    async *start({ session, text, signal }) {
      const chatId = messageId('chat');
      yield { kind: 'chat_created', conversationId: session.conversationId ?? messageId('conv'), chatId };

      const script = classify(text, session);

      if (script.kind === 'greeting') {
        yield* say('你好呀 我是影子课堂 输入科目 大概年级 核心（大概）知识点就可以开始模拟课堂了呀', FAST, signal);
        yield { kind: 'chat_completed', conversationId: session.conversationId };
        return;
      }

      if (script.kind === 'chitchat') {
        yield* say(
          session.classroomState === 'ON_CLASS'
            ? '模拟中暂时不支持课程外的内容 请继续课堂内容'
            : '请问你需要的是哪个年级、哪门学科的核心知识点呢？说清楚我就能开课了。',
          FAST,
          signal,
        );
        yield { kind: 'chat_completed', conversationId: session.conversationId };
        return;
      }

      if (script.kind === 'init' && session.classroomState === 'ON_CLASS') {
        yield* say('重开课堂请先结束当前课程', FAST, signal);
        yield { kind: 'chat_completed', conversationId: session.conversationId };
        return;
      }

      if (script.kind === 'end') {
        if (session.classroomState !== 'ON_CLASS') {
          yield* say('请先开始课程 开始课程需要先输入课程科目 大概学年级 大概（核心）知识点', FAST, signal);
          yield { kind: 'chat_completed', conversationId: session.conversationId };
          return;
        }
        yield {
          kind: 'requires_action',
          chatId,
          toolCalls: [questionToolCall('是否生成报告？', ['是', '否'], false)],
        };
        return;
      }

      if (script.kind === 'init' && session.classroomState !== 'ON_CLASS') {
        yield* say('正在初始化课堂', FAST, signal);
        await sleep(420, signal);


        // 163928 → 142720 批处理：逐生打分的过程
        yield {
          kind: 'requires_action',
          chatId,
          toolCalls: [questionToolCall(STUDENT_QUESTION, ROSTER.map((s) => s.name), true)],
        };
        return;
      }

      // 一次课中一轮：对应 1816786 / 1205865 / 1599286 三条台词，常见只有 1 条非空
      const speaker = pickSpeaker(session, text);
      if (speaker) {
        yield* say(`${speaker}：${replyFor(text, speaker)}`, SLOW, signal);
      } else {
        yield* say('（这一轮没有学生举手，课堂继续）', FAST, signal);
      }
      yield { kind: 'chat_completed', conversationId: session.conversationId };
    },

    async *resume({ session, chatId, answer, signal, action }) {
      if (!action) throw new Error('没有待回答的问题');

      yield { kind: 'chat_created', conversationId: session.conversationId ?? messageId('conv'), chatId };

      if (action.kind === 'pick_students') {
        await sleep(300, signal);
        yield* say('课堂已经开始 老师请开课', FAST, signal);
        yield { kind: 'chat_completed', conversationId: session.conversationId };
        return;
      }

      if (action.kind === 'confirm_report') {
        if (answer.trim() === '是') {
          yield* say('报告的PDF下载地址:https://mock.docmaker.coze.cn/report/' + session.sessionId + '.pdf', FAST, signal);
        }
        await sleep(200, signal);
        yield {
          kind: 'requires_action',
          chatId,
          toolCalls: [questionToolCall('是否删除数据？', ['是', '否'], false)],
        };
        return;
      }

      if (action.kind === 'confirm_cleanup') {
        await sleep(240, signal);
        yield* say(answer.trim() === '是' ? '课堂数据已清理，本节课堂结束。' : '课堂数据已保留，本节课堂结束。', FAST, signal);
        yield { kind: 'chat_completed', conversationId: session.conversationId };
        return;
      }

      yield { kind: 'chat_completed', conversationId: session.conversationId };
    },
  };
}

function pickSpeaker(session: SessionRecord, text: string): string | null {
  const active = session.students.filter((s) => s.confidence !== null);
  if (active.length === 0) return null;

  // 老师点名优先
  const named = active.find((s) => text.includes(s.name));
  if (named) return named.name;

  // 提问/表扬时挑参与度最高的那个，讲解时不发言（对应 1573750 的随机门限）
  if (/提问|谁来|说说|回答|试试|求|证明|等于|多少/.test(text)) {
    const top = [...active].sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))[0];
    return top ? top.name : null;
  }
  // 讲解时全班安静听讲，只有低概率有人插话
  if (Math.random() > 0.35) return null;
  return active[Math.floor(Math.random() * active.length)]?.name ?? null;
}

function replyFor(text: string, speaker: string): string {
  if (/提问|谁来|说说|回答|试试/.test(text)) {
    return '我觉得可以先把已知条件列出来，再一步步往下推。';
  }
  if (/表扬|很好|不错/.test(text)) {
    return '谢谢老师。';
  }
  if (/求|证明|等于|多少/.test(text)) {
    return `${speaker}在草稿纸上试了一种做法，算到一半停住了。`;
  }
  return '嗯……我先记下来。';
}

/** 把一段话按流式分片推出去，模拟 streamingOutput: true 的节点 */
async function* say(text: string, timing: Timing, signal: AbortSignal): AsyncGenerator<UpstreamEvent> {
  const id = messageId('msg');
  const chars = [...text];
  const step = Math.max(2, Math.ceil(chars.length / 24));
  for (let i = 0; i < chars.length; i += step) {
    await sleep(timing.deltaMs, signal);
    yield { kind: 'message_delta', messageId: id, text: chars.slice(i, i + step).join('') };
  }
  await sleep(timing.gapMs, signal);
  yield { kind: 'message_completed', messageId: id, text, type: 'answer' };
}
