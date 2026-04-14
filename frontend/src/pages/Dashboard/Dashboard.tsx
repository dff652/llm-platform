import { useState, useEffect, useCallback, useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart, PieChart, BarChart } from 'echarts/charts';
import {
  TitleComponent, TooltipComponent, LegendComponent,
  GridComponent, DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useSmartPoll } from '../../hooks/useSmartPoll';
import { Badge } from '../../components/common/Badge';
import type { DashboardOverview, GpuHardware, RequestTrend, ChatLogItem } from '../../types';
import styles from './Dashboard.module.css';

echarts.use([
  LineChart, PieChart, BarChart,
  TitleComponent, TooltipComponent, LegendComponent,
  GridComponent, DataZoomComponent, CanvasRenderer,
]);

interface ModelDist { model: string; count: number }
interface TokenDaily { date: string; prompt: number; completion: number; total: number; requests: number }

export default function Dashboard() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [gpus, setGpus] = useState<GpuHardware[]>([]);
  const [trend, setTrend] = useState<RequestTrend[]>([]);
  const [modelDist, setModelDist] = useState<ModelDist[]>([]);
  const [tokenDaily, setTokenDaily] = useState<TokenDaily[]>([]);
  const [recentRequests, setRecentRequests] = useState<ChatLogItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const promises: Promise<unknown>[] = [
        api.get<DashboardOverview>('/dashboard/overview'),
        api.get<{ gpus: GpuHardware[]; count: number }>('/dashboard/gpu-stats'),
        api.get<{ trend: RequestTrend[] }>('/dashboard/request-trend', { days: 7 }),
        api.get<ModelDist[]>('/dashboard/model-distribution'),
        api.get<{ usage: TokenDaily[] }>('/dashboard/token-usage-daily', { days: 14 }),
      ];
      if (isAdmin) {
        promises.push(
          api.get<{ items: ChatLogItem[] }>('/dashboard/recent-requests', { pageSize: 10 }),
        );
      }
      const results = await Promise.all(promises);
      setOverview(results[0] as DashboardOverview);
      setGpus((results[1] as { gpus: GpuHardware[] }).gpus);
      setTrend((results[2] as { trend: RequestTrend[] }).trend);
      setModelDist(results[3] as ModelDist[]);
      setTokenDaily((results[4] as { usage: TokenDaily[] }).usage);
      if (isAdmin && results[5]) {
        setRecentRequests((results[5] as { items: ChatLogItem[] }).items);
      }
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useSmartPoll(fetchData, 'active', { getInterval: () => 30000, enabled: true });

  const trendOption = useMemo(() => buildTrendChart(trend), [trend]);
  const pieOption = useMemo(() => buildPieChart(modelDist), [modelDist]);
  const tokenOption = useMemo(() => buildTokenChart(tokenDaily), [tokenDaily]);

  if (loading) return <div className={styles.page}><p>Loading...</p></div>;

  return (
    <div className={styles.page}>
      <h2>Dashboard</h2>

      {/* Stat cards */}
      {overview && (
        <div className={styles.statsGrid}>
          <StatCard label="Active Services" value={overview.services} />
          <StatCard label="Today Requests" value={overview.todayRequests} />
          <StatCard label="Success" value={overview.todaySuccess} color="var(--color-success)" />
          <StatCard label="Errors" value={overview.todayErrors} color="var(--color-danger)" />
          <StatCard label="Today Tokens" value={(overview.todayTokens || 0).toLocaleString()} />
          <StatCard label="Avg Latency" value={`${overview.avgLatencyMs}ms`} />
          <StatCard label="Active API Keys" value={overview.activeKeys} />
        </div>
      )}

      {/* Charts row 1: trend + pie */}
      <div className={styles.chartRow}>
        <div className={styles.chartCard}>
          <h3>Request Trend (7 days)</h3>
          {trend.length > 0 ? (
            <ReactEChartsCore echarts={echarts} option={trendOption} style={{ height: 280 }} />
          ) : (
            <div className={styles.emptyChart}>No data yet</div>
          )}
        </div>
        <div className={styles.chartCardSmall}>
          <h3>Model Distribution</h3>
          {modelDist.length > 0 ? (
            <ReactEChartsCore echarts={echarts} option={pieOption} style={{ height: 280 }} />
          ) : (
            <div className={styles.emptyChart}>No data yet</div>
          )}
        </div>
      </div>

      {/* Chart row 2: token usage */}
      <div className={styles.section}>
        <div className={styles.chartCard}>
          <h3>Token Usage (14 days)</h3>
          {tokenDaily.length > 0 ? (
            <ReactEChartsCore echarts={echarts} option={tokenOption} style={{ height: 260 }} />
          ) : (
            <div className={styles.emptyChart}>No data yet</div>
          )}
        </div>
      </div>

      {/* Recent requests table */}
      {isAdmin && recentRequests.length > 0 && (
        <div className={styles.section}>
          <h3>Recent Requests</h3>
          <table className={styles.reqTable}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Model</th>
                <th>Status</th>
                <th>Tokens</th>
                <th>Latency</th>
                <th>API Key</th>
              </tr>
            </thead>
            <tbody>
              {recentRequests.map((r) => (
                <tr key={r.id}>
                  <td className={styles.mono}>{r.createdAt ? formatTime(r.createdAt) : '-'}</td>
                  <td>{r.model}</td>
                  <td><Badge variant={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge></td>
                  <td className={styles.mono}>{r.totalTokens ?? '-'}</td>
                  <td className={styles.mono}>{r.latencyMs != null ? `${Math.round(r.latencyMs)}ms` : '-'}</td>
                  <td>{r.apiKeyName || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* GPU cards */}
      {gpus.length > 0 && (
        <div className={styles.section}>
          <h3>GPU Status</h3>
          <div className={styles.gpuGrid}>
            {gpus.map((gpu) => (
              <div key={gpu.index} className={styles.gpuCard}>
                <div className={styles.gpuName}>GPU {gpu.index}: {gpu.name}</div>
                <div className={styles.gpuBar}>
                  <div className={styles.gpuBarLabel}>Memory</div>
                  <div className={styles.barTrack}>
                    <div className={styles.barFill} style={{ width: `${gpu.memoryPct}%` }} />
                  </div>
                  <span className={styles.gpuBarValue}>
                    {gpu.memoryUsedMb?.toFixed(0)} / {gpu.memoryTotalMb?.toFixed(0)} MB ({gpu.memoryPct}%)
                  </span>
                </div>
                <div className={styles.gpuBar}>
                  <div className={styles.gpuBarLabel}>Utilization</div>
                  <div className={styles.barTrack}>
                    <div className={styles.barFill} style={{ width: `${gpu.utilizationPct}%` }} />
                  </div>
                  <span className={styles.gpuBarValue}>{gpu.utilizationPct}%</span>
                </div>
                <div className={styles.gpuMeta}>
                  Temp: {gpu.temperatureC}°C
                  {gpu.powerDrawW != null && ` | Power: ${gpu.powerDrawW}W / ${gpu.powerLimitW}W`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Chart builders ---------- */

function buildTrendChart(data: RequestTrend[]): echarts.EChartsCoreOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['Success', 'Error'], bottom: 0 },
    grid: { left: 50, right: 20, top: 10, bottom: 40 },
    xAxis: {
      type: 'category',
      data: data.map((d) => d.hour.replace('T', ' ')),
      axisLabel: { fontSize: 10, rotate: 45, formatter: (v: string) => v.slice(5) },
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      { name: 'Success', type: 'line', data: data.map((d) => d.success), smooth: true, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#52c41a' } },
      { name: 'Error', type: 'line', data: data.map((d) => d.error), smooth: true, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#ff4d4f' } },
    ],
  };
}

function buildPieChart(data: ModelDist[]): echarts.EChartsCoreOption {
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie', radius: ['40%', '70%'], center: ['50%', '50%'],
      data: data.map((d) => ({ name: d.model, value: d.count })),
      label: { fontSize: 12 },
    }],
  };
}

function buildTokenChart(data: TokenDaily[]): echarts.EChartsCoreOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['Prompt', 'Completion'], bottom: 0 },
    grid: { left: 60, right: 20, top: 10, bottom: 40 },
    xAxis: {
      type: 'category',
      data: data.map((d) => d.date),
      axisLabel: { fontSize: 10, formatter: (v: string) => v.slice(5) },
    },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v) } },
    series: [
      { name: 'Prompt', type: 'bar', stack: 'tokens', data: data.map((d) => d.prompt), itemStyle: { color: '#1890ff' } },
      { name: 'Completion', type: 'bar', stack: 'tokens', data: data.map((d) => d.completion), itemStyle: { color: '#36cfc9' } },
    ],
  };
}

/* ---------- Helpers ---------- */

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue} style={color ? { color } : undefined}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}
