"use client";

import { create } from "zustand";
import { fetchUserWallet, type UserWalletInfo } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import { isKnownPoints } from "@/lib/points";

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

let requestVersion = 0;
let identityVersion = 0;

export const useWalletStore = create<WalletStore>((set, get) => ({
    wallet: null,
    isLoading: false,
    isRechargeOpen: false,
    fetchWallet: async () => {
        const { token, user } = useUserStore.getState();
        const version = ++requestVersion;
        if (!token || !user) {
            set({ wallet: null, isLoading: false });
            return null;
        }
        const isCurrent = () => {
            const current = useUserStore.getState();
            return version === requestVersion && current.token === token && current.user?.id === user.id;
        };
        set({ isLoading: true });
        try {
            const wallet = await fetchUserWallet(token);
            if (!isCurrent()) return null;
            set({ wallet, isLoading: false });
            return wallet;
        } catch {
            if (isCurrent()) set({ wallet: null, isLoading: false });
            return null;
        }
    },
    triggerWalletSync: (delayMs = 600) => {
        const identity = identityVersion;
        void get().fetchWallet();
        if (delayMs > 0) {
            setTimeout(() => {
                if (identity === identityVersion) void get().fetchWallet();
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
        const points = get().wallet?.points;
        // Unknown balances defer to server billing; only a verified zero opens recharge.
        if (isKnownPoints(points) && points === 0) {
            set({ isRechargeOpen: true });
            onZeroBalance?.();
            return false;
        }
        return true;
    },
}));

// Invalidate synchronously, including logout, token rotation and A → B → A switches.
useUserStore.subscribe((current, previous) => {
    if (current.token === previous.token && current.user?.id === previous.user?.id) return;
    requestVersion++;
    identityVersion++;
    useWalletStore.setState({ wallet: null, isLoading: false, isRechargeOpen: false });
});
