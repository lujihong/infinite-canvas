"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";

export function AppFooter() {
    return (
        <footer className="mt-auto border-t border-stone-200 bg-background/80 py-8 text-xs text-stone-500 backdrop-blur-sm dark:border-stone-800 dark:text-stone-400">
            <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
                <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                    <span className="font-medium text-stone-700 dark:text-stone-300">
                        新元宝视频工作台
                    </span>
                    <span>·</span>
                    <span>© {new Date().getFullYear()} 鑫元宝云计算 版权所有</span>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
                    <a
                        href="https://api.xybcloud.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition hover:text-stone-900 hover:underline dark:hover:text-stone-200"
                    >
                        中转站算力中心
                    </a>

                    <a
                        href="https://beian.miit.gov.cn/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition hover:text-stone-900 hover:underline dark:hover:text-stone-200"
                        title="工业和信息化部政务服务平台 ICP 备案查询"
                    >
                        渝ICP备2022009613号
                    </a>

                    <a
                        href="https://beian.mps.gov.cn/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 transition hover:text-stone-900 hover:underline dark:hover:text-stone-200"
                        title="全国公安机关互联网站安全管理服务平台备案查询"
                    >
                        <svg className="size-3.5 shrink-0" viewBox="0 0 32 32" fill="currentColor">
                            <path d="M16 2L3 7v10c0 8.28 5.56 16.03 13 18 7.44-1.97 13-9.72 13-18V7L16 2zm0 4.18L26 10.3v6.7c0 6.64-4.27 12.87-10 14.7-5.73-1.83-10-8.06-10-14.7v-6.7l10-4.12z" />
                            <path d="M16 9.5l1.9 4.3 4.7.4-3.5 3.1 1 4.6-4.1-2.4-4.1 2.4 1-4.6-3.5-3.1 4.7-.4z" />
                        </svg>
                        <span>渝公网安备 50010302002598号</span>
                    </a>
                </div>
            </div>
        </footer>
    );
}
