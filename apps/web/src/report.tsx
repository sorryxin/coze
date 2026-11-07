/**
 * 报告页。真正的报告正文目前由 Coze 的 Doc Maker 生成 PDF（design-decisions §4），
 * 这里只做「下载入口 + 本次课堂的本地记录」，避免和 Doc Maker 的排版打架。
 */
import { useEffect, useState } from 'react';
import { getSnapshot } from './api.ts';
import type { SessionSnapshot } from '@shadow/shared';

export function ReportPage() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session') ?? '';
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setError('缺少 session 参数');
      return;
    }
    getSnapshot(sessionId)
      .then(setSnap)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取课堂失败'));
  }, [sessionId]);

  return (
    <div className="report">
      <header className="report-head">
        <div>
          <h1>课堂报告</h1>
          <p className="hint">课堂 {sessionId || '—'}</p>
        </div>
        <a className="btn ghost" href="/">
          返回课堂
        </a>
      </header>

      {error && <div className="notice error">{error}</div>}

      {snap && (
        <div className="report-grid">
          <section className="report-card">
            <h2>PDF 报告</h2>
            {snap.lastReportUrl ? (
              <>
                <a className="report-link" href={snap.lastReportUrl} target="_blank" rel="noreferrer">
                  下载 PDF
                </a>
                <p className="hint">链接由 Coze Doc Maker 生成，有有效期，请及时保存。</p>
              </>
            ) : (
              <p className="hint">本节课堂还没有生成报告。回到课堂说「下课」，在询问时选「是」即可。</p>
            )}
          </section>

          <section className="report-card">
            <h2>课堂概况</h2>
            <div className="kv">
              <span>状态</span>
              <b>{snap.classroomState === 'ON_CLASS' ? '上课中' : '未开始'}</b>
            </div>
            <div className="kv">
              <span>轮次</span>
              <b>{snap.turn}</b>
            </div>
            <div className="kv">
              <span>开始时间</span>
              <b>{new Date(snap.createdAt).toLocaleString('zh-CN')}</b>
            </div>
          </section>

          <section className="report-card wide">
            <h2>学生指标</h2>
            {snap.students.length === 0 ? (
              <p className="hint">本次没有入座学生记录。</p>
            ) : (
              <table className="metrics">
                <thead>
                  <tr>
                    <th>学生</th>
                    <th>掌握度</th>
                    <th>信心</th>
                    <th>参与度</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.students.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.name} <span className="hint">#{s.id}</span>
                      </td>
                      <td>{s.mastery ?? '—'}</td>
                      <td>{s.confidence ?? '—'}</td>
                      <td>{s.engagement ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
