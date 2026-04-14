import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useModelStoreStore } from '../../stores/modelStoreStore';
import { useAuthStore } from '../../stores/authStore';
import { useUiStore } from '../../stores/uiStore';
import { getRemoteModelDetail, checkDiskSpace, updateDownloadDir, browseDirs, getDownloadDependencies, ApiError } from '../../services/api';
import { api } from '../../services/api';
import type { RemoteModel, RemoteModelDetail, ModelDownload, PublishRequest, ModelEntity, LLMService } from '../../types';
import ModelCard from './components/ModelCard';
import CompareModal from './components/CompareModal';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { Tabs } from '../../components/common/Tabs';
import styles from './ModelStore.module.css';

type StoreTab = 'browse' | 'downloads' | 'published';

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Guess parameter count from model name (e.g. "Qwen3-8B" → 8) */
function guessParamB(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)\s*[Bb]/);
  return m?.[1] ? parseFloat(m[1]) : 0;
}

/** Estimate GPU VRAM needed (BF16 ≈ model size, INT4 ≈ 1/4) */
function estimateVram(sizeBytes: number): string {
  if (sizeBytes <= 0) return '';
  const gb = sizeBytes / 1024 ** 3;
  // BF16 safetensors ≈ 2 bytes/param, actual size is roughly the VRAM needed
  // Add ~2GB overhead for KV cache etc
  const vram = gb + 2;
  return `~${Math.ceil(vram)} GB`;
}

type SortKey = 'default' | 'downloads' | 'size' | 'updated' | 'stars';
type ParamFilter = '' | '7' | '8' | '14' | '27' | '32' | '72';
type TaskFilter = '' | 'text-generation' | 'image-text-to-text' | 'feature-extraction';
type GenFilter = '' | '3.5' | '3' | '2.5' | '2' | '1.5';

/** Extract Qwen generation from model name: "Qwen3.5-8B" → "3.5" */
function getModelGen(name: string): string {
  const m = name.match(/^Qwen(\d+(?:\.\d+)?)/);
  return m?.[1] ?? '';
}

export default function ModelStore() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const showToast = useUiStore((s) => s.showToast);
  const isAdmin = user?.role === 'admin';
  const {
    models, total, page, pageSize, query, owner, loading,
    downloads,
    setQuery, setOwner, setPage,
    fetchModels, fetchDownloads, startDownload,
    cancelDownload, deleteDownload, retryDownload,
  } = useModelStoreStore();

  const [activeTab, setActiveTab] = useState<StoreTab>('browse');
  const [publishedModels, setPublishedModels] = useState<ModelEntity[]>([]);
  const [publishedServices, setPublishedServices] = useState<LLMService[]>([]);
  const [searchInput, setSearchInput] = useState(query);
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [paramFilter, setParamFilter] = useState<ParamFilter>('');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('');
  const [genFilter, setGenFilter] = useState<GenFilter>('');
  const [detailModel, setDetailModel] = useState<RemoteModelDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Download management tab state
  const [diskInfo, setDiskInfo] = useState<{ free: number; total: number; downloadDir: string } | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [browsingDirs, setBrowsingDirs] = useState(false);
  const [browseCurrent, setBrowseCurrent] = useState('');
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseDirList, setBrowseDirList] = useState<Array<{ name: string; path: string }>>([]);
  const [publishTarget, setPublishTarget] = useState<ModelDownload | null>(null);

  // Delete confirm dialog state
  const [deleteTarget, setDeleteTarget] = useState<ModelDownload | null>(null);
  const [deleteDeps, setDeleteDeps] = useState<{ services: { id: number; name: string; endpoint: string }[] }>({ services: [] });
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [publishForm, setPublishForm] = useState<PublishRequest>({
    runtimeType: 'gpu',
    version: 'v1.0',
    description: '',
    createService: true,
    servicePort: null as number | null,
    gpuDevice: '',
    quantization: 'auto',
  });
  const [publishing, setPublishing] = useState(false);
  const [compareList, setCompareList] = useState<RemoteModel[]>([]);
  const [showCompare, setShowCompare] = useState(false);

  const toggleCompare = useCallback((model: RemoteModel) => {
    setCompareList((prev) => {
      const exists = prev.find((m) => m.modelId === model.modelId);
      if (exists) return prev.filter((m) => m.modelId !== model.modelId);
      if (prev.length >= 3) return prev; // max 3
      return [...prev, model];
    });
  }, []);

  // Initial load
  const fetchPublished = useCallback(async () => {
    try {
      const [mRes, sRes] = await Promise.all([
        api.get<{ items: ModelEntity[] }>('/models', { pageSize: 100 }),
        api.get<LLMService[]>('/services'),
      ]);
      setPublishedModels(mRes.items || []);
      setPublishedServices(sRes);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchModels();
    fetchDownloads();
    fetchPublished();
    checkDiskSpace().then(setDiskInfo).catch(() => {});
  }, [fetchModels, fetchDownloads, fetchPublished]);

  // Poll downloads when any are active (pending/downloading)
  const hasActiveDownloads = downloads.some((d) => ['pending', 'downloading', 'verifying'].includes(d.status));
  useEffect(() => {
    if (!hasActiveDownloads) return;
    const timer = setInterval(fetchDownloads, 3000);
    return () => clearInterval(timer);
  }, [hasActiveDownloads, fetchDownloads]);

  // Sort + filter models client-side
  const displayModels = useMemo(() => {
    let list = [...models];

    // Filter by param size
    if (paramFilter) {
      const target = parseFloat(paramFilter);
      list = list.filter((m) => {
        const p = guessParamB(m.name);
        return p > 0 && Math.abs(p - target) < target * 0.3; // 30% tolerance
      });
    }

    // Filter by task type
    if (taskFilter) {
      list = list.filter((m) => m.tasks.includes(taskFilter));
    }

    // Filter by generation
    if (genFilter) {
      list = list.filter((m) => getModelGen(m.name) === genFilter);
    }

    // Sort
    if (sortKey === 'downloads') list.sort((a, b) => b.downloads - a.downloads);
    else if (sortKey === 'size') list.sort((a, b) => a.storageSize - b.storageSize);
    else if (sortKey === 'updated') list.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
    else if (sortKey === 'stars') list.sort((a, b) => b.stars - a.stars);

    return list;
  }, [models, sortKey, paramFilter, taskFilter]);

  const handleSearch = () => {
    setQuery(searchInput);
    setPage(1);
    // Zustand setters are sync, fetchModels reads from get()
    fetchModels();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleOwnerChange = (value: string) => {
    setOwner(value);
    setPage(1);
    fetchModels();
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchModels();
  };

  const handleDownload = async (model: RemoteModel) => {
    if (!isAdmin) {
      showToast({ message: '仅管理员可下载模型', type: 'error' });
      return;
    }
    if (model.storageSize > 0) {
      try {
        const disk = await checkDiskSpace();
        const margin = 1024 ** 3;
        if (disk.free < model.storageSize + margin) {
          const freeGB = (disk.free / 1024 ** 3).toFixed(1);
          const needGB = (model.storageSize / 1024 ** 3).toFixed(1);
          showToast({ message: `磁盘空间不足: 剩余 ${freeGB}GB，需要 ${needGB}GB`, type: 'error' });
          return;
        }
      } catch { /* proceed */ }
    }
    try {
      await startDownload(model);
      await fetchDownloads();
      showToast({ message: `已开始下载: ${model.name}`, type: 'success' });
    } catch (err) {
      showToast({ message: err instanceof ApiError ? err.detail : '下载失败', type: 'error' });
    }
  };

  const handleModelClick = useCallback(async (model: RemoteModel) => {
    setDetailLoading(true);
    try {
      const detail = await getRemoteModelDetail('modelscope', model.modelId);
      setDetailModel(detail);
    } catch {
      setDetailModel({ ...model, readme: '', files: [], architectures: [], backendSupport: {} });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const getDownloadForModel = (modelId: string) =>
    downloads.find((d) => d.modelId === modelId);

  const handlePublish = async () => {
    if (!publishTarget) return;
    setPublishing(true);
    try {
      await useModelStoreStore.getState().publish(publishTarget.id, publishForm);
      setPublishTarget(null);
      if (publishForm.createService) {
        showToast({
          message: `${publishTarget.modelName} 已发布并创建服务`,
          type: 'success',
          action: { label: '去模型服务', onClick: () => navigate('/services') },
        });
      } else {
        showToast({
          message: `${publishTarget.modelName} 已发布到模型中心`,
          type: 'success',
          action: { label: '去模型中心', onClick: () => navigate('/models') },
        });
      }
    } catch (err) {
      showToast({ message: err instanceof ApiError ? err.detail : '发布失败', type: 'error' });
    } finally {
      setPublishing(false);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  const handleSavePath = async (dir?: string) => {
    const target = (dir || pathInput).trim();
    if (!target) return;
    try {
      const info = await updateDownloadDir(target);
      setDiskInfo(info);
      setEditingPath(false);
      setBrowsingDirs(false);
      showToast({ message: `下载路径已更新`, type: 'success' });
    } catch (err) {
      showToast({ message: err instanceof ApiError ? err.detail : '路径设置失败', type: 'error' });
    }
  };

  const handleDeleteClick = async (dl: ModelDownload) => {
    setDeleteTarget(dl);
    setDeleteDeps({ services: [] });
    if (dl.registeredModelId) {
      try {
        const deps = await getDownloadDependencies(dl.id);
        setDeleteDeps({ services: deps.services });
      } catch { /* ignore, show dialog anyway */ }
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    await deleteDownload(deleteTarget.id);
    setDeleteLoading(false);
    setDeleteTarget(null);
  };

  const openBrowser = async (path?: string) => {
    const target = path || diskInfo?.downloadDir || '/';
    try {
      const res = await browseDirs(target);
      setBrowseCurrent(res.current);
      setBrowseParent(res.parent);
      setBrowseDirList(res.dirs);
      setBrowsingDirs(true);
      setEditingPath(true);
      setPathInput(res.current);
    } catch (err) {
      showToast({ message: err instanceof ApiError ? err.detail : '无法浏览目录', type: 'error' });
    }
  };

  // Group downloads by status
  const dlActive = downloads.filter((d) => ['pending', 'downloading', 'verifying'].includes(d.status));
  const dlFailed = downloads.filter((d) => ['failed', 'cancelled'].includes(d.status));
  const dlCompleted = downloads.filter((d) => d.status === 'completed');
  const dlBadgeCount = dlActive.length + dlFailed.length;

  return (
    <div className={styles.page} style={compareList.length > 0 ? { paddingBottom: 56 } : undefined}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>模型商店</h2>
        <div className={styles.headerRight}>
          <select className={styles.sourceSelect} value="modelscope" disabled>
            <option value="modelscope">ModelScope</option>
            <option value="huggingface" disabled>HuggingFace (待实现)</option>
          </select>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        items={[
          { key: 'browse', label: '模型浏览' },
          { key: 'downloads', label: `下载管理${dlBadgeCount > 0 ? ` (${dlBadgeCount})` : ''}` },
          { key: 'published', label: `已发布${publishedModels.length > 0 ? ` (${publishedModels.length})` : ''}` },
        ]}
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as StoreTab)}
      />

      {activeTab === 'browse' && (<>
      {/* Search & Filters */}
      <div className={styles.filterBar}>
        <select
          className={styles.filterSelect}
          value={owner}
          onChange={(e) => handleOwnerChange(e.target.value)}
        >
          <option value="Qwen">Qwen 官方</option>
          <option value="">全部组织</option>
        </select>
        <input
          className={styles.searchInput}
          placeholder="搜索模型名称..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className={styles.btnSearch} onClick={handleSearch}>搜索</button>
      </div>

      {/* Sort & Filter Controls */}
      <div className={styles.sortBar}>
        <div className={styles.sortGroup}>
          <span className={styles.sortLabel}>排序</span>
          {([
            ['default', '默认'],
            ['downloads', '下载量'],
            ['size', '大小'],
            ['stars', '热度'],
            ['updated', '更新时间'],
          ] as [SortKey, string][]).map(([key, label]) => (
            <button
              key={key}
              className={`${styles.sortChip} ${sortKey === key ? styles.sortChipActive : ''}`}
              onClick={() => setSortKey(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles.sortGroup}>
          <span className={styles.sortLabel}>参数量</span>
          {([
            ['', '全部'],
            ['7', '7B'],
            ['8', '8B'],
            ['14', '14B'],
            ['27', '27B'],
            ['32', '32B'],
            ['72', '72B'],
          ] as [ParamFilter, string][]).map(([key, label]) => (
            <button
              key={key}
              className={`${styles.sortChip} ${paramFilter === key ? styles.sortChipActive : ''}`}
              onClick={() => setParamFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles.sortGroup}>
          <span className={styles.sortLabel}>任务</span>
          {([
            ['', '全部'],
            ['text-generation', '文本生成'],
            ['image-text-to-text', '视觉理解'],
            ['feature-extraction', '嵌入'],
          ] as [TaskFilter, string][]).map(([key, label]) => (
            <button
              key={key}
              className={`${styles.sortChip} ${taskFilter === key ? styles.sortChipActive : ''}`}
              onClick={() => setTaskFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles.sortGroup}>
          <span className={styles.sortLabel}>版本</span>
          {([
            ['', '全部'],
            ['3.5', '3.5'],
            ['3', '3'],
            ['2.5', '2.5'],
            ['2', '2'],
            ['1.5', '1.5'],
          ] as [GenFilter, string][]).map(([key, label]) => (
            <button
              key={key}
              className={`${styles.sortChip} ${genFilter === key ? styles.sortChipActive : ''}`}
              onClick={() => setGenFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Model Grid */}
      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : displayModels.length === 0 ? (
        <div className={styles.emptyState}>
          {models.length > 0 ? '当前筛选条件无匹配模型' : '未找到模型'}
        </div>
      ) : (
        <div className={styles.modelGrid}>
          {displayModels.map((model) => (
            <ModelCard
              key={model.modelId}
              model={model}
              download={getDownloadForModel(model.modelId)}
              vramEstimate={estimateVram(model.storageSize)}
              compareSelected={compareList.some((m) => m.modelId === model.modelId)}
              onCompareToggle={toggleCompare}
              onDownload={handleDownload}
              onClick={handleModelClick}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button className={styles.btnPage} disabled={page <= 1} onClick={() => handlePageChange(page - 1)}>
            上一页
          </button>
          <span className={styles.pageInfo}>{page} / {totalPages} (共 {total} 个)</span>
          <button className={styles.btnPage} disabled={page >= totalPages} onClick={() => handlePageChange(page + 1)}>
            下一页
          </button>
        </div>
      )}

      </>)}

      {/* Downloads Tab */}
      {activeTab === 'downloads' && (
        <div>
          {/* Path setting */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
            padding: 'var(--space-3) var(--space-4)',
            background: 'var(--color-surface)', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)', marginBottom: 'var(--space-4)',
            fontSize: 'var(--font-size-sm)',
          }}>
            <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>下载路径</span>
            {!editingPath ? (
              <>
                <code style={{
                  flex: 1, padding: '4px 8px', background: 'var(--color-bg)',
                  borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-xs)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {diskInfo?.downloadDir || '...'}
                </code>
                {diskInfo && (
                  <span style={{ color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', fontSize: 'var(--font-size-xs)' }}>
                    剩余 {(diskInfo.free / 1024 ** 3).toFixed(0)} GB / {(diskInfo.total / 1024 ** 3).toFixed(0)} GB
                  </span>
                )}
                <button className={styles.btnPage} onClick={() => openBrowser()}>
                  修改
                </button>
              </>
            ) : !browsingDirs ? (
              <>
                <input
                  style={{ flex: 1, padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', fontSize: 'var(--font-size-sm)' }}
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSavePath()}
                  placeholder="/data/llm_models"
                  autoFocus
                />
                <button className={styles.btnPage} onClick={() => openBrowser(pathInput || '/')}>浏览</button>
                <button className={styles.btnSearch} onClick={() => handleSavePath()}>保存</button>
                <button className={styles.btnPage} onClick={() => setEditingPath(false)}>取消</button>
              </>
            ) : (
              <>
                <code style={{
                  flex: 1, padding: '4px 8px', background: 'var(--color-bg)',
                  borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-xs)',
                }}>
                  {browseCurrent}
                </code>
                <button className={styles.btnSearch} onClick={() => handleSavePath(browseCurrent)}>选择此目录</button>
                <button className={styles.btnPage} onClick={() => { setBrowsingDirs(false); setEditingPath(false); }}>取消</button>
              </>
            )}
          </div>

          {/* Directory browser panel */}
          {browsingDirs && (
            <div style={{
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-4)', maxHeight: 300, overflow: 'auto',
              background: 'var(--color-surface)',
            }}>
              {browseParent && (
                <div
                  className={styles.dlRow}
                  style={{ cursor: 'pointer', color: 'var(--color-primary)' }}
                  onClick={() => openBrowser(browseParent!)}
                >
                  .. (上级目录)
                </div>
              )}
              {browseDirList.length === 0 ? (
                <div style={{ padding: 'var(--space-3) var(--space-4)', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-sm)' }}>
                  空目录
                </div>
              ) : (
                browseDirList.map((d) => (
                  <div
                    key={d.path}
                    className={styles.dlRow}
                    style={{ cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}
                    onClick={() => openBrowser(d.path)}
                  >
                    <span style={{ marginRight: 8, opacity: 0.5 }}>&#128193;</span>
                    {d.name}
                  </div>
                ))
              )}
            </div>
          )}

          {downloads.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--color-text-tertiary)' }}>
              暂无下载任务，去「模型浏览」搜索并下载模型
            </div>
          ) : (
            <>
              {/* Active downloads */}
              {dlActive.length > 0 && (
                <div style={{ marginBottom: 'var(--space-4)' }}>
                  <h4 style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2)' }}>
                    下载中 ({dlActive.length})
                  </h4>
                  {dlActive.map((dl) => {
                    const pct = Math.round(dl.progress * 100);
                    const statusText = dl.status === 'pending' ? '准备中...'
                      : dl.status === 'verifying' ? '校验本地文件...'
                      : `${formatSize(dl.downloadedSize)} / ${formatSize(dl.totalSize)}`;
                    return (
                      <div key={dl.id} className={styles.dlRow}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, fontSize: 'var(--font-size-sm)' }}>{dl.modelName}</div>
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                            {statusText}
                          </div>
                        </div>
                        <div style={{ width: 120, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {dl.status === 'verifying' ? (
                            <span style={{ fontSize: 11, color: 'var(--color-warning)', fontWeight: 500 }}>校验中</span>
                          ) : (
                            <>
                              <div style={{ flex: 1, height: 6, background: 'var(--color-bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-primary)', borderRadius: 3, transition: 'width 0.3s' }} />
                              </div>
                              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-primary)', minWidth: 30, textAlign: 'right' }}>{pct}%</span>
                            </>
                          )}
                        </div>
                        <button className={styles.btnPage} onClick={() => cancelDownload(dl.id)}>取消</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Failed downloads */}
              {dlFailed.length > 0 && (
                <div style={{ marginBottom: 'var(--space-4)' }}>
                  <h4 style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)', marginBottom: 'var(--space-2)' }}>
                    失败 ({dlFailed.length})
                  </h4>
                  {dlFailed.map((dl) => (
                    <div key={dl.id} className={styles.dlRow}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: 'var(--font-size-sm)' }}>{dl.modelName}</div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-danger)' }}>
                          {dl.errorMessage || '下载失败'}
                        </div>
                      </div>
                      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                        {Math.round(dl.progress * 100)}%
                      </span>
                      <button className={styles.btnSearch} onClick={() => retryDownload(dl.id)}>重试</button>
                      <button className={styles.btnPage} onClick={() => handleDeleteClick(dl)}>删除</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Completed downloads */}
              {dlCompleted.length > 0 && (
                <div>
                  <h4 style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-success)', marginBottom: 'var(--space-2)' }}>
                    已完成 ({dlCompleted.length})
                  </h4>
                  {dlCompleted.map((dl) => (
                    <div key={dl.id} className={styles.dlRow}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: 'var(--font-size-sm)' }}>{dl.modelName}</div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                          {formatSize(dl.totalSize)}
                          {dl.downloadPath && <> · <code style={{ fontSize: 10 }}>{dl.downloadPath}</code></>}
                        </div>
                      </div>
                      {dl.registeredModelId ? (
                        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-success)', fontWeight: 500 }}>已发布</span>
                      ) : (
                        <button className={styles.btnPublish} onClick={() => setPublishTarget(dl)}>发布</button>
                      )}
                      <button className={styles.btnPage} onClick={() => handleDeleteClick(dl)}>删除</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Detail Modal */}
      {(detailModel || detailLoading) && (
        <div className={styles.modalOverlay} onClick={() => !detailLoading && setDetailModel(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            {detailLoading ? (
              <div className={styles.loading}>加载模型详情...</div>
            ) : detailModel && (
              <>
                <div className={styles.modalHeader}>
                  <h3 className={styles.modalTitle}>{detailModel.name}</h3>
                  <button className={styles.modalClose} onClick={() => setDetailModel(null)}>&times;</button>
                </div>
                <div className={styles.modalMeta}>
                  <span>{detailModel.owner}</span>
                  <span>{formatSize(detailModel.storageSize)}</span>
                  <span>显存(预估) {estimateVram(detailModel.storageSize)}</span>
                  <span>{detailModel.license}</span>
                  {detailModel.architectures.map((a) => <span key={a}>{a}</span>)}
                </div>
                {detailModel.files.length > 0 && (
                  <div className={styles.fileList}>
                    <h4>文件列表 ({detailModel.files.length})</h4>
                    {detailModel.files.slice(0, 20).map((f) => (
                      <div key={f.path} className={styles.fileItem}>
                        <span>{f.name}</span>
                        <span>{formatSize(f.size)}</span>
                      </div>
                    ))}
                    {detailModel.files.length > 20 && (
                      <div className={styles.fileItem}>
                        <span>... 还有 {detailModel.files.length - 20} 个文件</span><span />
                      </div>
                    )}
                  </div>
                )}
                {detailModel.backendSupport && Object.keys(detailModel.backendSupport).length > 0 && (
                  <div className={styles.fileList}>
                    <h4>推理框架支持</h4>
                    <div className={styles.modalMeta}>
                      {Object.entries(detailModel.backendSupport)
                        .filter(([k]) => !['deploy_task'].includes(k))
                        .map(([name, ver]) => (
                          <span key={name}>
                            {name}: {typeof ver === 'object' && ver ? Object.values(ver as Record<string, string>).join('/') : String(ver ?? '-')}
                          </span>
                        ))}
                    </div>
                  </div>
                )}
                {detailModel.readme && (
                  <details className={styles.fileList}>
                    <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 'var(--space-2)' }}>
                      模型说明 (README)
                    </summary>
                    <pre style={{
                      fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px',
                      overflow: 'auto', background: 'var(--color-surface-elevated)',
                      padding: 'var(--space-3)', borderRadius: 'var(--radius-md)',
                    }}>
                      {detailModel.readme}
                    </pre>
                  </details>
                )}
                {isAdmin && (
                  <button className={styles.btnSearch} style={{ marginTop: 'var(--space-3)' }}
                    onClick={() => handleDownload(detailModel)}>
                    下载此模型
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Published tab */}
      {activeTab === 'published' && (
        <div className={styles.publishedSection}>
          {publishedModels.length === 0 ? (
            <div className={styles.emptyHint}>暂无已发布模型，在「模型浏览」中下载并发布模型</div>
          ) : (
            <div className={styles.publishedGrid}>
              {publishedModels.map((model) => {
                const linked = publishedServices.filter((s) =>
                  s.modelName === model.name || s.modelPath === model.artifactUri
                );
                return (
                  <div key={model.id} className={styles.publishedCard}>
                    <div className={styles.publishedCardHeader}>
                      <div>
                        <div className={styles.publishedName}>{model.name}</div>
                        <div className={styles.publishedFamily}>{model.family} · {model.runtimeType} · {model.version || '-'}</div>
                      </div>
                    </div>
                    {model.artifactUri && (
                      <div className={styles.publishedPath}>{model.artifactUri}</div>
                    )}
                    {model.description && (
                      <div className={styles.publishedDesc}>{model.description}</div>
                    )}
                    <div className={styles.publishedFooter}>
                      <span className={styles.publishedSvcCount}>
                        {linked.length > 0
                          ? `${linked.length} 个服务实例: ${linked.map((s) => s.displayName).join(', ')}`
                          : '无服务实例'}
                      </span>
                      {linked.length === 0 && (
                        <button className={styles.publishedDeployBtn}
                          onClick={() => navigate(`/services?create=1&modelId=${model.id}`)}>
                          部署服务
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Compare Bar */}
      {compareList.length > 0 && (
        <div className={styles.compareBar}>
          <span className={styles.compareBarLabel}>已选 {compareList.length}/3:</span>
          {compareList.map((m) => (
            <span key={m.modelId} className={styles.compareChip}>
              {m.name}
              <button className={styles.compareChipRemove} onClick={() => toggleCompare(m)}>&times;</button>
            </span>
          ))}
          <button
            className={styles.btnSearch}
            disabled={compareList.length < 2}
            onClick={() => setShowCompare(true)}
          >
            开始对比
          </button>
          <button
            className={styles.btnPage}
            onClick={() => setCompareList([])}
          >
            清空
          </button>
        </div>
      )}

      {/* Compare Modal */}
      {showCompare && compareList.length >= 2 && (
        <CompareModal
          models={compareList}
          downloads={downloads}
          onClose={() => setShowCompare(false)}
          onDownload={handleDownload}
        />
      )}

      {/* Publish Modal */}
      {publishTarget && (
        <div className={styles.modalOverlay} onClick={() => setPublishTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>发布模型: {publishTarget.modelName}</h3>
              <button className={styles.modalClose} onClick={() => setPublishTarget(null)}>&times;</button>
            </div>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-3)' }}>
              将下载的模型发布到模型注册，并可选择自动创建模型服务。
            </p>
            <div className={styles.publishForm}>
              <h4>模型注册</h4>
              <div className={styles.formRow}>
                <label>运行类型</label>
                <select value={publishForm.runtimeType} onChange={(e) => setPublishForm({ ...publishForm, runtimeType: e.target.value })}>
                  <option value="gpu">GPU</option><option value="cpu">CPU</option>
                </select>
              </div>
              <div className={styles.formRow}>
                <label>版本</label>
                <input value={publishForm.version} onChange={(e) => setPublishForm({ ...publishForm, version: e.target.value })} />
              </div>
              <div className={styles.formRow}>
                <label>描述</label>
                <input value={publishForm.description} onChange={(e) => setPublishForm({ ...publishForm, description: e.target.value })} placeholder="可选" />
              </div>
              <h4 style={{ marginTop: 'var(--space-4)' }}>模型服务</h4>
              <div className={styles.formRow}>
                <label>自动创建</label>
                <input type="checkbox" checked={publishForm.createService} onChange={(e) => setPublishForm({ ...publishForm, createService: e.target.checked })} />
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>自动创建 vLLM 模型服务</span>
              </div>
              {publishForm.createService && (
                <>
                  <div className={styles.formRow}>
                    <label>端口</label>
                    <input type="number" value={publishForm.servicePort ?? ''} onChange={(e) => setPublishForm({ ...publishForm, servicePort: e.target.value ? Number(e.target.value) : null })} placeholder="自动分配" />
                  </div>
                  <div className={styles.formRow}>
                    <label>GPU</label>
                    <input value={publishForm.gpuDevice ?? ''} onChange={(e) => setPublishForm({ ...publishForm, gpuDevice: e.target.value || null })} placeholder="自动 (如 0, 1)" />
                  </div>
                  <div className={styles.formRow}>
                    <label>量化</label>
                    <select value={publishForm.quantization} onChange={(e) => setPublishForm({ ...publishForm, quantization: e.target.value })}>
                      <option value="auto">自动</option><option value="bf16">BF16</option>
                      <option value="awq">AWQ</option><option value="gptq">GPTQ</option>
                    </select>
                  </div>
                </>
              )}
              <div style={{ marginTop: 'var(--space-4)', display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
                <button className={styles.btnPage} onClick={() => setPublishTarget(null)}>取消</button>
                <button className={styles.btnPublish} disabled={publishing} onClick={handlePublish}>
                  {publishing ? '发布中...' : '确认发布'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm dialog */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="删除模型文件"
        confirmText={deleteLoading ? '删除中...' : '确认删除'}
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      >
        {deleteTarget && (
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
            <p style={{ marginBottom: 'var(--space-2)' }}>
              确认删除 <strong>{deleteTarget.modelName}</strong> 模型文件？
            </p>
            <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
              <li>删除本地文件，释放 {formatSize(deleteTarget.totalSize)} 磁盘空间</li>
              {deleteDeps.services.length > 0 && (
                <li>
                  关联引擎将一并删除：
                  {deleteDeps.services.map(s => s.name).join('、')}
                </li>
              )}
              <li>重新下载后可恢复使用</li>
            </ul>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
