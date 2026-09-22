import { useEffect, useState } from "react";
import { channelIdForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { acquireQuoteSlot } from "./quote-queue";

export type QuoteDescriptor = { endpoint: string; body: Record<string, unknown>; batch_count: number; missing_fields?: string[] };
export type RequestQuote = {
    status: "estimated" | "usage_required" | "unavailable";
    points_cost: number | null;
    formatted_points_cost?: string;
    message?: string;
    missing_fields?: string[];
    billing_revision?: string;
    group?: string;
    unit_rates?: Array<{ dimension: string; points_cost: number | null; per: number; unit: string; formatted_points_cost?: string }>;
};

export function quoteLabel(quote?: RequestQuote): string {
    if (!quote) return "预计积分暂不可用";
    if (quote.status === "estimated" && typeof quote.points_cost === "number" && Number.isFinite(quote.points_cost) && quote.points_cost >= 0) {
        // Keep tiny positive quotes positive; display rounding must never imply free usage.
        return `预计消耗 ${Number(quote.points_cost.toPrecision(12))} 积分`;
    }
    return quote.status === "usage_required" ? "按实际用量结算积分" : "预计积分暂不可用";
}

export function quoteDetails(quote?: RequestQuote): string {
    const rates = quote?.unit_rates?.filter(rate => typeof rate.points_cost === "number" && Number.isFinite(rate.points_cost) && rate.points_cost >= 0 && Number.isFinite(rate.per) && rate.per > 0)
        .map(rate => `${rate.dimension}：${Number(rate.points_cost!.toPrecision(12))} 积分 / ${rate.per} ${rate.unit}`) || [];
    return [quote?.message, ...rates, quote?.missing_fields?.length ? `待确定：${quote.missing_fields.join("、")}` : "", "预计积分依当前参数及本人价格计算；实际返回用量和重试路由可能影响最终结算。"].filter(Boolean).join("\n");
}

// Mirrors usesAccountProxy in image.ts (also text/canvas-agent), video.ts and audio.ts.
// Their provider-specific browser senders are only used outside these account-proxy branches.
export function requestUsesSiteBackend(config: Pick<AiConfig, "channelMode">, token: string): boolean {
    return config.channelMode === "remote" || (config.channelMode === "local" && Boolean(token));
}

// No persistent/global quote cache: cancellation and identity checks protect parameter changes.
export function useRequestQuote(config: AiConfig, descriptor: QuoteDescriptor | null) {
    const token = useUserStore(state => state.token);
    const userID = useUserStore(state => state.user?.id);
    const channel = channelIdForActiveModel(config);
    const siteBackend = requestUsesSiteBackend(config, token);
    const missing = descriptor?.missing_fields || [];
    const blocked = !siteBackend ? "浏览器直连供应商，不使用本站积分报价" : !token || !userID ? "请先登录后查看本人预计积分" : !descriptor ? "请配置模型和生成参数" : missing.length ? `报价缺少：${missing.join("、")}` : "";
    const key = JSON.stringify({ descriptor, channel, mode: config.channelMode });
    const [state, setState] = useState<{ key: string; token: string; userID: unknown; quote?: RequestQuote; loading: boolean; error?: string }>({ key: "", token: "", userID: undefined, loading: false });
    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        if (blocked || !descriptor) {
            setState({ key, token, userID, loading: false, error: blocked });
            return () => { active = false; controller.abort(); };
        }
        setState({ key, token, userID, loading: true });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(async () => {
            deadline = setTimeout(() => controller.abort(), 12_000);
            let release: (() => void) | undefined;
            try {
                release = await acquireQuoteSlot(controller.signal);
                const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
                if (channel) headers[config.channelMode === "remote" ? "X-Model-Channel-ID" : "X-User-Model-Channel-ID"] = channel;
                const payload = { endpoint: descriptor.endpoint, body: descriptor.body, batch_count: descriptor.batch_count };
                const response = await fetch("/api/v1/model-pricing/quote", { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
                const result = await response.json();
                if (!response.ok || result.code !== 0 || !["estimated", "usage_required", "unavailable"].includes(result.data?.status)) throw new Error("暂时无法获取预计积分");
                if (result.data.status === "estimated" && (typeof result.data.points_cost !== "number" || !Number.isFinite(result.data.points_cost) || result.data.points_cost < 0)) throw new Error("积分报价数据无效");
                if (active && useUserStore.getState().token === token && useUserStore.getState().user?.id === userID) setState({ key, token, userID, quote: result.data, loading: false });
            } catch {
                if (active) setState({ key, token, userID, loading: false, error: "暂时无法获取预计积分，请检查网络或重新选择参数" });
            } finally { clearTimeout(deadline); release?.(); }
        }, 350);
        return () => { active = false; clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
    }, [key, token, userID, blocked]);
    const current = state.key === key && state.token === token && state.userID === userID ? state : undefined;
    return { quote: blocked ? undefined : current?.quote, label: !blocked && (!current || current.loading) ? "预计积分计算中…" : quoteLabel(blocked ? undefined : current?.quote), detail: blocked || current?.error || quoteDetails(current?.quote) };
}
