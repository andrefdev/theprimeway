import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import { router } from 'expo-router';
import type { User, LoginCredentials, RegisterData, AuthResponse } from '@shared/types/models';
import { AUTH } from '@shared/api/endpoints';
import { apiClient } from '@shared/api/client';
import { configureAuthSession } from '@shared/api/authSession';

type LoginResponse = AuthResponse | { requiresVerification: true; email: string };

const TOKEN_KEY = 'auth_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const USER_KEY = 'auth_user';

interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  loginWithOAuth: (provider: string, accessToken: string) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<void>;
  loadStoredAuth: () => Promise<void>;
  setUser: (user: User) => void;
  setTokens: (token: string, refreshToken?: string | null) => void;
}

let loadStoredAuthPromise: Promise<void> | null = null;

async function persistAuth(token: string, refreshToken?: string | null, user?: User | null) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  if (refreshToken) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
  }
  if (user) {
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  isAuthenticated: false,
  isLoading: true,

  login: async (credentials) => {
    try {
      const { data } = await apiClient.post<LoginResponse>(AUTH.LOGIN, credentials);
      if ('requiresVerification' in data) {
        router.replace({ pathname: '/(auth)/verify-otp', params: { email: data.email } });
        const err = new Error('verification_required') as Error & { code?: string };
        err.code = 'verification_required';
        throw err;
      } else {
        await persistAuth(data.token, data.refreshToken, data.user);
        set({ token: data.token, user: data.user, isAuthenticated: true });
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message =
          (error.response?.data as { error?: string } | undefined)?.error ?? error.message;
        console.warn('[AUTH] Login failed', { status });
        throw new Error(message);
      }
      throw error;
    }
  },

  loginWithOAuth: async (provider, token) => {
    // Native sign-in hands us a single token: for Apple it's the identity token
    // (server verifies it as `idToken`), for Google it's the id token (server
    // verifies it as `accessToken`/JWT). Send it in BOTH fields — same as the
    // web client — so either provider path on the server resolves it. Apple was
    // failing because only `accessToken` was sent and the server requires
    // `idToken` for Apple.
    const { data } = await apiClient.post<AuthResponse>(AUTH.OAUTH, {
      provider,
      accessToken: token,
      idToken: token,
    });
    await persistAuth(data.token, data.refreshToken, data.user);
    set({ token: data.token, user: data.user, isAuthenticated: true });
  },

  register: async (payload) => {
    const { data } = await apiClient.post<AuthResponse>(AUTH.REGISTER, payload);
    await persistAuth(data.token, data.refreshToken, data.user);
    set({ token: data.token, user: data.user, isAuthenticated: true });
  },

  logout: async () => {
    const token = get().token;
    try {
      if (token) {
        await apiClient.delete(AUTH.LOGOUT);
      }
    } catch {
      // Silently fail — we're logging out anyway
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
    set({ token: null, user: null, isAuthenticated: false });
  },

  refreshToken: async () => {
    try {
      const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
      if (!refreshToken) {
        await get().logout();
        return;
      }
      // Use raw axios to bypass interceptor and avoid recursion
      const { data } = await axios.post<AuthResponse>(
        `${process.env.EXPO_PUBLIC_API_URL}${AUTH.REFRESH}`,
        { refreshToken },
        { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
      );
      await persistAuth(data.token, data.refreshToken, data.user ?? get().user);
      set({
        token: data.token,
        user: data.user ?? get().user,
        isAuthenticated: true,
      });
    } catch {
      await get().logout();
    }
  },

  loadStoredAuth: async () => {
    const __t = Date.now();
    const __l = (m: string) => console.log(`[BOOT-AUTH +${Date.now() - __t}ms] ${m}`);
    __l('loadStoredAuth ENTER');
    if (loadStoredAuthPromise) {
      __l('loadStoredAuth: returning existing promise');
      return loadStoredAuthPromise;
    }
    loadStoredAuthPromise = (async () => {
      try {
        __l('before SecureStore.getItemAsync TOKEN_KEY');
        const token = await SecureStore.getItemAsync(TOKEN_KEY);
        __l(`after SecureStore.getItemAsync token=${token ? 'present' : 'null'}`);
        if (!token) {
          __l('no token → set isLoading=false');
          set({ isLoading: false });
          return;
        }
        // Hydrate token + cached user first, so the interceptor can attach the
        // token and the app has user data even if the network is unreachable.
        let cachedUser: User | null = null;
        try {
          const raw = await SecureStore.getItemAsync(USER_KEY);
          if (raw) cachedUser = JSON.parse(raw) as User;
        } catch {
          // ignore corrupt cache
        }
        set({ token, user: cachedUser });
        try {
          __l('before apiClient.get AUTH.ME');
          const { data } = await apiClient.get<{ user: User }>(AUTH.ME, {
            timeout: 8000,
          });
          __l('after apiClient.get AUTH.ME success');
          await SecureStore.setItemAsync(USER_KEY, JSON.stringify(data.user));
          set({ user: data.user, isAuthenticated: true, isLoading: false });
        } catch (e) {
          __l('apiClient.get AUTH.ME ERROR: ' + String((e as Error)?.message ?? e));
          const status = axios.isAxiosError(e) ? e.response?.status : undefined;
          const isAuthRejection = status === 401 || status === 403;
          if (isAuthRejection) {
            // Genuine auth failure: the interceptor already tried a token refresh
            // and it failed. The stored credentials are invalid — clear them.
            __l('AUTH.ME rejected auth (' + status + ') → clearing session');
            await SecureStore.deleteItemAsync(TOKEN_KEY);
            await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
            await SecureStore.deleteItemAsync(USER_KEY);
            set({ token: null, user: null, isAuthenticated: false, isLoading: false });
          } else {
            // No HTTP response (offline / timeout / server unreachable) or a
            // transient 5xx. The token is likely still valid — keep the stored
            // session instead of logging the user out. It is revalidated on the
            // next authenticated request; a real 401 there triggers refresh/logout.
            __l('AUTH.ME network/transient error → keeping stored session');
            set({ isAuthenticated: true, isLoading: false });
          }
        }
      } catch (e) {
        __l('outer catch: ' + String((e as Error)?.message ?? e));
        set({ isLoading: false });
      } finally {
        __l('loadStoredAuth FINALLY');
        loadStoredAuthPromise = null;
      }
    })();
    return loadStoredAuthPromise;
  },

  setUser: (user) => set({ user }),
  setTokens: (token, _refreshToken) => set({ token, isAuthenticated: true }),
}));

configureAuthSession({
  getToken: () => useAuthStore.getState().token,
  setTokens: (token, refreshToken) => useAuthStore.getState().setTokens(token, refreshToken),
  logout: () => useAuthStore.getState().logout(),
});
