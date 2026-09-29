import type { JSX } from "react";
/**
 * 认证状态：启动时恢复令牌 → /auth/me 校验；登录/注册/登出统一入口
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, auth, clearToken, loadToken, saveToken, type PublicUser } from "./api";

interface AuthState {
  /** null = 未登录；undefined = 启动检查中 */
  user: PublicUser | null | undefined;
  token: string | null;
  loginPassword: (phone: string, password: string) => Promise<void>;
  loginCode: (phone: string, code: string) => Promise<void>;
  register: (phone: string, code: string, password: string, nickname?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 引导流程/资料修改后同步本地用户态 */
  updateUser: (u: PublicUser) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await loadToken();
      if (!saved) {
        setUser(null);
        return;
      }
      try {
        const me = await auth.me(saved);
        setToken(saved);
        setUser(me);
      } catch {
        await clearToken();
        setUser(null);
      }
    })();
  }, []);

  const value = useMemo<AuthState>(() => ({
    user,
    token,
    loginPassword: async (phone, password) => {
      const res = await auth.loginPassword(phone, password);
      await saveToken(res.token);
      setToken(res.token);
      setUser(res.user);
    },
    loginCode: async (phone, code) => {
      const res = await auth.loginCode(phone, code);
      await saveToken(res.token);
      setToken(res.token);
      setUser(res.user);
    },
    register: async (phone, code, password, nickname) => {
      const res = await auth.register(phone, code, password, nickname);
      await saveToken(res.token);
      setToken(res.token);
      setUser(res.user);
    },
    logout: async () => {
      if (token) await auth.logout(token).catch(() => undefined);
      await clearToken();
      setToken(null);
      setUser(null);
    },
    updateUser: (u) => setUser(u),
  }), [user, token]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return ctx;
}
