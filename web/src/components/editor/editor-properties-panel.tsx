"use client";

import { useState } from "react";
import { Copy, Gauge, Sliders, Trash2, Type, Volume2, X } from "lucide-react";
import { Input, InputNumber, Slider, Switch } from "antd";

import {
    useEditorStore,
    getClipEffectiveDuration,
    getClipEndTime,
} from "@/stores/use-editor-store";
import { formatTimecode } from "@/services/editor-engine";

export function EditorPropertiesPanel() {
    const selectedClip = useEditorStore((state) => state.getSelectedClip());
    const updateClip = useEditorStore((state) => state.updateClip);
    const removeClip = useEditorStore((state) => state.removeClip);
    const selectClip = useEditorStore((state) => state.selectClip);

    if (!selectedClip) {
        return (
            <aside className="w-64 shrink-0 border-l border-stone-200/80 bg-stone-900/60 p-4 text-stone-400 text-xs flex flex-col items-center justify-center text-center select-none dark:border-stone-800">
                <Sliders className="size-8 text-stone-600 mb-2 opacity-40" />
                <span>未选中任何片段</span>
                <span className="text-[10px] text-stone-500 mt-1">在时间轴中点击片段以调节参数</span>
            </aside>
        );
    }

    const effectiveDuration = getClipEffectiveDuration(selectedClip);

    return (
        <aside className="w-64 sm:w-72 shrink-0 border-l border-stone-200/80 bg-stone-900/80 p-3.5 text-stone-200 flex flex-col h-full overflow-y-auto thin-scrollbar select-none dark:border-stone-800">
            {/* 顶栏：标题与关闭 */}
            <div className="flex items-center justify-between pb-3 border-b border-stone-800">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="size-2 rounded-full bg-amber-400" />
                    <span className="text-xs font-bold truncate">{selectedClip.name}</span>
                </div>
                <button
                    type="button"
                    onClick={() => selectClip(null)}
                    className="size-6 flex items-center justify-center rounded-md text-stone-400 hover:text-white hover:bg-stone-800"
                >
                    <X className="size-3.5" />
                </button>
            </div>

            <div className="mt-4 space-y-4 text-xs">
                {/* 片段名称重命名 */}
                <div>
                    <label className="text-[11px] text-stone-400 font-medium block mb-1">片段名称</label>
                    <Input
                        size="small"
                        value={selectedClip.name}
                        onChange={(e) => updateClip(selectedClip.id, { name: e.target.value })}
                        className="!bg-stone-800 !border-stone-700 !text-stone-100"
                    />
                </div>

                {/* 时间与裁剪信息 */}
                <div className="p-2.5 rounded-xl bg-stone-950/40 border border-stone-800/80 space-y-2">
                    <div className="flex justify-between items-center text-[11px]">
                        <span className="text-stone-400">时间轴起始点</span>
                        <span className="font-mono text-amber-400 font-bold">{formatTimecode(selectedClip.startTime, true)}</span>
                    </div>
                    <div className="flex justify-between items-center text-[11px]">
                        <span className="text-stone-400">有效播放时长</span>
                        <span className="font-mono text-emerald-400 font-bold">{effectiveDuration.toFixed(2)}s</span>
                    </div>
                    <div className="flex justify-between items-center text-[11px]">
                        <span className="text-stone-400">时间轴结束点</span>
                        <span className="font-mono text-stone-300 font-bold">{formatTimecode(getClipEndTime(selectedClip), true)}</span>
                    </div>
                </div>

                {/* 视频/音频：音量调节 */}
                {(selectedClip.type === "video" || selectedClip.type === "audio") ? (
                    <div>
                        <div className="flex justify-between items-center mb-1">
                            <label className="text-[11px] text-stone-400 font-medium flex items-center gap-1.5">
                                <Volume2 className="size-3.5 text-stone-400" />
                                <span>音量调节</span>
                            </label>
                            <span className="font-mono text-[11px] text-amber-400 font-bold">
                                {Math.round(selectedClip.volume * 100)}%
                            </span>
                        </div>
                        <Slider
                            min={0}
                            max={2}
                            step={0.05}
                            value={selectedClip.volume}
                            onChange={(val) => updateClip(selectedClip.id, { volume: val })}
                            tooltip={{ formatter: (v) => `${Math.round((v || 0) * 100)}%` }}
                        />
                    </div>
                ) : null}

                {/* 播放倍速 */}
                <div>
                    <div className="flex justify-between items-center mb-1">
                        <label className="text-[11px] text-stone-400 font-medium flex items-center gap-1.5">
                            <Gauge className="size-3.5 text-stone-400" />
                            <span>播放倍速</span>
                        </label>
                        <span className="font-mono text-[11px] text-amber-400 font-bold">
                            {selectedClip.speed}x
                        </span>
                    </div>
                    <Slider
                        min={0.5}
                        max={2.0}
                        step={0.1}
                        value={selectedClip.speed}
                        onChange={(val) => updateClip(selectedClip.id, { speed: val })}
                        tooltip={{ formatter: (v) => `${v}x` }}
                    />
                </div>

                {/* 文字字幕属性调节 */}
                {selectedClip.type === "text" && selectedClip.textProps ? (
                    <div className="space-y-3 pt-2 border-t border-stone-800">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-amber-400">
                            <Type className="size-3.5" />
                            <span>字幕与排版</span>
                        </div>

                        <div>
                            <label className="text-[11px] text-stone-400 block mb-1">字幕正文</label>
                            <Input.TextArea
                                rows={2}
                                value={selectedClip.textProps.text}
                                onChange={(e) =>
                                    updateClip(selectedClip.id, {
                                        textProps: { ...selectedClip.textProps!, text: e.target.value },
                                    })
                                }
                                className="!bg-stone-800 !border-stone-700 !text-stone-100 !text-xs"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="text-[11px] text-stone-400 block mb-1">字号 (px)</label>
                                <InputNumber
                                    size="small"
                                    min={14}
                                    max={72}
                                    value={selectedClip.textProps.fontSize}
                                    onChange={(v) =>
                                        updateClip(selectedClip.id, {
                                            textProps: { ...selectedClip.textProps!, fontSize: v || 28 },
                                        })
                                    }
                                    className="!w-full !bg-stone-800 !border-stone-700 !text-stone-100"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] text-stone-400 block mb-1">垂直位置 (%)</label>
                                <InputNumber
                                    size="small"
                                    min={10}
                                    max={95}
                                    value={selectedClip.textProps.yPercent}
                                    onChange={(v) =>
                                        updateClip(selectedClip.id, {
                                            textProps: { ...selectedClip.textProps!, yPercent: v || 80 },
                                        })
                                    }
                                    className="!w-full !bg-stone-800 !border-stone-700 !text-stone-100"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="text-[11px] text-stone-400 block mb-1">文字颜色</label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="color"
                                    value={selectedClip.textProps.color}
                                    onChange={(e) =>
                                        updateClip(selectedClip.id, {
                                            textProps: { ...selectedClip.textProps!, color: e.target.value },
                                        })
                                    }
                                    className="size-7 rounded cursor-pointer border-0 bg-transparent"
                                />
                                <span className="font-mono text-xs text-stone-300">{selectedClip.textProps.color}</span>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* 底部删除按钮 */}
                <div className="pt-4 border-t border-stone-800">
                    <button
                        type="button"
                        onClick={() => removeClip(selectedClip.id)}
                        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer text-xs font-semibold"
                    >
                        <Trash2 className="size-3.5" />
                        <span>移除此片段</span>
                    </button>
                </div>
            </div>
        </aside>
    );
}
