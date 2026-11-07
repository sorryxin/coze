import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { MAX_STUDENTS, ROSTER, type StudentBrief } from '@shadow/shared';
import { createSession, getSnapshot, streamRequest, ApiError } from './api.ts';
import { initialModel, reducer, type Bubble, type Card, type ClassroomModel } from './state.ts';

const PHASE_LABEL: Record<ClassroomModel['phase'], string> = {
  IDLE: '待开场',
  INITIALIZING: '初始化中',
  PICKING_STUDENTS: '选学生',
  ON_CLASS: '上课中',
  ENDING: '收尾',
  ENDED: '已结束',
};

export function ClassroomPage() {
  const [started, setStarted] = useState(false);
  /** 已提交选学生时记录人数，用于切换独立的等待过场 */
  const [seating, setSeating] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, dispatch] = useReducer(reducer, initialModel);
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  // 进入页面就开一节新课（一次刷新 = 一节课堂，符合「新课堂 = 变量归零」的设计）
  useEffect(() => {
    let alive = true;
    createSession()
      .then((r) => {
        if (alive) setSessionId(r.sessionId);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setBootError(err instanceof ApiError ? err.message : '无法创建课堂，请检查 BFF 是否启动');
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [model.bubbles, model.card]);

  const canSend = Boolean(sessionId) && !model.busy && !model.card && model.phase !== 'ENDED';

  async function send(text: string) {
    const value = text.trim();
    if (!value || !sessionId || model.busy) return;
    setDraft('');
    // 老师气泡由上方本地追加；服务端也会推一条 teacher 回显，统一忽略，避免重复
    dispatch({ type: 'local_user', text: value });
    dispatch({ type: 'sending', busy: true });
    try {
      await streamRequest(
        `/sessions/${sessionId}/chat`,
        { text: value, clientMsgId: `c_${Date.now()}` },
        (event) => {
          if (event.type === 'message' && event.from === 'teacher') return;
          dispatch({ type: 'event', event });
        },
      );
    } catch (err) {
      dispatch({ type: 'notice', kind: 'error', text: describe(err) });
      // 失败后必须校准，否则本地 card/状态与服务端不一致会一直卡住
      await refresh().catch(() => undefined);
    } finally {
      dispatch({ type: 'sending', busy: false });
    }
  }

  async function submitCard(answer: string) {
    if (!sessionId || !model.card) return;
    const actionId = model.card.actionId;
    dispatch({ type: 'card_submitted', actionId });
    try {
      await streamRequest(`/sessions/${sessionId}/actions/${actionId}`, { answer }, (event) =>
        dispatch({ type: 'event', event }),
      );
    } catch (err) {
      const message = describe(err);
      dispatch({ type: 'notice', kind: 'error', text: message });
      // ACTION_EXPIRED 一类错误必须校准：以服务端快照为准
      try {
        await refresh();
      } catch {
        dispatch({ type: 'card_dismissed' });
      }
    } finally {
      dispatch({ type: 'sending', busy: false });
    }
  }

  async function refresh() {
    if (!sessionId) return;
    const snap = await getSnapshot(sessionId);
    const card: Card | null = snap.pendingAction
      ? {
          actionId: snap.pendingAction.actionId,
          kind: snap.pendingAction.kind,
          question: snap.pendingAction.question,
          options: snap.pendingAction.options ?? [],
          multiple: Boolean(snap.pendingAction.multiple),
          submitted: false,
          roster: [],
        }
      : null;
    dispatch({
      type: 'snapshot',
      classroomState: snap.classroomState,
      turn: snap.turn,
      students: snap.students,
      reportUrl: snap.lastReportUrl,
      card,
    });
  }

  const canPickMore = picked.length < MAX_STUDENTS;

  /**
   * 背景图按学生人数切换。
   * 优先级：正在勾选时用"已勾选人数"（预览效果），否则用实际入座人数。
   * 三张图放在 apps/web/public/backgrounds/ 下，构图一致、只差人数。
   */
  const previewCount =
    model.card?.kind === 'pick_students' && picked.length > 0 ? picked.length : model.students.length;
  const seatsCount = Math.min(Math.max(previewCount, 1), 3);
  const sceneUrl = `url(/backgrounds/classroom-${seatsCount}.png)`;
  const sceneKey = String(seatsCount);

  /**
   * 三个阶段的界面：
   *  1. cover   —— 未点开始，只显示介绍
   *  2. prep    —— 已点开始，但还没走到选学生：在封面页上完成开场白问答
   *  3. scene   —— 出现选学生卡片后进入教室场景
   *
   * 结束态一律留在场景里（展示结束卡片），不能因为学生列表被清空而退回别处。
   */
  const inScene =
    started &&
    (model.card !== null ||
      model.students.length > 0 ||
      model.turn > 0 ||
      model.phase === 'ON_CLASS' ||
      model.phase === 'ENDING' ||
      model.phase === 'ENDED');

  // 首次进入教室时清掉备课阶段的对话（只执行一次）
  const enteredRef = useRef(false);
  useEffect(() => {
    if (inScene && !enteredRef.current) {
      enteredRef.current = true;
      dispatch({ type: 'enter_scene' });
    }
  }, [inScene]);

  if (!started) {
    return <Cover onStart={() => setStarted(true)} />;
  }

  if (!inScene) {
    // 已提交选学生、正在等课堂就绪：用独立的过场，避免停留在备课页看起来像卡住
    if (seating && model.phase !== 'ENDED') {
      return <Loading count={seating} />;
    }
    return (
      <Prep
        model={model}
        draft={draft}
        setDraft={setDraft}
        canSend={canSend}
        busy={model.busy}
        bootError={bootError}
        clearBootError={() => setBootError(null)}
        dispatch={dispatch}
        onSend={send}
      />
    );
  }

  return (
    <div className="shell immersive" style={{ ['--scene' as string]: sceneUrl }} data-seats={sceneKey}>
      {/* 顶部居中状态胶囊 */}
      <div className="hud-top">
        <div className="hud-pill">
          <span className={`dot ${model.phase === 'ON_CLASS' ? 'on' : 'warn'}`} />
          <div className="hud-pill-text">
            <b>影子课堂</b>
            <span>
              {PHASE_LABEL[model.phase]}
              {model.phase === 'ON_CLASS' && model.turn > 0 ? ` · 第 ${model.turn} 轮` : ''}
              {model.students.length > 0 ? ` · ${model.students.length} 名学生` : ''}
            </span>
          </div>
        </div>
      </div>

      {/* 左上角：场景标识 */}
      <div className="hud-corner left">
        <span className="hud-tag">沉浸式课堂</span>
      </div>

      {/* 右上角：课堂编号 + 结束 */}
      <div className="hud-corner right">
        {model.busy && <span className="hud-tag">生成中…</span>}
        {sessionId && <span className="hud-tag muted">课堂 {sessionId.slice(-6)}</span>}
        <button
          type="button"
          className="hud-btn"
          disabled={model.phase === 'ENDED'}
          onClick={() => void send('今天就上到这里，下课')}
        >
          结束课堂
        </button>
      </div>

      {/* 学生头顶标签（点击展开详情） */}
      <SeatTags students={model.students} count={seatsCount} />

      {/* 场景对白：老师近讲台、学生在各自座位，不做聊天记录 */}
      <SceneDialogue
        bubbles={model.bubbles}
        students={model.students}
        count={seatsCount}
        hints={model.hints}
      />

      {/* 整屏系统提示覆盖层 */}
      {model.banner && (
        <div
          className={`banner-overlay ${model.banner.mode}`}
          onClick={() => model.banner?.mode === 'transient' && dispatch({ type: 'banner_dismissed' })}
        >
          <div className="banner-box">
            <div className="banner-title">{model.banner.title}</div>
            <div className="banner-detail">{model.banner.detail}</div>
            {model.banner.mode === 'persistent' ? (
              <button
                type="button"
                className="banner-btn"
                onClick={() => dispatch({ type: 'banner_dismissed' })}
              >
                知道了
              </button>
            ) : (
              <div className="banner-hint">点击屏幕继续</div>
            )}
          </div>
        </div>
      )}

      {/* 底部浮动指令面板 */}
      <div className="dock">
        {bootError && <Notice kind="error" text={bootError} onClose={() => setBootError(null)} />}
        {model.notice && (
          <Notice
            kind={model.notice.kind}
            text={model.notice.text}
            onClose={() => dispatch({ type: 'clear_notice' })}
          />
        )}

        {model.bubbles.length === 0 && !bootError && !model.card && (
          <div className="dock-hint">{openingHint(model.students)}</div>
        )}

        {model.card && model.card.kind === 'pick_students' && (
          <div className="dock-card">
            <div className="dock-title">选择本节课的学生</div>
            <div className="dock-sub">最多可邀请 {MAX_STUDENTS} 位学生</div>
            <div className="students">
              {rosterForCard(model.card).map((s) => {
                const on = picked.includes(s.id);
                const disabled = model.busy || (!on && !canPickMore);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`student ${on ? 'sel' : ''}`}
                    disabled={disabled}
                    onClick={() =>
                      setPicked((prev) =>
                        prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id],
                      )
                    }
                  >
                    <span className="no">{s.id}</span>
                    <span className="s-name">{s.name}</span>
                    {s.persona && <span className="s-persona">{s.persona}</span>}
                  </button>
                );
              })}
            </div>
            <div className="row">
              <button
                type="button"
                className="btn primary"
                disabled={picked.length === 0 || model.busy}
                onClick={() => {
                  // 不在这里 setPicked([])：清空会让按钮立刻变成「0 人」并可能丢失点击
                  const ids = [...picked].sort((a, b) => a - b);
                  setSeating(ids.length || 1);
                  void submitCard(ids.join(','));
                }}
              >
                {model.busy ? '提交中…' : `开始上课（${picked.length} 人）`}
              </button>
              {!canPickMore && <span className="hint">人数已满，可先取消一位再选</span>}
            </div>
          </div>
        )}

        {model.card && model.card.kind !== 'pick_students' && (
          <div className="dock-card">
            <div className="dock-title">
              {model.card.kind === 'confirm_report' ? '是否生成课堂报告？' : '是否清理本节课堂数据？'}
            </div>
            <div className="dock-sub">
              {model.card.kind === 'confirm_report'
                ? '选「是」会生成 PDF 课堂报告；选「否」直接进入下一步。'
                : '选「是」会删除数据表里的课堂记录，选「否」保留以便复算。'}
            </div>
            <div className="row">
              {(model.card.options.length ? model.card.options : ['是', '否']).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`btn wide ${opt === '是' ? 'primary' : ''}`}
                  disabled={model.busy}
                  onClick={() => void submitCard(opt)}
                >
                  {opt === '是' ? '是' : '否'}
                </button>
              ))}
            </div>
          </div>
        )}

        {model.reportUrl && (
          <div className="dock-report">
            <a className="report-link" href={model.reportUrl} target="_blank" rel="noreferrer">
              下载课堂报告 PDF
            </a>
          </div>
        )}

        {model.phase === 'ENDED' ? (
          <div className="row" style={{ justifyContent: 'center' }}>
            <span className="hint">本节课堂已结束。</span>
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              新开一节课堂
            </button>
          </div>
        ) : (
          !model.card && (
            <form
              className="composer-inner"
              onSubmit={(e) => {
                e.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                value={draft}
                placeholder={
                  model.phase === 'ON_CLASS'
                    ? '讲解、提问或点名，说「下课」结束课堂'
                    : '输入学科、年级与知识点'
                }
                disabled={!canSend}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (canSend) void send(draft);
                  }
                }}
              />
              <button
                type="submit"
                className="btn primary"
                disabled={!canSend || draft.trim() === ''}
                onClick={(e) => {
                  e.preventDefault();
                  if (canSend && draft.trim() !== '') void send(draft);
                }}
              >
                {model.busy ? '生成中…' : '发送'}
              </button>
            </form>
          )
        )}
      </div>
    </div>
  );
}

/** 卡片优先用上游解析出的真实名册；拿不到时退回内置 6 人 */
function rosterForCard(card: Card): Array<{ id: number; name: string; persona: string }> {
  if (card.roster.length > 0) return card.roster;
  return ROSTER.map((s) => ({ id: s.id, name: s.name, persona: '' }));
}

/**
 * 学生头顶标签。
 *
 * 位置按背景图里学生的实际位置标定（百分比坐标）：
 *  - 1 人：正中  50%
 *  - 2 人：左右对称 36% / 64%
 *  - 3 人：三等分 27% / 50% / 73%
 * 纵向固定在 62% 左右（学生肩部以上），点击展开 K/C/E 详情。
 */
const SEAT_POSITIONS: Record<number, number[]> = {
  1: [50],
  2: [36, 64],
  3: [27, 50, 73],
};

/** 台词纵向位置：错开高度，避免并排时气泡在同一水平线上互相遮挡 */
const STUDENT_LINE_TOP: Record<number, number> = { 0: 74, 1: 66, 2: 74 };

/**
 * 提示面板的展开方位。
 *  - 单人：向上弹（mid）
 *  - 左侧学生：向左
 *  - 右侧学生：向右
 *  - 中间学生：向上弹（mid），避免压住自己的台词
 */
function hintSide(index: number, count: number): 'left' | 'right' | 'mid' {
  if (count <= 1) return 'mid';
  if (index === 0) return 'left';
  if (index === count - 1) return 'right';
  return 'mid';
}

function SeatTags({ students, count }: { students: StudentBrief[]; count: number }) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (students.length === 0) return null;

  const xs = SEAT_POSITIONS[Math.min(count, 3)] ?? SEAT_POSITIONS[3]!;

  return (
    <div className="seat-tags">
      {students.map((s, i) => {
        const left = xs[i] ?? 50;
        const open = openId === s.id;
        return (
          <div
            key={s.id}
            className={`seat-tag ${open ? 'open' : ''}`}
            data-index={i}
            style={{ left: `${left}%` }}
          >
            <button
              type="button"
              className="seat-tag-head"
              onClick={(e) => {
                e.stopPropagation();
                setOpenId(open ? null : s.id);
              }}
            >
              {s.name}
              <span className="seat-tag-caret">{open ? '▾' : '▸'}</span>
            </button>

            {open && (
              <div className="seat-pop">
                <div className="seat-pop-title">
                  {s.name} <span>#{s.id}</span>
                </div>
                {s.persona && <div className="seat-pop-persona">{s.persona}</div>}
                <Metric cls="k" label="掌握" value={s.mastery} />
                <Metric cls="c" label="信心" value={s.confidence} />
                <Metric cls="e" label="参与" value={s.engagement} />
                {s.mastery === null && s.confidence === null && s.engagement === null && (
                  <div className="seat-pop-hint">本轮尚未产出指标</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 封面：进入课堂前的介绍页 */
function Cover({ onStart }: { onStart: () => void }) {
  return (
    <div className="cover">
      <div className="cover-bg" />
      <div className="cover-inner">
        <div className="cover-mark">影子课堂</div>
        <div className="cover-en">SHADOW CLASSROOM</div>

        <p className="cover-lead">
          你讲，他们听。也有人说错，有人走神，有人举手。
        </p>

        <ul className="cover-points">
          <li>
            <b>开课</b>
            <span>说一句学科、年级和知识点，课堂自动搭建</span>
          </li>
          <li>
            <b>上课</b>
            <span>最多三名学生入座，讲解、提问、点名都由你决定</span>
          </li>
          <li>
            <b>观察</b>
            <span>点开学生名签，看他的掌握度、信心与参与度如何变化</span>
          </li>
          <li>
            <b>结课</b>
            <span>说「下课」即可生成课堂报告，附完整复盘</span>
          </li>
        </ul>

        <button type="button" className="cover-start" onClick={onStart}>
          开始上课
        </button>

        <div className="cover-foot">建议佩戴耳机，在安静环境中使用</div>
      </div>
    </div>
  );
}

/**
 * 开课前：在封面画面上完成开场白问答。
 * 这里的对话属于"备课阶段"，不进入教室场景，避免背景图上空对话。
 */
function Prep({
  model,
  draft,
  setDraft,
  canSend,
  busy,
  bootError,
  clearBootError,
  dispatch,
  onSend,
}: {
  model: ClassroomModel;
  draft: string;
  setDraft: (v: string) => void;
  canSend: boolean;
  busy: boolean;
  bootError: string | null;
  clearBootError: () => void;
  dispatch: (a: { type: 'clear_notice' }) => void;
  onSend: (text: string) => void;
}) {
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [model.bubbles]);

  return (
    <div className="cover prep">
      <div className="cover-bg" />
      <div className="prep-inner">
        <header className="prep-head">
          <div className="cover-mark small">影子课堂</div>
          <div className="prep-sub">
            先告诉我这节课要讲什么
            <span>学科 · 年级 · 核心知识点</span>
          </div>
        </header>

        <div className="prep-feed" ref={feedRef}>
          {model.bubbles.length === 0 && (
            <div className="prep-empty">
              例如：<b>初二数学，一次函数的图像</b>
            </div>
          )}
          {model.bubbles.map((b) => (
            <div key={b.id} className={`prep-line ${b.from}`}>
              <span className="prep-who">{b.from === 'teacher' ? '我' : '影子课堂'}</span>
              <div className="prep-text">
                {b.text}
                {b.streaming && <span className="caret" />}
              </div>
            </div>
          ))}
        </div>

        <div className="prep-dock">
          {bootError && <Notice kind="error" text={bootError} onClose={clearBootError} />}
          {model.notice && (
            <Notice
              kind={model.notice.kind}
              text={model.notice.text}
              onClose={() => dispatch({ type: 'clear_notice' })}
            />
          )}
          <form
            className="prep-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSend) onSend(draft);
            }}
          >
            <textarea
              value={draft}
              placeholder="例如：初二数学，一次函数的图像"
              disabled={!canSend}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) onSend(draft);
                }
              }}
            />
            <button
              type="submit"
              className="cover-start small"
              disabled={!canSend || draft.trim() === ''}
              onClick={(e) => {
                e.preventDefault();
                if (canSend && draft.trim() !== '') onSend(draft);
              }}
            >
              {busy ? '准备中…' : '开始备课'}
            </button>
          </form>
          <div className="prep-tip">准备好学生名单后会自动进入教室</div>
        </div>
      </div>
    </div>
  );
}

/**
 * 场景对白。
 *
 * 不做聊天记录：只显示最近一条老师台词（贴在讲台附近）和最近一条学生台词
 * （贴在该学生座位上方），读完即被下一句替换。
 *
 * 学生台词形如「孙八：……」，这里剥掉人名前缀——位置已经表明是谁在说，
 * 并据此把气泡挂到说话的那个学生头上，而不是固定居中。
 */

const SPEAKER_PREFIX = /^\s*([^\s：:]{1,6})\s*[：:]\s*/;

/** 问答卡片的文案不是台词，不进场景 */
function isCardPrompt(text: string): boolean {
  return (
    text.includes('选择本次课堂参与的学生') ||
    text.includes('是否生成报告') ||
    text.includes('是否删除数据')
  );
}

function splitSpeaker(text: string): { name: string | null; body: string } {
  const m = SPEAKER_PREFIX.exec(text);
  if (!m) return { name: null, body: text };
  return { name: m[1] ?? null, body: text.slice(m[0].length) };
}

function SceneDialogue({
  bubbles,
  students,
  count,
  hints,
}: {
  bubbles: Bubble[];
  students: StudentBrief[];
  count: number;
  hints: Record<string, string>;
}) {
  const [hintOpen, setHintOpen] = useState<string | null>(null);
  const lastTeacher = [...bubbles].reverse().find((b) => b.from === 'teacher');

  const xs = SEAT_POSITIONS[Math.min(count, 3)] ?? SEAT_POSITIONS[3]!;

  /**
   * 学生台词按人归位：多人同时发言时各自显示在自己头顶，不互相覆盖。
   * 只保留每个学生的最后一句。
   */
  const byStudent = new Map<string, Bubble>();
  for (const b of bubbles) {
    if (b.from !== 'workflow' || isCardPrompt(b.text)) continue;
    const { name } = splitSpeaker(b.text);
    if (name && students.some((s) => s.name === name)) byStudent.set(name, b);
  }

  const speakingNames = new Set(byStudent.keys());

  return (
    <>
      {lastTeacher && (
        <div className="line-teacher">
          <div className="line-bubble teacher">
            {lastTeacher.text}
            {lastTeacher.streaming && <span className="caret" />}
          </div>
        </div>
      )}

      {students.map((s, i) => {
        const bubble = byStudent.get(s.name);
        if (!bubble) return null;
        const { body } = splitSpeaker(bubble.text);
        const hint = hints[s.name];
        const open = hintOpen === s.name;
        const expanded = Boolean(hint) && open;

        return (
          <div
            key={s.id}
            className={`line-student ${expanded ? 'expanded' : ''}`}
            style={{
              left: `${xs[i] ?? 50}%`,
              top: `${STUDENT_LINE_TOP[i] ?? 74}%`,
              // 展开时抬高层级，避免被相邻气泡压住
              zIndex: expanded ? 40 : 18,
            }}
          >
            <div className="line-bubble student">
              {body}
              {bubble.streaming && <span className="caret" />}
            </div>

            {/* 半隐藏：默认收起，点「提示」才展开；横向展开，避开输入框与相邻气泡 */}
            {hint && (
              <div className={`hint-wrap ${open ? 'open' : ''} ${hintSide(i, count)}`}>
                <button
                  type="button"
                  className={`hint-toggle ${open ? 'open' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHintOpen(open ? null : s.name);
                  }}
                >
                  提示
                  <span className="hint-caret">{open ? '▴' : '▾'}</span>
                </button>
                {open && <div className="hint-body">{hint}</div>}
              </div>
            )}
          </div>
        );
      })}

      {[...speakingNames].map((name) => {
        const idx = students.findIndex((s) => s.name === name);
        if (idx < 0) return null;
        return (
          <style key={name}>{`.seat-tag[data-index="${idx}"] .seat-tag-head{background:#b5651d}`}</style>
        );
      })}
    </>
  );
}

/** 进入教室后的开场引导：直接让老师开口讲课或提问 */
function openingHint(students: StudentBrief[]): string {
  const names = students.map((s) => s.name);
  if (names.length === 0) return '开始讲课吧';
  if (names.length === 1) return `${names[0]} 已经坐好了，开始讲课或提问吧`;
  const last = names[names.length - 1]!;
  return `${names.slice(0, -1).join('、')} 和 ${last} 已经坐好，开始讲课或点名提问吧`;
}

/** 选完学生后的等待过场：与封面/备课页都不同，给"课堂正在建立"的实感 */
function Loading({ count }: { count: number }) {
  const steps = ['学生陆续入座', '建立课堂档案', '准备第一轮对话'];
  const [step, setStep] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % steps.length), 1800);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="loading">
      <div className="loading-bg" />
      <div className="loading-inner">
        <div className="loading-ring">
          {Array.from({ length: count }).map((_, i) => (
            <span key={i} className="loading-seat" style={{ animationDelay: `${i * 0.16}s` }} />
          ))}
        </div>

        <div className="loading-title">{count} 位学生正在入座</div>
        <div className="loading-steps">
          {steps.map((s, i) => (
            <span key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
              {s}
            </span>
          ))}
        </div>

        <div className="loading-bar">
          <span />
        </div>
        <div className="loading-foot">课堂正在建立，请稍候</div>
      </div>
    </div>
  );
}

function Message({ from, text, streaming }: { from: 'teacher' | 'workflow'; text: string; streaming: boolean }) {
  return (
    <div className={`msg ${from}`}>
      <div className="avatar">{from === 'teacher' ? '师' : '影'}</div>
      <div className="bubble">
        {text}
        {streaming && <span className="caret" />}
      </div>
    </div>
  );
}

function Notice({ kind, text, onClose }: { kind: 'error' | 'info'; text: string; onClose: () => void }) {
  return (
    <div className={`notice ${kind}`}>
      <span>{text}</span>
      <button type="button" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}

function Metric({ cls, label, value }: { cls: string; label: string; value: number | null }) {
  const known = value !== null;
  const v = known ? Math.max(0, Math.min(100, value as number)) : 0;
  return (
    <div className="metric">
      <span>{label}</span>
      <span className={`bar ${cls}`}>
        <span style={{ width: `${v}%`, opacity: known ? 1 : 0 }} />
      </span>
      <span className="val">{known ? v : '—'}</span>
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'ACTION_EXPIRED') return '这张卡片已过期，已为你同步最新状态';
    if (err.code === 'CHAT_IN_PROGRESS') return '上一轮还在生成，请稍候';
    if (err.code === 'SESSION_CLOSED') return '本节课堂已结课';
    if (err.code === 'UNAUTHORIZED') return '登录态失效，请刷新页面';
    return err.message;
  }
  if (err instanceof TypeError) return '无法连接服务端，请确认 BFF 已启动';
  return err instanceof Error ? err.message : '未知错误';
}
