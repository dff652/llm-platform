import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge } from '../../components/common/Badge';
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
        <h2>模型中心</h2>
        <span className={styles.hint}>通过模型商店下载并发布模型到此处</span>
      </div>

      {models.length === 0 ? (
        <div className={styles.empty}>
          <p>暂无已注册模型</p>
          <p className={styles.emptyHint}>
            前往 <a href="/model-store">模型商店</a> 下载模型，下载完成后点击"发布"即可注册到此处
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

                {/* Linked services */}
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
                    <span className={styles.noSvc}>无关联服务 — 前往模型服务页创建</span>
                  )}
                </div>

                {isAdmin && (
                  <div className={styles.cardActions}>
                    <button className={styles.btnDanger} onClick={() => setDeleteTarget(model)}>删除</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
