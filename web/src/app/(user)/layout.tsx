"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "antd";
import { LogIn } from "lucide-react";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";

const PROTECTED_PAGE_NAMES: Record<string, string> = {
    "/canvas": "我的画布",
    "/image": "生图工作台",
    "/video": "视频创作台",
    "/editor": "视频剪辑",
    "/assets": "我的素材",
    "/asset-library": "素材库",
    "/workflows": "创意工作流",
};

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const openLoginModal = useUserStore((state) => state.openLoginModal);
    const wasLoggedOutRef = useRef(false);

    const protectedEntry = Object.entries(PROTECTED_PAGE_NAMES).find(
        ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
    const isProtectedPage = Boolean(protectedEntry);
    const currentSectionName = protectedEntry ? protectedEntry[1] : "创作板块";

    // 未登录访问受保护的创作板块时，自动弹出登录提示弹窗
    useEffect(() => {
        if (!isReady) return;
        if (isProtectedPage && !user) {
            openLoginModal();
        }
    }, [isProtectedPage, isReady, user, openLoginModal]);

    useEffect(() => {
        if (!isReady) return;
        if (!user) {
            wasLoggedOutRef.current = true;
            return;
        }
        const syncCanvasAfterLogin = wasLoggedOutRef.current;
        const token = useUserStore.getState().token;
        if (!token) return;
        wasLoggedOutRef.current = false;
        fetchUserConfig(token).then(async (config) => {
            const syncEnabled = config.syncCapabilities?.userData === true;
            const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
            const canvasStore = useCanvasStore.getState();
            canvasStore.setSyncEnabled(syncEnabled);
            if (
                syncCanvasAfterLogin &&
                syncEnabled &&
                canvasStore.hydrated
            ) {
                void canvasStore.syncWithRemote(token, true);
            }
            const { useAssetStore } = await import("@/stores/use-asset-store");
            void useAssetStore.getState().hydrateAccountAssets(token, syncEnabled);
        }).catch(() => { });
    }, [isReady, user]);

    // 账号水合验证过程中，若访问受保护板块先进行平滑加载过渡，防止闪烁
    if (isProtectedPage && !isReady) {
        return (
            <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
                <AppTopNav />
                <div className="min-h-0 flex-1 flex items-center justify-center bg-stone-950 text-stone-400 select-none">
                    <div className="flex items-center gap-3">
                        <div className="size-5 animate-spin rounded-full border-2 border-stone-700 border-t-amber-500" />
                        <span className="text-xs font-medium">正在验证账号状态...</span>
                    </div>
                </div>
            </div>
        );
    }

    // 未登录或手动退出登录后，受保护板块绝对禁止访问，直接拦截并展示登录提示卡片，底层组件严禁挂载
    if (isProtectedPage && !user) {
        return (
            <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
                <AppTopNav />
                <div className="min-h-0 flex-1 flex items-center justify-center p-6 bg-stone-950 text-stone-200 select-none">
                    <div className="max-w-md w-full p-8 rounded-3xl bg-stone-900 border border-stone-800 shadow-2xl flex flex-col items-center text-center gap-4 animate-in fade-in zoom-in-95 duration-200">
                        <div className="size-16 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-inner">
                            <LogIn className="size-8" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-stone-100 tracking-tight">
                                请登录后使用{currentSectionName}
                            </h2>
                            <p className="text-xs text-stone-400 leading-relaxed mt-2">
                                「{currentSectionName}」属于个人专属创作空间，依赖账号权限与算力服务。账号退出后无法访问，请登录账号后继续使用。
                            </p>
                        </div>
                        <div className="flex items-center gap-3 mt-3 w-full">
                            <Button
                                type="primary"
                                icon={<LogIn className="size-4" />}
                                onClick={openLoginModal}
                                className="flex-1 !h-11 !rounded-xl !bg-amber-500 hover:!bg-amber-400 !text-stone-950 !font-bold !border-none text-sm shadow-md"
                            >
                                立即登录
                            </Button>
                            <Button
                                onClick={() => {
                                    window.location.href = "/";
                                }}
                                className="flex-1 !h-11 !rounded-xl !bg-stone-800 hover:!bg-stone-700 !border-stone-700 !text-stone-300 hover:!text-white text-sm"
                            >
                                返回首页
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <AppTopNav />
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
    );
}
