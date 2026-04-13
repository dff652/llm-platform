import { type ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'muted';
export type BadgeSize = 'sm' | 'md' | 'lg';

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

export function Badge({
  children,
  variant = 'default',
  size = 'md',
  dot = false,
  pulse = false,
  className = '',
}: BadgeProps) {
  const classes = [
    styles.badge,
    styles[variant],
    styles[size],
    dot ? styles.dot : '',
    pulse ? styles.pulse : '',
    className,
  ].filter(Boolean).join(' ');

  return <span className={classes}>{!dot && children}</span>;
}

export default Badge;
