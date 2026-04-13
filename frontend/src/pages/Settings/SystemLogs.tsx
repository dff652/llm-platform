/**
 * 系统日志 + 性能监控页面
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { getSystemLogs, getLogSources, clearSystemLog, getPerfStats, ApiError, type PerfStats } from '../../services/api';
import { useUiStore } from '../../stores/uiStore';
import styles from './SystemLogs.module.css';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const LEVELS = [
  { value: '', label: '全部' },
  { value: 'info', label: 'INFO' },
  { value: 'warning', label: 'WARNING' },
  { value: 'error', label: 'ERROR' },
];

const PRESETS = [
  { label: '推理请求', keyword: 'inference_request|inference_completed' },
  { label: '限流', keyword: 'rate_limit' },
  { label: '并发', keyword: 'concurrency|queued|dispatched' },
  { label: '错误', keyword: 'error|failed|exception' },
  { label: 'IoTDB', keyword: 'iotdb' },
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

  useEffect(() => { getLogSources().then(setSources).catch(() => {}); }, []);

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
                  { label: '任务总数', value: perf.total },
                  { label: '平均耗时', value: perf.stats.avg ? `${perf.stats.avg}s` : '—' },
                  { label: 'P95 耗时', value: perf.stats.p95 ? `${perf.stats.p95}s` : '—' },
                  { label: '成功率', value: perf.total > 0 ? `${Math.round(((perf.byStatus.completed || 0) + (perf.byStatus.partial_success || 0)) / perf.total * 100)}%` : '—' },
                ].map((c) => (
                  <div key={c.label} className={styles.perfCard}>
                    <div className={styles.perfCardLabel}>{c.label}</div>
                    <div className={styles.perfCardValue}>{c.value}</div>
                  </div>
                ))}
              </div>

              {Object.keys(perf.byAlgorithm).length > 0 && (
                <div className={styles.perfSection}>
                  <h4 className={styles.perfSectionTitle}>按算法</h4>
                  <table className={styles.perfTable}>
                    <thead><tr><th>算法</th><th>次数</th><th>平均耗时</th><th>P95</th></tr></thead>
                    <tbody>
                      {Object.entries(perf.byAlgorithm).map(([algo, s]) => (
                        <tr key={algo}><td>{algo}</td><td>{s.count}</td><td>{s.avg}s</td><td>{s.p95}s</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {perf.byHour.length > 1 && (
                <div className={styles.perfSection}>
                  <h4 className={styles.perfSectionTitle}>吞吐趋势</h4>
                  <ReactEChartsCore echarts={echarts} option={{
                    animation: false,
                    grid: { top: 30, right: 50, bottom: 24, left: 40 },
                    tooltip: { trigger: 'axis' },
                    legend: { top: 0, textStyle: { fontSize: 11 } },
                    xAxis: { type: 'category', data: perf.byHour.map((h) => h.hour.slice(11, 16)), axisLabel: { fontSize: 10 } },
                    yAxis: [
                      { type: 'value', name: '次数', axisLabel: { fontSize: 10 }, minInterval: 1 },
                      { type: 'value', name: '秒', axisLabel: { fontSize: 10 } },
                    ],
                    series: [
                      { name: '成功', type: 'bar', stack: 'c', data: perf.byHour.map((h) => h.success), itemStyle: { color: '#91cc75' } },
                      { name: '失败', type: 'bar', stack: 'c', data: perf.byHour.map((h) => h.failed), itemStyle: { color: '#ee6666' } },
                      { name: '平均耗时', type: 'line', yAxisIndex: 1, data: perf.byHour.map((h) => h.avgDuration), smooth: true, showSymbol: false, lineStyle: { width: 2 }, itemStyle: { color: '#5470c6' } },
                    ],
                  }} style={{ height: 250 }} notMerge />
                </div>
              )}

              {perf.recent.length > 0 && (
                <div className={styles.perfSection}>
                  <h4 className={styles.perfSectionTitle}>最近任务</h4>
                  <table className={styles.perfTable}>
                    <thead><tr><th>ID</th><th>算法</th><th>状态</th><th>耗时</th><th>来源</th><th>完成时间</th></tr></thead>
                    <tbody>
                      {perf.recent.map((t) => (
                        <tr key={t.id}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>{t.id}</td>
                          <td>{t.algorithm}</td>
                          <td>{t.status}</td>
                          <td>{t.duration != null ? `${t.duration}s` : '—'}</td>
                          <td>{t.source}</td>
                          <td>{t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : '—'}</td>
                        </tr>
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
