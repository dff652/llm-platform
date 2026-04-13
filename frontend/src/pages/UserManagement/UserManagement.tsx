import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useUiStore } from '../../stores/uiStore';
import { usePolling } from '../../hooks/usePolling';
import { DataTable, type TableColumn } from '../../components/common/DataTable';
import { Modal } from '../../components/common/Modal';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { Badge } from '../../components/common/Badge';
import { Pagination } from '../../components/common/Pagination';
import type { User, PaginatedResponse } from '../../types';
import styles from './UserManagement.module.css';

const PAGE_SIZE = 20;

function formatTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

export default function UserManagement() {
  const currentUser = useAuthStore((s) => s.user);
  const showToast = useUiStore((s) => s.showToast);
  const initialized = useRef(false);

  // ── List state ──
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  // ── Modal states ──
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [resetUser, setResetUser] = useState<User | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Create form ──
  const [createForm, setCreateForm] = useState({
    username: '', password: '', displayName: '', role: 'user',
  });

  // ── Edit form ──
  const [editForm, setEditForm] = useState({
    displayName: '', role: '', status: '',
  });

  // ── Reset password form ──
  const [newPassword, setNewPassword] = useState('');

  // ── Confirm dialog ──
  const [confirm, setConfirm] = useState({
    open: false, title: '', message: '', danger: false,
    onConfirm: () => {},
  });

  // ── Data fetching ──
  const fetchUsers = useCallback(async (_silent: boolean) => {
    try {
      const params: Record<string, string | number> = { page, pageSize: PAGE_SIZE };
      if (keyword.trim()) params.keyword = keyword.trim();
      if (roleFilter) params.role = roleFilter;
      const data = await api.get<PaginatedResponse<User>>('/users', params);
      setUsers(data.items);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError('加载用户列表失败');
    } finally {
      initialized.current = true;
    }
  }, [page, keyword, roleFilter]);

  usePolling(fetchUsers, 30000);

  // ── Create user ──
  const handleCreate = async () => {
    if (!createForm.username.trim() || !createForm.password.trim()) return;
    try {
      setSaving(true);
      await api.post('/users', {
        username: createForm.username.trim(),
        password: createForm.password,
        displayName: createForm.displayName.trim() || null,
        role: createForm.role,
      });
      setCreateOpen(false);
      setCreateForm({ username: '', password: '', displayName: '', role: 'user' });
      showToast({ message: '用户创建成功', type: 'success' });
      fetchUsers(true);
    } catch (err) {
      showToast({
        message: err instanceof ApiError ? err.detail : '创建失败',
        type: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  // ── Edit user ──
  const openEdit = (user: User) => {
    setEditUser(user);
    setEditForm({
      displayName: user.displayName || '',
      role: user.role,
      status: user.status,
    });
  };

  const handleEdit = async () => {
    if (!editUser) return;
    try {
      setSaving(true);
      await api.put(`/users/${editUser.id}`, {
        displayName: editForm.displayName.trim() || null,
        role: editForm.role,
        status: editForm.status,
      });
      setEditUser(null);
      showToast({ message: '用户信息已更新', type: 'success' });
      fetchUsers(true);
    } catch (err) {
      showToast({
        message: err instanceof ApiError ? err.detail : '更新失败',
        type: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  // ── Reset password ──
  const handleResetPassword = async () => {
    if (!resetUser || newPassword.length < 6) return;
    try {
      setSaving(true);
      await api.post(`/users/${resetUser.id}/reset-password`, {
        newPassword,
      });
      setResetUser(null);
      setNewPassword('');
      showToast({ message: '密码已重置', type: 'success' });
    } catch (err) {
      showToast({
        message: err instanceof ApiError ? err.detail : '重置失败',
        type: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  // ── Delete user ──
  const handleDelete = (user: User) => {
    if (user.id === currentUser?.id) {
      showToast({ message: '不能删除自己的账号', type: 'error' });
      return;
    }
    setConfirm({
      open: true,
      title: '删除用户',
      message: `确认删除用户「${user.username}」？此操作不可撤销。`,
      danger: true,
      onConfirm: async () => {
        setConfirm(prev => ({ ...prev, open: false }));
        try {
          await api.delete(`/users/${user.id}`);
          showToast({ message: '用户已删除', type: 'success' });
          fetchUsers(true);
        } catch (err) {
          showToast({
            message: err instanceof ApiError ? err.detail : '删除失败',
            type: 'error',
          });
        }
      },
    });
  };

  // ── Table columns ──
  const columns: TableColumn<User>[] = [
    {
      key: 'username',
      title: '用户名',
      width: '140px',
      render: (val) => <span className={styles.username}>{String(val)}</span>,
    },
    {
      key: 'displayName',
      title: '显示名',
      width: '140px',
      render: (val) => String(val || '—'),
    },
    {
      key: 'role',
      title: '角色',
      width: '90px',
      render: (val) => (
        <Badge variant={val === 'admin' ? 'primary' : 'default'} size="sm">
          {val === 'admin' ? '管理员' : '普通用户'}
        </Badge>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: '80px',
      render: (val) => (
        <Badge variant={val === 'active' ? 'success' : 'muted'} size="sm">
          {val === 'active' ? '正常' : '已禁用'}
        </Badge>
      ),
    },
    {
      key: 'lastLoginAt',
      title: '最后登录',
      width: '160px',
      render: (val) => <span className={styles.time}>{formatTime(val as string | null)}</span>,
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: '160px',
      render: (val) => <span className={styles.time}>{formatTime(val as string)}</span>,
    },
    {
      key: 'id',
      title: '操作',
      width: '240px',
      render: (_val, row) => (
        <div className={styles.actions}>
          <button className={styles.btnAction} onClick={() => openEdit(row)}>编辑</button>
          <button className={styles.btnAction} onClick={() => { setResetUser(row); setNewPassword(''); }}>
            重置密码
          </button>
          <button className={styles.btnDanger} onClick={() => handleDelete(row)}>删除</button>
        </div>
      ),
    },
  ];

  // ── Search handler (reset to page 1) ──
  const handleSearch = (value: string) => {
    setKeyword(value);
    setPage(1);
  };

  const handleRoleChange = (value: string) => {
    setRoleFilter(value);
    setPage(1);
  };

  if (error && !initialized.current) {
    return <div className={styles.error}>{error}</div>;
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>用户管理</h2>
      </div>

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="搜索用户名或显示名..."
          value={keyword}
          onChange={(e) => handleSearch(e.target.value)}
        />
        <select
          className={styles.roleFilter}
          value={roleFilter}
          onChange={(e) => handleRoleChange(e.target.value)}
        >
          <option value="">全部角色</option>
          <option value="admin">管理员</option>
          <option value="user">普通用户</option>
        </select>
        <div className={styles.spacer} />
        <button className={styles.btnPrimary} onClick={() => setCreateOpen(true)}>
          + 创建用户
        </button>
      </div>

      {/* Table */}
      <DataTable<User>
        columns={columns}
        data={users}
        rowKey="id"
        emptyText="暂无用户"
      />

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className={styles.pagination}>
          <Pagination
            current={page}
            total={total}
            pageSize={PAGE_SIZE}
            onChange={setPage}
            showTotal
          />
        </div>
      )}

      {/* ── Create User Modal ── */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="创建用户" size="sm">
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>用户名</label>
          <input
            className={styles.formInput}
            type="text"
            placeholder="2~50 个字符"
            value={createForm.username}
            onChange={(e) => setCreateForm(prev => ({ ...prev, username: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>密码</label>
          <input
            className={styles.formInput}
            type="password"
            placeholder="至少 6 个字符"
            value={createForm.password}
            onChange={(e) => setCreateForm(prev => ({ ...prev, password: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>显示名</label>
          <input
            className={styles.formInput}
            type="text"
            placeholder="可选"
            value={createForm.displayName}
            onChange={(e) => setCreateForm(prev => ({ ...prev, displayName: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>角色</label>
          <select
            className={styles.formSelect}
            value={createForm.role}
            onChange={(e) => setCreateForm(prev => ({ ...prev, role: e.target.value }))}
          >
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </div>
        <div className={styles.modalFooter}>
          <button className={styles.btnCancel} onClick={() => setCreateOpen(false)}>取消</button>
          <button
            className={styles.btnPrimary}
            disabled={saving || !createForm.username.trim() || createForm.password.length < 6}
            onClick={handleCreate}
          >
            {saving ? '创建中...' : '创建'}
          </button>
        </div>
      </Modal>

      {/* ── Edit User Modal ── */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={`编辑用户 — ${editUser?.username || ''}`}
        size="sm"
      >
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>显示名</label>
          <input
            className={styles.formInput}
            type="text"
            value={editForm.displayName}
            onChange={(e) => setEditForm(prev => ({ ...prev, displayName: e.target.value }))}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>角色</label>
          <select
            className={styles.formSelect}
            value={editForm.role}
            onChange={(e) => setEditForm(prev => ({ ...prev, role: e.target.value }))}
          >
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>状态</label>
          <select
            className={styles.formSelect}
            value={editForm.status}
            onChange={(e) => setEditForm(prev => ({ ...prev, status: e.target.value }))}
          >
            <option value="active">正常</option>
            <option value="disabled">禁用</option>
          </select>
          <div className={styles.formHint}>禁用后该用户将无法登录</div>
        </div>
        <div className={styles.modalFooter}>
          <button className={styles.btnCancel} onClick={() => setEditUser(null)}>取消</button>
          <button className={styles.btnPrimary} disabled={saving} onClick={handleEdit}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </Modal>

      {/* ── Reset Password Modal ── */}
      <Modal
        open={!!resetUser}
        onClose={() => setResetUser(null)}
        title={`重置密码 — ${resetUser?.username || ''}`}
        size="sm"
      >
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>新密码</label>
          <input
            className={styles.formInput}
            type="password"
            placeholder="至少 6 个字符"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div className={styles.modalFooter}>
          <button className={styles.btnCancel} onClick={() => setResetUser(null)}>取消</button>
          <button
            className={styles.btnPrimary}
            disabled={saving || newPassword.length < 6}
            onClick={handleResetPassword}
          >
            {saving ? '重置中...' : '确认重置'}
          </button>
        </div>
      </Modal>

      {/* ── Confirm Dialog ── */}
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
