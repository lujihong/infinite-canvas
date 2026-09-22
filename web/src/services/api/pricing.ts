import axios from "axios";
import { useEffect } from "react";
import { create } from "zustand";
import { useUserStore } from "@/stores/use-user-store";

export type ModelPricingItem = {
    model_name: string;
    quota_type: number;
    model_price: number;
    model_ratio: number;
    completion_ratio: number;
    points_cost: number | null; // Null until the quota-to-points conversion is verified.
    formatted_points_cost: string;
    billing_description: string;
    supported_endpoint_types: string[];
    billing_mode: string;
    billing_expr: string;
    enable_groups: string[];
    estimated: boolean;
    discount?: { factor: number; source: string; revision?: unknown; model: string };
    group_quotes: Array<{ group: string; final_ratio: number; base_usd?: number; usd_price?: number; output_usd_price?: number; unit: string; formatted_points_cost: string }>;
};

type PricingState = { items: Map<string, ModelPricingItem>; error: string; loading: boolean };
const usePricingState = create<PricingState>(() => ({ items: new Map(), error: "", loading: false }));
let controller: AbortController | undefined;
let pending: Promise<Map<string, ModelPricingItem>> | undefined;
let generation = 0;
let loadedAt = 0;

// Only the current session owns prices. No persisted cache, public cache, or shared query key.
useUserStore.subscribe((state, previous) => {
    if (state.token !== previous.token || state.user?.id !== previous.user?.id) {
        generation++;
        controller?.abort();
        controller = undefined;
        pending = undefined;
        loadedAt = 0;
        usePricingState.setState({ items: new Map(), error: "", loading: false });
    }
});

export async function fetchModelPricingList(signal?: AbortSignal) {
    const { token, user } = useUserStore.getState();
    if (!token || !user?.id) throw new Error("请先登录后查看本人报价");
    const epoch = generation;
    const response = await axios.request({
        url: "/api/model-pricing", method: "GET", signal, timeout: 12_000,
        headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" },
        validateStatus: () => true,
    });
    const current = useUserStore.getState();
    if (signal?.aborted || generation !== epoch || current.token !== token || current.user?.id !== user.id) throw new Error("登录身份已改变，请重新获取报价");
    if (response.status < 200 || response.status >= 300 || response.data?.code !== 0 || !Array.isArray(response.data?.data)) throw new Error("本人报价暂不可用，请重试");
    const items = response.data.data;
    // Reject old public-price payloads instead of displaying them as personal quotes.
    if (!items.every((item: ModelPricingItem) => item && typeof item.model_name === "string" && typeof item.formatted_points_cost === "string" && item.estimated === true && Array.isArray(item.group_quotes))) throw new Error("本人报价数据不完整，请重试");
    return items as ModelPricingItem[];
}

export function loadRemotePricing(): Promise<Map<string, ModelPricingItem>> {
    const { token, user } = useUserStore.getState();
    if (typeof window === "undefined" || !token || !user?.id) return Promise.resolve(new Map());
    if (pending) return pending;
    if (loadedAt && Date.now() - loadedAt < 30_000) return Promise.resolve(usePricingState.getState().items);
    const epoch = generation;
    const request = new AbortController();
    controller = request;
    usePricingState.setState({ items: new Map(), loading: true, error: "" });
    pending = fetchModelPricingList(request.signal).then((items) => {
        if (generation !== epoch || request.signal.aborted) return new Map<string, ModelPricingItem>();
        const map = new Map(items.map(item => [item.model_name, item]));
        loadedAt = Date.now();
        usePricingState.setState({ items: map });
        return map;
    }).catch(() => {
        if (generation === epoch) usePricingState.setState({ items: new Map(), error: "本人报价暂不可用，请重新打开模型列表重试" });
        return new Map<string, ModelPricingItem>();
    }).finally(() => {
        if (generation === epoch) {
            pending = undefined;
            controller = undefined;
            usePricingState.setState({ loading: false });
        }
    });
    return pending;
}

export function getModelPricing(model: string) {
    const { token, user } = useUserStore.getState();
    if (!token || !user?.id) return undefined;
    return usePricingState.getState().items.get(model);
}

export function usePersonalPricing(active = true) {
    const token = useUserStore(state => state.token);
    const userID = useUserStore(state => state.user?.id);
    const state = usePricingState();
    useEffect(() => { if (active) void loadRemotePricing(); }, [token, userID, active]);
    return state;
}

export function personalPricingDetails(pricing: ModelPricingItem): string {
    const discount = pricing.discount ? `本人优惠倍率 ${pricing.discount.factor}（来源：${pricing.discount.source}）` : "";
    const groups = pricing.group_quotes.map(quote => `${quote.group}：${quote.formatted_points_cost}；最终倍率 ${quote.final_ratio}`);
    return [discount, pricing.billing_description, ...groups, pricing.billing_expr ? `计费表达式：${pricing.billing_expr}` : ""].filter(Boolean).join("\n");
}
