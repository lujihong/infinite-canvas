"use client";

import { Tooltip } from "antd";
import { useRequestQuote, type QuoteDescriptor } from "@/services/api/request-quote";
import type { AiConfig } from "@/stores/use-config-store";

export type EstimatedCreditsProps = {
    config: AiConfig;
    descriptor: QuoteDescriptor | null;
    className?: string;
};

export function EstimatedCredits({ config, descriptor, className = "" }: EstimatedCreditsProps) {
    const { quote, label, detail } = useRequestQuote(config, descriptor);
    const explanation = [detail, quote?.missing_fields?.length ? `待确定用量：${quote.missing_fields.join("、")}` : ""].filter(Boolean).join("；");
    return (
        <Tooltip title={explanation}>
            <span className={`inline-block min-w-0 max-w-full whitespace-normal break-words text-xs leading-5 tabular-nums ${className}`} aria-live="polite" title={explanation}>
                {label}
            </span>
        </Tooltip>
    );
}
