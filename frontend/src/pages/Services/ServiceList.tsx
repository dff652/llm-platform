import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../../services/api';
import { useUiStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { Badge } from '../../components/common/Badge';
import { Modal } from '../../components/common/Modal';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import type { LLMService, ServiceHealth } from '../../types';
import styles from './ServiceList.module.css';

interface ProcessStatus {
  running: boolean;
  port?: number;
  pid?: number;
}

export default function ServiceList() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const showToast = useUiStore((s) => s.showToast);
  const [services, setServices] = useState<LLMService[]>([]);
  const [loading, setLoading] = useState(true);
  const [healthMap, setHealthMap] = useState<Record<number, ServiceHealth>>({});
  const [processMap, setProcessMap] = useState<Record<number, ProcessStatus>>({});
  const [actionLoading, setActionLoading] = useState<Record<number, string>>({});
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

  useEffect(() => { fetchServices(); }, [fetchServices]);

  const checkHealth = useCallback(async (id: number) => {
    try {
      const health = await api.get<ServiceHealth>(`/services/${id}/health`);
      setHealthMap((prev) => ({ ...prev, [id]: health }));
    } catch {
      setHealthMap((prev) => ({ ...prev, [id]: { healthy: false, error: 'Check failed' } as ServiceHealth }));
    }
  }, []);

  const checkProcess = useCallback(async (id: number) => {
    try {
      const status = await api.get<ProcessStatus>(`/services/${id}/process`);
      setProcessMap((prev) => ({ ...prev, [id]: status }));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    services.forEach((svc) => {
      checkHealth(svc.id);
      checkProcess(svc.id);
    });
  }, [services, checkHealth, checkProcess]);

  const handleStart = async (svc: LLMService) => {
    setActionLoading((prev) => ({ ...prev, [svc.id]: 'starting' }));
    try {
      const res = await api.post<{ success: boolean; message: string }>(`/services/${svc.id}/start`);
      showToast({ type: res.success ? 'success' : 'error', message: res.message });
      checkProcess(svc.id);
      checkHealth(svc.id);
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : 'Start failed' });
    } finally {
      setActionLoading((prev) => { const n = { ...prev }; delete n[svc.id]; return n; });
    }
  };

  const handleStop = async (svc: LLMService) => {
    setActionLoading((prev) => ({ ...prev, [svc.id]: 'stopping' }));
    try {
      const res = await api.post<{ success: boolean; message: string }>(`/services/${svc.id}/stop`);
      showToast({ type: 'success', message: res.message });
      checkProcess(svc.id);
      checkHealth(svc.id);
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : 'Stop failed' });
    } finally {
      setActionLoading((prev) => { const n = { ...prev }; delete n[svc.id]; return n; });
    }
  };

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
            <th>Process</th>
            <th>Health</th>
            {isAdmin && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {services.map((svc) => {
            const health = healthMap[svc.id];
            const proc = processMap[svc.id];
            const action = actionLoading[svc.id];
            return (
              <tr key={svc.id}>
                <td>
                  <strong>{svc.displayName}</strong>
                  <div className={styles.subText}>{svc.name}</div>
                </td>
                <td className={styles.mono}>{svc.endpoint}</td>
                <td>{svc.modelName || '-'}</td>
                <td>
                  {proc ? (
                    <Badge variant={proc.running ? 'success' : 'default'}>
                      {proc.running ? `Running (PID ${proc.pid})` : 'Stopped'}
                    </Badge>
                  ) : (
                    <span className={styles.subText}>...</span>
                  )}
                </td>
                <td>
                  {health ? (
                    <Badge variant={health.healthy ? 'success' : 'danger'}>
                      {health.healthy ? 'Healthy' : 'Unhealthy'}
                    </Badge>
                  ) : (
                    <span className={styles.subText}>...</span>
                  )}
                </td>
                {isAdmin && (
                  <td className={styles.actions}>
                    {svc.execCommand && (
                      proc?.running ? (
                        <button className={styles.btnSmallDanger} onClick={() => handleStop(svc)} disabled={!!action}>
                          {action === 'stopping' ? 'Stopping...' : 'Stop'}
                        </button>
                      ) : (
                        <button className={styles.btnSmallSuccess} onClick={() => handleStart(svc)} disabled={!!action}>
                          {action === 'starting' ? 'Starting...' : 'Start'}
                        </button>
                      )
                    )}
                    <button className={styles.btnSmall} onClick={() => { setEditingService(svc); setShowForm(true); }}>Edit</button>
                    <button className={styles.btnSmall} onClick={() => { checkHealth(svc.id); checkProcess(svc.id); }}>Refresh</button>
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
        isOpen={!!deleteTarget}
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

  // GPU parameter panel state
  const [useGpuPanel, setUseGpuPanel] = useState(!service?.execCommand);
  const [gpuParams, setGpuParams] = useState({
    port: service?.endpoint ? parsePort(service.endpoint) : '8001',
    tensorParallel: '1',
    maxModelLen: '4096',
    gpuMemUtil: '0.90',
    dtype: 'auto',
    quantization: '',
    extraArgs: '',
  });

  const handleChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleGpuParam = (field: string, value: string) => {
    setGpuParams((prev) => ({ ...prev, [field]: value }));
  };

  // Auto-generate exec_command + endpoint from GPU params
  const generateCommand = () => {
    if (!form.modelPath) return;
    const parts = [
      'python -m vllm.entrypoints.openai.api_server',
      `--model ${form.modelPath}`,
      `--port ${gpuParams.port}`,
      `--tensor-parallel-size ${gpuParams.tensorParallel}`,
      `--max-model-len ${gpuParams.maxModelLen}`,
      `--gpu-memory-utilization ${gpuParams.gpuMemUtil}`,
      `--dtype ${gpuParams.dtype}`,
      '--trust-remote-code',
    ];
    if (form.modelName) parts.push(`--served-model-name ${form.modelName}`);
    if (gpuParams.quantization) parts.push(`--quantization ${gpuParams.quantization}`);
    if (gpuParams.extraArgs.trim()) parts.push(gpuParams.extraArgs.trim());
    const cmd = parts.join(' \\\n  ');
    setForm((prev) => ({
      ...prev,
      execCommand: cmd,
      endpoint: `http://localhost:${gpuParams.port}`,
    }));
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
          Model Path
          <input value={form.modelPath} onChange={(e) => handleChange('modelPath', e.target.value)} placeholder="/path/to/model" />
        </label>
        <label>
          Model Name (served-model-name for routing)
          <input value={form.modelName} onChange={(e) => handleChange('modelName', e.target.value)} placeholder="e.g. qwen or Qwen/Qwen2.5-7B" />
        </label>

        {/* GPU Parameter Panel */}
        <div className={styles.gpuPanel}>
          <div className={styles.gpuPanelHeader}>
            <strong>GPU Parameters</strong>
            <label className={styles.toggleSmall}>
              <input type="checkbox" checked={useGpuPanel} onChange={(e) => setUseGpuPanel(e.target.checked)} />
              Auto-generate command
            </label>
          </div>
          {useGpuPanel ? (
            <div className={styles.gpuGrid}>
              <label>Port<input value={gpuParams.port} onChange={(e) => handleGpuParam('port', e.target.value)} /></label>
              <label>GPU Device<input value={form.gpuDevice} onChange={(e) => handleChange('gpuDevice', e.target.value)} placeholder="0 or 0,1" /></label>
              <label>Tensor Parallel
                <select value={gpuParams.tensorParallel} onChange={(e) => handleGpuParam('tensorParallel', e.target.value)}>
                  <option value="1">1</option><option value="2">2</option><option value="4">4</option>
                </select>
              </label>
              <label>Max Model Len<input value={gpuParams.maxModelLen} onChange={(e) => handleGpuParam('maxModelLen', e.target.value)} /></label>
              <label>GPU Memory Util
                <select value={gpuParams.gpuMemUtil} onChange={(e) => handleGpuParam('gpuMemUtil', e.target.value)}>
                  <option value="0.80">80%</option><option value="0.85">85%</option>
                  <option value="0.90">90%</option><option value="0.95">95%</option><option value="0.97">97%</option>
                </select>
              </label>
              <label>Dtype
                <select value={gpuParams.dtype} onChange={(e) => handleGpuParam('dtype', e.target.value)}>
                  <option value="auto">auto</option><option value="half">half (fp16)</option><option value="bfloat16">bfloat16</option>
                </select>
              </label>
              <label>Quantization
                <select value={gpuParams.quantization} onChange={(e) => handleGpuParam('quantization', e.target.value)}>
                  <option value="">None</option><option value="awq">AWQ</option><option value="gptq">GPTQ</option><option value="squeezellm">SqueezeLLM</option>
                </select>
              </label>
              <label>Extra Args<input value={gpuParams.extraArgs} onChange={(e) => handleGpuParam('extraArgs', e.target.value)} placeholder="--enforce-eager" /></label>
              <div style={{ gridColumn: '1 / -1' }}>
                <button className={styles.btnDefault} onClick={generateCommand} type="button">Generate Command</button>
              </div>
            </div>
          ) : null}
        </div>

        <label>
          Endpoint
          <input value={form.endpoint} onChange={(e) => handleChange('endpoint', e.target.value)} placeholder="http://localhost:8001" />
        </label>
        <label>
          Exec Command
          <textarea value={form.execCommand} onChange={(e) => handleChange('execCommand', e.target.value)} rows={3}
            placeholder="Auto-generated from GPU parameters, or enter manually" />
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

function parsePort(endpoint: string): string {
  try {
    return new URL(endpoint).port || '8001';
  } catch {
    return '8001';
  }
}
