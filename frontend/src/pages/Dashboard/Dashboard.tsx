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
import { useSmartPoll } from '../../hooks/useSmartPoll';
import type { DashboardOverview, GpuHardware, RequestTrend } from '../../types';
import styles from './Dashboard.module.css';

echarts.use([
  LineChart, PieChart, BarChart,
  TitleComponent, TooltipComponent, LegendComponent,
  GridComponent, DataZoomComponent, CanvasRenderer,
]);

interface ModelDist {
  model: string;
  count: number;
}

export default function Dashboard() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [gpus, setGpus] = useState<GpuHardware[]>([]);
  const [trend, setTrend] = useState<RequestTrend[]>([]);
  const [modelDist, setModelDist] = useState<ModelDist[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [ov, gpuData, trendData, distData] = await Promise.all([
        api.get<DashboardOverview>('/dashboard/overview'),
        api.get<{ gpus: GpuHardware[]; count: number }>('/dashboard/gpu-stats'),
        api.get<{ trend: RequestTrend[] }>('/dashboard/request-trend', { days: 7 }),
        api.get<ModelDist[]>('/dashboard/model-distribution'),
      ]);
      setOverview(ov);
      setGpus(gpuData.gpus);
      setTrend(trendData.trend);
      setModelDist(distData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useSmartPoll(fetchData, 'active', { getInterval: () => 30000, enabled: true });

  const trendOption = useMemo(() => buildTrendChart(trend), [trend]);
  const pieOption = useMemo(() => buildPieChart(modelDist), [modelDist]);

  if (loading) return <div className={styles.page}><p>Loading...</p></div>;

  return (
    <div className={styles.page}>
      <h2>Dashboard</h2>

      {/* Stats cards */}
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

      {/* Charts row */}
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
  const hours = data.map((d) => d.hour.replace('T', ' '));
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['Success', 'Error'], bottom: 0 },
    grid: { left: 50, right: 20, top: 10, bottom: 40 },
    xAxis: {
      type: 'category',
      data: hours,
      axisLabel: { fontSize: 10, rotate: 45, formatter: (v: string) => v.slice(5) },
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        name: 'Success',
        type: 'line',
        data: data.map((d) => d.success),
        smooth: true,
        areaStyle: { opacity: 0.15 },
        itemStyle: { color: '#52c41a' },
      },
      {
        name: 'Error',
        type: 'line',
        data: data.map((d) => d.error),
        smooth: true,
        areaStyle: { opacity: 0.15 },
        itemStyle: { color: '#ff4d4f' },
      },
    ],
  };
}

function buildPieChart(data: ModelDist[]): echarts.EChartsCoreOption {
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['50%', '50%'],
        data: data.map((d) => ({ name: d.model, value: d.count })),
        label: { fontSize: 12 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.2)' } },
      },
    ],
  };
}

/* ---------- StatCard ---------- */

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue} style={color ? { color } : undefined}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}
