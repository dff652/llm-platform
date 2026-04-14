import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge } from '../../components/common/Badge';
import { Modal } from '../../components/common/Modal';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import type { ModelEntity, LLMService } from '../../types';
import styles from './ModelCenter.module.css';

export default function ModelCenter() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const showToast = useUiStore((s) => s.showToast);
  const [models, setModels] = useState<ModelEntity[]>([]);
  const [services, setServices] = useState<LLMService[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<ModelEntity | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelEntity | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [modelRes, svcRes] = await Promise.all([
        api.get<{ items: ModelEntity[] }>('/models'),
        api.get<LLMService[]>('/services'),
      ]);
      setModels(modelRes.items || []);
      setServices(svcRes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const getLinkedServices = (model: ModelEntity): LLMService[] => {
    return services.filter((s) =>
      s.modelName === model.name || s.modelPath === model.artifactUri
    );
  };

  const handleSave = async (data: Record<string, unknown>) => {
    try {
      if (editingModel) {
        await api.put(`/models/${editingModel.id}`, data);
        showToast({ type: 'success', message: '模型已更新' });
      } else {
        await api.post('/models', data);
        showToast({ type: 'success', message: '模型已创建' });
      }
      setShowForm(false);
      setEditingModel(null);
      fetchData();
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : '保存失败' });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/models/${deleteTarget.id}`);
      showToast({ type: 'success', message: '模型已删除' });
      setDeleteTarget(null);
      fetchData();
    } catch (e) {
      showToast({ type: 'error', message: e instanceof ApiError ? e.detail : '删除失败' });
    }
  };

  if (loading) return <div className={styles.page}><p>加载中...</p></div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2>模型注册</h2>
          <span className={styles.hint}>通过模型商店下载发布，或手动注册模型</span>
        </div>
        {isAdmin && (
          <button className={styles.btnPrimary} onClick={() => { setEditingModel(null); setShowForm(true); }}>
            + 注册模型
          </button>
        )}
      </div>

      {models.length === 0 ? (
        <div className={styles.empty}>
          <p>暂无已注册模型</p>
          <p className={styles.emptyHint}>
            前往 <a href="/model-store">模型商店</a> 下载模型并发布，或点击上方"注册模型"手动添加
          </p>
        </div>
      ) : (
        <div className={styles.cardGrid}>
          {models.map((model) => {
            const linked = getLinkedServices(model);
            return (
              <div key={model.id} className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h3 className={styles.cardTitle}>{model.name}</h3>
                    <span className={styles.cardFamily}>{model.family}</span>
                  </div>
                  <Badge variant={model.status === 'active' ? 'success' : 'default'}>
                    {model.status === 'active' ? '已激活' : model.status}
                  </Badge>
                </div>

                <div className={styles.cardBody}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>运行时</span>
                    <span>{model.runtimeType}</span>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>版本</span>
                    <span>{model.version || '-'}</span>
                  </div>
                  {model.artifactUri && (
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>路径</span>
                      <span className={styles.pathText}>{model.artifactUri}</span>
                    </div>
                  )}
                  {model.description && (
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>说明</span>
                      <span>{model.description}</span>
                    </div>
                  )}
                </div>

                <div className={styles.cardServices}>
                  <span className={styles.fieldLabel}>关联服务</span>
                  {linked.length > 0 ? (
                    <div className={styles.svcList}>
                      {linked.map((svc) => (
                        <a key={svc.id} href="/services" className={styles.svcChip}>
                          {svc.displayName}
                          <span className={styles.svcEndpoint}>{svc.endpoint}</span>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <span className={styles.noSvc}>无关联服务</span>
                  )}
                </div>

                {isAdmin && (
                  <div className={styles.cardActions}>
                    <button className={styles.btnEdit} onClick={() => { setEditingModel(model); setShowForm(true); }}>编辑</button>
                    <button className={styles.btnDanger} onClick={() => setDeleteTarget(model)}>删除</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <ModelFormModal
          model={editingModel}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditingModel(null); }}
        />
      )}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="删除模型"
        message={`确定删除模型 "${deleteTarget?.name}"？关联的服务也会被删除。`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function ModelFormModal({
  model,
  onSave,
  onClose,
}: {
  model: ModelEntity | null;
  onSave: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: model?.name || '',
    family: model?.family || '',
    runtimeType: model?.runtimeType || 'gpu',
    version: model?.version || 'v1.0',
    artifactUri: model?.artifactUri || '',
    description: model?.description || '',
  });

  const handleChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Modal open onClose={onClose} title={model ? '编辑模型' : '注册模型'}>
      <div className={styles.form}>
        <label>
          模型名称
          <input value={form.name} onChange={(e) => handleChange('name', e.target.value)} disabled={!!model} placeholder="如 Qwen2.5-7B-Instruct" />
        </label>
        <label>
          模型族
          <input value={form.family} onChange={(e) => handleChange('family', e.target.value)} placeholder="如 qwen, llama, chatts" />
        </label>
        <label>
          运行时
          <select value={form.runtimeType} onChange={(e) => handleChange('runtimeType', e.target.value)}>
            <option value="gpu">GPU (vLLM)</option>
            <option value="cpu">CPU</option>
            <option value="transformers">Transformers</option>
          </select>
        </label>
        <label>
          版本
          <input value={form.version} onChange={(e) => handleChange('version', e.target.value)} />
        </label>
        <label>
          模型路径
          <input value={form.artifactUri} onChange={(e) => handleChange('artifactUri', e.target.value)} placeholder="/path/to/model" />
        </label>
        <label>
          描述
          <textarea value={form.description} onChange={(e) => handleChange('description', e.target.value)} rows={2} />
        </label>
        <div className={styles.formActions}>
          <button className={styles.btnDefault} onClick={onClose}>取消</button>
          <button className={styles.btnPrimary} onClick={() => onSave(form)} disabled={!form.name || !form.family}>保存</button>
        </div>
      </div>
    </Modal>
  );
}
