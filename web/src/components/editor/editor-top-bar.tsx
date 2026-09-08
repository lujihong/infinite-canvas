"use client";

import { ArrowLeft, Download, Film, Layers, Play, Redo2, RotateCcw, Scissors, Sparkles, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { Button, Dropdown, Select, Tooltip } from "antd";

import { AspectRatio, useEditorStore } from "@/stores/use-editor-store";
import { formatTimecode } from "@/services/editor-engine";

const ratioOptions: Array<{ label: string; value: AspectRatio; desc: string }> = [
    { label: "16:9 横屏", value: "16:9", desc: "电脑/电视/大片" },
    { label: "9:16 竖屏", value: "9:16", desc: "短视频/抖音/小红书" },
    { label: "1:1 方形", value: "1:1", desc: "头像/朋友圈/小方块" },
    { label: "4:3 传统", value: "4:3", desc: "复古/平板" },
];

export function EditorTopBar({ onExport, projectId }: { onExport: () => void; projectId?: string }) {
    const projectTitle = useEditorStore((state) => state.projectTitle);
    const setProjectTitle = useEditorStore((state) => state.setProjectTitle);
    const aspectRatio = useEditorStore((state) => state.aspectRatio);
    const setAspectRatio = useEditorStore((state) => state.setAspectRatio);
    const getTotalDuration = useEditorStore((state) => state.getTotalDuration);
    const clearProject = useEditorStore((state) => state.clearProject);

    const totalDuration = getTotalDuration();

    return (
        <header className="h-14 shrink-0 border-b border-stone-200/80 bg-stone-900/90 px-4 text-stone-100 backdrop-blur-md dark:border-stone-800 flex items-center justify-between gap-3 select-none">
            {/* 左侧：返回与工程名称 */}
            <div className="flex items-center gap-3 min-w-0">
                <Link
                    href={projectId ? `/canvas/${projectId}` : "/canvas"}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-stone-700/60 bg-stone-800/80 text-stone-300 transition hover:bg-stone-700 hover:text-white"
                    title={projectId ? "返回原画布" : "返回画布列表"}
                >
                    <ArrowLeft className="size-4" />
                </Link>

                <div className="flex items-center gap-2 min-w-0">
                    <div className="flex size-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-500 border border-amber-500/30">
                        <Film className="size-3.5" />
                    </div>
                    <input
                        type="text"
                        value={projectTitle}
                        onChange={(e) => setProjectTitle(e.target.value)}
                        placeholder="输入工程标题..."
                        className="h-8 max-w-[120px] sm:max-w-[220px] truncate rounded-md border border-transparent bg-transparent px-2 text-sm font-semibold text-stone-100 outline-none transition hover:border-stone-700 focus:border-amber-500/60 focus:bg-stone-800/60"
                        title="点击修改工程标题"
                    />
                </div>
            </div>

            {/* 中间：画幅比例切换与总时长指示 */}
            <div className="flex items-center gap-2.5">
                <div className="inline-flex items-center rounded-lg border border-stone-700/60 bg-stone-800/60 p-0.5 text-xs">
                    {ratioOptions.map((opt) => {
                        const active = aspectRatio === opt.value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => setAspectRatio(opt.value)}
                                className={`px-2.5 py-1 rounded-md transition-colors text-xs font-medium cursor-pointer ${
                                    active
                                        ? "bg-amber-500 text-stone-950 font-bold shadow-xs"
                                        : "text-stone-400 hover:text-stone-200"
                                }`}
                                title={opt.desc}
                            >
                                <span className="hidden sm:inline">{opt.label}</span>
                                <span className="sm:hidden">{opt.value}</span>
                            </button>
                        );
                    })}
                </div>

                <div className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-stone-700/50 bg-stone-800/40 px-2.5 py-1 text-xs font-mono text-stone-400">
                    <span>总时长:</span>
                    <span className="font-bold text-amber-400 tabular-nums">
                        {formatTimecode(totalDuration, true)}
                    </span>
                </div>
            </div>

            {/* 右侧：清空与导出按钮 */}
            <div className="flex items-center gap-2 shrink-0">
                <Tooltip title="清空当前时间轴">
                    <button
                        type="button"
                        onClick={() => {
                            if (window.confirm("确定要清空当前剪辑工程吗？已添加的片段将全部被重置。")) {
                                clearProject();
                            }
                        }}
                        className="inline-flex size-8 items-center justify-center rounded-lg border border-stone-700/60 bg-stone-800/80 text-stone-400 transition hover:bg-red-500/15 hover:border-red-500/40 hover:text-red-400"
                    >
                        <Trash2 className="size-3.5" />
                    </button>
                </Tooltip>

                <Button
                    type="primary"
                    onClick={onExport}
                    className="!h-8 !px-3.5 !rounded-lg !bg-gradient-to-r !from-amber-500 !to-amber-600 !border-none !font-bold !text-stone-950 shadow-md hover:!from-amber-400 hover:!to-amber-500 !inline-flex !items-center !gap-1.5"
                >
                    <Download className="size-3.5 stroke-[2.5]" />
                    <span>导出成片</span>
                </Button>
            </div>
        </header>
    );
}
