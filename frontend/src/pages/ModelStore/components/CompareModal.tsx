/**
 * Model comparison modal — side-by-side table for 2-3 models.
 * Fetches detailed info (architectures, backend support, files) on open.
 */
import { useState, useEffect } from 'react';
import { getRemoteModelDetail } from '../../../services/api';
import type { RemoteModel, RemoteModelDetail, ModelDownload } from '../../../types';
import styles from './CompareModal.module.css';

function formatSize(bytes: number): string {
  if (bytes <= 0) return '-';
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function guessParamB(name: string): string {
  const m = name.match(/(\d+(?:\.\d+)?)\s*[Bb]/);
  return m?.[1] ? `${m[1]}B` : '-';
}

function estimateVram(sizeBytes: number): string {
  if (sizeBytes <= 0) return '-';
  return `~${Math.ceil(sizeBytes / 1024 ** 3 + 2)} GB`;
}

function getBackendVersion(bs: Record<string, unknown> | undefined, key: string): string {
  if (!bs) return '-';
  const val = bs[key];
  if (!val) return '-';
  if (typeof val === 'object' && val !== null) {
    const versions = Object.values(val as Record<string, string>).filter(Boolean);
    return versions.length > 0 ? versions.join('/') : '-';
  }
  return String(val);
}

interface Props {
  models: RemoteModel[];
  downloads: ModelDownload[];
  onClose: () => void;
  onDownload: (model: RemoteModel) => void;
}

export default function CompareModal({ models, downloads, onClose, onDownload }: Props) {
  const [details, setDetails] = useState<(RemoteModelDetail | null)[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all(
      models.map((m) =>
        getRemoteModelDetail('modelscope', m.modelId).catch(() => null),
      ),
    ).then((results) => {
      setDetails(results);
      setLoading(false);
    });
  }, [models]);

  const getDownloadStatus = (modelId: string): string => {
    const dl = downloads.find((d) => d.modelId === modelId);
    if (!dl) return '未下载';
    if (dl.registeredModelId) return '已部署';
    if (dl.status === 'completed') return '已下载';
    if (dl.status === 'downloading') return `下载中 ${Math.round(dl.progress * 100)}%`;
    if (dl.status === 'failed') return '下载失败';
    return dl.status;
  };

  const isDownloaded = (modelId: string): boolean => {
    const dl = downloads.find((d) => d.modelId === modelId);
    return !!dl && ['completed', 'downloading', 'pending'].includes(dl.status);
  };

  // Helper to find best value in a row
  const bestIdx = (vals: number[], mode: 'min' | 'max'): number => {
    if (vals.length === 0) return -1;
    let best = mode === 'min' ? Infinity : -Infinity;
    let idx = 0;
    vals.forEach((v, i) => {
      if (v <= 0) return;
      if (mode === 'min' ? v < best : v > best) { best = v; idx = i; }
    });
    return idx;
  };

  const rows: { label: string; values: string[]; highlights?: number[] }[] = [];

  // Basic rows from RemoteModel (always available)
  rows.push({ label: '参数量', values: models.map((m) => guessParamB(m.name)) });
  rows.push({
    label: '模型大小',
    values: models.map((m) => formatSize(m.storageSize)),
    highlights: [bestIdx(models.map((m) => m.storageSize), 'min')],
  });
  rows.push({
    label: 'VRAM 估算',
    values: models.map((m) => estimateVram(m.storageSize)),
    highlights: [bestIdx(models.map((m) => m.storageSize), 'min')],
  });
  rows.push({
    label: '下载量',
    values: models.map((m) => formatCount(m.downloads)),
    highlights: [bestIdx(models.map((m) => m.downloads), 'max')],
  });
  rows.push({
    label: '热度',
    values: models.map((m) => formatCount(m.stars)),
    highlights: [bestIdx(models.map((m) => m.stars), 'max')],
  });
  rows.push({ label: 'License', values: models.map((m) => m.license || '-') });
  rows.push({ label: '任务类型', values: models.map((m) => m.tasks.join(', ') || '-') });

  // Detail rows (from API, may be loading)
  if (!loading && details.length > 0) {
    rows.push({
      label: '架构',
      values: details.map((d) => d?.architectures?.join(', ') || '-'),
    });
    rows.push({
      label: 'vLLM',
      values: details.map((d) => getBackendVersion(d?.backendSupport, 'vllm')),
    });
    rows.push({
      label: 'sglang',
      values: details.map((d) => getBackendVersion(d?.backendSupport, 'sglang')),
    });
    rows.push({
      label: 'lmdeploy',
      values: details.map((d) => {
        const v1 = getBackendVersion(d?.backendSupport, 'lmdeploy');
        const v2 = getBackendVersion(d?.backendSupport, 'lmdeploy_turbomind');
        return [v1, v2].filter((v) => v !== '-').join(' / ') || '-';
      }),
    });
    rows.push({
      label: '文件数',
      values: details.map((d) => d?.files ? String(d.files.length) : '-'),
    });
  }

  rows.push({
    label: '下载状态',
    values: models.map((m) => getDownloadStatus(m.modelId)),
  });

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>模型对比</h3>
          <button className={styles.close} onClick={onClose}>&times;</button>
        </div>

        {loading && <div className={styles.loading}>加载详情中...</div>}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.labelCol}></th>
                {models.map((m) => (
                  <th key={m.modelId} className={styles.modelCol}>
                    <div className={styles.modelHeader}>
                      <span className={styles.modelName}>{m.name}</span>
                      <span className={styles.modelOwner}>{m.owner}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className={styles.labelCell}>{row.label}</td>
                  {row.values.map((val, i) => (
                    <td
                      key={i}
                      className={`${styles.valueCell} ${row.highlights?.includes(i) ? styles.highlight : ''}`}
                    >
                      {val}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className={styles.labelCell}></td>
                {models.map((m) => (
                  <td key={m.modelId} className={styles.valueCell}>
                    {!isDownloaded(m.modelId) && (
                      <button className={styles.btnDownload} onClick={() => onDownload(m)}>
                        下载
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
