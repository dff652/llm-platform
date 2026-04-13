import React, { useState, useMemo, useCallback } from 'react';
import styles from './DataTable.module.css';

type TableKey<T> = keyof T & string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TableColumn<T = Record<string, any>> {
  key: TableKey<T>;
  title: string | React.ReactNode;
  width?: string;
  sortable?: boolean;
  render?: (value: unknown, row: T, index: number) => React.ReactNode;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SortState<T = Record<string, any>> {
  key: TableKey<T>;
  direction: 'asc' | 'desc';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DataTableProps<T = Record<string, any>> {
  columns: TableColumn<T>[];
  data: T[];
  rowKey: TableKey<T>;
  selectable?: boolean;
  selectedKeys?: string[];
  onSelectionChange?: (keys: string[]) => void;
  onSortChange?: (sort: SortState<T> | null) => void;
  emptyText?: string;
  onRowClick?: (row: T) => void;
  activeRowKey?: string;
  /** Render extra content below a row (e.g. inline progress bar). Return null to skip. */
  renderAfterRow?: (row: T, index: number) => React.ReactNode;
}

function normalizeSortValue(val: unknown): string | number {
  if (val == null) return '';
  if (typeof val === 'number') return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof Date) return val.getTime();
  return String(val).toLowerCase();
}

function renderCellValue(val: unknown): React.ReactNode {
  if (val == null) return '—';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (val instanceof Date) return val.toLocaleString();
  return String(val);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function DataTable<T extends Record<string, any> = Record<string, unknown>>({
  columns,
  data,
  rowKey,
  selectable = false,
  selectedKeys = [],
  onSelectionChange,
  onSortChange,
  emptyText = '暂无数据',
  onRowClick,
  activeRowKey,
  renderAfterRow,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState<T> | null>(null);

  const sortedData = useMemo(() => {
    if (!sort) return data;
    const { key, direction } = sort;
    return [...data].sort((a, b) => {
      const va = normalizeSortValue(a[key]);
      const vb = normalizeSortValue(b[key]);
      if (va < vb) return direction === 'asc' ? -1 : 1;
      if (va > vb) return direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [data, sort]);

  const allSelected = data.length > 0 && selectedKeys.length === data.length;
  const someSelected = selectedKeys.length > 0 && !allSelected;

  const handleSort = useCallback(
    (col: TableColumn<T>) => {
      if (!col.sortable) return;
      let next: SortState<T> | null;
      if (sort?.key === col.key) {
        next = sort.direction === 'asc' ? { key: col.key, direction: 'desc' } : null;
      } else {
        next = { key: col.key, direction: 'asc' };
      }
      setSort(next);
      onSortChange?.(next);
    },
    [sort, onSortChange],
  );

  const handleSelectAll = () => {
    if (allSelected) {
      onSelectionChange?.([]);
    } else {
      onSelectionChange?.(data.map((r) => String(r[rowKey])));
    }
  };

  const handleSelectRow = (key: string) => {
    const next = selectedKeys.includes(key)
      ? selectedKeys.filter((k) => k !== key)
      : [...selectedKeys, key];
    onSelectionChange?.(next);
  };

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            {selectable && (
              <th className={styles.checkCol}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={handleSelectAll}
                />
              </th>
            )}
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={col.sortable ? styles.sortable : ''}
                onClick={() => handleSort(col)}
              >
                <span>{col.title}</span>
                {col.sortable && sort?.key === col.key && (
                  <span className={styles.sortIcon}>
                    {sort.direction === 'asc' ? ' \u2191' : ' \u2193'}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + (selectable ? 1 : 0)}
                className={styles.empty}
              >
                {emptyText}
              </td>
            </tr>
          ) : (
            sortedData.map((row, idx) => {
              const key = String(row[rowKey]);
              const isActive = activeRowKey === key;
              const isSelected = selectedKeys.includes(key);
              const afterContent = renderAfterRow?.(row, idx);
              return (
                <React.Fragment key={key}>
                  <tr
                    className={[
                      isActive ? styles.activeRow : '',
                      isSelected ? styles.selectedRow : '',
                      onRowClick ? styles.clickable : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onRowClick?.(row)}
                  >
                    {selectable && (
                      <td className={styles.checkCol}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleSelectRow(key)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td key={col.key}>
                        {col.render
                          ? col.render(row[col.key], row, idx)
                          : renderCellValue(row[col.key])}
                      </td>
                    ))}
                  </tr>
                  {afterContent && (
                    <tr className={styles.afterRow}>
                      <td colSpan={columns.length + (selectable ? 1 : 0)} style={{ padding: 0 }}>
                        {afterContent}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tbody>
      </table>
      {selectable && selectedKeys.length > 0 && (
        <div className={styles.footer}>
          已选 {selectedKeys.length} 条
        </div>
      )}
    </div>
  );
}

export default DataTable;
