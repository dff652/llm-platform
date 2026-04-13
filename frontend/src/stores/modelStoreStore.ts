import { create } from 'zustand';
import type { RemoteModel, ModelDownload } from '../types';
import {
  searchRemoteModels,
  listModelDownloads,
  createModelDownload,
  cancelModelDownload,
  retryModelDownload,
  publishDownloadedModel,
  ApiError,
} from '../services/api';
import { useUiStore } from './uiStore';
import type { PublishRequest } from '../types';

interface ModelStoreState {
  // Browse
  models: RemoteModel[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
  owner: string;
  source: 'modelscope' | 'huggingface';
  loading: boolean;

  // Downloads
  downloads: ModelDownload[];
  downloadsLoading: boolean;

  // Actions
  setQuery: (q: string) => void;
  setOwner: (o: string) => void;
  setPage: (p: number) => void;
  fetchModels: () => Promise<void>;
  fetchDownloads: () => Promise<void>;
  startDownload: (model: RemoteModel) => Promise<ModelDownload>;
  cancelDownload: (id: number) => Promise<void>;
  deleteDownload: (id: number) => Promise<void>;
  retryDownload: (id: number) => Promise<void>;
  publish: (downloadId: number, data: PublishRequest) => Promise<void>;
}

// Monotonic counter to discard stale search responses
let _searchSeq = 0;

export const useModelStoreStore = create<ModelStoreState>((set, get) => ({
  models: [],
  total: 0,
  page: 1,
  pageSize: 20,
  query: '',
  owner: 'Qwen',
  source: 'modelscope',
  loading: false,

  downloads: [],
  downloadsLoading: false,

  setQuery: (q) => set({ query: q }),
  setOwner: (o) => set({ owner: o }),
  setPage: (p) => set({ page: p }),

  fetchModels: async () => {
    const { source, query, owner, page, pageSize } = get();
    const seq = ++_searchSeq;
    set({ loading: true });
    try {
      const res = await searchRemoteModels({ source, query, owner, page, pageSize });
      // Discard if a newer request was fired while we were waiting
      if (seq !== _searchSeq) return;
      set({ models: res.items, total: res.total });
    } finally {
      if (seq === _searchSeq) {
        set({ loading: false });
      }
    }
  },

  fetchDownloads: async () => {
    try {
      const res = await listModelDownloads({ pageSize: 50 });
      set({ downloads: res.items });
    } catch {
      // Silently ignore polling failures
    }
  },

  startDownload: async (model) => {
    const { source } = get();
    try {
      const dl = await createModelDownload({
        source,
        modelId: model.modelId,
        modelName: model.name,
        modelFamily: model.owner.toLowerCase(),
        totalSize: model.storageSize,
      });
      await get().fetchDownloads();
      return dl;
    } catch (e) {
      const msg = e instanceof ApiError ? e.detail : '创建下载失败';
      useUiStore.getState().showToast({ type: 'error', message: msg });
      throw e;
    }
  },

  cancelDownload: async (id) => {
    try {
      await cancelModelDownload(id);
    } catch (e) {
      const msg = e instanceof ApiError ? e.detail : '操作失败';
      useUiStore.getState().showToast({ type: 'error', message: msg });
    }
    await get().fetchDownloads();
  },

  deleteDownload: async (id) => {
    try {
      await cancelModelDownload(id);
    } catch (e) {
      const msg = e instanceof ApiError ? e.detail : '删除失败';
      useUiStore.getState().showToast({ type: 'error', message: msg });
    }
    await get().fetchDownloads();
  },

  retryDownload: async (id) => {
    try {
      await retryModelDownload(id);
    } catch (e) {
      const msg = e instanceof ApiError ? e.detail : '重试失败';
      useUiStore.getState().showToast({ type: 'error', message: msg });
    }
    await get().fetchDownloads();
  },

  publish: async (downloadId, data) => {
    try {
      await publishDownloadedModel(downloadId, data);
    } catch (e) {
      const msg = e instanceof ApiError ? e.detail : '发布失败';
      useUiStore.getState().showToast({ type: 'error', message: msg });
      throw e;
    }
    await get().fetchDownloads();
  },
}));
