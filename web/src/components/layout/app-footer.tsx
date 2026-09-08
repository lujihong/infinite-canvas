"use client";

import { useState } from "react";
import Link from "next/link";
import { LegalModal, type LegalDocType } from "@/components/layout/legal-modal";

export function AppFooter() {
    const [legalDoc, setLegalDoc] = useState<LegalDocType>(null);

    return (
        <footer className="mt-auto border-t border-stone-200 bg-background/80 py-8 text-xs text-stone-500 backdrop-blur-sm dark:border-stone-800 dark:text-stone-400">
            <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
                <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                    <span className="font-medium text-stone-700 dark:text-stone-300">
                        鑫元宝视频创作工作台
                    </span>
                    <span>·</span>
                    <span>© {new Date().getFullYear()} 鑫元宝云计算（重庆）有限责任公司 版权所有</span>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
                    <button
                        type="button"
                        onClick={() => setLegalDoc("agreement")}
                        className="cursor-pointer transition hover:text-stone-900 hover:underline dark:hover:text-stone-200"
                    >
                        用户协议
                    </button>

                    <button
                        type="button"
                        onClick={() => setLegalDoc("privacy")}
                        className="cursor-pointer transition hover:text-stone-900 hover:underline dark:hover:text-stone-200"
                    >
                        隐私政策
                    </button>

                    <a
                        href="https://api.xybcloud.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition hover:text-stone-900 hover:underline dark:hover:text-stone-200"
                        title="鑫元宝云计算模型服务平台"
                    >
                        模型服务平台
                    </a>

                    <a
                        href="https://beian.miit.gov.cn/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition hover:text-stone-900 hover:underline dark:hover:text-stone-200"
                        title="工业和信息化部政务服务平台 ICP 备案查询"
                    >
                        渝ICP备2024036208号
                    </a>
                </div>
            </div>

            <LegalModal
                type={legalDoc}
                open={Boolean(legalDoc)}
                onClose={() => setLegalDoc(null)}
            />
        </footer>
    );
}
