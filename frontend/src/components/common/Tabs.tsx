import type { ReactNode } from 'react';
import styles from './Tabs.module.css';

export interface TabItem {
  key: string;
  label: string;
  icon?: ReactNode;
}

interface TabsProps {
  items: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  /** 紧凑模式（右栏使用） */
  compact?: boolean;
  className?: string;
}

export function Tabs({ items, activeKey, onChange, compact, className = '' }: TabsProps) {
  return (
    <div className={`${styles.tabs} ${compact ? styles.compact : ''} ${className}`}>
      {items.map((item) => (
        <button
          key={item.key}
          className={`${styles.tab} ${activeKey === item.key ? styles.active : ''}`}
          onClick={() => onChange(item.key)}
          type="button"
        >
          {item.icon && <span className={styles.icon}>{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
