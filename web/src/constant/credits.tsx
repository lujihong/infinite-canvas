import type { ComponentProps } from "react";
import { Zap } from "lucide-react";
import { getModelPricing } from "@/services/api/pricing";
export { getModelPricing, loadRemotePricing } from "@/services/api/pricing";

export function CreditSymbol({ className, ...props }: ComponentProps<"span">) {
    return <span {...props} className={`inline-flex items-center justify-center ${className || ""}`}><Zap className="size-[1em] fill-amber-400 text-amber-500" strokeWidth={2.4} /></span>;
}

export type ModelCreditCost = { model: string; credits: number };

type LegacyQuoteOptions = { channelMode?: string; modelCosts?: ModelCreditCost[]; model: string; count?: string | number; mode?: string; seconds?: string | number; resolution?: string };

// A model name or list price cannot establish a parameter-specific task price.
// Existing numeric consumers may retain zero as unavailable, never as a free quote.
export function requestCreditCost(_options: LegacyQuoteOptions): number { return 0; }

export function formatModelCostTag(options: LegacyQuoteOptions): string {
    const pricing = getModelPricing(options.model);
    if (!pricing) return "本人报价暂不可用";
    if (pricing.billing_mode === "tiered_expr" || pricing.billing_expr) return "按实际用量结算积分";
    return pricing.formatted_points_cost.includes("积分") ? pricing.formatted_points_cost : "积分报价暂不可用";
}

export function formatCreditDisplay(credits: number): string {
    return Number.isFinite(credits) && credits >= 0 ? `${credits} 积分` : "积分报价暂不可用";
}
