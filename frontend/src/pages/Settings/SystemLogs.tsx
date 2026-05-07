/**
 * 系统日志 + 性能监控页面
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getSystemLogs, getLogSources, clearSystemLog, getPerfStats, ApiError, type PerfStats } from '../../services/api';
import { useUiStore } from '../../stores/uiStore';
import styles from './SystemLogs.module.css';

const LEVELS = [
  { value: '', label: '全部' },
  { value: 'info', label: 'INFO' },
  { value: 'warning', label: 'WARNING' },
  { value: 'error', label: 'ERROR' },
];

const PRESETS = [
  { label: '推理请求', keyword: 'inference_request|inference_completed' },
  { label: '限流', keyword: 'rate_limit' },
  { label: '路由', keyword: 'round_robin|resolve|no_route' },
  { label: '错误', keyword: 'error|failed|exception' },
];

function colorize(line: string): string {
  if (/\bERROR\b|exception|traceback/i.test(line)) return 'log-error';
  if (/\bWARNING\b|warn\b/i.test(line)) return 'log-warn';
  if (/\bDEBUG\b/i.test(line)) return 'log-debug';
  return '';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default function SystemLogs() {
  const showToast = useUiStore((s) => s.showToast);
  const [tab, setTab] = useState<'logs' | 'perf'>('logs');

  // Logs state
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(false);
  const [tail, setTail] = useState(200);
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [level, setLevel] = useState('');
  const [source, setSource] = useState('app');
  const [sources, setSources] = useState<Array<{ name: string; label: string; exists: boolean; size: number }>>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const prevLogsRef = useRef('');

  // Perf state
  const [perf, setPerf] = useState<PerfStats | null>(null);
  const [perfHours, setPerfHours] = useState(24);
  const [perfLoading, setPerfLoading] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 500);
    return () => clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    getLogSources().then(setSources).catch((err) => {
      const detail = err instanceof ApiError ? err.detail : '日志源加载失败';
      showToast({ type: 'error', message: detail });
    });
  }, [showToast]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const text = await getSystemLogs({ source, tail, keyword: debouncedKeyword || undefined, level: level || undefined });
      const content = text || '（空）';
      if (content !== prevLogsRef.current) {
        prevLogsRef.current = content;
        setLogs(content);
      }
    } catch { setLogs('加载失败'); }
    finally { setLoading(false); }
  }, [source, tail, debouncedKeyword, level]);

  useEffect(() => { if (tab === 'logs') fetchLogs(); }, [fetchLogs, tab]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);
  useEffect(() => {
    if (!autoRefresh || tab !== 'logs') return;
    const timer = setInterval(fetchLogs, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchLogs, tab]);

  const handleClear = async () => {
    try {
      await clearSystemLog(source);
      showToast({ message: '日志已清空', type: 'success' });
      prevLogsRef.current = '';
      fetchLogs();
    } catch (err) {
      showToast({ message: err instanceof ApiError ? err.detail : '清空失败', type: 'error' });
    }
  };

  const fetchPerf = useCallback(async () => {
    setPerfLoading(true);
    try { setPerf(await getPerfStats(perfHours)); }
    catch { setPerf(null); }
    finally { setPerfLoading(false); }
  }, [perfHours]);

  useEffect(() => { if (tab === 'perf') fetchPerf(); }, [fetchPerf, tab]);

  const coloredHtml = useMemo(() => {
    return logs.split('\n').map((line) => {
      const escaped = escapeHtml(line);
      const cls = colorize(line);
      return cls ? `<span class="${cls}">${escaped}</span>` : escaped;
    }).join('\n');
  }, [logs]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.tabBar}>
          <button className={`${styles.tabBtn} ${tab === 'logs' ? styles.tabBtnActive : ''}`} onClick={() => setTab('logs')}>日志</button>
          <button className={`${styles.tabBtn} ${tab === 'perf' ? styles.tabBtnActive : ''}`} onClick={() => setTab('perf')}>性能</button>
        </div>
        {tab === 'logs' && (
          <div className={styles.actions}>
            <label className={styles.autoRefresh}>
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              自动刷新
            </label>
            <button className={styles.refreshBtn} onClick={fetchLogs} disabled={loading}>刷新</button>
            <button className={styles.clearBtn} onClick={handleClear}>清空</button>
          </div>
        )}
      </div>

      {tab === 'logs' && (
        <>
          <div className={styles.filters}>
            <select className={styles.select} value={source} onChange={(e) => setSource(e.target.value)}>
              {sources.length > 0 ? sources.map((s) => (
                <option key={s.name} value={s.name} disabled={!s.exists}>
                  {s.label} {s.size > 0 ? `(${(s.size / 1024).toFixed(0)}KB)` : ''}
                </option>
              )) : <option value="app">应用日志</option>}
            </select>
            <select className={styles.select} value={level} onChange={(e) => setLevel(e.target.value)}>
              {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
            <input className={styles.input} type="text" value={keyword}
              onChange={(e) => setKeyword(e.target.value)} placeholder="关键词过滤..." />
            <select className={styles.select} value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              {[100, 200, 500, 1000, 2000].map((n) => <option key={n} value={n}>最近 {n} 行</option>)}
            </select>
            <div className={styles.presets}>
              {PRESETS.map((p) => (
                <button key={p.label}
                  className={`${styles.presetBtn} ${keyword === p.keyword ? styles.presetActive : ''}`}
                  onClick={() => setKeyword(keyword === p.keyword ? '' : p.keyword)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <pre ref={logRef} className={styles.logContent} dangerouslySetInnerHTML={{ __html: coloredHtml }} />
        </>
      )}

      {tab === 'perf' && (
        <div className={styles.perfContainer}>
          <div className={styles.perfHeader}>
            <select className={styles.select} value={perfHours} onChange={(e) => setPerfHours(Number(e.target.value))}>
              {[1, 6, 12, 24, 48, 168].map((h) => <option key={h} value={h}>最近 {h} 小时</option>)}
            </select>
            <button className={styles.refreshBtn} onClick={fetchPerf} disabled={perfLoading}>
              {perfLoading ? '加载中...' : '刷新'}
            </button>
          </div>

          {perf ? (
            <>
              <div className={styles.perfCards}>
                {[
                  { label: '请求总数', value: perf.total },
                  { label: '平均延迟', value: perf.stats.avgMs ? `${perf.stats.avgMs}ms` : '—' },
                  { label: 'P95 延迟', value: perf.stats.p95Ms ? `${perf.stats.p95Ms}ms` : '—' },
                  { label: '成功率', value: perf.total > 0 ? `${Math.round((perf.byStatus.success || 0) / perf.total * 100)}%` : '—' },
                ].map((c) => (
                  <div key={c.label} className={styles.perfCard}>
                    <div className={styles.perfCardLabel}>{c.label}</div>
                    <div className={styles.perfCardValue}>{c.value}</div>
                  </div>
                ))}
              </div>

              {perf.byModel && Object.keys(perf.byModel).length > 0 && (
                <div className={styles.perfSection}>
                  <h4 className={styles.perfSectionTitle}>按模型</h4>
                  <table className={styles.perfTable}>
                    <thead><tr><th>模型</th><th>请求数</th></tr></thead>
                    <tbody>
                      {Object.entries(perf.byModel).map(([model, count]) => (
                        <tr key={model}><td>{model}</td><td>{count}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {perf.byStatus && Object.keys(perf.byStatus).length > 0 && (
                <div className={styles.perfSection}>
                  <h4 className={styles.perfSectionTitle}>按状态</h4>
                  <table className={styles.perfTable}>
                    <thead><tr><th>状态</th><th>数量</th></tr></thead>
                    <tbody>
                      {Object.entries(perf.byStatus).map(([status, count]) => (
                        <tr key={status}><td>{status}</td><td>{count}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : !perfLoading ? (
            <div className={styles.empty}>暂无数据</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
