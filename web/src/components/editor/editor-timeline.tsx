"use client";

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import {
    Eye,
    EyeOff,
    Film,
    Image as ImageIcon,
    Minus,
    Music2,
    Plus,
    Scissors,
    Trash2,
    Type,
    Volume2,
    VolumeX,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { Tooltip, Slider, Button, App } from "antd";

import {
    EditorClip,
    EditorTrack,
    getClipEffectiveDuration,
    getClipEndTime,
    useEditorStore,
} from "@/stores/use-editor-store";
import { formatTimecode } from "@/services/editor-engine";

export function EditorTimeline() {
    const { message } = App.useApp();
    const tracks = useEditorStore((state) => state.tracks);
    const currentTime = useEditorStore((state) => state.currentTime);
    const setCurrentTime = useEditorStore((state) => state.setCurrentTime);
    const pixelsPerSecond = useEditorStore((state) => state.pixelsPerSecond);
    const setPixelsPerSecond = useEditorStore((state) => state.setPixelsPerSecond);
    const selectedClipId = useEditorStore((state) => state.selectedClipId);
    const selectClip = useEditorStore((state) => state.selectClip);
    const updateClip = useEditorStore((state) => state.updateClip);
    const moveClip = useEditorStore((state) => state.moveClip);
    const removeClip = useEditorStore((state) => state.removeClip);
    const splitClipAtCurrentTime = useEditorStore((state) => state.splitClipAtCurrentTime);
    const toggleTrackMute = useEditorStore((state) => state.toggleTrackMute);
    const toggleTrackVisibility = useEditorStore((state) => state.toggleTrackVisibility);
    const getTotalDuration = useEditorStore((state) => state.getTotalDuration);

    const totalDuration = getTotalDuration();
    const timelineContainerRef = useRef<HTMLDivElement>(null);
    const tracksScrollRef = useRef<HTMLDivElement>(null);

    // 拖拽与裁剪状态
    const [draggingClip, setDraggingClip] = useState<{
        clipId: string;
        startX: number;
        originalStartTime: number;
    } | null>(null);

    const [trimmingClip, setTrimmingClip] = useState<{
        clipId: string;
        side: "start" | "end";
        startX: number;
        originalTrimStart: number;
        originalTrimEnd: number;
        originalStartTime: number;
    } | null>(null);

    const [isScrubbingPlayhead, setIsScrubbingPlayhead] = useState(false);

    // 点击标尺或拖动播放头
    const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!tracksScrollRef.current) return;
        const rect = tracksScrollRef.current.getBoundingClientRect();
        const scrollLeft = tracksScrollRef.current.scrollLeft;
        const clickX = e.clientX - rect.left + scrollLeft;
        const targetTime = Math.max(0, clickX / pixelsPerSecond);
        setCurrentTime(targetTime);
        setIsScrubbingPlayhead(true);
    };

    // 全局拖动走带或拖动片段
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isScrubbingPlayhead && tracksScrollRef.current) {
                const rect = tracksScrollRef.current.getBoundingClientRect();
                const scrollLeft = tracksScrollRef.current.scrollLeft;
                const clickX = e.clientX - rect.left + scrollLeft;
                const targetTime = Math.max(0, clickX / pixelsPerSecond);
                setCurrentTime(targetTime);
                return;
            }

            if (draggingClip) {
                const deltaX = e.clientX - draggingClip.startX;
                const deltaTime = deltaX / pixelsPerSecond;
                const newStart = Math.max(0, draggingClip.originalStartTime + deltaTime);
                moveClip(draggingClip.clipId, newStart);
                return;
            }

            if (trimmingClip) {
                const deltaX = e.clientX - trimmingClip.startX;
                const deltaTime = deltaX / pixelsPerSecond;
                if (trimmingClip.side === "start") {
                    const newTrimStart = Math.max(0, trimmingClip.originalTrimStart + deltaTime);
                    if (newTrimStart < trimmingClip.originalTrimEnd - 0.2) {
                        const newStartTime = trimmingClip.originalStartTime + deltaTime;
                        updateClip(trimmingClip.clipId, {
                            trimStart: newTrimStart,
                            startTime: Math.max(0, newStartTime),
                        });
                    }
                } else {
                    const newTrimEnd = Math.max(
                        trimmingClip.originalTrimStart + 0.2,
                        trimmingClip.originalTrimEnd + deltaTime
                    );
                    updateClip(trimmingClip.clipId, { trimEnd: newTrimEnd });
                }
            }
        };

        const handleMouseUp = () => {
            if (isScrubbingPlayhead) setIsScrubbingPlayhead(false);
            if (draggingClip) setDraggingClip(null);
            if (trimmingClip) setTrimmingClip(null);
        };

        if (isScrubbingPlayhead || draggingClip || trimmingClip) {
            window.addEventListener("mousemove", handleMouseMove);
            window.addEventListener("mouseup", handleMouseUp);
        }
        return () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };
    }, [
        isScrubbingPlayhead,
        draggingClip,
        trimmingClip,
        pixelsPerSecond,
        setCurrentTime,
        moveClip,
        updateClip,
    ]);

    // 刻度标尺渲染 (每秒或每5秒一个刻度)
    const rulerMarkers = useMemo(() => {
        const markers: Array<{ second: number; isMajor: boolean }> = [];
        const maxSec = Math.ceil(totalDuration + 10);
        const step = pixelsPerSecond >= 40 ? 1 : 5;
        for (let i = 0; i <= maxSec; i += step) {
            markers.push({ second: i, isMajor: i % 5 === 0 });
        }
        return markers;
    }, [totalDuration, pixelsPerSecond]);

    const timelineTotalWidth = Math.max(1200, (totalDuration + 15) * pixelsPerSecond);

    return (
        <section
            ref={timelineContainerRef}
            className="h-64 sm:h-72 shrink-0 border-t border-stone-200/80 bg-stone-900/90 text-stone-200 flex flex-col select-none dark:border-stone-800"
        >
            {/* 时间轴顶部工具行 */}
            <div className="h-10 px-4 border-b border-stone-800 flex items-center justify-between text-xs bg-stone-950/40">
                <div className="flex items-center gap-2">
                    <Tooltip title="分割当前选中的片段 (或在播放头处切断)">
                        <Button
                            size="small"
                            onClick={() => {
                                const ok = splitClipAtCurrentTime(selectedClipId || undefined);
                                if (!ok) {
                                    message.warning("请先选中一段视频或移动播放头至片段内部以执行分割切断。");
                                }
                            }}
                            icon={<Scissors className="size-3.5 text-amber-400" />}
                            className="!rounded-lg !text-xs !bg-stone-800 !border-stone-700 !text-stone-200 hover:!bg-stone-700"
                        >
                            分割片段
                        </Button>
                    </Tooltip>

                    {selectedClipId ? (
                        <Tooltip title="移除当前选中的片段">
                            <Button
                                size="small"
                                danger
                                onClick={() => removeClip(selectedClipId)}
                                icon={<Trash2 className="size-3.5" />}
                                className="!rounded-lg !text-xs"
                            >
                                删除
                            </Button>
                        </Tooltip>
                    ) : null}
                </div>

                {/* 缩放滑块 */}
                <div className="flex items-center gap-2 text-stone-400">
                    <ZoomOut
                        className="size-3.5 cursor-pointer hover:text-white"
                        onClick={() => setPixelsPerSecond(pixelsPerSecond - 15)}
                    />
                    <div className="w-24 sm:w-32">
                        <Slider
                            min={15}
                            max={160}
                            value={pixelsPerSecond}
                            onChange={setPixelsPerSecond}
                            tooltip={{ formatter: (v) => `${v}px/s` }}
                        />
                    </div>
                    <ZoomIn
                        className="size-3.5 cursor-pointer hover:text-white"
                        onClick={() => setPixelsPerSecond(pixelsPerSecond + 15)}
                    />
                </div>
            </div>

            {/* 时间轴多轨内容区 */}
            <div className="flex-1 flex min-h-0 overflow-hidden relative">
                {/* 1. 左侧固定：轨道头列表 (Track Headers) */}
                <div className="w-28 sm:w-36 shrink-0 border-r border-stone-800 bg-stone-950/70 flex flex-col z-20 shadow-md">
                    {/* 标尺占位头 */}
                    <div className="h-7 border-b border-stone-800 shrink-0 flex items-center px-2 text-[10px] text-stone-500 font-mono">
                        轨道
                    </div>

                    {/* 各轨道标题行 */}
                    <div className="flex-1 flex flex-col divide-y divide-stone-800/80">
                        {tracks.map((track) => (
                            <div
                                key={track.id}
                                className="h-14 px-2.5 flex items-center justify-between text-xs bg-stone-900/40"
                            >
                                <div className="flex items-center gap-1.5 min-w-0">
                                    {track.type === "video" ? (
                                        <Film className="size-3.5 text-amber-400 shrink-0" />
                                    ) : track.type === "audio" ? (
                                        <Music2 className="size-3.5 text-emerald-400 shrink-0" />
                                    ) : track.type === "text" ? (
                                        <Type className="size-3.5 text-indigo-400 shrink-0" />
                                    ) : (
                                        <ImageIcon className="size-3.5 text-sky-400 shrink-0" />
                                    )}
                                    <span className="truncate text-[11px] font-medium text-stone-300">
                                        {track.name}
                                    </span>
                                </div>

                                <div className="flex items-center gap-1 shrink-0">
                                    {track.type === "audio" || track.type === "video" ? (
                                        <button
                                            type="button"
                                            onClick={() => toggleTrackMute(track.id)}
                                            className={`size-5 rounded flex items-center justify-center transition-colors ${
                                                track.muted ? "text-red-400 bg-red-500/10" : "text-stone-500 hover:text-stone-300"
                                            }`}
                                            title={track.muted ? "取消静音" : "静音轨道"}
                                        >
                                            {track.muted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
                                        </button>
                                    ) : null}

                                    <button
                                        type="button"
                                        onClick={() => toggleTrackVisibility(track.id)}
                                        className={`size-5 rounded flex items-center justify-center transition-colors ${
                                            track.hidden ? "text-amber-400 bg-amber-500/10" : "text-stone-500 hover:text-stone-300"
                                        }`}
                                        title={track.hidden ? "显示轨道" : "隐藏轨道"}
                                    >
                                        {track.hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* 2. 右侧横向滚动轨道内容区 */}
                <div
                    ref={tracksScrollRef}
                    className="flex-1 overflow-x-auto overflow-y-hidden relative thin-scrollbar"
                >
                    <div
                        style={{ width: timelineTotalWidth }}
                        className="h-full flex flex-col relative"
                    >
                        {/* 时间标尺 (Time Ruler) */}
                        <div
                            onMouseDown={handleRulerMouseDown}
                            className="h-7 border-b border-stone-800 bg-stone-950/60 relative cursor-pointer shrink-0"
                        >
                            {rulerMarkers.map((m) => (
                                <div
                                    key={m.second}
                                    style={{ left: m.second * pixelsPerSecond }}
                                    className="absolute top-0 bottom-0 flex flex-col justify-between pointer-events-none"
                                >
                                    <span
                                        className={`text-[9px] font-mono leading-none pl-1 select-none ${
                                            m.isMajor ? "text-stone-400 font-bold" : "text-stone-600"
                                        }`}
                                    >
                                        {formatTimecode(m.second)}
                                    </span>
                                    <div
                                        className={`w-px ${
                                            m.isMajor ? "h-3 bg-stone-600" : "h-1.5 bg-stone-800"
                                        }`}
                                    />
                                </div>
                            ))}
                        </div>

                        {/* 轨道泳道 (Track Lanes) */}
                        <div className="flex-1 flex flex-col divide-y divide-stone-800/80 relative">
                            {tracks.map((track) => (
                                <div
                                    key={track.id}
                                    className={`h-14 relative overflow-hidden transition-opacity ${
                                        track.hidden ? "opacity-30" : "opacity-100"
                                    }`}
                                >
                                    {/* 背景辅助对齐网格 */}
                                    <div className="absolute inset-0 bg-stone-900/20 pointer-events-none" />

                                    {/* 片段卡片列表 */}
                                    {track.clips.map((clip) => {
                                        const effectiveDuration = getClipEffectiveDuration(clip);
                                        const widthPx = Math.max(30, effectiveDuration * pixelsPerSecond);
                                        const leftPx = clip.startTime * pixelsPerSecond;
                                        const isSelected = selectedClipId === clip.id;

                                        // 根据轨道类型赋予专属设计质感
                                        const colorClass =
                                            clip.type === "video"
                                                ? "bg-amber-950/40 border-amber-500/60 text-amber-200"
                                                : clip.type === "audio"
                                                ? "bg-emerald-950/40 border-emerald-500/60 text-emerald-200"
                                                : clip.type === "text"
                                                ? "bg-indigo-950/40 border-indigo-500/60 text-indigo-200"
                                                : "bg-sky-950/40 border-sky-500/60 text-sky-200";

                                        return (
                                            <div
                                                key={clip.id}
                                                style={{ left: leftPx, width: widthPx }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    selectClip(clip.id);
                                                }}
                                                onMouseDown={(e) => {
                                                    // 排除点击左右拉手
                                                    if ((e.target as HTMLElement).closest("[data-trim-handle]")) return;
                                                    selectClip(clip.id);
                                                    setDraggingClip({
                                                        clipId: clip.id,
                                                        startX: e.clientX,
                                                        originalStartTime: clip.startTime,
                                                    });
                                                }}
                                                className={`absolute top-1.5 bottom-1.5 rounded-lg border flex items-center px-2 text-xs font-medium cursor-move overflow-hidden transition-shadow shadow-xs group ${colorClass} ${
                                                    isSelected ? "ring-2 ring-amber-400 ring-offset-1 ring-offset-black z-10" : "hover:border-stone-400"
                                                }`}
                                            >
                                                {/* 左侧裁剪拉伸把手 */}
                                                <div
                                                    data-trim-handle
                                                    onMouseDown={(e) => {
                                                        e.stopPropagation();
                                                        setTrimmingClip({
                                                            clipId: clip.id,
                                                            side: "start",
                                                            startX: e.clientX,
                                                            originalTrimStart: clip.trimStart,
                                                            originalTrimEnd: clip.trimEnd,
                                                            originalStartTime: clip.startTime,
                                                        });
                                                    }}
                                                    className="absolute left-0 top-0 bottom-0 w-2.5 bg-white/20 hover:bg-white/40 cursor-ew-resize opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
                                                >
                                                    <div className="w-0.5 h-3 bg-white/60 rounded-full" />
                                                </div>

                                                {/* 片段正文标题 */}
                                                <div className="truncate flex-1 min-w-0 text-[11px] select-none pointer-events-none">
                                                    <span>{clip.name}</span>
                                                    <span className="text-[10px] opacity-70 ml-1.5 font-mono">
                                                        ({effectiveDuration.toFixed(1)}s)
                                                    </span>
                                                </div>

                                                {/* 右侧裁剪拉伸把手 */}
                                                <div
                                                    data-trim-handle
                                                    onMouseDown={(e) => {
                                                        e.stopPropagation();
                                                        setTrimmingClip({
                                                            clipId: clip.id,
                                                            side: "end",
                                                            startX: e.clientX,
                                                            originalTrimStart: clip.trimStart,
                                                            originalTrimEnd: clip.trimEnd,
                                                            originalStartTime: clip.startTime,
                                                        });
                                                    }}
                                                    className="absolute right-0 top-0 bottom-0 w-2.5 bg-white/20 hover:bg-white/40 cursor-ew-resize opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
                                                >
                                                    <div className="w-0.5 h-3 bg-white/60 rounded-full" />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>

                        {/* 3. 走带播放头指针线 (Playhead) */}
                        <div
                            style={{ left: currentTime * pixelsPerSecond }}
                            className="absolute top-0 bottom-0 w-px bg-amber-400 z-30 pointer-events-none flex flex-col items-center shadow-lg"
                        >
                            {/* 顶部红/金三角指针头 */}
                            <div
                                onMouseDown={(e) => {
                                    e.stopPropagation();
                                    setIsScrubbingPlayhead(true);
                                }}
                                className="size-3.5 -mt-0.5 bg-amber-400 rotate-45 pointer-events-auto cursor-ew-resize shadow-md rounded-[2px]"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
