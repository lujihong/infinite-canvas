"use client";

import { useEffect } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "antd";

export default function EditorError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("[Editor Route Error]:", error);
    }, [error]);

    return (
        <div className="flex flex-col h-[calc(100dvh-4rem)] w-full bg-stone-950 text-stone-200 items-center justify-center p-6 text-center select-none">
            <div className="max-w-md p-6 rounded-2xl bg-stone-900 border border-stone-800 shadow-2xl flex flex-col items-center gap-3">
                <div className="size-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                    <AlertCircle className="size-6" />
                </div>
                <h2 className="text-base font-bold text-stone-100">剪辑工作台已恢复</h2>
                <p className="text-xs text-stone-400 leading-relaxed">
                    客户端环境已重置，点击下方按钮即可重新加载。
                </p>
                <div className="flex items-center gap-3 mt-2">
                    <Button
                        type="primary"
                        icon={<RotateCcw className="size-3.5" />}
                        onClick={() => {
                            try {
                                localStorage.removeItem("infinite-canvas:editor_store");
                            } catch {}
                            reset();
                        }}
                        className="!rounded-lg !bg-amber-500 !text-stone-950 !font-bold !border-none"
                    >
                        重置并恢复
                    </Button>
                    <Button
                        onClick={() => {
                            window.location.href = "/canvas";
                        }}
                        className="!rounded-lg !bg-stone-800 !border-stone-700 !text-stone-300"
                    >
                        返回画布
                    </Button>
                </div>
            </div>
        </div>
    );
}
