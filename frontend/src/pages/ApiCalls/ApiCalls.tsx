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
        <h2>API 调用</h2>
        <span className={styles.total}>{total} 条记录</span>
      </div>

      {/* Filter bar */}
      <div className={styles.filterBar}>
        <select value={filterModel} onChange={(e) => { setFilterModel(e.target.value); setPage(1); }}>
          <option value="">全部模型</option>
          {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}>
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="error">失败</option>
        </select>
        <input
          type="text"
          placeholder="API Key 名称"
          value={filterApiKey}
          onChange={(e) => { setFilterApiKey(e.target.value); setPage(1); }}
        />
        <input
          type="datetime-local"
          value={filterStartTime}
          onChange={(e) => { setFilterStartTime(e.target.value); setPage(1); }}
          title="开始时间"
        />
        <input
          type="datetime-local"
          value={filterEndTime}
          onChange={(e) => { setFilterEndTime(e.target.value); setPage(1); }}
          title="结束时间"
        />
        <button className={styles.resetBtn} onClick={handleReset}>重置</button>
      </div>

      {/* Table */}
      <table className={styles.table}>
        <thead>
          <tr>
            <th></th>
            <th>时间</th>
            <th>模型</th>
            <th>类型</th>
            <th>状态</th>
            <th>Token</th>
            <th>延迟</th>
            <th>首Token</th>
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
                      <div><strong>请求 ID</strong><code>{item.requestId}</code></div>
                      <div><strong>Prompt Token</strong><span>{item.promptTokens ?? '-'}</span></div>
                      <div><strong>Completion Token</strong><span>{item.completionTokens ?? '-'}</span></div>
                      <div><strong>总 Token</strong><span>{item.totalTokens ?? '-'}</span></div>
                      <div><strong>延迟</strong><span>{item.latencyMs != null ? `${item.latencyMs.toFixed(1)}ms` : '-'}</span></div>
                      <div><strong>首 Token 时间</strong><span>{item.timeToFirstTokenMs != null ? `${item.timeToFirstTokenMs.toFixed(1)}ms` : '-'}</span></div>
                      {item.errorMessage && (
                        <div className={styles.detailFull}>
                          <strong>错误信息</strong>
                          <pre className={styles.errorPre}>{item.errorMessage}</pre>
                        </div>
                      )}
                      {item.requestBody && (
                        <div className={styles.detailFull}>
                          <strong>请求体</strong>
                          <pre className={styles.jsonPre}>{JSON.stringify(item.requestBody, null, 2)}</pre>
                        </div>
                      )}
                      {item.responseBody && (
                        <div className={styles.detailFull}>
                          <strong>响应体</strong>
                          <pre className={styles.jsonPre}>{JSON.stringify(item.responseBody, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
          {!loading && items.length === 0 && (
            <tr><td colSpan={9} className={styles.empty}>暂无 API 调用记录</td></tr>
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
