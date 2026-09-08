"use client";

import { create } from "zustand";
import { fetchUserWallet, type UserWalletInfo } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

type WalletStore = {
    wallet: UserWalletInfo | null;
    isLoading: boolean;
    isRechargeOpen: boolean;
    fetchWallet: () => Promise<UserWalletInfo | null>;
    triggerWalletSync: (delayMs?: number) => void;
    openRechargeModal: () => void;
    closeRechargeModal: () => void;
    checkBalanceOrIntercept: (onZeroBalance?: () => void) => boolean;
};

export const useWalletStore = create<WalletStore>((set, get) => ({
    wallet: null,
    isLoading: false,
    isRechargeOpen: false,
    fetchWallet: async () => {
        const token = useUserStore.getState().token;
        if (!token) {
            set({ wallet: null, isLoading: false });
            return null;
        }
        set({ isLoading: true });
        try {
            const wallet = await fetchUserWallet(token);
            set({ wallet, isLoading: false });
            return wallet;
        } catch {
            set({ isLoading: false });
            return null;
        }
    },
    triggerWalletSync: (delayMs = 600) => {
        void get().fetchWallet();
        if (delayMs > 0) {
            setTimeout(() => {
                void get().fetchWallet();
            }, delayMs);
        }
    },
    openRechargeModal: () => set({ isRechargeOpen: true }),
    closeRechargeModal: () => set({ isRechargeOpen: false }),
    checkBalanceOrIntercept: (onZeroBalance) => {
        const { user, token, openLoginModal } = useUserStore.getState();
        if (!token || !user) {
            openLoginModal();
            return false;
        }
        const wallet = get().wallet;
        // 如果未加载钱包，则允许先尝试或根据当前余额判断
        if (wallet && wallet.quota <= 0) {
            set({ isRechargeOpen: true });
            onZeroBalance?.();
            return false;
        }
        return true;
    },
}));
