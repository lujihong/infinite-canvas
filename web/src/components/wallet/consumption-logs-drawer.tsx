"use client";

import { useEffect, useMemo, useState } from "react";
import { Drawer, Empty, Input, Modal, Skeleton, Tag, message } from "antd";
import {
    AlertCircle,
    CheckCircle2,
    Clock,
    Copy,
    CreditCard,
    Cpu,
    ExternalLink,
    FileText,
    HelpCircle,
    Image as ImageIcon,
    Info,
    Music2,
    Play,
    RefreshCw,
    Search,
    Video,
    Wallet,
    XCircle,
    Zap
} from "lucide-react";
import dayjs from "dayjs";

import {
    checkRechargeStatus,
    fetchUserConsumptionLogs,
    fetchUserRechargeLogs,
    type ConsumptionLogItem,
    type RechargeLogItem
} from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import { useWalletStore } from "@/stores/use-wallet-store";

type ConsumptionLogsDrawerProps = {
    open: boolean;
    onClose: () => void;
    initialTab?: "consumption" | "recharge";
    onOpenRecharge?: () => void;
};

export function ConsumptionLogsDrawer({
    open,
    onClose,
    initialTab = "consumption",
    onOpenRecharge
}: ConsumptionLogsDrawerProps) {
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const wallet = useWalletStore((state) => state.wallet);
    const [mainTab, setMainTab] = useState<"consumption" | "recharge">("consumption");

    // 消费记录状态（严格单用户隔离）
    const [logs, setLogs] = useState<ConsumptionLogItem[]>([]);
    const [loadingLogs, setLoadingLogs] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [category, setCategory] = useState<"all" | "image" | "video" | "audio" | "text">("all");
    const [statusFilter, setStatusFilter] = useState<"all" | "success" | "failed" | "refunded">("all");
    const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
    const [selectedDetailLog, setSelectedDetailLog] = useState<ConsumptionLogItem | null>(null);

    // 充值记录状态（严格单用户隔离）
    const [rechargeLogs, setRechargeLogs] = useState<RechargeLogItem[]>([]);
    const [loadingRecharge, setLoadingRecharge] = useState(false);
    const [checkingTradeNo, setCheckingTradeNo] = useState<string | null>(null);

    const loadConsumptionLogs = async () => {
        if (!token) return;
        setLoadingLogs(true);
        try {
            const data = await fetchUserConsumptionLogs(token);
            setLogs(Array.isArray(data) ? data : []);
        } catch {
            setLogs([]);
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
            setRechargeLogs([]);
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

    const handleCheckOrderStatus = async (tradeNo: string) => {
        if (!tradeNo || checkingTradeNo) return;
        setCheckingTradeNo(tradeNo);
        try {
            const res = await checkRechargeStatus(tradeNo, token);
            if (res && res.paid) {
                message.success("该笔充值已到账！");
                void loadRechargeLogs();
            } else {
                message.info("暂未查询到微信到账，请确认是否已在微信完成支付");
            }
        } catch {
            message.error("查询支付状态失败");
        } finally {
            setCheckingTradeNo(null);
        }
    };

    useEffect(() => {
        if (open) {
            // 打开时或切换用户时，先清空上一个用户的残留数据，防止串号闪烁
            setLogs([]);
            setRechargeLogs([]);
            setKeyword("");
            setSelectedDetailLog(null);
            if (initialTab) {
                setMainTab(initialTab);
            }
            void loadConsumptionLogs();
            void loadRechargeLogs();
        } else {
            setLogs([]);
            setRechargeLogs([]);
        }
    }, [open, initialTab, token, user?.id]);

    // 消费分类、状态与关键词过滤
    const filteredLogs = useMemo(() => {
        let list = logs;
        if (category !== "all") {
            list = list.filter((item) => {
                const name = (item.model_name || "").toLowerCase();
                const action = (item.task_action || "").toLowerCase();
                const isImage = action.includes("图") || name.includes("image") || name.includes("flux") || name.includes("dall") || name.includes("midjourney") || name.includes("seedream");
                const isVideo = action.includes("视频") || name.includes("video") || name.includes("seedance") || name.includes("kling") || name.includes("sora") || name.includes("hailuo") || name.includes("happyhouse") || name.includes("omni") || name.includes("minimax-h3");
                const isAudio = action.includes("音频") || name.includes("music") || name.includes("audio") || name.includes("tts") || name.includes("voice") || name.includes("suno") || name.includes("speech");

                if (category === "image") return isImage && !isVideo;
                if (category === "video") return isVideo;
                if (category === "audio") return isAudio;
                return !isImage && !isVideo && !isAudio;
            });
        }
        if (statusFilter !== "all") {
            list = list.filter((item) => {
                if (statusFilter === "success") return item.status === "success";
                if (statusFilter === "failed") return item.status === "failed" || item.type === 5;
                if (statusFilter === "refunded") return item.status === "refunded" || item.type === 6;
                return true;
            });
        }
        const kw = keyword.trim().toLowerCase();
        if (kw) {
            list = list.filter((item) => {
                const name = (item.model_name || "").toLowerCase();
                const taskID = (item.task_id || "").toLowerCase();
                const action = (item.task_action || "").toLowerCase();
                const reqID = (item.request_id || "").toLowerCase();
                return name.includes(kw) || taskID.includes(kw) || action.includes(kw) || reqID.includes(kw);
            });
        }
        return list;
    }, [logs, category, statusFilter, keyword]);

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
                    <div className="flex items-center gap-2.5">
                        <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
                            <Zap className="size-4" />
                        </div>
                        <div>
                            <div className="text-base font-bold text-stone-900 dark:text-stone-100">
                                任务日志与充值明细中心
                            </div>
                            <div className="text-xs font-normal text-stone-400 dark:text-stone-500">
                                当前账户: <span className="font-medium text-stone-600 dark:text-stone-300">{user?.displayName || user?.username || "用户"}</span> · 官方直连物理独立账本
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
            width={680}
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
                            <span>任务与消费记录</span>
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
                        <div className="flex flex-col gap-2 border-b border-stone-200/80 pb-3 dark:border-stone-800/80">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="inline-flex rounded-lg border border-stone-200 bg-stone-100/70 p-0.5 dark:border-stone-700 dark:bg-stone-800/60 text-xs">
                                    {[
                                        { key: "all", label: "全部类别" },
                                        { key: "video", label: "视频渲染", icon: Video },
                                        { key: "image", label: "图像生成", icon: ImageIcon },
                                        { key: "audio", label: "音频合成", icon: Music2 },
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

                                <div className="w-56">
                                    <Input
                                        prefix={<Search className="size-3 text-stone-400" />}
                                        placeholder="搜索任务 ID 或模型..."
                                        size="small"
                                        allowClear
                                        value={keyword}
                                        onChange={(e) => setKeyword(e.target.value)}
                                        className="!rounded-lg text-xs"
                                    />
                                </div>
                            </div>

                            {/* 状态快速过滤 */}
                            <div className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400 pl-0.5">
                                <span className="text-[11px] text-stone-400">状态过滤:</span>
                                {[
                                    { key: "all", label: "全部" },
                                    { key: "success", label: "成功" },
                                    { key: "failed", label: "失败/未扣费" },
                                    { key: "refunded", label: "已退款" },
                                ].map((st) => (
                                    <button
                                        key={st.key}
                                        type="button"
                                        onClick={() => setStatusFilter(st.key as typeof statusFilter)}
                                        className={`px-2 py-0.5 rounded-full text-[11px] transition cursor-pointer ${
                                            statusFilter === st.key
                                                ? "bg-stone-800 text-white dark:bg-stone-200 dark:text-stone-900 font-semibold"
                                                : "text-stone-500 hover:text-stone-800 hover:bg-stone-100 dark:hover:bg-stone-800 dark:text-stone-400"
                                        }`}
                                    >
                                        {st.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* 消费流水列表（100% 对齐第一张截图的核心要素） */}
                        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                            {loadingLogs ? (
                                <div className="space-y-3 pt-2">
                                    <Skeleton active paragraph={{ rows: 3 }} />
                                    <Skeleton active paragraph={{ rows: 3 }} />
                                </div>
                            ) : filteredLogs.length > 0 ? (
                                filteredLogs.map((log) => {
                                    const isFailed = log.status === "failed" || log.type === 5;
                                    const isRefund = log.status === "refunded" || log.type === 6;
                                    const isProcessing = log.status === "processing";
                                    const isFree = log.status === "free";
                                    const isSuccess = log.status === "success";

                                    const isVideo = (log.task_action || "").includes("视频") ||
                                        (log.model_name || "").toLowerCase().includes("seedance") ||
                                        (log.model_name || "").toLowerCase().includes("video") ||
                                        (log.model_name || "").toLowerCase().includes("kling") ||
                                        (log.model_name || "").toLowerCase().includes("sora");

                                    const isImage = (log.task_action || "").includes("图") ||
                                        (log.model_name || "").toLowerCase().includes("image") ||
                                        (log.model_name || "").toLowerCase().includes("flux");

                                    const submitTimeStr = log.submit_time || log.created_at
                                        ? dayjs((log.submit_time || log.created_at) * 1000).format("YYYY-MM-DD HH:mm:ss")
                                        : "-";
                                    const completeTimeStr = log.complete_time && log.complete_time > 0
                                        ? dayjs(log.complete_time * 1000).format("YYYY-MM-DD HH:mm:ss")
                                        : null;

                                    const durSec = log.duration_seconds !== undefined
                                        ? log.duration_seconds
                                        : log.use_time > 0
                                        ? log.use_time / 1000
                                        : 0;

                                    return (
                                        <div
                                            key={`${log.id}-${log.task_id || log.created_at}`}
                                            className={`flex flex-col gap-2 rounded-xl border p-3.5 transition-colors ${
                                                isFailed
                                                    ? "border-red-500/25 bg-red-500/5 hover:border-red-500/50 dark:border-red-500/30 dark:bg-red-950/15"
                                                    : isRefund
                                                    ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/60 dark:border-emerald-500/30 dark:bg-emerald-950/20"
                                                    : isProcessing
                                                    ? "border-blue-500/30 bg-blue-500/5 hover:border-blue-500/60 dark:border-blue-500/30 dark:bg-blue-950/20"
                                                    : "border-stone-200/80 bg-white hover:border-amber-400/60 dark:border-stone-800 dark:bg-stone-900/60"
                                            }`}
                                        >
                                            {/* 顶部行：模型/操作类型 vs 积分扣费状态 */}
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="flex items-start gap-2.5 min-w-0">
                                                    <div
                                                        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${
                                                            isFailed
                                                                ? "bg-red-500/15 text-red-600 dark:text-red-400"
                                                                : isRefund
                                                                ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                                                                : isVideo
                                                                ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                                                                : isImage
                                                                ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                                                                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                                        }`}
                                                    >
                                                        {isFailed ? (
                                                            <XCircle className="size-4" />
                                                        ) : isRefund ? (
                                                            <RefreshCw className="size-4" />
                                                        ) : isVideo ? (
                                                            <Video className="size-4" />
                                                        ) : isImage ? (
                                                            <ImageIcon className="size-4" />
                                                        ) : (
                                                            <Cpu className="size-4" />
                                                        )}
                                                    </div>

                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-1.5 flex-wrap">
                                                            <span className="font-mono text-sm font-bold text-stone-900 dark:text-stone-100 truncate">
                                                                {log.model_name || "未指定模型"}
                                                            </span>
                                                            {log.task_action ? (
                                                                <span className="rounded-md bg-stone-100 border border-stone-200/80 px-1.5 py-0.2 text-[10px] font-semibold text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300">
                                                                    1 · {log.task_action}
                                                                </span>
                                                            ) : null}
                                                        </div>

                                                        {/* 提交时间与完成时间（双时间戳显示，对齐第一张截图） */}
                                                        <div className="mt-0.5 text-[11px] font-mono text-stone-400 dark:text-stone-500 flex flex-wrap items-center gap-x-2">
                                                            <span>提交: {submitTimeStr}</span>
                                                            {completeTimeStr && completeTimeStr !== submitTimeStr ? (
                                                                <span>完成: {completeTimeStr}</span>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* 费用呈现（彻底纠正免扣误导） */}
                                                <div className="text-right shrink-0">
                                                    <div
                                                        className={`font-mono text-sm font-extrabold ${
                                                            isFailed || isFree
                                                                ? "text-stone-400 dark:text-stone-500"
                                                                : isRefund
                                                                ? "text-emerald-600 dark:text-emerald-400"
                                                                : isProcessing
                                                                ? "text-blue-500 animate-pulse"
                                                                : "text-amber-600 dark:text-amber-400"
                                                        }`}
                                                    >
                                                        {isFailed
                                                            ? "0.00 积分"
                                                            : isRefund
                                                            ? `+${log.formatted_points}`
                                                            : isProcessing
                                                            ? "计算中"
                                                            : isFree
                                                            ? "0.00 积分"
                                                            : `-${log.formatted_points}`}
                                                    </div>
                                                    <div className="text-[11px] text-stone-400">
                                                        {isFailed
                                                            ? "调用未完成 · 未产生扣费"
                                                            : isRefund
                                                            ? "任务失败 · 积分已全额返还"
                                                            : isProcessing
                                                            ? "生成中暂未扣除"
                                                            : isFree
                                                            ? "平台免费体验模型"
                                                            : `折合 ${log.formatted_money}`}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* 核心数据展板（第一张截图：任务 ID、耗时、状态、进度） */}
                                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-stone-50/80 px-2.5 py-1.5 text-xs font-mono dark:bg-stone-800/40 border border-stone-200/60 dark:border-stone-750">
                                                {/* 任务 ID 展示与一键复制 */}
                                                <div className="flex items-center gap-1.5 min-w-0 max-w-[280px]">
                                                    <span className="text-[10px] text-stone-400 font-sans shrink-0">
                                                        任务ID:
                                                    </span>
                                                    <span className="truncate text-xs font-semibold text-stone-700 dark:text-stone-300">
                                                        {log.task_id || "即时API调用"}
                                                    </span>
                                                    {log.task_id ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                void navigator.clipboard.writeText(log.task_id!);
                                                                message.success("任务 ID 已复制");
                                                            }}
                                                            className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition cursor-pointer"
                                                            title="复制任务 ID"
                                                        >
                                                            <Copy className="size-3" />
                                                        </button>
                                                    ) : null}
                                                </div>

                                                {/* 耗时、状态、进度徽标 */}
                                                <div className="flex items-center gap-2.5 shrink-0 text-xs">
                                                    {/* 耗时显示：如 ● 145.0s */}
                                                    <span className="flex items-center gap-1 text-stone-600 dark:text-stone-300 font-medium">
                                                        <span
                                                            className={`size-1.5 rounded-full ${
                                                                isFailed
                                                                    ? "bg-red-500"
                                                                    : isProcessing
                                                                    ? "bg-amber-400 animate-ping"
                                                                    : "bg-emerald-500"
                                                            }`}
                                                        />
                                                        <span>{durSec > 0 ? `${durSec.toFixed(1)}s` : "0.0s"}</span>
                                                    </span>

                                                    {/* 状态徽章 */}
                                                    <Tag
                                                        color={
                                                            isFailed
                                                                ? "error"
                                                                : isRefund
                                                                ? "success"
                                                                : isProcessing
                                                                ? "processing"
                                                                : "success"
                                                        }
                                                        className="!mr-0 !text-[10px] font-semibold"
                                                    >
                                                        {log.status_label || (isFailed ? "调用失败 · 未扣费" : "成功")}
                                                    </Tag>

                                                    {/* 进度百分比 */}
                                                    <span className="text-stone-400 dark:text-stone-500 text-[11px]">
                                                        {log.progress !== undefined ? `${log.progress}%` : "100%"}
                                                    </span>
                                                </div>
                                            </div>

                                            {/* 失败/异常原因展开提示框 */}
                                            {isFailed && log.error_message ? (
                                                <div className="flex items-start gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 p-2 text-xs text-red-600 dark:text-red-400">
                                                    <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
                                                    <div className="min-w-0 flex-1">
                                                        <span className="font-semibold">失败原因：</span>
                                                        <span>{log.error_message}</span>
                                                    </div>
                                                </div>
                                            ) : null}

                                            {isRefund && log.error_message ? (
                                                <div className="flex items-start gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2 text-xs text-emerald-600 dark:text-emerald-400">
                                                    <Info className="size-3.5 shrink-0 mt-0.5" />
                                                    <div className="min-w-0 flex-1">
                                                        <span className="font-semibold">退款说明：</span>
                                                        <span>{log.error_message}</span>
                                                    </div>
                                                </div>
                                            ) : null}

                                            {/* 底部详细 Token、播放视频与查看详情按钮 */}
                                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-2 text-[11px] text-stone-500 dark:border-stone-800/80 dark:text-stone-400">
                                                <div className="flex flex-wrap items-center gap-3 font-mono">
                                                    {log.prompt_tokens > 0 ? (
                                                        <span>输入: {log.prompt_tokens.toLocaleString()} Tokens</span>
                                                    ) : null}
                                                    {log.completion_tokens > 0 ? (
                                                        <span>输出: {log.completion_tokens.toLocaleString()} Tokens</span>
                                                    ) : null}
                                                </div>

                                                <div className="flex items-center gap-2 ml-auto">
                                                    {isVideo && (log.video_url || log.task_id) && !isFailed ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                const targetUrl = log.video_url || `https://api.xybcloud.com/v1/videos/${log.task_id}/content?key=${token}`;
                                                                setPreviewVideoUrl(targetUrl);
                                                            }}
                                                            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20 text-[11px] font-semibold transition cursor-pointer"
                                                        >
                                                            <Play className="size-3 fill-current" />
                                                            <span>播放视频</span>
                                                        </button>
                                                    ) : null}

                                                    <button
                                                        type="button"
                                                        onClick={() => setSelectedDetailLog(log)}
                                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-stone-100 hover:bg-stone-200 text-stone-600 dark:bg-stone-800 dark:hover:bg-stone-700 dark:text-stone-300 text-[11px] font-medium transition cursor-pointer"
                                                    >
                                                        <span>查看详情</span>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })
                            ) : (
                                <div className="py-16 text-center">
                                    <Empty description="暂无符合条件的任务与扣费记录" />
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
                                    const completeTimeStr = item.complete_time && item.complete_time > 0 ? dayjs(item.complete_time * 1000).format("YYYY-MM-DD HH:mm:ss") : "-";

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
                                                    <span className="text-[10px] text-stone-400">
                                                        官方直连订单
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {isPending ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => void handleCheckOrderStatus(item.trade_no)}
                                                            className="text-[11px] text-sky-600 hover:underline dark:text-sky-400 font-medium cursor-pointer"
                                                        >
                                                            {checkingTradeNo === item.trade_no ? "查单中..." : "刷新支付状态"}
                                                        </button>
                                                    ) : null}
                                                    <Tag color={isSuccess ? "success" : isPending ? "warning" : "error"} className="!mr-0 !text-[10px] font-medium">
                                                        {item.status_label || (isSuccess ? "充值成功" : isPending ? "等待支付" : "支付失败")}
                                                    </Tag>
                                                </div>
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

            {/* 任务详情完整模态框 */}
            <Modal
                open={Boolean(selectedDetailLog)}
                onCancel={() => setSelectedDetailLog(null)}
                footer={null}
                title={
                    <div className="flex items-center gap-2">
                        <Info className="size-4 text-amber-500" />
                        <span>任务与调用日志完整详情</span>
                    </div>
                }
                width={600}
                destroyOnClose
                centered
            >
                {selectedDetailLog ? (
                    <div className="space-y-4 py-2 text-xs">
                        <div className="grid grid-cols-2 gap-3 rounded-xl bg-stone-50 p-3.5 dark:bg-stone-900/70 border border-stone-200/70 dark:border-stone-800">
                            <div>
                                <span className="text-stone-400">调用模型：</span>
                                <span className="font-mono font-bold text-stone-800 dark:text-stone-200 ml-1">
                                    {selectedDetailLog.model_name}
                                </span>
                            </div>
                            <div>
                                <span className="text-stone-400">操作类型：</span>
                                <span className="font-semibold text-stone-800 dark:text-stone-200 ml-1">
                                    {selectedDetailLog.task_action || "大模型调用"}
                                </span>
                            </div>
                            <div>
                                <span className="text-stone-400">任务状态：</span>
                                <span className="ml-1">
                                    <Tag
                                        color={
                                            selectedDetailLog.status === "failed"
                                                ? "error"
                                                : selectedDetailLog.status === "refunded"
                                                ? "success"
                                                : "success"
                                        }
                                        className="!mr-0"
                                    >
                                        {selectedDetailLog.status_label || "成功"}
                                    </Tag>
                                </span>
                            </div>
                            <div>
                                <span className="text-stone-400">任务进度：</span>
                                <span className="font-mono font-semibold ml-1">
                                    {selectedDetailLog.progress !== undefined ? `${selectedDetailLog.progress}%` : "100%"}
                                </span>
                            </div>
                            <div className="col-span-2">
                                <span className="text-stone-400">任务 ID：</span>
                                <span className="font-mono text-stone-700 dark:text-stone-300 ml-1 select-all">
                                    {selectedDetailLog.task_id || "即时API调用"}
                                </span>
                            </div>
                            {selectedDetailLog.request_id ? (
                                <div className="col-span-2">
                                    <span className="text-stone-400">Request ID：</span>
                                    <span className="font-mono text-stone-600 dark:text-stone-400 ml-1 select-all text-[11px]">
                                        {selectedDetailLog.request_id}
                                    </span>
                                </div>
                            ) : null}
                            <div>
                                <span className="text-stone-400">提交时间：</span>
                                <span className="font-mono ml-1">
                                    {selectedDetailLog.submit_time
                                        ? dayjs(selectedDetailLog.submit_time * 1000).format("YYYY-MM-DD HH:mm:ss")
                                        : "-"}
                                </span>
                            </div>
                            <div>
                                <span className="text-stone-400">完成时间：</span>
                                <span className="font-mono ml-1">
                                    {selectedDetailLog.complete_time && selectedDetailLog.complete_time > 0
                                        ? dayjs(selectedDetailLog.complete_time * 1000).format("YYYY-MM-DD HH:mm:ss")
                                        : "-"}
                                </span>
                            </div>
                            <div>
                                <span className="text-stone-400">任务耗时：</span>
                                <span className="font-mono font-semibold ml-1">
                                    {selectedDetailLog.duration_seconds !== undefined
                                        ? `${selectedDetailLog.duration_seconds.toFixed(1)} 秒`
                                        : `${(selectedDetailLog.use_time / 1000).toFixed(1)} 秒`}
                                </span>
                            </div>
                            <div>
                                <span className="text-stone-400">积分结算：</span>
                                <span className="font-mono font-bold text-amber-600 dark:text-amber-400 ml-1">
                                    {selectedDetailLog.formatted_points} ({selectedDetailLog.formatted_money})
                                </span>
                            </div>
                        </div>

                        {/* 报错详情 */}
                        {selectedDetailLog.error_message || selectedDetailLog.error_detail ? (
                            <div className="space-y-1.5">
                                <div className="font-semibold text-red-600 dark:text-red-400">
                                    调用失败 / 异常详情：
                                </div>
                                <div className="max-h-40 overflow-y-auto rounded-lg bg-red-500/10 border border-red-500/20 p-2.5 font-mono text-xs text-red-600 dark:text-red-400 select-all">
                                    {selectedDetailLog.error_detail || selectedDetailLog.error_message}
                                </div>
                            </div>
                        ) : null}

                        {/* 视频快速播放 */}
                        {selectedDetailLog.video_url ? (
                            <div className="pt-2 flex justify-end">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setPreviewVideoUrl(selectedDetailLog.video_url!);
                                        setSelectedDetailLog(null);
                                    }}
                                    className="inline-flex items-center gap-1 px-4 py-2 rounded-xl bg-purple-600 text-white hover:bg-purple-700 text-xs font-bold transition cursor-pointer"
                                >
                                    <Play className="size-3.5 fill-current" />
                                    <span>播放视频成片</span>
                                </button>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </Modal>

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
