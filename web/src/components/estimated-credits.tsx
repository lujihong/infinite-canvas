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
    const { label, detail } = useRequestQuote(config, descriptor);
    return (
        <Tooltip title={<div className="whitespace-pre-line break-words text-xs leading-5">{detail}</div>} styles={{ root: { maxWidth: "min(360px, calc(100vw - 24px))" }, container: { maxHeight: "min(480px, 70vh)", overflowY: "auto", overflowWrap: "anywhere" } }}>
            <span className={`inline-block min-w-0 max-w-full whitespace-normal break-words text-xs leading-5 tabular-nums ${className}`} aria-live="polite">
                {label}
            </span>
        </Tooltip>
    );
}
