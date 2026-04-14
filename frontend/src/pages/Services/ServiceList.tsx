import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const showToast = useUiStore((s) => s.showToast);
  const [services, setServices] = useState<LLMService[]>([]);
  const [loading, setLoading] = useState(true);
  const [healthMap, setHealthMap] = useState<Record<number, ServiceHealth>>({});
  const [processMap, setProcessMap] = useState<Record<number, ProcessStatus>>({});
  const [actionLoading, setActionLoading] = useState<Record<number, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [preSelectModelId, setPreSelectModelId] = useState<number | null>(null);
  const [editingService, setEditingService] = useState<LLMService | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LLMService | null>(null);
  const [logTarget, setLogTarget] = useState<LLMService | null>(null);
  const [logContent, setLogContent] = useState('');

  useEffect(() => {
    if (searchParams.get('create') === '1' && isAdmin) {
      const mid = searchParams.get('modelId');
      if (mid) setPreSelectModelId(Number(mid));
      setShowForm(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, isAdmin, setSearchParams]);

  const fetchServices = useCallback(async () => {
    try {
      const data = await api.get<LLMService[]>('/services');
      setServices(data);
    } catch {
      showToast({ type: 'error', message: '加载服务失败' });
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
      setHealthMap((prev) => ({ ...prev, [id]: { healthy: false, error: '检查失败' } as ServiceHealth }));
    }
  }, []);

  const checkProcess = useCallback(async (id: number) => {
    try {
      const status = await api.get<ProcessStatus>(`/services/${id}/process`);
      setProcessMap((prev) => ({ ...prev, [id]: status }));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    services.forEach((svc) => { checkHealth(svc.id); checkProcess(svc.id); });
  }, [services, checkHealth, checkProcess]);

  const handleStart = async (svc: LLMService) => {
    setActionLoading((prev) => ({ ...prev, [svc.id]: 'starting' }));
    try {
      const res = await api.post<{ success: boolean; message: string }>(`/services/${svc.id}/start`);
      showToast({ type: res.success ? 'success' : 'error', message: res.message });
      checkProcess(svc.id); checkHealth(svc.id);
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : '启动失败' });
    } finally {
      setActionLoading((prev) => { const n = { ...prev }; delete n[svc.id]; return n; });
    }
  };

  const handleStop = async (svc: LLMService) => {
    setActionLoading((prev) => ({ ...prev, [svc.id]: 'stopping' }));
    try {
      const res = await api.post<{ success: boolean; message: string }>(`/services/${svc.id}/stop`);
      showToast({ type: 'success', message: res.message });
      checkProcess(svc.id); checkHealth(svc.id);
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : '停止失败' });
    } finally {
      setActionLoading((prev) => { const n = { ...prev }; delete n[svc.id]; return n; });
    }
  };

  const handleToggleStatus = async (svc: LLMService) => {
    const newStatus = svc.status === 'enabled' ? 'disabled' : 'enabled';
    try {
      await api.put(`/services/${svc.id}`, { status: newStatus });
      showToast({ type: 'success', message: newStatus === 'enabled' ? '已启用' : '已禁用' });
      fetchServices();
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : '操作失败' });
    }
  };

  const handleViewLog = async (svc: LLMService) => {
    setLogTarget(svc); setLogContent('加载中...');
    try {
      const res = await api.get<{ lines: string[] }>(`/services/${svc.id}/logs`, { lines: 200 });
      setLogContent(res.lines.join('\n') || '暂无日志');
    } catch { setLogContent('加载日志失败'); }
  };

  const handleSave = async (data: Record<string, unknown>) => {
    try {
      if (editingService) {
        await api.put(`/services/${editingService.id}`, data);
        showToast({ type: 'success', message: '服务已更新' });
      } else {
        await api.post('/services', data);
        showToast({ type: 'success', message: '服务已创建' });
      }
      setShowForm(false); setEditingService(null); fetchServices();
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : '保存失败' });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/services/${deleteTarget.id}`);
      showToast({ type: 'success', message: '服务已删除' });
      setDeleteTarget(null); fetchServices();
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : '删除失败' });
    }
  };

  if (loading) return <div className={styles.page}><p>加载中...</p></div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2>模型服务</h2>
        {isAdmin && (
          <button className={styles.btnPrimary} onClick={() => { setEditingService(null); setShowForm(true); }}>
            + 添加服务
          </button>
        )}
      </div>

      {services.length === 0 ? (
        <div className={styles.empty}>暂无已注册服务</div>
      ) : (
        <div className={styles.cardGrid}>
          {services.map((svc) => {
            const health = healthMap[svc.id];
            const proc = processMap[svc.id];
            const action = actionLoading[svc.id];
            const isDisabled = svc.status !== 'enabled';
            const isHealthy = health?.healthy === true;
            const isRunning = proc?.running === true;
            const dotState = isDisabled ? 'disabled' : isHealthy ? 'healthy' : isRunning ? 'starting' : 'offline';

            return (
              <div key={svc.id} className={`${styles.card} ${isDisabled ? styles.cardDisabled : ''}`}>
                {/* Header: dot + name + GPU badge */}
                <div className={styles.cardHeader}>
                  <div className={styles.cardHeaderLeft}>
                    <span className={styles.healthDot} data-state={dotState} />
                    <span className={styles.cardTitle}>{svc.displayName}</span>
                  </div>
                  <div className={styles.cardBadges}>
                    {svc.gpuDevice && (
                      <Badge variant="primary">GPU {svc.gpuDevice}</Badge>
                    )}
                  </div>
                </div>

                {/* Info */}
                {svc.endpoint && <div className={styles.cardMeta}>{svc.endpoint}</div>}
                {svc.modelName && <div className={styles.cardMeta}>模型: {svc.modelName}</div>}
                {health?.maxModelLen && (
                  <div className={styles.cardMeta}>上下文: {health.maxModelLen.toLocaleString()} tokens</div>
                )}
                {proc?.running && proc.pid && (
                  <div className={styles.cardMeta}>PID: {proc.pid}</div>
                )}

                {/* Status hint */}
                {!isDisabled && action === 'starting' && (
                  <div className={styles.cardHint} style={{ color: 'var(--color-primary)' }}>模型加载中...</div>
                )}
                {!isDisabled && !isHealthy && !action && svc.execCommand && !isRunning && (
                  <div className={styles.cardHint} style={{ color: '#fa8c16' }}>未加载 — 点击「启动」加载模型</div>
                )}
                {!isDisabled && health?.error && isRunning && (
                  <div className={styles.cardError}>{health.error}</div>
                )}

                {/* Actions */}
                {isAdmin && (
                  <div className={styles.cardActions}>
                    <div className={styles.cardActionsLeft}>
                      {!isDisabled && (
                        svc.execCommand ? (
                          isRunning ? (
                            <button className={styles.btnDanger} onClick={() => handleStop(svc)} disabled={!!action}>
                              {action === 'stopping' ? '停止中...' : '卸载模型'}
                            </button>
                          ) : (
                            <button className={styles.btnSuccess} onClick={() => handleStart(svc)} disabled={!!action}>
                              {action === 'starting' ? '启动中...' : '启动'}
                            </button>
                          )
                        ) : (
                          <button className={styles.btnWarn} onClick={() => { setEditingService(svc); setShowForm(true); }}>
                            配置命令
                          </button>
                        )
                      )}
                    </div>
                    <div className={styles.cardActionsRight}>
                      <label className={styles.switch} title={isDisabled ? '点击启用' : '点击禁用'}>
                        <input type="checkbox" checked={!isDisabled} onChange={() => handleToggleStatus(svc)} />
                        <span className={styles.slider} />
                      </label>
                      <button className={styles.btnSmall} onClick={() => handleViewLog(svc)}>日志</button>
                      <button className={styles.btnSmall} onClick={() => { setEditingService(svc); setShowForm(true); }}>编辑</button>
                      <button className={styles.btnSmall} onClick={() => { checkHealth(svc.id); checkProcess(svc.id); }}>刷新</button>
                      <button className={styles.btnSmallDanger} onClick={() => setDeleteTarget(svc)}>删除</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <ServiceFormModal
          service={editingService}
          preSelectModelId={preSelectModelId}
          onSave={(data) => { handleSave(data); setPreSelectModelId(null); }}
          onClose={() => { setShowForm(false); setEditingService(null); setPreSelectModelId(null); }}
        />
      )}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="删除服务"
        message={`确定删除服务 "${deleteTarget?.displayName}"？`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {logTarget && (
        <Modal open onClose={() => setLogTarget(null)} title={`日志 — ${logTarget.displayName}`}>
          <pre className={styles.logPre}>{logContent}</pre>
        </Modal>
      )}
    </div>
  );
}

// ============ ServiceFormModal (unchanged logic, imported from below) ============

interface RegisteredModel {
  id: number;
  name: string;
  family: string;
  artifactUri: string | null;
}

function parsePort(endpoint: string): string {
  try { return new URL(endpoint).port || '8001'; } catch { return '8001'; }
}

function parseCmdFlag(cmd: string, flag: string, fallback: string): string {
  const m = cmd.match(new RegExp(`${flag}\\s+(\\S+)`));
  return m ? m[1]! : fallback;
}

function buildCmd(opts: {
  modelPath: string; port: string; modelName: string; gpuMemUtil: string;
  maxModelLen: string; tensorParallel: string; dtype: string; quantization: string; extraArgs: string;
}): string {
  const parts = [
    'python -m vllm.entrypoints.openai.api_server',
    `--model ${opts.modelPath}`,
    `--port ${opts.port}`,
    `--tensor-parallel-size ${opts.tensorParallel}`,
    `--max-model-len ${opts.maxModelLen}`,
    `--gpu-memory-utilization ${opts.gpuMemUtil}`,
    `--dtype ${opts.dtype}`,
    '--trust-remote-code',
  ];
  if (opts.modelName) parts.push(`--served-model-name ${opts.modelName}`);
  if (opts.quantization) parts.push(`--quantization ${opts.quantization}`);
  if (parseInt(opts.tensorParallel) > 1) {
    parts.push('--disable-custom-all-reduce', '--enforce-eager');
  }
  if (opts.extraArgs.trim()) parts.push(opts.extraArgs.trim());
  return parts.join(' \\\n  ');
}

function ServiceFormModal({
  service, preSelectModelId, onSave, onClose,
}: {
  service: LLMService | null;
  preSelectModelId?: number | null;
  onSave: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const isEdit = !!service;
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null);

  useEffect(() => {
    api.get<{ items: RegisteredModel[] }>('/models', { pageSize: 100 })
      .then((res) => {
        setModels(res.items || []);
        if (preSelectModelId && !isEdit) {
          setTimeout(() => handleModelSelect(preSelectModelId), 0);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [name, setName] = useState(service?.name || '');
  const [displayName, setDisplayName] = useState(service?.displayName || '');
  const [modelPath, setModelPath] = useState(service?.modelPath || '');
  const [modelName, setModelName] = useState(service?.modelName || '');
  const [description, setDescription] = useState(service?.description || '');
  const [endpoint, setEndpoint] = useState(service?.endpoint || '');
  const [execCommand, setExecCommand] = useState(service?.execCommand || '');
  const [gpuDevice, setGpuDevice] = useState(service?.gpuDevice || service?.extraEnv?.CUDA_VISIBLE_DEVICES || '');

  const [nameManual, setNameManual] = useState(isEdit);
  const [displayNameManual, setDisplayNameManual] = useState(isEdit);
  const [endpointManual, setEndpointManual] = useState(isEdit);

  const [port, setPort] = useState(service?.endpoint ? parsePort(service.endpoint) : '8003');
  const [tensorParallel, setTensorParallel] = useState(parseCmdFlag(service?.execCommand || '', '--tensor-parallel-size', '1'));
  const [maxModelLen, setMaxModelLen] = useState(parseCmdFlag(service?.execCommand || '', '--max-model-len', '4096'));
  const [gpuMemUtil, setGpuMemUtil] = useState(parseCmdFlag(service?.execCommand || '', '--gpu-memory-utilization', '0.90'));
  const [dtype, setDtype] = useState(parseCmdFlag(service?.execCommand || '', '--dtype', 'auto'));
  const [quantization, setQuantization] = useState(parseCmdFlag(service?.execCommand || '', '--quantization', ''));
  const [extraArgs, setExtraArgs] = useState('');

  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const rebuildCmd = useCallback((overrides?: Record<string, string>) => {
    const mp = overrides?.modelPath ?? modelPath;
    if (!mp) return;
    const cmd = buildCmd({
      modelPath: mp, port: overrides?.port ?? port, modelName: overrides?.modelName ?? modelName,
      gpuMemUtil: overrides?.gpuMemUtil ?? gpuMemUtil, maxModelLen: overrides?.maxModelLen ?? maxModelLen,
      tensorParallel: overrides?.tensorParallel ?? tensorParallel, dtype: overrides?.dtype ?? dtype,
      quantization: overrides?.quantization ?? quantization, extraArgs: overrides?.extraArgs ?? extraArgs,
    });
    setExecCommand(cmd);
    if (!endpointManual) setEndpoint(`http://localhost:${overrides?.port ?? port}`);
  }, [modelPath, port, modelName, gpuMemUtil, maxModelLen, tensorParallel, dtype, quantization, extraArgs, endpointManual]);

  const handleModelSelect = (id: number | null) => {
    setSelectedModelId(id);
    if (!id) return;
    const model = models.find((m) => m.id === id);
    if (!model) return;
    setModelPath(model.artifactUri || '');
    setModelName(model.family);
    if (!nameManual) setName(`svc-${model.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
    if (!displayNameManual) setDisplayName(model.name);
    setDescription(`${model.name} 推理服务`);
    if (!endpointManual) setEndpoint(`http://localhost:${port}`);
    if (model.artifactUri) {
      setExecCommand(buildCmd({
        modelPath: model.artifactUri, port, modelName: model.family,
        gpuMemUtil, maxModelLen, tensorParallel, dtype, quantization, extraArgs,
      }));
    }
  };

  const handleTestConnection = async () => {
    if (!endpoint.trim()) { setTestResult({ ok: false, msg: '请填写端点' }); return; }
    setTesting(true); setTestResult(null);
    try {
      const url = endpoint.trim().replace(/\/$/, '') + '/v1/models';
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const names = data.data?.map((m: { id: string }) => m.id) ?? [];
        setTestResult({ ok: true, msg: names.length ? `连接正常，模型: ${names.join(', ')}` : '连接正常' });
      } else { setTestResult({ ok: false, msg: `HTTP ${res.status}` }); }
    } catch { setTestResult({ ok: false, msg: '无法连接' }); }
    finally { setTesting(false); }
  };

  return (
    <Modal open onClose={onClose} title={isEdit ? '编辑服务' : '添加服务'} size="lg">
      <div className={styles.form}>
        {!isEdit && models.length > 0 && (
          <label>
            从已注册模型创建
            <span className={styles.fieldHint}>选择后自动填充，也可跳过手动填写</span>
            <select value={selectedModelId ?? ''} onChange={(e) => handleModelSelect(e.target.value ? Number(e.target.value) : null)}>
              <option value="">— 手动填写 —</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.family})</option>)}
            </select>
          </label>
        )}
        <div className={styles.formRow2}>
          <label>名称（唯一标识）<input value={name} disabled={isEdit} onChange={(e) => { setName(e.target.value); setNameManual(true); }} /></label>
          <label>显示名称<input value={displayName} onChange={(e) => { setDisplayName(e.target.value); setDisplayNameManual(true); }} /></label>
        </div>
        <div className={styles.formRow2}>
          <label>模型路径<input value={modelPath} placeholder="/path/to/model" onChange={(e) => { setModelPath(e.target.value); rebuildCmd({ modelPath: e.target.value }); }} /></label>
          <label>模型名称（API 路由）<input value={modelName} placeholder="如 qwen" onChange={(e) => { setModelName(e.target.value); rebuildCmd({ modelName: e.target.value }); }} /></label>
        </div>
        <div className={styles.gpuPanel}>
          <strong>GPU / vLLM 参数</strong>
          <div className={styles.gpuGrid}>
            <label>GPU 设备
              <select value={gpuDevice} onChange={(e) => { const v = e.target.value; setGpuDevice(v); const tp = String(v ? v.split(',').length : 1); setTensorParallel(tp); rebuildCmd({ tensorParallel: tp }); }}>
                <option value="">自动</option>
                <option value="0">GPU 0</option><option value="1">GPU 1</option><option value="2">GPU 2</option><option value="3">GPU 3</option>
                <option value="0,1">GPU 0,1（双卡）</option><option value="2,3">GPU 2,3（双卡）</option><option value="0,1,2,3">GPU 0-3（四卡）</option>
              </select>
            </label>
            <label>端口<input value={port} onChange={(e) => { setPort(e.target.value); if (!endpointManual) setEndpoint(`http://localhost:${e.target.value}`); rebuildCmd({ port: e.target.value }); }} /></label>
            <label>张量并行
              <select value={tensorParallel} onChange={(e) => { setTensorParallel(e.target.value); rebuildCmd({ tensorParallel: e.target.value }); }}>
                <option value="1">1</option><option value="2">2</option><option value="4">4</option>
              </select>
            </label>
            <label>最大上下文<input value={maxModelLen} onChange={(e) => { setMaxModelLen(e.target.value); rebuildCmd({ maxModelLen: e.target.value }); }} /></label>
            <label>显存利用率
              <select value={gpuMemUtil} onChange={(e) => { setGpuMemUtil(e.target.value); rebuildCmd({ gpuMemUtil: e.target.value }); }}>
                <option value="0.80">80%</option><option value="0.85">85%</option><option value="0.90">90%</option><option value="0.95">95%</option><option value="0.97">97%</option>
              </select>
            </label>
            <label>精度
              <select value={dtype} onChange={(e) => { setDtype(e.target.value); rebuildCmd({ dtype: e.target.value }); }}>
                <option value="auto">auto</option><option value="half">fp16</option><option value="bfloat16">bf16</option>
              </select>
            </label>
            <label>量化
              <select value={quantization} onChange={(e) => { setQuantization(e.target.value); rebuildCmd({ quantization: e.target.value }); }}>
                <option value="">无</option><option value="awq">AWQ</option><option value="gptq">GPTQ</option>
              </select>
            </label>
            <label>额外参数<input value={extraArgs} placeholder="--enforce-eager" onChange={(e) => { setExtraArgs(e.target.value); rebuildCmd({ extraArgs: e.target.value }); }} /></label>
          </div>
        </div>
        <div className={styles.formRow2}>
          <label>端点<input value={endpoint} placeholder="http://localhost:8001" onChange={(e) => { setEndpoint(e.target.value); setEndpointManual(true); }} /></label>
          <label>连接测试
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <button className={styles.btnDefault} onClick={handleTestConnection} disabled={testing} type="button">{testing ? '测试中...' : '测试连接'}</button>
              {testResult && <span style={{ fontSize: 'var(--font-size-xs)', color: testResult.ok ? '#52c41a' : 'var(--color-danger)' }}>{testResult.msg}</span>}
            </div>
          </label>
        </div>
        <label>启动命令<span className={styles.fieldHint}>修改 GPU 参数时自动更新</span>
          <textarea value={execCommand} onChange={(e) => setExecCommand(e.target.value)} rows={3} />
        </label>
        <label>描述<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></label>
        <div className={styles.formActions}>
          <button className={styles.btnDefault} onClick={onClose}>取消</button>
          <button className={styles.btnPrimary} onClick={() => {
            const data: Record<string, unknown> = { name, displayName, endpoint, modelName, modelPath, gpuDevice, description, execCommand };
            if (gpuDevice) data.extraEnv = { CUDA_VISIBLE_DEVICES: gpuDevice };
            onSave(data);
          }} disabled={!name.trim()}>保存</button>
        </div>
      </div>
    </Modal>
  );
}
