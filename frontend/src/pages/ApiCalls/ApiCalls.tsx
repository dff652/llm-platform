import { useState, useEffect, useCallback } from 'react';
import { api } from '../../services/api';
import { useSmartPoll } from '../../hooks/useSmartPoll';
import { Badge } from '../../components/common/Badge';
import { Pagination } from '../../components/common/Pagination';
import type { ChatLogItem, PaginatedResponse } from '../../types';
import styles from './ApiCalls.module.css';

export default function ApiCalls() {
  const [items, setItems] = useState<ChatLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);

  // Filters
  const [filterModel, setFilterModel] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterApiKey, setFilterApiKey] = useState('');
  const [filterStartTime, setFilterStartTime] = useState('');
  const [filterEndTime, setFilterEndTime] = useState('');

  // Available model names for filter dropdown
  const [modelOptions, setModelOptions] = useState<string[]>([]);

  // Expanded row
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    api.get<{ model: string; count: number }[]>('/dashboard/model-distribution')
      .then((data) => setModelOptions(data.map((d) => d.model)))
      .catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, pageSize };
      if (filterModel) params.model = filterModel;
      if (filterStatus) params.status = filterStatus;
      if (filterApiKey) params.apiKeyName = filterApiKey;
      if (filterStartTime) params.startTime = filterStartTime;
      if (filterEndTime) params.endTime = filterEndTime;

      const res = await api.get<PaginatedResponse<ChatLogItem>>('/dashboard/recent-requests', params);
      setItems(res.items);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filterModel, filterStatus, filterApiKey, filterStartTime, filterEndTime]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useSmartPoll(fetchData, 'active', { getInterval: () => 15000, enabled: true });

  const handleReset = () => {
    setFilterModel('');
    setFilterStatus('');
    setFilterApiKey('');
    setFilterStartTime('');
    setFilterEndTime('');
    setPage(1);
  };

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2>API Calls</h2>
        <span className={styles.total}>{total} total</span>
      </div>

      {/* Filter bar */}
      <div className={styles.filterBar}>
        <select value={filterModel} onChange={(e) => { setFilterModel(e.target.value); setPage(1); }}>
          <option value="">All Models</option>
          {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}>
          <option value="">All Status</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </select>
        <input
          type="text"
          placeholder="API Key name"
          value={filterApiKey}
          onChange={(e) => { setFilterApiKey(e.target.value); setPage(1); }}
        />
        <input
          type="datetime-local"
          value={filterStartTime}
          onChange={(e) => { setFilterStartTime(e.target.value); setPage(1); }}
          title="Start time"
        />
        <input
          type="datetime-local"
          value={filterEndTime}
          onChange={(e) => { setFilterEndTime(e.target.value); setPage(1); }}
          title="End time"
        />
        <button className={styles.resetBtn} onClick={handleReset}>Reset</button>
      </div>

      {/* Table */}
      <table className={styles.table}>
        <thead>
          <tr>
            <th></th>
            <th>Time</th>
            <th>Model</th>
            <th>Type</th>
            <th>Status</th>
            <th>Tokens</th>
            <th>Latency</th>
            <th>TTFT</th>
            <th>API Key</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <>
              <tr key={item.id} className={expandedId === item.id ? styles.rowExpanded : ''} onClick={() => toggleExpand(item.id)}>
                <td className={styles.expandIcon}>{expandedId === item.id ? '▾' : '▸'}</td>
                <td className={styles.mono}>{formatTime(item.createdAt)}</td>
                <td>{item.model}</td>
                <td>
                  <span className={styles.typeBadge}>
                    {item.endpointType}{item.stream ? ' (stream)' : ''}
                  </span>
                </td>
                <td><Badge variant={item.status === 'success' ? 'success' : 'danger'}>{item.status}</Badge></td>
                <td className={styles.mono}>
                  {item.totalTokens != null ? (
                    <span title={`prompt: ${item.promptTokens ?? '?'} + completion: ${item.completionTokens ?? '?'}`}>
                      {item.totalTokens}
                    </span>
                  ) : '-'}
                </td>
                <td className={styles.mono}>{item.latencyMs != null ? `${Math.round(item.latencyMs)}ms` : '-'}</td>
                <td className={styles.mono}>{item.timeToFirstTokenMs != null ? `${Math.round(item.timeToFirstTokenMs)}ms` : '-'}</td>
                <td>{item.apiKeyName || '-'}</td>
              </tr>
              {expandedId === item.id && (
                <tr key={`${item.id}-detail`} className={styles.detailRow}>
                  <td colSpan={9}>
                    <div className={styles.detailGrid}>
                      <div><strong>Request ID</strong><code>{item.requestId}</code></div>
                      <div><strong>Prompt Tokens</strong><span>{item.promptTokens ?? '-'}</span></div>
                      <div><strong>Completion Tokens</strong><span>{item.completionTokens ?? '-'}</span></div>
                      <div><strong>Total Tokens</strong><span>{item.totalTokens ?? '-'}</span></div>
                      <div><strong>Latency</strong><span>{item.latencyMs != null ? `${item.latencyMs.toFixed(1)}ms` : '-'}</span></div>
                      <div><strong>Time to First Token</strong><span>{item.timeToFirstTokenMs != null ? `${item.timeToFirstTokenMs.toFixed(1)}ms` : '-'}</span></div>
                      {item.errorMessage && (
                        <div className={styles.detailFull}>
                          <strong>Error</strong>
                          <pre className={styles.errorPre}>{item.errorMessage}</pre>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
          {!loading && items.length === 0 && (
            <tr><td colSpan={9} className={styles.empty}>No API calls found</td></tr>
          )}
        </tbody>
      </table>

      {total > pageSize && (
        <div className={styles.pagination}>
          <Pagination
            current={page}
            pageSize={pageSize}
            total={total}
            onChange={setPage}
          />
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}
