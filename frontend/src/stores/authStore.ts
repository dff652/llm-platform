import { create } from 'zustand';
import { api, setToken, removeToken, getToken } from '../services/api';
import type { AuthUser, AuthResponse } from '../types';

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  initialized: boolean;

  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  initialize: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: getToken(),
  loading: false,
  initialized: false,

  login: async (username: string, password: string) => {
    set({ loading: true });
    try {
      const res = await api.post<AuthResponse>('/auth/login', { username, password });
      setToken(res.accessToken);
      set({ user: res.user, token: res.accessToken, loading: false });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  logout: () => {
    removeToken();
    set({ user: null, token: null });
  },

  initialize: async () => {
    if (get().initialized) return;
    const token = getToken();
    if (token) {
      try {
        const user = await api.get<AuthUser>('/auth/me');
        set({ user, token });
      } catch {
        removeToken();
        set({ user: null, token: null });
      }
    }
    set({ initialized: true });
  },
}));
