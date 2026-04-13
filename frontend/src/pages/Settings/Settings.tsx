/**
 * 系统设置页面 — API 限流 + 过期清理 + 并发限制
 */
import { useState, useEffect, useCallback } from 'react';
import {
  getSystemConfigs,
  updateSystemConfigs,
  ApiError,
} from '../../services/api';
import { useUiStore } from '../../stores/uiStore';
import styles from './Settings.module.css';

interface ConfigItem {
  key: string;
  label: string;
  suffix?: string;
  type?: 'toggle';
  hint?: string;
}

interface ConfigGroup {
  title: string;
  description: string;
  presets?: boolean;
  items: ConfigItem[];
}

const RATE_LIMIT_DEFAULTS: Record<string, string> = {
  rate_limit_per_minute: '10',
  rate_limit_per_hour: '100',
  rate_limit_per_day: '500',
};

const RATE_LIMIT_UNLIMITED: Record<string, string> = {
  rate_limit_per_minute: '-1',
  rate_limit_per_hour: '-1',
  rate_limit_per_day: '-1',
};

const CONCURRENCY_DEFAULTS: Record<string, string> = {
  max_gpu_concurrency: '4',
  max_cpu_concurrency: '8',
  gpu_sync_concurrency: '4',
};

const CONFIG_GROUPS: ConfigGroup[] = [
  {
    title: 'API 限流',
    description: 'API Key 默认调用频率限制（-1 = 不限制，0 = 禁止，单个 Key 可在 API 密钥页覆盖）',
    presets: true,
    items: [
      { key: 'rate_limit_per_minute', label: '每分钟上限', suffix: '次/分钟', hint: '默认 -1 不限制，推荐值 10，0 禁止' },
      { key: 'rate_limit_per_hour', label: '每小时上限', suffix: '次/小时', hint: '默认 -1 不限制，推荐值 100，0 禁止' },
      { key: 'rate_limit_per_day', label: '每日上限', suffix: '次/天', hint: '默认 -1 不限制，推荐值 500，0 禁止' },
    ],
  },
  {
    title: '结果清理',
    description: '自动清理过期的推理结果文件和索引记录',
    items: [
      { key: 'cleanup_enabled', label: '启用自动清理', type: 'toggle' },
      { key: 'cleanup_retention_days', label: '保留天数', suffix: '天' },
    ],
  },
  {
    title: '并发限制',
    description: '推理任务最大同时执行数（-1 = 不限制，0 = 暂停所有任务，超过上限自动排队）',
    presets: true,
    items: [
      { key: 'max_gpu_concurrency', label: 'GPU 任务并发', suffix: '个任务', hint: '同时推理的 GPU 任务数，多卡部署时建议等于引擎数量（如 4 卡设 4）' },
      { key: 'max_cpu_concurrency', label: 'CPU 任务并发', suffix: '个任务', hint: 'CPU 算法同时执行数，推荐 8' },
      { key: 'gpu_sync_concurrency', label: '外部 API GPU 并发（同步模式）', suffix: '个请求', hint: '仅控制同步调用，异步调用受 GPU 任务并发控制。设 1 可确保结果一致' },
    ],
  },
  {
    title: '日志管理',
    description: '系统日志文件轮转策略，超过上限自动归档旧日志',
    items: [
      { key: 'log_max_size_mb', label: '单文件上限', suffix: 'MB' },
      { key: 'log_backup_count', label: '备份文件数', suffix: '个' },
    ],
  },
];

export default function Settings() {
  const showToast = useUiStore((s) => s.showToast);
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchConfigs = useCallback(async () => {
    try {
      setLoading(true);
      const items = await getSystemConfigs();
      const map: Record<string, string> = {};
      const descMap: Record<string, string> = {};
      for (const item of items) {
        map[item.key] = item.value;
        if (item.description) descMap[item.key] = item.description;
      }
      setConfigs(map);
      setOriginal(map);
      setDescriptions(descMap);
    } catch {
      showToast({ message: '加载设置失败', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const hasChanges = JSON.stringify(configs) !== JSON.stringify(original);

  const handleSave = async () => {
    const changed = Object.entries(configs).filter(
      ([key, value]) => value !== original[key],
    );
    if (changed.length === 0) return;

    setSaving(true);
    try {
      await updateSystemConfigs(changed.map(([key, value]) => ({ key, value })));
      setOriginal({ ...configs });
      showToast({ message: '设置已保存', type: 'success' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : '保存失败';
      showToast({ message: msg, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className={styles.loading}>加载中...</div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>系统设置</h2>
        <button
          className={styles.saveBtn}
          onClick={handleSave}
          disabled={!hasChanges || saving}
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>

      {CONFIG_GROUPS.map((group) => (
        <div key={group.title} className={styles.group}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            {group.presets && (
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button
                  className={styles.presetBtn}
                  onClick={() => {
                    const defaults = group.title === 'API 限流' ? RATE_LIMIT_DEFAULTS : CONCURRENCY_DEFAULTS;
                    setConfigs((prev) => ({ ...prev, ...defaults }));
                  }}
                >
                  推荐值
                </button>
                <button
                  className={styles.presetBtn}
                  onClick={() => {
                    const unlimited = group.title === 'API 限流' ? RATE_LIMIT_UNLIMITED
                      : { max_gpu_concurrency: '-1', max_cpu_concurrency: '-1', gpu_sync_concurrency: '-1' };
                    setConfigs((prev) => ({ ...prev, ...unlimited }));
                  }}
                >
                  不限制
                </button>
              </div>
            )}
          </div>
          <p className={styles.groupDesc}>{group.description}</p>
          <div className={styles.fields}>
            {group.items.map((item) => (
              <div key={item.key} className={styles.field}>
                <label className={styles.label}>
                  {item.label}
                  {descriptions[item.key] && (
                    <span className={styles.hint}>{descriptions[item.key]}</span>
                  )}
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                  <div className={styles.inputRow}>
                    {item.type === 'toggle' ? (
                      <label className={styles.toggle}>
                        <input
                          type="checkbox"
                          checked={configs[item.key] === 'true'}
                          onChange={(e) =>
                            setConfigs((prev) => ({ ...prev, [item.key]: e.target.checked ? 'true' : 'false' }))
                          }
                        />
                        <span>{configs[item.key] === 'true' ? '已启用' : '已关闭'}</span>
                      </label>
                    ) : (
                      <>
                        <input
                          className={styles.input}
                          type="number"
                          min={-1}
                          value={configs[item.key] || ''}
                          onChange={(e) =>
                            setConfigs((prev) => ({ ...prev, [item.key]: e.target.value }))
                          }
                        />
                        {item.suffix && <span className={styles.suffix}>{item.suffix}</span>}
                      </>
                    )}
                  </div>
                  {item.hint && (
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', textAlign: 'right' }}>
                      {item.hint}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
