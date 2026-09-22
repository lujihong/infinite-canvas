"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, fetchCurrentUser, login, register, type AuthPayload, type AuthUser } from "@/services/api/auth";

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    isLoginModalOpen: boolean;
    openLoginModal: () => void;
    closeLoginModal: () => void;
    setSession: (token: string, user: AuthUser) => void;
    clearSession: () => void;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            isLoginModalOpen: false,
            openLoginModal: () => set({ isLoginModalOpen: true }),
            closeLoginModal: () => set({ isLoginModalOpen: false }),
            setSession: (token, user) => {
                const prevUser = get().user;
                if (prevUser && prevUser.id !== user.id) {
                    // 切换不同用户时，先重置旧用户的内存数据与钱包，并按新用户加载独立工程与配置
                    import("@/app/(user)/canvas/stores/use-canvas-store").then(({ useCanvasStore }) => useCanvasStore.getState().reset()).catch(() => {});
                    import("@/stores/use-asset-store").then(({ useAssetStore }) => useAssetStore.getState().reset()).catch(() => {});
                    import("@/stores/use-config-store").then(({ useConfigStore }) => useConfigStore.getState().loadUserConfig(user.id)).catch(() => {});
                    import("@/stores/use-editor-store").then(({ useEditorStore }) => useEditorStore.getState().loadUserProject(user.id)).catch(() => {});
                    import("@/components/layout/app-providers").then(({ appQueryClient }) => appQueryClient.clear()).catch(() => {});
                } else if (!prevUser) {
                    import("@/stores/use-config-store").then(({ useConfigStore }) => useConfigStore.getState().loadUserConfig(user.id)).catch(() => {});
                    import("@/stores/use-editor-store").then(({ useEditorStore }) => useEditorStore.getState().loadUserProject(user.id)).catch(() => {});
                }
                set({ token, user, isReady: true, isLoginModalOpen: false });
            },
            clearSession: () => {
                // 退出登录时，彻底重置所有业务 Store 内存、钱包与全局 Query 缓存
                import("@/app/(user)/canvas/stores/use-canvas-store").then(({ useCanvasStore }) => useCanvasStore.getState().reset()).catch(() => {});
                import("@/stores/use-asset-store").then(({ useAssetStore }) => useAssetStore.getState().reset()).catch(() => {});
                import("@/stores/use-config-store").then(({ useConfigStore }) => useConfigStore.getState().reset()).catch(() => {});
                import("@/stores/use-editor-store").then(({ useEditorStore }) => useEditorStore.getState().clearProject()).catch(() => {});
                import("@/services/image-storage").then(({ clearGuestStorageProviders }) => clearGuestStorageProviders()).catch(() => {});
                import("@/components/layout/app-providers").then(({ appQueryClient }) => appQueryClient.clear()).catch(() => {});
                set({ token: "", user: null, isReady: true });
            },
            hydrateUser: async () => {
                const token = get().token;
                if (!token) {
                    set({ user: null, isReady: true });
                    return;
                }
                set({ isLoading: true });
                try {
                    const user = await fetchCurrentUser(token);
                    if (user.role === "guest") {
                        set({ token: "", user: null, isReady: true, isLoading: false });
                        return;
                    }
                    set({ user, isReady: true, isLoading: false });
                } catch {
                    set({ token: "", user: null, isReady: true, isLoading: false });
                }
            },
            login: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await login(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            register: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await register(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
        }),
        {
            name: AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
