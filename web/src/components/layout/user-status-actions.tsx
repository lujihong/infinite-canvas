"use client";

import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { Dropdown, Tooltip } from "antd";
import { CreditCard, Keyboard, LogIn, LogOut, Moon, Receipt, Settings2, Shield, Sun, Zap } from "lucide-react";
import type { ItemType } from "antd/es/menu/interface";
import Link from "next/link";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { CreditSymbol } from "@/constant/credits";
import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { fetchUserWallet, type UserWalletInfo } from "@/services/api/auth";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useWalletStore } from "@/stores/use-wallet-store";
import { RechargeModal } from "@/components/wallet/recharge-modal";
import { ConsumptionLogsDrawer } from "@/components/wallet/consumption-logs-drawer";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    accountOpen?: boolean;
    onAccountOpenChange?: (open: boolean) => void;
    accountRef?: RefObject<HTMLDivElement | null>;
    getPopupContainer?: (node: HTMLElement) => HTMLElement;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, accountOpen, onAccountOpenChange, accountRef, getPopupContainer }: UserStatusActionsProps) {
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const user = useUserStore((state) => state.user);
    const token = useUserStore((state) => state.token);
    const logout = useUserStore((state) => state.clearSession);
    const openLoginModal = useUserStore((state) => state.openLoginModal);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canvasTheme = canvasThemes[theme];
    const userName = user?.displayName || user?.username || "用户";
    const avatarUrl = user?.avatarUrl?.trim();

    const wallet = useWalletStore((state) => state.wallet);
    const rechargeOpen = useWalletStore((state) => state.isRechargeOpen);
    const openRechargeModal = useWalletStore((state) => state.openRechargeModal);
    const closeRechargeModal = useWalletStore((state) => state.closeRechargeModal);
    const fetchWallet = useWalletStore((state) => state.fetchWallet);
    const [logsOpen, setLogsOpen] = useState(false);
    const [logsTab, setLogsTab] = useState<"consumption" | "recharge">("consumption");

    useEffect(() => {
        if (user && token) {
            void fetchWallet();
        }
    }, [user, token, fetchWallet]);
    
    // 统一各按钮与胶囊的高度、字号、圆角、盒模型及深浅主题视觉
    const actionBtnClass = "box-border inline-flex h-8 shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 rounded-lg border border-stone-200/80 bg-stone-100/70 px-2.5 text-xs font-medium leading-none text-stone-700 transition hover:bg-stone-200/80 hover:text-stone-950 dark:border-stone-700/60 dark:bg-stone-800/70 dark:text-stone-300 dark:hover:bg-stone-700/80 dark:hover:text-white [&_svg]:size-3.5";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    
    const handleLogout = () => {
        logout();
        if (typeof window !== "undefined") {
            window.location.href = "/login";
        }
    };

    const menuItems: ItemType[] = [
        { key: "user", disabled: true, label: <span className="font-medium text-current">{userName}</span> },
        ...(user ? [
            { key: "recharge", icon: <Zap className="size-4 text-amber-500" />, label: "算力充值", onClick: openRechargeModal },
            { key: "preferences", icon: <Settings2 className="size-4 text-stone-500" />, label: "偏好设置", onClick: () => openConfigDialog(false) },
            { key: "logs", icon: <Receipt className="size-4 text-sky-500" />, label: "扣费流水", onClick: () => { setLogsTab("consumption"); setLogsOpen(true); } },
            { key: "recharge-logs", icon: <CreditCard className="size-4 text-emerald-500" />, label: "充值记录", onClick: () => { setLogsTab("recharge"); setLogsOpen(true); } },
        ] : []),
        ...(user?.role === "admin" ? [{ key: "admin", icon: <Shield className="size-4" />, label: <Link href="/admin">管理后台</Link> }] : []),
        ...(onOpenShortcuts ? [{ key: "shortcuts", icon: <Keyboard className="size-4" />, label: "快捷键", onClick: onOpenShortcuts }] : []),
        { type: "divider" },
        { key: "logout", icon: <LogOut className="size-4" />, label: "退出登录", onClick: handleLogout },
    ];

    return (
        <div className="inline-flex shrink-0 items-center gap-2 leading-none">
            {/* 算力余额胶囊卡片与充值入口 */}
            {user ? (
                <button
                    type="button"
                    onClick={openRechargeModal}
                    className="box-border inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 text-xs font-semibold leading-none text-amber-700 transition hover:bg-amber-500/20 hover:border-amber-500/50 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-900/50 shadow-xs"
                    title={`当前可用算力：${wallet?.formattedPoints || (wallet ? `${(wallet.balanceYuan * (wallet.exchangeRate || 10)).toFixed(1)} 积分` : "0.0 积分")} (折合 ${wallet?.formattedBalance || "¥0.00"})\n点击查看算力详情与在线充值`}
                >
                    <Zap className="size-3.5 fill-amber-500 text-amber-500 shrink-0" />
                    <span className="font-mono font-bold tracking-tight">
                        {wallet?.formattedPoints || (wallet ? `${(wallet.balanceYuan * (wallet.exchangeRate || 10)).toFixed(1)} 积分` : "算力")}
                    </span>
                    <span className="hidden xl:inline text-[10px] font-medium opacity-70">
                        ({wallet?.formattedBalance || "¥0.00"})
                    </span>
                    <span className="rounded bg-amber-500/25 px-1 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-200 shrink-0">
                        充值
                    </span>
                </button>
            ) : null}

            {/* 偏好设置：统一只在登录后的用户头像下拉菜单中提供，未登录状态下不显示 */}
            
            <AnimatedThemeToggler
                theme={theme}
                onThemeChange={setTheme}
                className={actionBtnClass}
                style={iconStyle}
                aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            >
                {theme === "dark" ? <Sun className="size-3.5 text-amber-400 shrink-0" /> : <Moon className="size-3.5 text-stone-600 shrink-0" />}
                <span className="hidden lg:inline">{theme === "dark" ? "深色" : "浅色"}</span>
            </AnimatedThemeToggler>

            {!user && onOpenShortcuts ? (
                <button type="button" className={actionBtnClass} style={iconStyle} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                    <Keyboard className="size-3.5" />
                    <span>快捷键</span>
                </button>
            ) : null}

            {!user ? (
                <button
                    type="button"
                    onClick={openLoginModal}
                    className={cn(actionBtnClass, "font-semibold text-stone-900 hover:border-stone-400/80 dark:text-white dark:hover:border-stone-500/80")}
                    style={iconStyle}
                    aria-label="登录"
                    title="登录工作台"
                >
                    <LogIn className="size-3.5" />
                    <span>登录</span>
                </button>
            ) : null}

            {user ? (
                <div ref={accountRef} className="inline-flex items-center leading-none">
                    <Dropdown open={accountOpen} onOpenChange={onAccountOpenChange} trigger={["click"]} placement="bottomRight" getPopupContainer={getPopupContainer} styles={{ root: { minWidth: 150 } }} menu={{ items: menuItems }}>
                        <button
                            type="button"
                            className={cn(actionBtnClass, "gap-2 px-2")}
                            aria-label="账户菜单"
                        >
                            <img
                                src={avatarUrl || "/default-avatar.png"}
                                alt={userName}
                                className="size-[20px] shrink-0 rounded-full border border-stone-300/80 object-cover dark:border-stone-600"
                            />
                            <span className="max-w-[80px] truncate text-xs font-medium leading-none text-stone-800 dark:text-stone-200">
                                {userName}
                            </span>
                        </button>
                    </Dropdown>
                </div>
            ) : null}

            {/* 算力充值弹窗 */}
            <RechargeModal
                open={rechargeOpen}
                onClose={closeRechargeModal}
                onSuccess={() => void fetchWallet()}
                onOpenLogs={(tab) => {
                    setLogsTab(tab || "recharge");
                    setLogsOpen(true);
                }}
            />

            {/* 消费与充值记录抽屉 */}
            <ConsumptionLogsDrawer
                open={logsOpen}
                onClose={() => setLogsOpen(false)}
                initialTab={logsTab}
                onOpenRecharge={() => {
                    setLogsOpen(false);
                    openRechargeModal();
                }}
            />
        </div>
    );
}



