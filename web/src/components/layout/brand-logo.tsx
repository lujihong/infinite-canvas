"use client";

import { cn } from "@/lib/utils";

type BrandLogoProps = {
    className?: string;
    alt?: string;
};

export function BrandLogo({ className = "size-8", alt = "鑫元宝视频创作工作台" }: BrandLogoProps) {
    return (
        <span className={cn("relative inline-flex shrink-0 items-center justify-center", className)}>
            {/* 浅色模式下的专属深蓝黑 Logo */}
            <img
                src="/logo-light.png"
                alt={alt}
                className="h-full w-auto max-w-full object-contain dark:hidden"
            />
            {/* 深色模式下的专属高亮钛银白 Logo */}
            <img
                src="/logo-dark.png"
                alt={alt}
                className="hidden h-full w-auto max-w-full object-contain drop-shadow-[0_0_10px_rgba(255,255,255,0.25)] dark:block"
            />
        </span>
    );
}
