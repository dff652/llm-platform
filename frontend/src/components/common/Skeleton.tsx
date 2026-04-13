/**
 * Skeleton — 骨架屏占位组件
 *
 * 用于页面首次加载时替代空白，提供视觉反馈。
 */

interface SkeletonProps {
  /** Number of rows to show */
  rows?: number;
  /** Show status cards (4 cards) */
  cards?: boolean;
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--color-bg-tertiary) 25%, var(--color-border-light, var(--color-border)) 50%, var(--color-bg-tertiary) 75%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 1.5s infinite',
  borderRadius: 'var(--radius-sm)',
};

function Bar({ width = '100%', height = 12 }: { width?: string | number; height?: number }) {
  return <div style={{ ...shimmer, width, height, marginBottom: 8 }} />;
}

export function Skeleton({ rows = 5, cards = false }: SkeletonProps) {
  return (
    <div>
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>

      {cards && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ padding: 'var(--space-4)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <Bar width={40} height={24} />
              <Bar width={60} height={10} />
            </div>
          ))}
        </div>
      )}

      <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        {/* Header row */}
        <div style={{ display: 'flex', gap: 'var(--space-4)', padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg)' }}>
          <Bar width={120} height={14} />
          <Bar width={80} height={14} />
          <Bar width={100} height={14} />
          <Bar width={60} height={14} />
          <Bar width={140} height={14} />
        </div>
        {/* Data rows */}
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} style={{ display: 'flex', gap: 'var(--space-4)', padding: 'var(--space-3) var(--space-4)', borderBottom: i < rows - 1 ? '1px solid var(--color-border-light, var(--color-border))' : undefined }}>
            <Bar width={`${100 + Math.random() * 80}px`} height={12} />
            <Bar width={`${60 + Math.random() * 40}px`} height={12} />
            <Bar width={`${80 + Math.random() * 60}px`} height={12} />
            <Bar width={`${40 + Math.random() * 30}px`} height={12} />
            <Bar width={`${100 + Math.random() * 60}px`} height={12} />
          </div>
        ))}
      </div>
    </div>
  );
}
