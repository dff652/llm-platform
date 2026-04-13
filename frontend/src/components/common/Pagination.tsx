/**
 * 分页组件 — 页码导航 + 总数显示
 */
import { useMemo } from 'react';
import styles from './Pagination.module.css';

interface PaginationProps {
  /** 当前页码（从 1 开始） */
  current: number;
  /** 总条目数 */
  total: number;
  /** 每页条目数 */
  pageSize: number;
  /** 页码变更回调 */
  onChange: (page: number) => void;
  /** 是否显示总数 */
  showTotal?: boolean;
}

/** 生成页码数组，含省略号占位 */
function getPageNumbers(current: number, totalPages: number): (number | '...')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | '...')[] = [1];

  if (current > 3) {
    pages.push('...');
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(totalPages - 1, current + 1);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < totalPages - 2) {
    pages.push('...');
  }

  if (totalPages > 1) {
    pages.push(totalPages);
  }

  return pages;
}

export function Pagination({
  current,
  total,
  pageSize,
  onChange,
  showTotal = true,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pages = useMemo(() => getPageNumbers(current, totalPages), [current, totalPages]);

  if (total === 0) return null;

  return (
    <div className={styles.pagination}>
      {showTotal && (
        <span className={styles.total}>共 {total} 条</span>
      )}
      <div className={styles.pages}>
        {/* 上一页 */}
        <button
          className={styles.pageBtn}
          disabled={current <= 1}
          onClick={() => onChange(current - 1)}
        >
          &lt;
        </button>

        {/* 页码 */}
        {pages.map((page, idx) =>
          page === '...' ? (
            <span key={`ellipsis-${idx}`} className={styles.ellipsis}>…</span>
          ) : (
            <button
              key={page}
              className={`${styles.pageBtn} ${page === current ? styles.active : ''}`}
              onClick={() => onChange(page)}
            >
              {page}
            </button>
          ),
        )}

        {/* 下一页 */}
        <button
          className={styles.pageBtn}
          disabled={current >= totalPages}
          onClick={() => onChange(current + 1)}
        >
          &gt;
        </button>
      </div>
    </div>
  );
}
