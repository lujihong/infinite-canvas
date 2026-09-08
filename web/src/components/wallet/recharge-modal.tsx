"use client";

import { useEffect, useRef, useState } from "react";
import { App, Button, Modal, QRCode, Skeleton } from "antd";
import { CheckCircle2, CreditCard, Loader2, Receipt, Sparkles, Wallet, Zap } from "lucide-react";

import { checkRechargeStatus, createRechargeOrder, fetchUserWallet, type RechargeOrderResult, type UserWalletInfo } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

// 默认中转站标准汇率兜底：1 元人民币 = 10 积分（优先从中转站接口实时读取动态汇率）
const DEFAULT_EXCHANGE_RATE = 10;

const PRESET_AMOUNTS = [
    { value: 10, label: "¥10", desc: "日常尝鲜" },
    { value: 20, label: "¥20", desc: "轻度创作" },
    { value: 50, label: "¥50", desc: "热门推荐", tag: "热门" },
    { value: 100, label: "¥100", desc: "超值精选", tag: "特惠" },
    { value: 200, label: "¥200", desc: "专业制作" },
    { value: 500, label: "¥500", desc: "高阶工作室" },
];

export function RechargeModal({
    open,
    onClose,
    onSuccess,
    onOpenLogs,
}: {
    open: boolean;
    onClose: () => void;
    onSuccess?: () => void;
    onOpenLogs?: (tab?: "consumption" | "recharge") => void;
}) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);

    const [wallet, setWallet] = useState<UserWalletInfo | null>(null);
    const [loadingWallet, setLoadingWallet] = useState(false);

    const [selectedAmount, setSelectedAmount] = useState<number>(50);
    const [customAmount, setCustomAmount] = useState<string>("50");
    const [isCustom, setIsCustom] = useState(false);

    const [creatingOrder, setCreatingOrder] = useState(false);
    const [activeOrder, setActiveOrder] = useState<RechargeOrderResult | null>(null);
    const [isPaid, setIsPaid] = useState(false);

    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // 动态获取中转站配置的汇率（默认 7）
    const exchangeRate = wallet?.exchangeRate && wallet.exchangeRate > 0 ? wallet.exchangeRate : DEFAULT_EXCHANGE_RATE;

    // 计算当前选定金额对应积分（动态依据中转站汇率折算）
    const currentAmountNum = Math.max(1, parseInt(customAmount, 10) || selectedAmount || 1);
    const currentPoints = Math.round(currentAmountNum * exchangeRate * 100) / 100;

    // 加载用户当前钱包余额
    const loadWallet = async () => {
        if (!token) return;
        setLoadingWallet(true);
        try {
            const data = await fetchUserWallet(token);
            setWallet(data);
        } catch {
            // ignore
        } finally {
            setLoadingWallet(false);
        }
    };

    useEffect(() => {
        if (open) {
            loadWallet();
            setActiveOrder(null);
            setIsPaid(false);
        } else {
            if (pollTimerRef.current) {
                clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
            }
        }
    }, [open, token]);

    // 选择预设金额
    const handleSelectPreset = (amount: number) => {
        setSelectedAmount(amount);
        setCustomAmount(String(amount));
        setIsCustom(false);
        if (activeOrder) setActiveOrder(null);
    };

    // 自定义金额输入
    const handleCustomAmountChange = (val: string) => {
        const num = val.replace(/\D/g, "");
        setCustomAmount(num);
        const parsed = parseInt(num, 10);
        if (!isNaN(parsed)) {
            setSelectedAmount(parsed);
        }
        setIsCustom(true);
        if (activeOrder) setActiveOrder(null);
    };

    // 发起微信下单
    const handleStartPay = async () => {
        const amount = parseInt(customAmount, 10);
        if (isNaN(amount) || amount < 1) {
            message.warning("请输入有效的充值金额（最低 1 元）");
            return;
        }

        setCreatingOrder(true);
        try {
            const order = await createRechargeOrder(amount, token);
            setActiveOrder(order);
            setIsPaid(false);

            // 启动轮询检查支付状态
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = setInterval(async () => {
                try {
                    const status = await checkRechargeStatus(order.trade_no, token);
                    if (status.paid) {
                        if (pollTimerRef.current) {
                            clearInterval(pollTimerRef.current);
                            pollTimerRef.current = null;
                        }
                        setIsPaid(true);
                        message.success("支付成功！算力积分已实时到账");
                        loadWallet();
                        if (onSuccess) onSuccess();
                    }
                } catch {
                    // ignore network flicker
                }
            }, 1500);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建充值订单失败");
        } finally {
            setCreatingOrder(false);
        }
    };

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            centered
            width={480}
            destroyOnClose
            className="recharge-modal"
            styles={{
                body: {
                    maxHeight: "84vh",
                    overflowY: "auto",
                    padding: "4px 8px 12px",
                },
            }}
        >
            <div className="space-y-3.5">
                {/* 标题栏 */}
                <div className="flex items-center justify-between pb-3 border-b border-stone-200/80 dark:border-stone-800/80">
                    <div className="flex items-center gap-2">
                        <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
                            <Zap className="size-4" />
                        </div>
                        <div>
                            <h2 className="text-base font-bold tracking-tight text-stone-950 dark:text-stone-100">
                                算力充值中心
                            </h2>
                            <p className="text-[11px] text-stone-500 dark:text-stone-400">
                                官方直连通道 · 实时汇率 1元 = {exchangeRate}积分 · 两端秒级互通
                            </p>
                        </div>
                    </div>
                    {onOpenLogs ? (
                        <div className="flex items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => {
                                    onClose();
                                    onOpenLogs("recharge");
                                }}
                                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-50/70 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60 transition"
                                title="查看在线充值记录"
                            >
                                <CreditCard className="size-3 text-emerald-600 dark:text-emerald-400" />
                                <span>充值记录</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    onClose();
                                    onOpenLogs("consumption");
                                }}
                                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-stone-200/80 bg-stone-50 px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300 dark:hover:bg-stone-700 transition"
                                title="查看任务扣费流水明细"
                            >
                                <Receipt className="size-3 text-sky-500" />
                                <span>消费明细</span>
                            </button>
                        </div>
                    ) : null}
                </div>

                {/* 余额状态轻量展示条 */}
                <div className="flex items-center justify-between rounded-xl border border-stone-200/70 bg-gradient-to-r from-stone-50 to-stone-100/60 px-3.5 py-2.5 dark:border-stone-800/70 dark:from-stone-900/90 dark:to-stone-950/80">
                    <div className="flex items-center gap-2">
                        <Wallet className="size-4 text-amber-500" />
                        <span className="text-xs font-medium text-stone-600 dark:text-stone-400">账户当前可用算力</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                        {loadingWallet ? (
                            <Skeleton.Input active size="small" style={{ width: 90, height: 22 }} />
                        ) : (
                            <>
                                <span className="font-mono text-lg font-extrabold tracking-tight text-amber-600 dark:text-amber-400">
                                    {wallet?.formattedPoints || (wallet ? `${(wallet.balanceYuan * exchangeRate).toFixed(1)} 积分` : "0.0 积分")}
                                </span>
                                <span className="text-[11px] text-stone-400">
                                    ({wallet?.formattedBalance || "¥0.00"})
                                </span>
                            </>
                        )}
                    </div>
                </div>

                {/* 尚未生成订单：选择金额与支付方式 */}
                {!activeOrder ? (
                    <div className="space-y-3.5 pt-0.5">
                        {/* 预设面额选择 */}
                        <div>
                            <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                                <span>快捷面额选择</span>
                                <span className="text-[11px] font-normal text-amber-600 dark:text-amber-400 font-medium">
                                    1元 = {exchangeRate}积分
                                </span>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {PRESET_AMOUNTS.map((item) => {
                                    const isSelected = !isCustom && selectedAmount === item.value;
                                    const itemPoints = Math.round(item.value * exchangeRate);
                                    return (
                                        <button
                                            key={item.value}
                                            type="button"
                                            onClick={() => handleSelectPreset(item.value)}
                                            className={`relative flex flex-col items-center justify-center rounded-xl border-2 py-2 px-1 transition-all duration-150 cursor-pointer outline-none ${
                                                isSelected
                                                    ? "border-sky-500 bg-sky-500/10 text-sky-600 dark:border-sky-400 dark:bg-sky-950/40 dark:text-sky-300 shadow-xs"
                                                    : "border-stone-200/80 bg-white hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900/60 dark:hover:border-stone-700"
                                            }`}
                                        >
                                            {item.tag ? (
                                                <span className="absolute -top-2 -right-1 rounded-full bg-red-500 px-1.5 py-0.2 text-[9px] font-bold text-white shadow-xs">
                                                    {item.tag}
                                                </span>
                                            ) : null}
                                            <span className="font-mono text-sm font-bold text-stone-900 dark:text-stone-100">
                                                {item.label}
                                            </span>
                                            <span className="mt-0.5 font-mono text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                                                +{itemPoints} 积分
                                            </span>
                                            <span className="text-[10px] text-stone-400 dark:text-stone-500">
                                                {item.desc}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* 自定义金额输入 */}
                        <div>
                            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 flex items-center justify-between">
                                <span>自定义充值金额</span>
                                <span className="text-[11px] font-normal text-stone-400">最低 1 元起</span>
                            </div>
                            <div className="relative flex items-center">
                                <span className="absolute left-3 text-base font-bold text-stone-400 select-none pointer-events-none">
                                    ¥
                                </span>
                                <input
                                    type="text"
                                    value={customAmount}
                                    onChange={(e) => handleCustomAmountChange(e.target.value)}
                                    placeholder="输入任意整数金额"
                                    className="h-10 w-full rounded-xl border border-stone-200/80 bg-white pl-7 pr-24 font-mono text-base font-bold text-stone-900 transition-colors focus:border-sky-500 focus:outline-none dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100"
                                />
                                <div className="absolute right-3 text-xs font-semibold text-amber-600 dark:text-amber-400 pointer-events-none">
                                    +{currentPoints.toLocaleString()} 积分
                                </div>
                            </div>
                        </div>

                        {/* 付款方式选择 */}
                        <div>
                            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                                付款方式
                            </div>
                            <div className="rounded-xl border-2 border-emerald-500/50 bg-emerald-500/5 p-3 dark:border-emerald-500/40 dark:bg-emerald-950/20 shadow-xs">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-[#07C160] ring-1 ring-emerald-500/30">
                                            <svg className="size-5" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.295.295a.325.325 0 0 0 .167-.05l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.832.403c.276 0 .543-.027.81-.05-.858-2.593-.153-5.302 2.064-7.058 2.06-1.633 4.77-2.148 7.37-1.578-.853-3.328-4.99-6.05-10.192-6.05zm-2.457 4.09c.54 0 .977.438.977.978 0 .54-.437.977-.977.977-.54 0-.978-.437-.978-.977 0-.54.438-.978.978-.978zm4.914 0c.54 0 .977.438.977.978 0 .54-.437.977-.977.977-.54 0-.977-.437-.977-.977 0-.54.437-.978.977-.978zm6.544 3.273c-4.09 0-7.406 2.766-7.406 6.177 0 1.86.994 3.535 2.54 4.673.132.096.2.253.18.413l-.33 1.25c-.015.06-.04.12-.04.18 0 .138.11.25.25.25.05 0 .1-.016.14-.043l1.608-.94c.175-.102.383-.133.58-.083a8.58 8.58 0 0 0 2.478.35c4.09 0 7.406-2.766 7.406-6.177 0-3.411-3.316-6.177-7.406-6.177zm-2.046 3.447c.456 0 .825.37.825.826s-.37.825-.825.825c-.456 0-.825-.37-.825-.825s.37-.826.825-.826zm4.09 0c.456 0 .826.37.826.826s-.37.825-.826.825c-.455 0-.825-.37-.825-.825s.37-.826.825-.826z" />
                                            </svg>
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-sm font-bold text-stone-900 dark:text-stone-100">
                                                    微信支付
                                                </span>
                                                <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.2 text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
                                                    官方直连
                                                </span>
                                            </div>
                                            <p className="text-[11px] text-stone-500 dark:text-stone-400">
                                                使用手机微信扫码，极速充值到账
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white shadow-xs">
                                        <CheckCircle2 className="size-3.5" />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* 提交按钮 */}
                        <div className="pt-1">
                            <Button
                                type="primary"
                                block
                                size="large"
                                loading={creatingOrder}
                                onClick={handleStartPay}
                                className="!h-11 !rounded-xl !text-sm !font-bold"
                            >
                                立即充值 · 支付 ¥{currentAmountNum} 获得 {currentPoints.toLocaleString()} 积分
                            </Button>
                        </div>
                    </div>
                ) : (
                    /* 已生成微信支付二维码展示面板 */
                    <div className="mt-5 flex flex-col items-center justify-center text-center">
                        {!isPaid ? (
                            <>
                                <div className="flex items-center justify-center rounded-2xl border border-stone-200/80 bg-white p-4 shadow-md dark:border-stone-700">
                                    <QRCode
                                        value={activeOrder.qrcode || activeOrder.payurl}
                                        size={210}
                                        type="svg"
                                        color="#000000"
                                        bgColor="#ffffff"
                                        bordered={false}
                                    />
                                </div>

                                <div className="mt-4">
                                    <div className="flex items-center justify-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                                        <Loader2 className="size-3.5 animate-spin text-emerald-500" />
                                        <span>正在等待您在微信上确认支付...</span>
                                    </div>
                                    <div className="mt-1 flex items-baseline justify-center gap-2">
                                        <span className="font-mono text-2xl font-bold text-stone-900 dark:text-stone-100">
                                            ¥{activeOrder.amount}.00
                                        </span>
                                        <span className="font-mono text-sm font-semibold text-amber-600 dark:text-amber-400">
                                            (到账 {Math.round(activeOrder.amount * exchangeRate).toLocaleString()} 积分)
                                        </span>
                                    </div>
                                </div>

                                <div className="mt-4 w-full rounded-xl bg-stone-100 p-3 text-xs text-stone-500 dark:bg-stone-900 dark:text-stone-400">
                                    <div>订单号：<span className="font-mono text-stone-700 dark:text-stone-300">{activeOrder.trade_no}</span></div>
                                    <div className="mt-1">商户名称：鑫元宝云计算（重庆）有限责任公司</div>
                                </div>

                                <div className="mt-4 flex w-full gap-2">
                                    <Button
                                        block
                                        onClick={() => {
                                            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
                                            setActiveOrder(null);
                                        }}
                                    >
                                        更换金额
                                    </Button>
                                    <Button
                                        block
                                        type="primary"
                                        onClick={async () => {
                                            const status = await checkRechargeStatus(activeOrder.trade_no, token);
                                            if (status.paid) {
                                                setIsPaid(true);
                                                message.success("支付成功！");
                                                loadWallet();
                                            } else {
                                                message.info("暂未查询到微信到账，若已付款请等待数秒后刷新");
                                            }
                                        }}
                                    >
                                        我已完成支付
                                    </Button>
                                </div>
                            </>
                        ) : (
                            /* 支付完成成功页 */
                            <div className="py-8 text-center">
                                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                                    <CheckCircle2 className="size-10" />
                                </div>
                                <h3 className="mt-4 text-xl font-bold text-stone-900 dark:text-stone-100">
                                    支付成功，算力积分已到账！
                                </h3>
                                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                                    充值金额：¥{activeOrder.amount}.00 · 获得 {Math.round(activeOrder.amount * exchangeRate).toLocaleString()} 积分
                                </p>
                                <Button
                                    type="primary"
                                    size="large"
                                    className="mt-6 !rounded-xl !px-8"
                                    onClick={onClose}
                                >
                                    完成并关闭
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Modal>
    );
}
