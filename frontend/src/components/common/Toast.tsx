import { useUiStore } from '../../stores/uiStore';
import styles from './Toast.module.css';

export function Toast() {
  const { toast, hideToast } = useUiStore();

  if (!toast) return null;

  const durationMs = toast.action ? 5000 : 3000;

  return (
    <div className={styles.container}>
      <div className={`${styles.toast} ${styles[toast.type]}`}>
        <span className={styles.icon}>
          {toast.type === 'success' ? '\u2713' : '\u2717'}
        </span>
        <span className={styles.message}>{toast.message}</span>
        {toast.action && (
          <button
            className={styles.action}
            onClick={() => {
              toast.action!.onClick();
              hideToast();
            }}
          >
            {toast.action.label}
          </button>
        )}
        <button className={styles.close} onClick={hideToast}>
          \u00d7
        </button>
        <div
          key={toast.message}
          className={styles.progress}
          style={{ animationDuration: `${durationMs}ms` }}
        />
      </div>
    </div>
  );
}
