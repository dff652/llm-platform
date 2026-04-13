/**
 * Dropdown 下拉菜单组件 — 迁移自 ta 项目，改用 CSS Modules
 */
import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import styles from './Dropdown.module.css';

export type DropdownPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface DropdownItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  onClick?: () => void;
}

export interface DropdownProps {
  /** 触发元素 */
  trigger: ReactNode;
  /** 菜单项 */
  items: DropdownItem[];
  /** 弹出位置 */
  placement?: DropdownPlacement;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 菜单关闭回调 */
  onClose?: () => void;
}

export function Dropdown({
  trigger,
  items,
  placement = 'bottom-start',
  disabled = false,
  className = '',
  onClose,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [autoPlacement, setAutoPlacement] = useState(placement);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    setIsOpen((prev) => {
      if (!prev && containerRef.current) {
        // Auto-detect: if near bottom of viewport, flip to top
        const rect = containerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < 160 && rect.top > 160) {
          setAutoPlacement(placement.replace('bottom', 'top') as DropdownPlacement);
        } else {
          setAutoPlacement(placement);
        }
      }
      return !prev;
    });
  }, [disabled, placement]);

  const handleItemClick = useCallback(
    (item: DropdownItem) => {
      if (item.disabled) return;
      item.onClick?.();
      handleClose();
    },
    [handleClose],
  );

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, handleClose]);

  // ESC 键关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  // 位置类名映射
  const placementClass = styles[autoPlacement.replace('-', '_')] ?? '';

  return (
    <div ref={containerRef} className={`${styles.dropdown} ${className}`}>
      <div className={styles.trigger} onClick={handleToggle}>
        {trigger}
      </div>
      {isOpen && (
        <div className={`${styles.menu} ${placementClass}`}>
          {items.map((item) => {
            if (item.divider) {
              return <div key={item.key} className={styles.divider} />;
            }
            return (
              <button
                key={item.key}
                className={`${styles.item} ${item.danger ? styles.danger : ''} ${item.disabled ? styles.disabled : ''}`}
                onClick={() => handleItemClick(item)}
                disabled={item.disabled}
              >
                {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
                <span className={styles.itemLabel}>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Dropdown;
