import { useState, useRef, useEffect } from 'react';
import { api } from '../../../services/api';
import { Modal } from '../../../components/common/Modal';
import type { ModelDownload } from '../../../types';
import styles from './DownloadManager.module.css';

function formatSize(bytes: number): string {
  if (bytes <= 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '-';
  if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  if (bytesPerSec < 1024 ** 3) return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024 ** 3).toFixed(2)} GB/s`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Track previous downloadedSize to compute speed */
interface SpeedEntry {
  prevSize: number;
  prevTime: number;
  speed: number;
}

interface Props {
  downloads: ModelDownload[];
  onCancel: (id: number) => void;
  onDelete: (id: number) => void;
  onRetry: (id: number) => void;
  onPublish: (dl: ModelDownload) => void;
}

export default function DownloadManager({ downloads, onCancel, onDelete, onRetry, onPublish }: Props) {
  const [logModal, setLogModal] = useState<{ open: boolean; title: string; content: string; loading: boolean }>({
    open: false, title: '', content: '', loading: false,
  });

  const viewLog = async (dl: ModelDownload) => {
    setLogModal({ open: true, title: `日志 — ${dl.modelName}`, content: '', loading: true });
    try {
      const text = await api.getText(`/model-store/downloads/${dl.id}/logs`);
      setLogModal(prev => ({ ...prev, content: text || '暂无日志', loading: false }));
    } catch {
      setLogModal(prev => ({ ...prev, content: '获取日志失败', loading: false }));
    }
  };

  // Speed calculation: compare downloadedSize between renders
  const speedMap = useRef<Map<number, SpeedEntry>>(new Map());

  useEffect(() => {
    const now = Date.now();
    for (const dl of downloads) {
      if (dl.status !== 'downloading') {
        speedMap.current.delete(dl.id);
        continue;
      }
      const prev = speedMap.current.get(dl.id);
      if (prev) {
        const dt = (now - prev.prevTime) / 1000; // seconds
        if (dt > 1) {
          const ds = dl.downloadedSize - prev.prevSize;
          const newSpeed = ds / dt;
          // Smooth: 70% new, 30% old
          const smoothed = prev.speed > 0 ? newSpeed * 0.7 + prev.speed * 0.3 : newSpeed;
          speedMap.current.set(dl.id, { prevSize: dl.downloadedSize, prevTime: now, speed: Math.max(smoothed, 0) });
        }
      } else {
        speedMap.current.set(dl.id, { prevSize: dl.downloadedSize, prevTime: now, speed: 0 });
      }
    }
  }, [downloads]);

  if (downloads.length === 0) {
    return <div className={styles.emptyDownloads}>暂无下载任务</div>;
  }

  return (
    <div className={styles.list}>
      {downloads.map((dl) => {
        const pct = Math.round(dl.progress * 100);
        const speed = speedMap.current.get(dl.id)?.speed ?? 0;
        const remaining = dl.totalSize - dl.downloadedSize;
        const eta = speed > 0 ? remaining / speed : 0;

        const statusClass =
          dl.status === 'completed' ? styles.statusCompleted
            : dl.status === 'failed' ? styles.statusFailed
              : dl.status === 'downloading' ? styles.statusDownloading
                : styles.statusPending;
        const fillClass =
          dl.status === 'completed' ? styles.progressFillCompleted
            : dl.status === 'failed' ? styles.progressFillFailed
              : '';

        return (
          <div key={dl.id} className={styles.item}>
            <div className={styles.info}>
              <div className={styles.name}>{dl.modelName}</div>
              <div className={styles.meta}>
                <span>{formatSize(dl.downloadedSize)} / {formatSize(dl.totalSize)}</span>
                {dl.status === 'downloading' && speed > 0 && (
                  <>
                    <span className={styles.sep}>·</span>
                    <span className={styles.speed}>{formatSpeed(speed)}</span>
                    {eta > 0 && (
                      <>
                        <span className={styles.sep}>·</span>
                        <span>剩余 {formatEta(eta)}</span>
                      </>
                    )}
                  </>
                )}
                {dl.status === 'completed' && dl.downloadPath && (
                  <>
                    <span className={styles.sep}>·</span>
                    <span className={styles.path} title={dl.downloadPath}>{dl.downloadPath}</span>
                  </>
                )}
                {dl.errorMessage && (
                  <>
                    <span className={styles.sep}>·</span>
                    <span className={styles.errorMsg}>{dl.errorMessage}</span>
                  </>
                )}
              </div>
            </div>
            <div className={styles.progressGroup}>
              <div className={styles.progressBar}>
                <div
                  className={`${styles.progressFill} ${fillClass}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className={`${styles.pct} ${statusClass}`}>
                {dl.status === 'pending' ? '准备中'
                  : dl.status === 'downloading' ? `${pct}%`
                    : dl.status === 'completed' ? '完成'
                      : dl.status === 'failed' ? '失败'
                        : '已取消'}
              </span>
            </div>
            <div className={styles.actions}>
              {['pending', 'downloading'].includes(dl.status) && (
                <button className={styles.btnCancel} onClick={() => onCancel(dl.id)}>
                  取消
                </button>
              )}
              {['failed', 'cancelled'].includes(dl.status) && (
                <button className={styles.btnRetry} onClick={() => onRetry(dl.id)}>
                  重试
                </button>
              )}
              {dl.status === 'completed' && !dl.registeredModelId && (
                <button className={styles.btnPublish} onClick={() => onPublish(dl)}>
                  发布
                </button>
              )}
              {dl.status === 'completed' && dl.registeredModelId && (
                <span className={styles.statusCompleted}>已发布</span>
              )}
              {['completed', 'failed', 'cancelled'].includes(dl.status) && (
                <button className={styles.btnRetry} onClick={() => viewLog(dl)}>
                  日志
                </button>
              )}
              {['completed', 'failed', 'cancelled'].includes(dl.status) && (
                <button className={styles.btnCancel} onClick={() => onDelete(dl.id)}>
                  删除
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* 日志弹窗 */}
      <Modal
        open={logModal.open}
        onClose={() => setLogModal(prev => ({ ...prev, open: false }))}
        title={logModal.title}
        size="lg"
      >
        <pre style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-xs)',
          background: 'var(--color-bg)',
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-md)',
          maxHeight: 400,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {logModal.loading ? '加载中...' : logModal.content}
        </pre>
      </Modal>
    </div>
  );
}
