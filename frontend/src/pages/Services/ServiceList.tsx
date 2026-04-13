import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../../services/api';
import { useUiStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { Badge } from '../../components/common/Badge';
import { Modal } from '../../components/common/Modal';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import type { LLMService, ServiceHealth } from '../../types';
import styles from './ServiceList.module.css';

export default function ServiceList() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const showToast = useUiStore((s) => s.showToast);
  const [services, setServices] = useState<LLMService[]>([]);
  const [loading, setLoading] = useState(true);
  const [healthMap, setHealthMap] = useState<Record<number, ServiceHealth>>({});
  const [showForm, setShowForm] = useState(false);
  const [editingService, setEditingService] = useState<LLMService | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LLMService | null>(null);

  const fetchServices = useCallback(async () => {
    try {
      const data = await api.get<LLMService[]>('/services');
      setServices(data);
    } catch {
      showToast({ type: 'error', message: 'Failed to load services' });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  const checkHealth = useCallback(async (id: number) => {
    try {
      const health = await api.get<ServiceHealth>(`/services/${id}/health`);
      setHealthMap((prev) => ({ ...prev, [id]: health }));
    } catch {
      setHealthMap((prev) => ({ ...prev, [id]: { healthy: false, error: 'Check failed' } as ServiceHealth }));
    }
  }, []);

  useEffect(() => {
    services.forEach((svc) => checkHealth(svc.id));
  }, [services, checkHealth]);

  const handleSave = async (data: Record<string, unknown>) => {
    try {
      if (editingService) {
        await api.put(`/services/${editingService.id}`, data);
        showToast({ type: 'success', message: 'Service updated' });
      } else {
        await api.post('/services', data);
        showToast({ type: 'success', message: 'Service created' });
      }
      setShowForm(false);
      setEditingService(null);
      fetchServices();
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : 'Save failed' });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/services/${deleteTarget.id}`);
      showToast({ type: 'success', message: 'Service deleted' });
      setDeleteTarget(null);
      fetchServices();
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : 'Delete failed' });
    }
  };

  if (loading) return <div className={styles.page}><p>Loading...</p></div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2>Model Services</h2>
        {isAdmin && (
          <button className={styles.btnPrimary} onClick={() => { setEditingService(null); setShowForm(true); }}>
            + Add Service
          </button>
        )}
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Endpoint</th>
            <th>Model</th>
            <th>Status</th>
            <th>Health</th>
            {isAdmin && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {services.map((svc) => {
            const health = healthMap[svc.id];
            return (
              <tr key={svc.id}>
                <td>
                  <strong>{svc.displayName}</strong>
                  <div className={styles.subText}>{svc.name}</div>
                </td>
                <td className={styles.mono}>{svc.endpoint}</td>
                <td>{svc.modelName || '-'}</td>
                <td><Badge variant={svc.status === 'enabled' ? 'success' : 'default'}>{svc.status}</Badge></td>
                <td>
                  {health ? (
                    <Badge variant={health.healthy ? 'success' : 'danger'}>
                      {health.healthy ? 'Healthy' : 'Unhealthy'}
                    </Badge>
                  ) : (
                    <span className={styles.subText}>Checking...</span>
                  )}
                </td>
                {isAdmin && (
                  <td>
                    <button className={styles.btnSmall} onClick={() => { setEditingService(svc); setShowForm(true); }}>Edit</button>
                    <button className={styles.btnSmall} onClick={() => checkHealth(svc.id)}>Check</button>
                    <button className={styles.btnSmallDanger} onClick={() => setDeleteTarget(svc)}>Delete</button>
                  </td>
                )}
              </tr>
            );
          })}
          {services.length === 0 && (
            <tr><td colSpan={isAdmin ? 6 : 5} className={styles.empty}>No services registered</td></tr>
          )}
        </tbody>
      </table>

      {showForm && (
        <ServiceFormModal
          service={editingService}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditingService(null); }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Service"
        message={`Are you sure you want to delete "${deleteTarget?.displayName}"?`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function ServiceFormModal({
  service,
  onSave,
  onClose,
}: {
  service: LLMService | null;
  onSave: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: service?.name || '',
    displayName: service?.displayName || '',
    endpoint: service?.endpoint || '',
    modelName: service?.modelName || '',
    modelPath: service?.modelPath || '',
    gpuDevice: service?.gpuDevice || '',
    description: service?.description || '',
    execCommand: service?.execCommand || '',
  });

  const handleChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Modal open onClose={onClose} title={service ? 'Edit Service' : 'Add Service'}>
      <div className={styles.form}>
        <label>
          Name (unique ID)
          <input value={form.name} onChange={(e) => handleChange('name', e.target.value)} disabled={!!service} />
        </label>
        <label>
          Display Name
          <input value={form.displayName} onChange={(e) => handleChange('displayName', e.target.value)} />
        </label>
        <label>
          Endpoint (vLLM URL)
          <input value={form.endpoint} onChange={(e) => handleChange('endpoint', e.target.value)} placeholder="http://localhost:8001" />
        </label>
        <label>
          Model Name (as reported by vLLM)
          <input value={form.modelName} onChange={(e) => handleChange('modelName', e.target.value)} placeholder="e.g. Qwen/Qwen2.5-7B-Instruct" />
        </label>
        <label>
          Model Path
          <input value={form.modelPath} onChange={(e) => handleChange('modelPath', e.target.value)} />
        </label>
        <label>
          GPU Device
          <input value={form.gpuDevice} onChange={(e) => handleChange('gpuDevice', e.target.value)} placeholder="e.g. cuda:0" />
        </label>
        <label>
          Exec Command (for process management)
          <textarea value={form.execCommand} onChange={(e) => handleChange('execCommand', e.target.value)} rows={2} />
        </label>
        <label>
          Description
          <textarea value={form.description} onChange={(e) => handleChange('description', e.target.value)} rows={2} />
        </label>
        <div className={styles.formActions}>
          <button className={styles.btnDefault} onClick={onClose}>Cancel</button>
          <button className={styles.btnPrimary} onClick={() => onSave(form)}>Save</button>
        </div>
      </div>
    </Modal>
  );
}
