"use client";

import { useEffect, useMemo, useState } from "react";
import { Drawer, Empty, Input, Modal, Skeleton, Tag, message } from "antd";
import { CheckCircle2, Clock, Copy, CreditCard, Cpu, ExternalLink, FileText, Image as ImageIcon, Music2, Play, RefreshCw, Search, Video, Wallet, Zap } from "lucide-react";
import dayjs from "dayjs";

import { fetchUserConsumptionLogs, fetchUserRechargeLogs, type ConsumptionLogItem, type RechargeLogItem } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import { useWalletStore } from "@/stores/use-wallet-store";

type ConsumptionLogsDrawerProps = {
    open: boolean;
    onClose: () => void;
    initialTab?: "consumption" | "recharge";
    onOpenRecharge?: () => void;
};

export function ConsumptionLogsDrawer({ open, onClose, initialTab = "consumption", onOpenRecharge }: ConsumptionLogsDrawerProps) {
    const token = useUserStore((state) => state.token);
    const wallet = useWalletStore((state) => state.wallet);
    const [mainTab, setMainTab] = useState<"consumption" | "recharge">("consumption");
    
    // 消费记录状态
    const [logs, setLogs] = useState<ConsumptionLogItem[]>([]);
    const [loadingLogs, setLoadingLogs] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [category, setCategory] = useState<"all" | "image" | "video" | "audio" | "text">("all");
    const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);

    // 充值记录状态
    const [rechargeLogs, setRechargeLogs] = useState<RechargeLogItem[]>([]);
    const [loadingRecharge, setLoadingRecharge] = useState(false);

    const loadConsumptionLogs = async () => {
        if (!token) return;
        setLoadingLogs(true);
        try {
            const data = await fetchUserConsumptionLogs(token);
            setLogs(Array.isArray(data) ? data : []);
        } catch {
            // ignore
        } finally {
            setLoadingLogs(false);
        }
    };

    const loadRechargeLogs = async () => {
        if (!token) return;
        setLoadingRecharge(true);
        try {
            const data = await fetchUserRechargeLogs(token);
            setRechargeLogs(Array.isArray(data) ? data : []);
        } catch {
            // ignore
        } finally {
            setLoadingRecharge(false);
        }
    };

    const handleRefresh = () => {
        if (mainTab === "consumption") {
            void loadConsumptionLogs();
        } else {
            void loadRechargeLogs();
        }
    };

    useEffect(() => {
        if (open) {
            if (initialTab) {
                setMainTab(initialTab);
            }
            void loadConsumptionLogs();
            void loadRechargeLogs();
        }
    }, [open, initialTab, token]);

    // 消费分类与关键词过滤
    const filteredLogs = useMemo(() => {
        let list = logs;
        if (category !== "all") {
            list = list.filter((item) => {
                const name = (item.model_name || "").toLowerCase();
                const isImage = name.includes("image") || name.includes("flux") || name.includes("dall") || name.includes("midjourney") || name.includes("seedream");
                const isVideo = name.includes("video") || name.includes("seedance") || name.includes("kling") || name.includes("sora") || name.includes("hailuo") || name.includes("happyhouse") || name.includes("omni") || name.includes("minimax-h3");
                const isAudio = name.includes("music") || name.includes("audio") || name.includes("tts") || name.includes("voice") || name.includes("suno") || name.includes("speech");

                if (category === "image") return isImage;
                if (category === "video") return isVideo;
                if (category === "audio") return isAudio;
                return !isImage && !isVideo && !isAudio;
            });
        }
        const kw = keyword.trim().toLowerCase();
        if (kw) {
            list = list.filter((item) => (item.model_name || "").toLowerCase().includes(kw));
        }
        return list;
    }, [logs, category, keyword]);

    // 统计总积分净消耗（消费为加，失败退款 type===6 自动核减，真实反映实际净扣费）
    const totalPointsSpent = useMemo(() => {
        const sum = logs.reduce((acc, cur) => {
            if (cur.type === 6) {
                return acc - (cur.points_cost || 0);
            }
            return acc + (cur.points_cost || 0);
        }, 0);
        return Math.max(0, Math.round(sum * 100) / 100);
    }, [logs]);

    // 统计充值总额与总积分
    const { totalRechargedMoney, totalRechargedPoints, successfulRechargesCount } = useMemo(() => {
        let moneySum = 0;
        let pointsSum = 0;
        let count = 0;
        for (const item of rechargeLogs) {
            if (item.status === "success" || item.status === "SUCCESS") {
                moneySum += item.money || Number(item.amount) || 0;
                pointsSum += item.points || (item.money ? item.money * 10 : 0);
                count++;
            }
        }
        return {
            totalRechargedMoney: moneySum,
            totalRechargedPoints: pointsSum,
            successfulRechargesCount: count,
        };
    }, [rechargeLogs]);

    return (
        <Drawer
            open={open}
            onClose={onClose}
            title={
                <div className="flex items-center justify-between gap-3 pr-2">
                    <div className="flex items-center gap-2">
                        <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
                            <Zap className="size-4" />
                        </div>
                        <div>
                            <div className="text-base font-bold text-stone-900 dark:text-stone-100">
                                算力与充值明细中心
                            </div>
                            <div className="text-xs font-normal text-stone-400 dark:text-stone-500">
                                官方直连中转底座 · 100% 物理真实账本流水
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleRefresh}
                        className="cursor-pointer rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200 transition-colors"
                        title="刷新记录"
                    >
                        <RefreshCw className={`size-4 ${(loadingLogs || loadingRecharge) ? "animate-spin text-amber-500" : ""}`} />
                    </button>
                </div>
            }
            width={640}
            destroyOnClose
            className="consumption-logs-drawer"
        >
            <div className="flex flex-col h-full space-y-4">
                {/* 主功能 Tab 切换：任务扣费流水 vs 在线充值记录 */}
                <div className="flex items-center justify-between border-b border-stone-200/80 pb-3 dark:border-stone-800">
                    <div className="inline-flex rounded-xl border border-stone-200 bg-stone-100/70 p-1 dark:border-stone-700 dark:bg-stone-800/60 text-xs font-semibold">
                        <button
                            type="button"
                            onClick={() => setMainTab("consumption")}
                            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition cursor-pointer ${
                                mainTab === "consumption"
                                    ? "bg-white text-stone-900 shadow-xs dark:bg-stone-700 dark:text-white"
                                    : "text-stone-500 hover:text-stone-800 dark:hover:text-stone-300"
                            }`}
                        >
                            <Zap className="size-3.5 text-amber-500" />
                            <span>任务扣费流水</span>
                            {logs.length > 0 ? (
                                <span className="ml-1 rounded-full bg-stone-200/80 px-1.5 py-0.2 text-[10px] text-stone-600 dark:bg-stone-600 dark:text-stone-200">
                                    {logs.length}
                                </span>
                            ) : null}
                        </button>
                        <button
                            type="button"
                            onClick={() => setMainTab("recharge")}
                            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition cursor-pointer ${
                                mainTab === "recharge"
                                    ? "bg-white text-stone-900 shadow-xs dark:bg-stone-700 dark:text-white"
                                    : "text-stone-500 hover:text-stone-800 dark:hover:text-stone-300"
                            }`}
                        >
                            <CreditCard className="size-3.5 text-emerald-500" />
                            <span>在线充值记录</span>
                            {rechargeLogs.length > 0 ? (
                                <span className="ml-1 rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                                    {rechargeLogs.length}
                                </span>
                            ) : null}
                        </button>
                    </div>

                    {onOpenRecharge ? (
                        <button
                            type="button"
                            onClick={onOpenRecharge}
                            className="inline-flex items-center gap-1 rounded-lg bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-500/20 dark:text-amber-400 transition cursor-pointer"
                        >
                            <Zap className="size-3 fill-current" />
                            <span>去充值</span>
                        </button>
                    ) : null}
                </div>

                {mainTab === "consumption" ? (
                    <>
                        {/* 顶部消费统计卡片 */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="rounded-xl border border-stone-200/80 bg-stone-50/70 p-3.5 dark:border-stone-800 dark:bg-stone-900/60">
                                <div className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                                    <Wallet className="size-3.5 text-amber-500" />
                                    <span>当前可用算力余额</span>
                                </div>
                                <div className="mt-1.5 font-mono text-2xl font-bold text-stone-900 dark:text-stone-100">
                                    {wallet ? `${(wallet.balanceYuan * (wallet.exchangeRate || 10)).toFixed(1)} 积分` : "0.0 积分"}
                                </div>
                                <div className="mt-0.5 text-[11px] text-stone-400">
                                    折合 {wallet?.formattedBalance || "¥ 0.00"}
                                </div>
                            </div>

                            <div className="rounded-xl border border-stone-200/80 bg-stone-50/70 p-3.5 dark:border-stone-800 dark:bg-stone-900/60">
                                <div className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                                    <Clock className="size-3.5 text-blue-500" />
                                    <span>累计历史调用扣费</span>
                                </div>
                                <div className="mt-1.5 font-mono text-2xl font-bold text-stone-900 dark:text-stone-100">
                                    {totalPointsSpent} 积分
                                </div>
                                <div className="mt-0.5 text-[11px] text-stone-400">
                                    共计记录 {logs.length} 次生成调用
                                </div>
                            </div>
                        </div>

                        {/* 筛选与搜索 */}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200/80 pb-3 dark:border-stone-800/80">
                            <div className="inline-flex rounded-lg border border-stone-200 bg-stone-100/70 p-0.5 dark:border-stone-700 dark:bg-stone-800/60 text-xs">
                                {[
                                    { key: "all", label: "全部记录" },
                                    { key: "image", label: "图像生成", icon: ImageIcon },
                                    { key: "video", label: "视频渲染", icon: Video },
                                    { key: "audio", label: "音频音乐", icon: Music2 },
                                    { key: "text", label: "文本对话", icon: FileText },
                                ].map((tab) => (
                                    <button
                                        key={tab.key}
                                        type="button"
                                        onClick={() => setCategory(tab.key as typeof category)}
                                        className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition cursor-pointer ${
                                            category === tab.key
                                                ? "bg-white text-stone-900 shadow-xs dark:bg-stone-700 dark:text-white"
                                                : "text-stone-500 hover:text-stone-800 dark:hover:text-stone-300"
                                        }`}
                                    >
                                        {tab.icon ? <tab.icon className="size-3" /> : null}
                                        <span>{tab.label}</span>
                                    </button>
                                ))}
                            </div>

                            <div className="w-44">
                                <Input
                                    prefix={<Search className="size-3 text-stone-400" />}
                                    placeholder="搜索模型名称..."
                                    size="small"
                                    allowClear
                                    value={keyword}
                                    onChange={(e) => setKeyword(e.target.value)}
                                    className="!rounded-lg"
                                />
                            </div>
                        </div>

                        {/* 消费流水列表 */}
                        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                            {loadingLogs ? (
                                <div className="space-y-3 pt-2">
                                    <Skeleton active paragraph={{ rows: 3 }} />
                                    <Skeleton active paragraph={{ rows: 3 }} />
                                </div>
                            ) : filteredLogs.length > 0 ? (
                                filteredLogs.map((log) => {
                                    const name = (log.model_name || "").toLowerCase();
                                    const isImage = name.includes("image") || name.includes("flux") || name.includes("dall") || name.includes("midjourney");
                                    const isVideo = name.includes("video") || name.includes("seedance") || name.includes("kling") || name.includes("sora") || name.includes("omni") || name.includes("minimax-h3");
                                    const isAudio = name.includes("music") || name.includes("audio") || name.includes("tts") || name.includes("voice") || name.includes("suno");
                                    const timeStr = log.created_at ? dayjs(log.created_at * 1000).format("YYYY-MM-DD HH:mm:ss") : "-";
                                    const isRefund = log.type === 6;
                                    const isFreeOrZero = !isRefund && (log.points_cost || 0) <= 0;

                                    return (
                                        <div
                                            key={log.id}
                                            className={`flex flex-col gap-2 rounded-xl border p-3 transition-colors ${
                                                isRefund
                                                    ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/60 dark:border-emerald-500/30 dark:bg-emerald-950/20"
                                                    : "border-stone-200/80 bg-white hover:border-amber-400/60 dark:border-stone-800 dark:bg-stone-900/60"
                                            }`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <div
                                                        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                                                            isRefund
                                                                ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                                                                : isVideo
                                                                ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                                                                : isImage
                                                                ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                                                                : isAudio
                                                                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                                                                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                                        }`}
                                                    >
                                                        {isRefund ? (
                                                            <RefreshCw className="size-4" />
                                                        ) : isVideo ? (
                                                            <Video className="size-4" />
                                                        ) : isImage ? (
                                                            <ImageIcon className="size-4" />
                                                        ) : isAudio ? (
                                                            <Music2 className="size-4" />
                                                        ) : (
                                                            <Cpu className="size-4" />
                                                        )}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="truncate font-mono text-sm font-semibold text-stone-900 dark:text-stone-100 flex items-center gap-1.5">
                                                            <span>{log.model_name || "未指定模型"}</span>
                                                            {isRefund ? (
                                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-sans font-bold">
                                                                    退款入账
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                        <div className="text-[11px] text-stone-400">
                                                            {timeStr}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="text-right shrink-0">
                                                    <div className={`font-mono text-sm font-extrabold ${
                                                        isRefund || isFreeOrZero
                                                            ? "text-stone-400 dark:text-stone-500"
                                                            : "text-amber-600 dark:text-amber-400"
                                                    }`}>
                                                        {isRefund || isFreeOrZero ? "0.00 积分" : `-${log.formatted_points}`}
                                                    </div>
                                                    <div className="text-[11px] text-stone-400">
                                                        {isRefund ? "任务生成失败 · 实际扣费 0 积分 (已全额退还)" : isFreeOrZero ? "系统免扣费 / 免费体验" : `折合 ${log.formatted_money}`}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* 底部详细 Token 与响应数据 */}
                                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-2 text-[11px] text-stone-500 dark:border-stone-800/80 dark:text-stone-400">
                                                <div className="flex flex-wrap items-center gap-3 font-mono">
                                                    {log.prompt_tokens > 0 ? (
                                                        <span>输入: {log.prompt_tokens.toLocaleString()} Tokens</span>
                                                    ) : null}
                                                    {log.completion_tokens > 0 ? (
                                                        <span>输出: {log.completion_tokens.toLocaleString()} Tokens</span>
                                                    ) : null}
                                                    {log.use_time > 0 ? (
                                                        <span>耗时: {(log.use_time / 1000).toFixed(2)}s</span>
                                                    ) : null}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {isVideo && (log.video_url || log.task_id) ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                const targetUrl = log.video_url || `https://api.xybcloud.com/v1/videos/${log.task_id}/content?key=${token}`;
                                                                setPreviewVideoUrl(targetUrl);
                                                            }}
                                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20 text-[11px] font-medium transition cursor-pointer"
                                                        >
                                                            <Play className="size-3 fill-current" />
                                                            <span>播放视频</span>
                                                        </button>
                                                    ) : null}
                                                    <Tag color={isRefund ? "default" : isFreeOrZero ? "default" : "success"} className="!mr-0 !text-[10px]">
                                                        {isRefund ? "失败免扣费 (已退款)" : isFreeOrZero ? "免扣费" : "扣费成功"}
                                                    </Tag>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })
                            ) : (
                                <div className="py-16 text-center">
                                    <Empty description="暂无符合条件的扣费消费记录" />
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <>
                        {/* 顶部充值统计卡片 */}
                        <div className="grid grid-cols-3 gap-2.5">
                            <div className="rounded-xl border border-stone-200/80 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/60">
                                <div className="text-[11px] text-stone-500 dark:text-stone-400">累计成功充值</div>
                                <div className="mt-1 font-mono text-lg font-bold text-stone-900 dark:text-stone-100">
                                    ¥{totalRechargedMoney.toFixed(2)}
                                </div>
                            </div>
                            <div className="rounded-xl border border-stone-200/80 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/60">
                                <div className="text-[11px] text-stone-500 dark:text-stone-400">累计获得算力</div>
                                <div className="mt-1 font-mono text-lg font-bold text-emerald-600 dark:text-emerald-400">
                                    +{totalRechargedPoints.toFixed(1)} 积分
                                </div>
                            </div>
                            <div className="rounded-xl border border-stone-200/80 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/60">
                                <div className="text-[11px] text-stone-500 dark:text-stone-400">成功订单数</div>
                                <div className="mt-1 font-mono text-lg font-bold text-stone-900 dark:text-stone-100">
                                    {successfulRechargesCount} 笔
                                </div>
                            </div>
                        </div>

                        {/* 充值流水列表 */}
                        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                            {loadingRecharge ? (
                                <div className="space-y-3 pt-2">
                                    <Skeleton active paragraph={{ rows: 2 }} />
                                    <Skeleton active paragraph={{ rows: 2 }} />
                                </div>
                            ) : rechargeLogs.length > 0 ? (
                                rechargeLogs.map((item) => {
                                    const isSuccess = item.status === "success" || item.status === "SUCCESS";
                                    const isPending = item.status === "pending" || item.status === "PENDING";
                                    const createTimeStr = item.create_time ? dayjs(item.create_time * 1000).format("YYYY-MM-DD HH:mm:ss") : "-";
                                    const completeTimeStr = item.complete_time ? dayjs(item.complete_time * 1000).format("YYYY-MM-DD HH:mm:ss") : "-";

                                    return (
                                        <div
                                            key={item.id || item.trade_no}
                                            className="flex flex-col gap-2 rounded-xl border border-stone-200/80 bg-white p-3 hover:border-emerald-400/60 dark:border-stone-800 dark:bg-stone-900/60 transition-colors"
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-mono text-xs font-semibold text-stone-900 dark:text-stone-100 truncate">
                                                            {item.trade_no}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                void navigator.clipboard.writeText(item.trade_no);
                                                                message.success("订单号已复制");
                                                            }}
                                                            className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 transition cursor-pointer"
                                                            title="复制订单号"
                                                        >
                                                            <Copy className="size-3" />
                                                        </button>
                                                    </div>
                                                    <div className="mt-1 flex items-center gap-2 text-[11px] text-stone-400">
                                                        <span>创建：{createTimeStr}</span>
                                                        {isSuccess && item.complete_time > 0 ? (
                                                            <span>· 完成：{completeTimeStr}</span>
                                                        ) : null}
                                                    </div>
                                                </div>

                                                <div className="text-right shrink-0">
                                                    <div className="font-mono text-base font-extrabold text-emerald-600 dark:text-emerald-400">
                                                        +{item.points.toFixed(1)} 积分
                                                    </div>
                                                    <div className="text-xs font-semibold text-stone-600 dark:text-stone-400">
                                                        实付 ¥{(item.money || item.amount).toFixed(2)}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center justify-between border-t border-stone-100 pt-2 dark:border-stone-800/80">
                                                <div className="flex items-center gap-1.5">
                                                    <Tag color={item.payment_method === "alipay" ? "processing" : "success"} className="!mr-0 !text-[10px]">
                                                        {item.payment_name || "微信支付"}
                                                    </Tag>
                                                </div>
                                                <Tag color={isSuccess ? "success" : isPending ? "warning" : "error"} className="!mr-0 !text-[10px] font-medium">
                                                    {item.status_label || (isSuccess ? "充值成功" : isPending ? "等待支付" : "支付失败")}
                                                </Tag>
                                            </div>
                                        </div>
                                    );
                                })
                            ) : (
                                <div className="py-16 text-center space-y-3">
                                    <Empty description="暂无充值记录" />
                                    {onOpenRecharge ? (
                                        <button
                                            type="button"
                                            onClick={onOpenRecharge}
                                            className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-amber-600 transition cursor-pointer"
                                        >
                                            <Zap className="size-3.5 fill-current" />
                                            <span>立即在线充值</span>
                                        </button>
                                    ) : null}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* 视频播放预览弹窗 */}
            <Modal
                open={Boolean(previewVideoUrl)}
                onCancel={() => setPreviewVideoUrl(null)}
                footer={
                    <div className="flex items-center justify-between gap-2 pt-2">
                        <span className="text-xs text-stone-400 font-mono truncate max-w-xs">
                            {previewVideoUrl || ""}
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    if (previewVideoUrl) {
                                        void navigator.clipboard.writeText(previewVideoUrl);
                                        message.success("视频直链已复制");
                                    }
                                }}
                                className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800 transition cursor-pointer"
                            >
                                <Copy className="size-3.5" />
                                <span>复制直链</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    if (previewVideoUrl) {
                                        window.open(previewVideoUrl, "_blank");
                                    }
                                }}
                                className="inline-flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 transition cursor-pointer"
                            >
                                <ExternalLink className="size-3.5" />
                                <span>新标签页打开</span>
                            </button>
                        </div>
                    </div>
                }
                title={
                    <div className="flex items-center gap-2">
                        <Video className="size-4 text-purple-500" />
                        <span>视频预览与播放</span>
                    </div>
                }
                width={720}
                destroyOnClose
                centered
            >
                <div className="flex flex-col items-center justify-center p-2">
                    <div className="w-full aspect-video rounded-xl overflow-hidden bg-black flex items-center justify-center border border-stone-800 shadow-inner">
                        {previewVideoUrl ? (
                            <video
                                src={previewVideoUrl}
                                controls
                                autoPlay
                                playsInline
                                className="w-full h-full object-contain"
                            />
                        ) : null}
                    </div>
                </div>
            </Modal>
        </Drawer>
    );
}
