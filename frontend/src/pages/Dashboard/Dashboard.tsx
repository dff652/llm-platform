import { useState, useEffect, useCallback } from 'react';
import { api } from '../../services/api';
import { useSmartPoll } from '../../hooks/useSmartPoll';
import type { DashboardOverview, GpuHardware } from '../../types';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [gpus, setGpus] = useState<GpuHardware[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [ov, gpuData] = await Promise.all([
        api.get<DashboardOverview>('/dashboard/overview'),
        api.get<{ gpus: GpuHardware[]; count: number }>('/dashboard/gpu-stats'),
      ]);
      setOverview(ov);
      setGpus(gpuData.gpus);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useSmartPoll(fetchData, { interval: 30000, enabled: true });

  if (loading) return <div className={styles.page}><p>Loading...</p></div>;

  return (
    <div className={styles.page}>
      <h2>Dashboard</h2>

      {overview && (
        <div className={styles.statsGrid}>
          <StatCard label="Active Services" value={overview.services} />
          <StatCard label="Today Requests" value={overview.todayRequests} />
          <StatCard label="Success" value={overview.todaySuccess} color="var(--color-success)" />
          <StatCard label="Errors" value={overview.todayErrors} color="var(--color-danger)" />
          <StatCard label="Today Tokens" value={overview.todayTokens.toLocaleString()} />
          <StatCard label="Avg Latency" value={`${overview.avgLatencyMs}ms`} />
          <StatCard label="Active API Keys" value={overview.activeKeys} />
        </div>
      )}

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

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue} style={color ? { color } : undefined}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}
