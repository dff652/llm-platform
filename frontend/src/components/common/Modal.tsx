import React, { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: 'sm' | 'md' | 'lg';
  footer?: React.ReactNode;
  children: React.ReactNode;
  closable?: boolean;
  maskClosable?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  size = 'md',
  footer,
  children,
  closable = true,
  maskClosable = true,
}: ModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closable) onClose();
    },
    [onClose, closable],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && maskClosable) onClose();
  };

  const sizeClass = size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : styles.md;

  return createPortal(
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={`${styles.container} ${sizeClass}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
          {closable && (
            <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export default Modal;
