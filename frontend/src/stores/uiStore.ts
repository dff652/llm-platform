import { create } from 'zustand';

export interface ToastData {
  message: string;
  type: 'success' | 'error';
  action?: { label: string; onClick: () => void };
}

interface UiState {
  toast: ToastData | null;
  toastTimer: ReturnType<typeof setTimeout> | null;

  showToast: (toast: ToastData) => void;
  hideToast: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  toast: null,
  toastTimer: null,

  showToast: (toast: ToastData) => {
    const prev = get().toastTimer;
    if (prev) clearTimeout(prev);

    const duration = toast.action ? 5000 : 3000;
    const timer = setTimeout(() => {
      set({ toast: null, toastTimer: null });
    }, duration);

    set({ toast, toastTimer: timer });
  },

  hideToast: () => {
    const prev = get().toastTimer;
    if (prev) clearTimeout(prev);
    set({ toast: null, toastTimer: null });
  },
}));
