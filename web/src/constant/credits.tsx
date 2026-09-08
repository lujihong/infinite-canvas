import type { ComponentProps } from "react";
import { Zap } from "lucide-react";
import { fetchModelPricingList, type ModelPricingItem } from "@/services/api/pricing";

export function CreditSymbol({ className, ...props }: ComponentProps<"span">) {
    return (
        <span {...props} className={`inline-flex items-center justify-center ${className || ""}`}>
            <Zap className="size-[1em] fill-amber-400 text-amber-500" strokeWidth={2.4} />
        </span>
    );
}

export type ModelCreditCost = {
    model: string;
    credits: number;
};

// 全局动态模型计费缓存（从中转站 api.xybcloud.com/api/pricing 实时同步）
let cachedPricingMap = new Map<string, ModelPricingItem>();
let pricingFetched = false;
let isFetchingPricing = false;

export function loadRemotePricing(): Promise<Map<string, ModelPricingItem>> {
    if (typeof window === "undefined") return Promise.resolve(cachedPricingMap);
    if (pricingFetched && cachedPricingMap.size > 0) return Promise.resolve(cachedPricingMap);
    if (isFetchingPricing) return Promise.resolve(cachedPricingMap);

    isFetchingPricing = true;
    return fetchModelPricingList()
        .then((items) => {
            const map = new Map<string, ModelPricingItem>();
            if (Array.isArray(items)) {
                items.forEach((item) => {
                    map.set(item.model_name.toLowerCase(), item);
                });
            }
            cachedPricingMap = map;
            pricingFetched = true;
            return map;
        })
        .catch(() => cachedPricingMap)
        .finally(() => {
            isFetchingPricing = false;
        });
}

// 自动触发静默加载
if (typeof window !== "undefined") {
    setTimeout(() => {
        void loadRemotePricing();
    }, 100);
}

/**
 * 获取当前模型在中转站的精确计费信息
 */
export function getModelPricing(modelName: string): ModelPricingItem | undefined {
    const key = (modelName || "").trim().toLowerCase();
    return cachedPricingMap.get(key);
}

/**
 * 预估模型基准积分（兜底安全逻辑）
 */
export function estimateModelBaseCredits(modelName: string, mode?: string): number {
    const m = (modelName || "").toLowerCase();

    // 1. 视频模型 (按次计费兜底)
    if (
        mode === "video" ||
        m.includes("video") ||
        m.includes("seedance") ||
        m.includes("sora") ||
        m.includes("veo") ||
        m.includes("kling") ||
        m.includes("hailuo") ||
        m.includes("minimax-h3") ||
        m.includes("skyreels") ||
        m.includes("happyhouse") ||
        m.includes("omni") ||
        m.includes("wan2")
    ) {
        if (m.includes("1080p") || m.includes("4k") || m.includes("sd8")) return 8;
        if (m.includes("720p") || m.includes("fast") || m.includes("mini") || m.includes("sd4")) return 3.5;
        return 5;
    }

    // 2. 图像模型 (按次计费兜底)
    if (
        mode === "image" ||
        m.includes("image") ||
        m.includes("flux") ||
        m.includes("midjourney") ||
        m.includes("dall-e") ||
        m.includes("dalle") ||
        m.includes("imagen") ||
        m.includes("seedream") ||
        m.includes("recraft")
    ) {
        if (m.includes("4k")) return 0.75;
        if (m.includes("2k")) return 0.46;
        if (m.includes("1k")) return 0.23;
        return 0.7;
    }

    // 3. 音频与音乐模型
    if (
        mode === "audio" ||
        m.includes("music") ||
        m.includes("suno") ||
        m.includes("audio") ||
        m.includes("tts") ||
        m.includes("speech") ||
        m.includes("voice")
    ) {
        if (m.includes("music") || m.includes("suno")) return 8.3;
        return 0.5;
    }

    // 4. 文本模型（按 Token 计费，单次千 Token 成本极低）
    return 0;
}

export function requestCreditCost(options: {
    channelMode?: string;
    modelCosts?: ModelCreditCost[];
    model: string;
    count?: string | number;
    mode?: string;
    seconds?: string | number;
    resolution?: string;
}): number {
    const model = (options.model || "").trim();
    const count = Math.max(1, Math.floor(Math.abs(Number(options.count)) || 1));
    const mode = options.mode || "";
    const isVideo = mode === "video" || model.includes("video") || model.includes("seedance") || model.includes("kling") || model.includes("sora") || model.includes("minimax-h3");

    // 1. 优先查中转站真实定价
    const pricing = getModelPricing(model);
    if (pricing) {
        if (pricing.quota_type === 1) {
            let basePoints = pricing.points_cost;
            // 视频任务：基准单价对应标准 5 秒，随实际秒数与分辨率精准乘算
            if (isVideo) {
                const sec = Math.max(1, Number(options.seconds) || 5);
                const perSecond = basePoints / 5;
                let cost = perSecond * sec;
                // 分辨率加成：若指定 1080P 且模型名未固定为 1080p SKU，加乘 1080P 官方系数 (51/46 ≈ 1.1087)
                const res = (options.resolution || "").toLowerCase();
                if ((res.includes("1080") || res.includes("fhd")) && !model.includes("1080p")) {
                    cost *= 1.1087;
                }
                return Math.round(cost * 100) / 100;
            }
            // 图片或普通按次：中转站单价 * 生成张数
            return Math.round(basePoints * (mode === "image" ? count : 1) * 100) / 100;
        } else {
            // 按 Token 计费：无法提前确定 token 消耗，返回 0 触发“按量扣费”
            return 0;
        }
    }

    // 2. 查管理员后台自定义配置
    const configured = options.modelCosts?.find((item) => item.model === model)?.credits;
    if (typeof configured === "number" && configured > 0) {
        if (isVideo) {
            const sec = Math.max(1, Number(options.seconds) || 5);
            return Math.round((configured / 5) * sec * 100) / 100;
        }
        return Math.round(configured * (mode === "image" ? count : 1) * 100) / 100;
    }

    // 3. 兜底估算
    const base = estimateModelBaseCredits(model, mode);
    if (isVideo) {
        const sec = Math.max(1, Number(options.seconds) || 5);
        return Math.round((base / 5) * sec * 100) / 100;
    }
    return Math.round(base * (mode === "image" ? count : 1) * 100) / 100;
}

/**
 * 格式化模型消耗文案呈现
 */
export function formatModelCostTag(options: {
    model: string;
    mode?: string;
    count?: string | number;
    seconds?: string | number;
    resolution?: string;
    modelCosts?: ModelCreditCost[];
}): string {
    const pricing = getModelPricing(options.model);
    if (pricing && pricing.quota_type === 0) {
        return "按量扣费";
    }
    if (options.mode === "text") {
        return "按量扣费";
    }

    const cost = requestCreditCost(options);
    if (cost <= 0) {
        return "按量扣费";
    }

    if (Number.isInteger(cost)) {
        return `消耗 ${cost} 积分`;
    }
    return `消耗 ${cost.toFixed(2).replace(/\.?0+$/, "")} 积分`;
}

export function formatCreditDisplay(credits: number): string {
    if (credits <= 0) return "按量扣费";
    if (Number.isInteger(credits)) {
        return `${credits} 积分`;
    }
    return `${credits.toFixed(2).replace(/\.?0+$/, "")} 积分`;
}
