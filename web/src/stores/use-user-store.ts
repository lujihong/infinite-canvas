"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, fetchCurrentUser, login as requestLogin, register as requestRegister, type AuthPayload, type AuthUser } from "@/services/api/auth";
import { beginSessionTransition, canPersistSessionData, captureSessionIdentity, finishSessionTransition, initializeSessionIdentity, isSessionIdentityCurrent, type SessionIdentity } from "@/lib/session-identity";

type UserStore = {
    token: string; user: AuthUser | null; isReady: boolean; isLoading: boolean; isLoginModalOpen: boolean;
    openLoginModal: () => void; closeLoginModal: () => void;
    setSession: (token: string, user: AuthUser) => Promise<void>;
    clearSession: () => Promise<void>; hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>; register: (payload: AuthPayload) => Promise<AuthUser>;
};

let authOperation = 0;
let sessionTransition: Promise<void> = Promise.resolve();

async function transitionSession(token: string, user: AuthUser | null, expected?: number): Promise<void> {
    if (expected !== undefined && expected !== authOperation) return;
    const operation = ++authOperation;
    const snapshot = beginSessionTransition(token, user?.id || "");
    useUserStore.setState({ token, user, isReady: false, isLoading: false, isLoginModalOpen: false });
    const work = (async () => {
        try {
            const [{ useCanvasStore }, { useAssetStore }, { useConfigStore }, { useEditorStore }] = await Promise.all([
                import("@/app/(user)/canvas/stores/use-canvas-store"), import("@/stores/use-asset-store"),
                import("@/stores/use-config-store"), import("@/stores/use-editor-store"),
            ]);
            if (operation !== authOperation || !isSessionIdentityCurrent(snapshot)) return;
            const { appQueryClient } = await import("@/components/layout/app-providers");
            if (operation !== authOperation || !isSessionIdentityCurrent(snapshot)) return;
            appQueryClient.clear();
            useCanvasStore.getState().reset();
            useAssetStore.getState().reset();
            useConfigStore.getState().reset();
            useEditorStore.getState().clearProject();
            const { resetAgentSkillCache } = await import("@/stores/use-agent-skill-store");
            if (operation !== authOperation || !isSessionIdentityCurrent(snapshot)) return;
            resetAgentSkillCache();
            if (user) {
                useConfigStore.getState().loadUserConfig(user.id);
                useEditorStore.getState().loadUserProject(user.id);
                await Promise.all([useCanvasStore.persist.rehydrate(), useAssetStore.persist.rehydrate()]);
            } else {
                const { clearGuestStorageProviders } = await import("@/services/image-storage");
                if (operation !== authOperation || !isSessionIdentityCurrent(snapshot)) return;
                await clearGuestStorageProviders();
            }
            if (operation !== authOperation || !finishSessionTransition(snapshot)) return;
            useUserStore.setState({ isReady: true });
        } catch (error) {
            if (operation === authOperation && isSessionIdentityCurrent(snapshot)) {
                useUserStore.setState({ token: "", user: null, isReady: false, isLoading: false });
                const cleared = beginSessionTransition("", "");
                if (operation === authOperation) {
                    finishSessionTransition(cleared);
                    useUserStore.setState({ isReady: true });
                }
            }
            throw error;
        }
    })();
    sessionTransition = work;
    await work;
}

export const useUserStore = create<UserStore>()(persist((set, get) => ({
    token: "", user: null, isReady: false, isLoading: false, isLoginModalOpen: false,
    openLoginModal: () => set({ isLoginModalOpen: true }), closeLoginModal: () => set({ isLoginModalOpen: false }),
    setSession: (token, user) => transitionSession(token, user),
    clearSession: async () => { ++authOperation; await transitionSession("", null); await sessionTransition; },
    hydrateUser: async () => {
        if (!canPersistSessionData()) {
            await sessionTransition;
            return;
        }
        const token = get().token;
        const operation = ++authOperation;
        const existingUser = get().user;
        if (!token) { await transitionSession("", null, operation); return; }
        const initialIdentity = captureSessionIdentity();
        set({ isLoading: true });
        try {
            const user = await fetchCurrentUser(token);
            if (operation !== authOperation || !isSessionIdentityCurrent(initialIdentity)) return;
            if (user.role === "guest") { await transitionSession("", null, operation); return; }
            if (existingUser?.id === user.id && initialIdentity.userId === user.id) {
                if (operation === authOperation && isSessionIdentityCurrent(initialIdentity)) set({ user, isReady: true, isLoading: false });
                return;
            }
            await transitionSession(token, user, operation);
        } catch {
            if (operation === authOperation && isSessionIdentityCurrent(initialIdentity)) await transitionSession("", null, operation);
        }
    },
    login: async (payload) => {
        const operation = ++authOperation; set({ isLoading: true });
        try {
            const session = await requestLogin(payload);
            if (operation !== authOperation) throw new Error("登录已被更新的认证操作取代");
            await transitionSession(session.token, session.user, operation); return session.user;
        } catch (error) { if (operation === authOperation) set({ isLoading: false }); throw error; }
    },
    register: async (payload) => {
        const operation = ++authOperation; set({ isLoading: true });
        try {
            const session = await requestRegister(payload);
            if (operation !== authOperation) throw new Error("注册已被更新的认证操作取代");
            await transitionSession(session.token, session.user, operation); return session.user;
        } catch (error) { if (operation === authOperation) set({ isLoading: false }); throw error; }
    },
}), {
    name: AUTH_TOKEN_KEY,
    storage: createJSONStorage(() => ({
        getItem: (key) => typeof window === "undefined" ? null : window.localStorage.getItem(key),
        setItem: (key, value) => { if (typeof window !== "undefined" && canPersistSessionData()) window.localStorage.setItem(key, value); },
        removeItem: (key) => { if (typeof window !== "undefined" && !captureSessionIdentity().token) window.localStorage.removeItem(key); },
    })),
    partialize: (state) => ({ token: state.token }),
    onRehydrateStorage: () => (state) => { if (state) { state.isReady = false; initializeSessionIdentity(state.token, state.user?.id || ""); } },
}));

export type { SessionIdentity };
