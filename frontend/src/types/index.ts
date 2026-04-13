// ===== Auth =====

export type Role = 'admin' | 'user';

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuthUser {
  id: number;
  username: string;
  displayName: string | null;
  role: Role;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: string;
  user: AuthUser;
}

// ===== LLM Service =====

export interface LLMService {
  id: number;
  name: string;
  displayName: string;
  endpoint: string;
  modelName: string | null;
  modelPath: string | null;
  gpuDevice: string | null;
  description: string | null;
  execCommand: string | null;
  workDir: string | null;
  extraEnv: Record<string, string> | null;
  status: 'enabled' | 'disabled';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceHealth {
  healthy: boolean;
  endpoint: string | null;
  models?: string[];
  error?: string | null;
}

// ===== Model =====

export type ModelStatus = 'active' | 'archived' | 'disabled';

export interface ModelEntity {
  id: number;
  name: string;
  family: string;
  runtimeType: string;
  version: string | null;
  artifactUri: string | null;
  baseModel: string | null;
  compatibility: Record<string, unknown> | null;
  metrics: Record<string, number> | null;
  tags: string[] | null;
  status: ModelStatus;
  description: string | null;
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ===== API Key =====

export interface ApiKey {
  id: number;
  name: string;
  keyPrefix: string;
  keyValue: string | null;
  userId: number;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyCreated {
  id: number;
  name: string;
  keyPrefix: string;
  key: string;
}

// ===== Dashboard =====

export interface DashboardOverview {
  services: number;
  todayRequests: number;
  todaySuccess: number;
  todayErrors: number;
  todayTokens: number;
  avgLatencyMs: number;
  activeKeys: number;
}

export interface RequestTrend {
  hour: string;
  count: number;
  success: number;
  error: number;
}

export interface ChatLogItem {
  id: number;
  requestId: string;
  model: string;
  endpointType: string;
  stream: boolean;
  status: string;
  apiKeyName: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  timeToFirstTokenMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

// ===== GPU =====

export interface GpuHardware {
  index: number;
  name: string;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryPct: number;
  utilizationPct: number;
  temperatureC: number;
  powerDrawW?: number;
  powerLimitW?: number;
}

// ===== Model Store =====

export interface RemoteModel {
  modelId: string;
  name: string;
  owner: string;
  description: string;
  downloads: number;
  stars: number;
  storageSize: number;
  license: string;
  tasks: string[];
  tags: string[];
  frameworks: string[];
  lastUpdated: string;
}

export type DownloadStatus = 'pending' | 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled';

export interface ModelDownload {
  id: number;
  source: string;
  modelId: string;
  modelName: string;
  modelFamily: string;
  status: DownloadStatus;
  progress: number;
  totalSize: number;
  downloadedSize: number;
  downloadPath: string | null;
  errorMessage: string | null;
  celeryTaskId: string | null;
  registeredModelId: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishRequest {
  runtimeType: string;
  version: string;
  description: string;
  createService: boolean;
  servicePort: number | null;
  gpuDevice: string | null;
  quantization: string;
}

export interface PublishResponse {
  modelId: number;
  modelName: string;
  message: string;
  serviceId?: number;
  serviceName?: string;
  endpoint?: string;
}

// ===== Common =====

export interface PaginatedResponse<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}
