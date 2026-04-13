import type { RemoteModel, ModelDownload } from '../../../types';
import styles from './ModelCard.module.css';

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface Props {
  model: RemoteModel;
  download?: ModelDownload;
  vramEstimate?: string;
  compareSelected?: boolean;
  onCompareToggle?: (model: RemoteModel) => void;
  onDownload: (model: RemoteModel) => void;
  onClick: (model: RemoteModel) => void;
}

export default function ModelCard({ model, download, vramEstimate, compareSelected, onCompareToggle, onDownload, onClick }: Props) {
  const isDownloading = download && ['pending', 'downloading'].includes(download.status);
  const isCompleted = download?.status === 'completed';
  const isPublished = isCompleted && !!download?.registeredModelId;

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isDownloading && !isCompleted) {
      onDownload(model);
    }
  };

  const btnClass = isDownloading
    ? `${styles.btnDownload} ${styles.btnDownloading}`
    : isCompleted
      ? `${styles.btnDownload} ${styles.btnCompleted}`
      : styles.btnDownload;

  const btnText = isDownloading
    ? `${Math.round((download?.progress ?? 0) * 100)}%`
    : isPublished
      ? '已部署'
      : isCompleted
        ? '已下载'
        : '下载';

  return (
    <div className={styles.card} onClick={() => onClick(model)}>
      {/* Downloaded / deployed badge */}
      {isCompleted && (
        <span className={isPublished ? styles.badgeDeployed : styles.badgeDownloaded}>
          {isPublished ? '已部署' : '已下载'}
        </span>
      )}
      <div className={styles.cardHeader}>
        <span className={styles.modelName}>{model.name}</span>
        {onCompareToggle && (
          <label className={styles.compareCheck} onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={compareSelected ?? false}
              onChange={() => onCompareToggle(model)}
            />
            <span>对比</span>
          </label>
        )}
      </div>
      <div className={styles.modelOwner}>{model.owner}</div>
      {model.description && (
        <div className={styles.modelDesc}>{model.description}</div>
      )}
      <div className={styles.tags}>
        {model.tasks.slice(0, 2).map((t) => (
          <span key={t} className={styles.tag}>{t}</span>
        ))}
        {model.license && <span className={styles.tag}>{model.license}</span>}
      </div>
      <div className={styles.stats}>
        <span className={styles.stat}>
          <span>&#11015;</span> {formatCount(model.downloads)}
        </span>
        <span className={styles.stat}>
          <span>&#9733;</span> {formatCount(model.stars)}
        </span>
        {model.frameworks.length > 0 && (
          <span className={styles.stat}>{model.frameworks[0]}</span>
        )}
      </div>
      <div className={styles.cardFooter}>
        <span className={styles.size}>
          {formatSize(model.storageSize)}
          {vramEstimate && <span className={styles.vram}> · 显存(预估) {vramEstimate}</span>}
        </span>
        <button className={btnClass} onClick={handleDownload}>
          {btnText}
        </button>
      </div>
    </div>
  );
}
