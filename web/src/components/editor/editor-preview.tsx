"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { Maximize2, Minimize2, Pause, Play, RotateCcw, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { Tooltip } from "antd";

import { useEditorStore, getClipEndTime, type EditorTrack } from "@/stores/use-editor-store";
import {
    formatTimecode,
    getCachedAudioElement,
    getCachedVideoElement,
    getResolutionForAspectRatio,
    renderCompositedFrame,
} from "@/services/editor-engine";

export function EditorPreview() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isPlaying = useEditorStore((state) => state.isPlaying);
    const togglePlay = useEditorStore((state) => state.togglePlay);
    const setIsPlaying = useEditorStore((state) => state.setIsPlaying);
    const currentTime = useEditorStore((state) => state.currentTime);
    const setCurrentTime = useEditorStore((state) => state.setCurrentTime);
    const aspectRatio = useEditorStore((state) => state.aspectRatio);
    const tracks = useEditorStore((state) => state.tracks);
    const getTotalDuration = useEditorStore((state) => state.getTotalDuration);

    const totalDuration = getTotalDuration();
    const { width: targetWidth, height: targetHeight } = getResolutionForAspectRatio(aspectRatio);

    const [isFullscreen, setIsFullscreen] = useState(false);

    // 统一多媒体播放控制、时钟走带与帧渲染（彻底解决循环 Seek 导致的画面黑屏与疯狂闪动）
    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d", { alpha: false });

        // 1. 播放进行时：统一由单一 requestAnimationFrame 推进时间走带、音频视频平滑播放与连续画面渲染
        if (isPlaying) {
            let animId: number;
            let lastTimestamp = performance.now();
            let currentPlayingVideoId: string | null = null;

            const syncMedia = (time: number) => {
                tracks.forEach((track) => {
                    track.clips.forEach((clip) => {
                        if (clip.type !== "video" && clip.type !== "audio") return;
                        const media = clip.type === "video" 
                            ? getCachedVideoElement(clip.sourceUrl) 
                            : getCachedAudioElement(clip.sourceUrl);

                        const start = clip.startTime;
                        const end = getClipEndTime(clip);
                        const isActive = time >= start && time < end;

                        if (isActive) {
                            const mediaOffset = clip.trimStart + (time - start) * clip.speed;
                            
                            // 刚切入此片段时，执行一次精准对齐并启动播放
                            if (clip.type === "video") {
                                if (currentPlayingVideoId !== clip.id || media.paused) {
                                    currentPlayingVideoId = clip.id;
                                    media.currentTime = Math.max(0, mediaOffset);
                                    media.playbackRate = clip.speed || 1.0;
                                    media.muted = track.muted;
                                    media.volume = Math.max(0, Math.min(1, clip.volume));
                                    void media.play().catch(() => {});
                                } else {
                                    // 正常连续播放中绝不频繁 seek，仅在严重卡顿漂移超过 400ms 时微调
                                    if (Math.abs(media.currentTime - mediaOffset) > 0.4) {
                                        media.currentTime = Math.max(0, mediaOffset);
                                    }
                                }
                            } else if (clip.type === "audio") {
                                if (media.paused) {
                                    media.currentTime = Math.max(0, mediaOffset);
                                    media.playbackRate = clip.speed || 1.0;
                                    media.muted = track.muted;
                                    media.volume = Math.max(0, Math.min(1, clip.volume));
                                    void media.play().catch(() => {});
                                } else if (Math.abs(media.currentTime - mediaOffset) > 0.4) {
                                    media.currentTime = Math.max(0, mediaOffset);
                                }
                            }
                        } else {
                            if (!media.paused) {
                                media.pause();
                            }
                        }
                    });
                });
            };

            const loop = (now: number) => {
                const deltaSeconds = (now - lastTimestamp) / 1000;
                lastTimestamp = now;

                const state = useEditorStore.getState();
                const total = state.getTotalDuration();
                const nextTime = state.currentTime + deltaSeconds;

                if (nextTime >= total) {
                    state.setCurrentTime(0);
                    state.setIsPlaying(false);
                    pauseAllMedia(tracks);
                    return;
                }

                syncMedia(nextTime);
                state.setCurrentTime(nextTime);

                if (ctx) {
                    renderCompositedFrame(ctx, targetWidth, targetHeight, nextTime, tracks);
                }

                animId = requestAnimationFrame(loop);
            };

            animId = requestAnimationFrame(loop);

            return () => {
                cancelAnimationFrame(animId);
                pauseAllMedia(tracks);
            };
        }

        // 2. 暂停/停止播放状态：立即暂停所有媒体元素，对当前播放头位置执行静态画面渲染
        pauseAllMedia(tracks);

        tracks.forEach((track) => {
            track.clips.forEach((clip) => {
                if (clip.type !== "video" && clip.type !== "audio") return;
                const media = clip.type === "video" 
                    ? getCachedVideoElement(clip.sourceUrl) 
                    : getCachedAudioElement(clip.sourceUrl);

                const start = clip.startTime;
                const end = getClipEndTime(clip);
                const isActive = currentTime >= start && currentTime < end;

                if (isActive) {
                    const mediaOffset = clip.trimStart + (currentTime - start) * clip.speed;
                    if (Math.abs(media.currentTime - mediaOffset) > 0.02) {
                        media.currentTime = Math.max(0, mediaOffset);
                    }
                    if (clip.type === "video" && ctx) {
                        const onReady = () => {
                            renderCompositedFrame(ctx, targetWidth, targetHeight, currentTime, tracks);
                        };
                        media.addEventListener("seeked", onReady, { once: true });
                        media.addEventListener("loadeddata", onReady, { once: true });
                    }
                }
            });
        });

        if (ctx) {
            renderCompositedFrame(ctx, targetWidth, targetHeight, currentTime, tracks);
        }
    }, [isPlaying, tracks, targetWidth, targetHeight]);

    // 暂停状态下响应用户拖动播放头 (Scrubbing)，画面实时平滑对齐
    useEffect(() => {
        if (isPlaying) return;

        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d", { alpha: false });

        tracks.forEach((track) => {
            track.clips.forEach((clip) => {
                if (clip.type !== "video") return;
                const media = getCachedVideoElement(clip.sourceUrl);
                const start = clip.startTime;
                const end = getClipEndTime(clip);
                const isActive = currentTime >= start && currentTime < end;

                if (isActive) {
                    const mediaOffset = clip.trimStart + (currentTime - start) * clip.speed;
                    if (Math.abs(media.currentTime - mediaOffset) > 0.02) {
                        media.currentTime = Math.max(0, mediaOffset);
                    }
                    if (ctx) {
                        const onReady = () => {
                            renderCompositedFrame(ctx, targetWidth, targetHeight, currentTime, tracks);
                        };
                        media.addEventListener("seeked", onReady, { once: true });
                    }
                }
            });
        });

        if (ctx) {
            renderCompositedFrame(ctx, targetWidth, targetHeight, currentTime, tracks);
        }
    }, [currentTime, isPlaying, tracks, targetWidth, targetHeight]);

    // 全局空格键监听播放/暂停
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            if (e.code === "Space") {
                e.preventDefault();
                togglePlay();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [togglePlay]);

    const toggleFullscreen = () => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) {
            void containerRef.current.requestFullscreen();
            setIsFullscreen(true);
        } else {
            void document.exitFullscreen();
            setIsFullscreen(false);
        }
    };

    return (
        <section
            ref={containerRef}
            className="flex-1 flex flex-col items-center justify-center bg-stone-950 p-4 relative overflow-hidden select-none min-h-0"
        >
            {/* 实时预览 Canvas 画布容器（按 AspectRatio 自适应包裹） */}
            <div className="flex-1 flex items-center justify-center w-full h-full min-h-0">
                <div
                    className="relative max-w-full max-h-full shadow-2xl rounded-lg overflow-hidden border border-stone-800 bg-black flex items-center justify-center"
                    style={{
                        aspectRatio: aspectRatio.replace(":", "/"),
                        width: aspectRatio === "9:16" ? "auto" : "100%",
                        height: aspectRatio === "9:16" ? "100%" : "auto",
                        maxHeight: "100%",
                        maxWidth: "100%",
                    }}
                >
                    <canvas
                        ref={canvasRef}
                        width={targetWidth}
                        height={targetHeight}
                        className="w-full h-full object-contain pointer-events-none"
                    />

                    {/* 未添加任何媒体时的提示 */}
                    {tracks.every((t) => t.clips.length === 0) ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-stone-500 gap-2 p-4 text-center pointer-events-none bg-stone-950/80">
                            <span className="text-sm font-medium">预览视口已就绪</span>
                            <span className="text-xs text-stone-600">从左侧素材库添加视频、贴图或文字开始剪辑</span>
                        </div>
                    ) : null}
                </div>
            </div>

            {/* 视口底部悬浮播放控制条 */}
            <div className="mt-3 flex items-center justify-between gap-3 px-4 py-2 rounded-xl bg-stone-900/90 border border-stone-800 backdrop-blur shadow-lg text-stone-300 w-full max-w-xl">
                <div className="flex items-center gap-2">
                    <Tooltip title="跳到开头">
                        <button
                            type="button"
                            onClick={() => setCurrentTime(0)}
                            className="size-8 rounded-lg flex items-center justify-center text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
                        >
                            <SkipBack className="size-4" />
                        </button>
                    </Tooltip>

                    <Tooltip title={isPlaying ? "暂停 (空格)" : "播放 (空格)"}>
                        <button
                            type="button"
                            onClick={togglePlay}
                            className="size-9 rounded-lg flex items-center justify-center bg-amber-500 text-stone-950 hover:bg-amber-400 transition-colors font-bold shadow-xs cursor-pointer"
                        >
                            {isPlaying ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
                        </button>
                    </Tooltip>

                    <Tooltip title="跳到结尾">
                        <button
                            type="button"
                            onClick={() => setCurrentTime(totalDuration)}
                            className="size-8 rounded-lg flex items-center justify-center text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
                        >
                            <SkipForward className="size-4" />
                        </button>
                    </Tooltip>
                </div>

                {/* 走带时间码展示 */}
                <div className="flex items-center gap-1.5 font-mono text-xs text-stone-300 tabular-nums">
                    <span className="font-bold text-amber-400">{formatTimecode(currentTime, true)}</span>
                    <span className="text-stone-600">/</span>
                    <span className="text-stone-500">{formatTimecode(totalDuration, true)}</span>
                </div>

                {/* 画幅标识与全屏 */}
                <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-stone-800 text-stone-400 border border-stone-700/50">
                        {aspectRatio}
                    </span>

                    <Tooltip title={isFullscreen ? "退出全屏" : "全屏预览"}>
                        <button
                            type="button"
                            onClick={toggleFullscreen}
                            className="size-8 rounded-lg flex items-center justify-center text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
                        >
                            {isFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                        </button>
                    </Tooltip>
                </div>
            </div>
        </section>
    );
}

function pauseAllMedia(tracks: EditorTrack[]) {
    tracks.forEach((track) => {
        track.clips.forEach((clip) => {
            if (clip.type === "video") {
                const v = getCachedVideoElement(clip.sourceUrl);
                if (!v.paused) v.pause();
            } else if (clip.type === "audio") {
                const a = getCachedAudioElement(clip.sourceUrl);
                if (!a.paused) a.pause();
            }
        });
    });
}
