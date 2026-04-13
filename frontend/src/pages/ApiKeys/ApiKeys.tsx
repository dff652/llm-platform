import { useState, useCallback, useRef } from 'react';
import { api, ApiError } from '../../services/api';
import { useUiStore } from '../../stores/uiStore';
import { usePolling } from '../../hooks/usePolling';
import { DataTable, type TableColumn } from '../../components/common/DataTable';
import { Badge } from '../../components/common/Badge';
import { Modal } from '../../components/common/Modal';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { Skeleton } from '../../components/common/Skeleton';
import type { ApiKey, ApiKeyCreated } from '../../types';
import styles from './ApiKeys.module.css';

type KeyRow = ApiKey & Record<string, unknown>;

export default function ApiKeys() {
  const showToast = useUiStore((s) => s.showToast);

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const initialized = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);

  // Confirm dialog
  const [confirm, setConfirm] = useState<{
    open: boolean; title: string; message: string; danger: boolean; onConfirm: () => void;
  }>({ open: false, title: '', message: '', danger: false, onConfirm: () => {} });

  const fetchKeys = useCallback(async (_silent: boolean) => {
    try {
      const data = await api.get<ApiKey[]>('/api-keys');
      setKeys(data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError('加载失败');
    } finally {
      initialized.current = true;
    }
  }, []);

  usePolling(fetchKeys, 30000);

  const handleCreate = async () => {
    if (!createName.trim()) return;
    try {
      setCreating(true);
      await api.post<ApiKeyCreated>('/api-keys', { name: createName.trim() });
      setCreateOpen(false);
      setCreateName('');
      showToast({ message: 'API Key 创建成功', type: 'success' });
      fetchKeys(true);
    } catch (err) {
      showToast({
        message: err instanceof ApiError ? err.detail : '创建失败',
        type: 'error',
      });
    } finally {
      setCreating(false);
    }
  };

  const copyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      showToast({ message: '已复制到剪贴板', type: 'success' });
    } catch {
      const el = document.createElement('textarea');
      el.value = key;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showToast({ message: '已复制到剪贴板', type: 'success' });
    }
  };

  const handleRevoke = (key: ApiKey) => {
    setConfirm({
      open: true,
      title: '吊销 API Key',
      message: `确认吊销「${key.name}」？吊销后使用此 Key 的外部系统将无法访问。`,
      danger: true,
      onConfirm: async () => {
        setConfirm(prev => ({ ...prev, open: false }));
        try {
          await api.patch(`/api-keys/${key.id}/revoke`);
          showToast({ message: 'Key 已吊销', type: 'success' });
          fetchKeys(true);
        } catch (err) {
          showToast({
            message: err instanceof ApiError ? err.detail : '吊销失败',
            type: 'error',
          });
        }
      },
    });
  };

  const handleDelete = (key: ApiKey) => {
    setConfirm({
      open: true,
      title: '删除 API Key',
      message: `确认永久删除「${key.name}」？此操作不可撤销。`,
      danger: true,
      onConfirm: async () => {
        setConfirm(prev => ({ ...prev, open: false }));
        try {
          await api.delete(`/api-keys/${key.id}`);
          showToast({ message: 'Key 已删除', type: 'success' });
          fetchKeys(true);
        } catch (err) {
          showToast({
            message: err instanceof ApiError ? err.detail : '删除失败',
            type: 'error',
          });
        }
      },
    });
  };

  const columns: TableColumn<KeyRow>[] = [
    { key: 'name', title: '名称', width: '160px' },
    {
      key: 'keyValue',
      title: 'Key',
      render: (val) => {
        const key = val as string | null;
        if (!key) return <span className={styles.prefix}>—</span>;
        return <span className={styles.prefix}>{key}</span>;
      },
    },
    {
      key: 'isActive',
      title: '状态',
      width: '80px',
      render: (val) => (
        <Badge variant={val ? 'success' : 'muted'} size="sm">
          {val ? '有效' : '已吊销'}
        </Badge>
      ),
    },
    {
      key: 'lastUsedAt',
      title: '最后使用',
      width: '140px',
      render: (val) => val ? new Date(val as string).toLocaleString('zh-CN') : '从未使用',
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: '140px',
      render: (val) => val ? new Date(val as string).toLocaleString('zh-CN') : '—',
    },
    {
      key: 'updatedAt',
      title: '操作',
      width: '130px',
      render: (_val, row) => (
        <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
          {row.isActive ? (
            <>
              {row.keyValue && (
                <button className={styles.btnCopy} title="复制 Key" onClick={() => copyKey(row.keyValue!)}>
                  复制
                </button>
              )}
              <button className={styles.btnDanger} onClick={() => handleRevoke(row)}>
                吊销
              </button>
            </>
          ) : (
            <button className={styles.btnDanger} onClick={() => handleDelete(row)}>
              删除
            </button>
          )}
        </div>
      ),
    },
  ];

  if (!initialized.current) return <Skeleton rows={4} />;
  if (error) return <div className={styles.error}>{error}</div>;

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>API 密钥</h2>
        <button className={styles.btnPrimary} onClick={() => setCreateOpen(true)}>
          + 创建 Key
        </button>
      </div>

      <DataTable<KeyRow>
        columns={columns}
        data={keys as KeyRow[]}
        rowKey="id"
        emptyText="暂无 API Key，点击「创建 Key」开始"
      />

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="创建 API Key"
        size="sm"
        footer={
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button className={styles.btnSecondary} onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              className={styles.btnPrimary}
              disabled={!createName.trim() || creating}
              onClick={handleCreate}
            >
              {creating ? '创建中...' : '创建'}
            </button>
          </div>
        }
      >
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Key 名称</label>
          <input
            className={styles.formInput}
            type="text"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="例如：MES 系统、质检平台"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && createName.trim()) handleCreate();
            }}
          />
        </div>
      </Modal>

      {/* Confirm dialog */}
      <ConfirmDialog
        isOpen={confirm.open}
        title={confirm.title}
        message={confirm.message}
        danger={confirm.danger}
        onConfirm={confirm.onConfirm}
        onCancel={() => setConfirm(prev => ({ ...prev, open: false }))}
      />
    </div>
  );
}
