/**
 * API client with JWT auth and snake_case ↔ camelCase conversion.
 */

// ===== Naming Convention Conversion =====

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// Keys whose values are arbitrary dicts — do NOT recurse into them for case conversion
const PASSTHROUGH_KEYS = new Set([
  'extraEnv', 'extra_env',
  'defaultParams', 'default_params',
  'labelDetail', 'label_detail',
  'dataSnapshot', 'data_snapshot',
  'incrementalConfig', 'incremental_config',
]);

function convertKeys(obj: unknown, converter: (s: string) => string): unknown {
  if (Array.isArray(obj)) return obj.map((item) => convertKeys(item, converter));
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, value]) => [
        converter(key),
        PASSTHROUGH_KEYS.has(key) ? value : convertKeys(value, converter),
      ]),
    );
  }
  return obj;
}

// ===== Token Management =====

const TOKEN_KEY = 'ts_platform_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ===== Fetch Wrapper =====

const BASE_URL = '/api/v1';

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | undefined>;
  responseType?: 'json' | 'text';
  timeout?: number;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

export interface WithHeaders<T> {
  data: T;
  headers: Headers;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, params, responseType = 'json', timeout = 30000 } = options;

  // Build URL with query params
  let url = `${BASE_URL}${path}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) searchParams.set(camelToSnake(key), String(value));
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  // Headers
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  // Convert request body keys to snake_case
  const processedBody = body ? JSON.stringify(convertKeys(body, camelToSnake)) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: processedBody,
      signal: controller.signal,
    });

    if (response.status === 401) {
      removeToken();
      window.location.href = '/login';
      throw new ApiError(401, 'Unauthorized');
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new ApiError(response.status, err.detail || response.statusText);
    }

    if (responseType === 'text') return (await response.text()) as T;

    // 204 No Content 等无响应体的情况
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }

    const data = await response.json();
    return convertKeys(data, snakeToCamel) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithHeaders<T>(
  path: string,
  options: RequestOptions = {},
): Promise<WithHeaders<T>> {
  const { method = 'GET', body, params, responseType = 'json', timeout = 30000 } = options;

  // Build URL with query params
  let url = `${BASE_URL}${path}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) searchParams.set(camelToSnake(key), String(value));
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  // Headers
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  // Convert request body keys to snake_case
  const processedBody = body ? JSON.stringify(convertKeys(body, camelToSnake)) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: processedBody,
      signal: controller.signal,
    });

    if (response.status === 401) {
      removeToken();
      window.location.href = '/login';
      throw new ApiError(401, 'Unauthorized');
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new ApiError(response.status, err.detail || response.statusText);
    }

    if (responseType === 'text') {
      return { data: (await response.text()) as T, headers: response.headers };
    }

    const data = await response.json();
    return { data: convertKeys(data, snakeToCamel) as T, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

// ===== Convenience Methods =====

export const api = {
  get: <T>(path: string, params?: Record<string, string | number | undefined>) =>
    request<T>(path, { params }),

  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body }),

  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body }),

  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body }),

  delete: <T>(path: string) =>
    request<T>(path, { method: 'DELETE' }),

  getText: (path: string, params?: Record<string, string | number | undefined>) =>
    request<string>(path, { params, responseType: 'text' }),

  getWithHeaders: <T>(path: string, params?: Record<string, string | number | undefined>) =>
    requestWithHeaders<T>(path, { params }),
};

export { ApiError };

// ===== Data Pool API =====

import type {
  PaginatedResponse,
  PoolItem,
  PoolStats,
  PoolVersion,
  BuildMode,
  FineTuneJob,
  ModelVersion,
  GpuGroup,
} from '../types';

/** 查询数据池条目（分页 + 筛选 + 按 ID 批量查询） */
export function listPoolItems(params: {
  page?: number;
  pageSize?: number;
  labelType?: string;
  status?: string;
  sourceType?: string;
  itemIds?: string;
}) {
  return api.get<PaginatedResponse<PoolItem>>('/pool/items', params);
}

/** 获取数据池全局统计 */
export function fetchPoolStats() {
  return api.get<PoolStats>('/pool/stats');
}

/** 获取单个条目详情 */
export function getPoolItem(id: number) {
  return api.get<PoolItem>(`/pool/items/${id}`);
}

/** 创建数据池条目 (admin) */
export function createPoolItem(data: {
  pointName: string;
  sourceTaskId?: string;
  sourceType?: string;
  labelType?: string;
  labelDetail?: Record<string, unknown>;
  dataSnapshot?: Record<string, unknown>;
  dataPath?: string;
  segments?: Record<string, unknown>;
  score?: number;
}) {
  return api.post<PoolItem>('/pool/items', data);
}

/** 更新数据池条目 */
export function updatePoolItem(id: number, data: {
  labelType?: string;
  labelDetail?: Record<string, unknown>;
  status?: 'available' | 'used' | 'archived';
}) {
  return api.put<PoolItem>(`/pool/items/${id}`, data);
}

/** 查询版本快照列表（分页） */
export function listPoolVersions(params: {
  page?: number;
  pageSize?: number;
}) {
  return api.get<PaginatedResponse<PoolVersion>>('/pool/versions', params);
}

/** 获取版本详情 */
export function getPoolVersion(id: number) {
  return api.get<PoolVersion>(`/pool/versions/${id}`);
}

/** 创建版本（快照或增量） */
export function createPoolVersion(data: {
  name: string;
  type: 'training' | 'validation' | 'inference';
  description?: string;
  itemIds?: number[];
  format?: string;
  buildMode?: BuildMode;
  incrementalConfig?: { sourceFilter: string[]; labelFilter: string[]; threshold: number };
}) {
  return api.post<PoolVersion>('/pool/versions', data);
}

/** 手动同步增量版本 */
export function syncPoolVersion(id: number) {
  return api.post<PoolVersion>(`/pool/versions/${id}/sync`);
}

/** 更新版本元数据（名称、类型、描述） */
export function updatePoolVersion(id: number, data: {
  name?: string;
  type?: 'training' | 'validation' | 'inference';
  description?: string;
}) {
  return api.put<PoolVersion>(`/pool/versions/${id}`, data);
}

/** 从数据集中移除指定条目（仅管理员） */
export function removeVersionItems(id: number, itemIds: number[]) {
  return api.post<PoolVersion>(`/pool/versions/${id}/remove-items`, { itemIds });
}

/** 向数据集追加条目，自动去重（仅管理员） */
export function addVersionItems(id: number, itemIds: number[]) {
  return api.post<PoolVersion>(`/pool/versions/${id}/add-items`, { itemIds });
}

/** 删除数据集（仅管理员） */
export function deletePoolVersion(id: number) {
  return api.delete<void>(`/pool/versions/${id}`);
}

// ===== Fine-tune API (微调任务) =====

/** 查询 GPU 组实时状态 */
export function fetchGpuGroups() {
  return api.get<GpuGroup[]>('/finetune/gpu-groups');
}

/** 创建并触发微调任务（仅管理员） */
export function triggerFineTune(data: {
  modelId: number;
  configId: number;
  trainingVersionId: number;
  validationVersionId?: number;
  gpuGroup?: string;
}) {
  return api.post<FineTuneJob>('/finetune/jobs', data);
}

/** 查询微调任务列表 */
export function listFineTuneJobs(params: {
  modelId?: number;
  page?: number;
  pageSize?: number;
}) {
  return api.get<PaginatedResponse<FineTuneJob>>('/finetune/jobs', params);
}

/** 获取微调任务详情 */
export function getFineTuneJob(jobId: number) {
  return api.get<FineTuneJob>(`/finetune/jobs/${jobId}`);
}

/** 取消微调任务（仅管理员） */
export function cancelFineTuneJob(jobId: number) {
  return api.post<FineTuneJob>(`/finetune/jobs/${jobId}/cancel`);
}

// ===== Model Version API (模型版本) =====

/** 获取模型版本列表 */
export function listModelVersions(modelId: number) {
  return api.get<ModelVersion[]>(`/models/${modelId}/versions`);
}

/** 激活指定模型版本（回滚） */
export function activateModelVersion(modelId: number, versionId: number) {
  return api.post<ModelVersion>(`/models/${modelId}/versions/${versionId}/activate`);
}

// ===== Model Store API (模型商店) =====

import type {
  RemoteModel,
  RemoteModelDetail,
  ModelDownload,
  PublishRequest,
  PublishResponse,
} from '../types';

/** 检查磁盘空间 */
export function checkDiskSpace() {
  return api.get<{ total: number; used: number; free: number; downloadDir: string }>(
    '/model-store/disk-space',
  );
}

/** 修改下载路径 */
export function updateDownloadDir(downloadDir: string) {
  return api.put<{ total: number; used: number; free: number; downloadDir: string }>(
    '/model-store/disk-space',
    { downloadDir },
  );
}

/** 浏览服务器目录 */
export function browseDirs(path: string) {
  return api.get<{ current: string; parent: string | null; dirs: Array<{ name: string; path: string }> }>(
    '/model-store/browse-dirs',
    { path },
  );
}

/** 搜索远程模型 */
export function searchRemoteModels(params: {
  source?: string;
  query?: string;
  owner?: string;
  page?: number;
  pageSize?: number;
}) {
  return api.get<{ total: number; page: number; pageSize: number; items: RemoteModel[] }>(
    '/model-store/models',
    params,
  );
}

/** 获取远程模型详情 */
export function getRemoteModelDetail(source: string, modelId: string) {
  return api.get<RemoteModelDetail>(`/model-store/models/${source}/${modelId}`);
}

/** 获取下载列表 */
export function listModelDownloads(params?: { page?: number; pageSize?: number; status?: string }) {
  return api.get<{ total: number; items: ModelDownload[] }>('/model-store/downloads', params);
}

/** 创建下载任务 */
export function createModelDownload(data: {
  source: string;
  modelId: string;
  modelName: string;
  modelFamily: string;
  totalSize: number;
}) {
  return api.post<ModelDownload>('/model-store/downloads', data);
}

/** 获取单个下载状态 */
export function getModelDownload(downloadId: number) {
  return api.get<ModelDownload>(`/model-store/downloads/${downloadId}`);
}

/** 取消/删除下载 */
export function cancelModelDownload(downloadId: number) {
  return api.delete<void>(`/model-store/downloads/${downloadId}`);
}

/** 重试失败的下载（断点续传） */
export function retryModelDownload(downloadId: number) {
  return api.post<ModelDownload>(`/model-store/downloads/${downloadId}/retry`);
}

/** 发布模型到模型中心（含可选部署引擎） */
export function publishDownloadedModel(downloadId: number, data: PublishRequest) {
  return api.post<PublishResponse>(`/model-store/downloads/${downloadId}/publish`, data);
}

/** 发布本地模型目录到模型中心 */
export function publishLocalModel(data: {
  path: string;
  name?: string;
  family?: string;
  runtimeType?: string;
  version?: string;
  description?: string;
  createService?: boolean;
  servicePort?: number | null;
  gpuDevice?: string | null;
}) {
  return api.post<{
    model: { id: number; name: string; family: string; artifactUri: string; status: string };
    modelType: string;
    serviceCreated: boolean;
    serviceId: number | null;
  }>('/models/publish', data);
}

/** 查询下载的关联依赖（模型注册、引擎） */
export function getDownloadDependencies(downloadId: number) {
  return api.get<{
    model: { id: number; name: string } | null;
    services: { id: number; name: string; endpoint: string }[];
  }>(`/model-store/downloads/${downloadId}/dependencies`);
}

/** 查询模型的关联依赖（引擎、下载记录） */
export function getModelDependencies(modelId: number) {
  return api.get<{
    model: { id: number; name: string };
    services: { id: number; name: string; endpoint: string }[];
    download: { id: number; path: string; size: number } | null;
  }>(`/models/${modelId}/dependencies`);
}

/** 彻底删除模型（注册+引擎，可选删文件） */
export function deleteModel(modelId: number, deleteFiles: boolean = false) {
  return api.delete<void>(`/models/${modelId}?deleteFiles=${deleteFiles}`);
}

// ─── Data Sources ────────────────────────────────────────

export interface DataSourceItem {
  id: number;
  name: string;
  type: string;
  connectionConfig: Record<string, unknown>;
  status: string;
  lastCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataSourceTestResult {
  success: boolean;
  message: string;
  latencyMs: number;
}

export function listDataSources(params?: { page?: number; pageSize?: number }) {
  return api.get<{ total: number; page: number; pageSize: number; items: DataSourceItem[] }>(
    '/data-sources', params,
  );
}

export function createDataSource(data: {
  name: string;
  type: string;
  connectionConfig: Record<string, unknown>;
}) {
  return api.post<DataSourceItem>('/data-sources', data);
}

export function updateDataSource(id: number, data: Partial<{
  name: string;
  type: string;
  connectionConfig: Record<string, unknown>;
  status: string;
}>) {
  return api.put<DataSourceItem>(`/data-sources/${id}`, data);
}

export function deleteDataSource(id: number) {
  return api.delete(`/data-sources/${id}`);
}

export function testDataSource(id: number) {
  return api.post<DataSourceTestResult>(`/data-sources/${id}/test`);
}

// ─── System Config ────────────────────────────────────────

export interface SystemConfigItem {
  key: string;
  value: string;
  description: string | null;
}

export function getSystemConfigs() {
  return api.get<SystemConfigItem[]>('/system-config');
}

export function updateSystemConfigs(configs: Array<{ key: string; value: string }>) {
  return api.put<{ updated: number }>('/system-config', { configs });
}

export function getSystemLogs(params?: { source?: string; tail?: number; keyword?: string; level?: string }) {
  return api.getText('/system-logs', params);
}

export function getLogSources() {
  return api.get<Array<{ name: string; label: string; exists: boolean; size: number }>>('/system-logs/sources');
}

export function clearSystemLog(source: string) {
  return api.delete<{ cleared: string }>(`/system-logs?source=${source}`);
}

export interface PerfStats {
  hours: number;
  total: number;
  byStatus: Record<string, number>;
  stats: { avg?: number; p50?: number; p95?: number; min?: number; max?: number };
  byAlgorithm: Record<string, { count: number; avg: number; p95: number }>;
  byHour: Array<{ hour: string; count: number; success: number; failed: number; avgDuration: number }>;
  recent: Array<{ id: string; algorithm: string; status: string; duration: number | null; source: string; completedAt: string | null }>;
}

export function getPerfStats(hours?: number) {
  return api.get<PerfStats>('/system-logs/perf-stats', hours ? { hours } : {});
}

export interface ConcurrencyStatus {
  gpu: { running: number; limit: number; queued: number };
  cpu: { running: number; limit: number; queued: number };
}

export function getConcurrencyStatus() {
  return api.get<ConcurrencyStatus>('/dashboard/concurrency-status');
}

export interface BrowseNode {
  path: string;
  name?: string;
  type: 'storage_groups' | 'group' | 'device' | 'empty';
  children?: BrowseNode[];
  measurements?: string[];
}

export function browseDataSource(id: number, path?: string) {
  return api.get<BrowseNode>(`/data-sources/${id}/browse`, path ? { path } : {});
}

export interface PointInfo {
  measurement: string;
  device: string;
  dataType?: string;
  count?: number;
  minTime?: string;
  maxTime?: string;
}

export function getPointInfo(dsId: number, device: string, measurement: string) {
  return api.get<PointInfo>(`/data-sources/${dsId}/point-info`, { device, measurement });
}

export interface PreviewData {
  times: string[];
  values: number[];
  count: number;
  measurement: string;
}

export function importConfigAsDatasets(dsId: number, data: {
  namePrefix?: string;
  type?: string;
  config: Record<string, { columns?: string[]; st?: string; et?: string }>;
}) {
  return api.post<{ created: number; skipped: number; versions: Array<{ versionId: number; name: string; device: string; itemCount: number }> }>(
    `/data-sources/${dsId}/import-config`, data,
  );
}

export function createDatasetFromIoTDB(dsId: number, data: {
  name: string;
  type: string;
  device: string;
  measurements: string[];
  startTime?: string;
  endTime?: string;
}) {
  return api.post<{ versionId: number; name: string; itemCount: number }>(`/data-sources/${dsId}/create-dataset`, data);
}

export function previewPointData(dsId: number, device: string, measurement: string, start?: string, end?: string, n?: number) {
  const params: Record<string, string | number> = { device, measurement };
  if (start) params.start = start;
  if (end) params.end = end;
  if (n) params.n = n;
  return api.get<PreviewData>(`/data-sources/${dsId}/preview`, params);
}
