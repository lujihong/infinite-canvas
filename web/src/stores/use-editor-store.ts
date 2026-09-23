"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";
import { useUserStore } from "@/stores/use-user-store";
import { canPersistSessionData, captureSessionIdentity, isSessionIdentityCurrent } from "@/lib/session-identity";

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3";
export type TrackType = "video" | "audio" | "text" | "overlay";
export type ClipType = "video" | "audio" | "image" | "text";

export type EditorTextProps = {
    text: string;
    fontSize: number; // 像素
    color: string; // 颜色 hex/rgb
    bgColor?: string; // 背景色
    yPercent: number; // 垂直位置百分比 0-100 (默认 80% 底部)
    fontStyle?: "normal" | "bold";
    align?: "left" | "center" | "right";
};

export type EditorClip = {
    id: string;
    trackId: string;
    name: string;
    type: ClipType;
    sourceUrl: string;
    storageKey?: string;
    thumbnailUrl?: string;
    duration: number; // 原始媒体长度（秒）
    startTime: number; // 在时间轴上的起点（秒）
    trimStart: number; // 裁剪起始偏移（秒）
    trimEnd: number; // 裁剪结束偏移（秒）
    volume: number; // 0 ~ 2 (1.0 为原始音量)
    speed: number; // 0.5 ~ 4.0 (1.0 为正常速度)
    textProps?: EditorTextProps;
};

export function getClipEffectiveDuration(clip: EditorClip): number {
    if (!clip || typeof clip !== "object") return 1.0;
    const duration = typeof clip.duration === "number" && !isNaN(clip.duration) && clip.duration > 0 ? clip.duration : 5;
    const trimStart = typeof clip.trimStart === "number" && !isNaN(clip.trimStart) ? Math.max(0, clip.trimStart) : 0;
    const trimEnd = typeof clip.trimEnd === "number" && !isNaN(clip.trimEnd) && clip.trimEnd > trimStart ? clip.trimEnd : duration;
    const raw = Math.max(0.1, trimEnd - trimStart);
    const speed = typeof clip.speed === "number" && !isNaN(clip.speed) && clip.speed > 0 ? clip.speed : 1.0;
    return raw / speed;
}

export function getClipEndTime(clip: EditorClip): number {
    if (!clip || typeof clip !== "object") return 0;
    const startTime = typeof clip.startTime === "number" && !isNaN(clip.startTime) ? Math.max(0, clip.startTime) : 0;
    return startTime + getClipEffectiveDuration(clip);
}

export function normalizeEditorTracks(rawTracks: unknown): EditorTrack[] {
    if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
        return DEFAULT_TRACKS.map((t) => ({ ...t, clips: [] }));
    }
    return DEFAULT_TRACKS.map((defTrack) => {
        const found = rawTracks.find((t) => t && typeof t === "object" && t.id === defTrack.id);
        if (!found) return { ...defTrack, clips: [] };
        const rawClips = Array.isArray(found.clips) ? found.clips : [];
        const validClips: EditorClip[] = rawClips
            .filter((c: unknown): c is Record<string, unknown> => Boolean(c && typeof c === "object" && typeof (c as Record<string, unknown>).id === "string"))
            .map((c: Record<string, unknown>): EditorClip => {
                const duration = typeof c.duration === "number" && !isNaN(c.duration) && c.duration > 0 ? c.duration : 5;
                const trimStart = typeof c.trimStart === "number" && !isNaN(c.trimStart) ? Math.max(0, c.trimStart) : 0;
                const trimEnd = typeof c.trimEnd === "number" && !isNaN(c.trimEnd) && c.trimEnd > trimStart ? c.trimEnd : duration;
                return {
                    id: String(c.id),
                    trackId: defTrack.id,
                    name: typeof c.name === "string" ? c.name : "片段",
                    type: (c.type as ClipType) || (defTrack.type === "audio" ? "audio" : defTrack.type === "text" ? "text" : defTrack.type === "overlay" ? "image" : "video"),
                    sourceUrl: typeof c.sourceUrl === "string" ? c.sourceUrl : "",
                    storageKey: typeof c.storageKey === "string" ? c.storageKey : undefined,
                    thumbnailUrl: typeof c.thumbnailUrl === "string" ? c.thumbnailUrl : undefined,
                    duration,
                    startTime: typeof c.startTime === "number" && !isNaN(c.startTime) ? Math.max(0, c.startTime) : 0,
                    trimStart,
                    trimEnd,
                    volume: typeof c.volume === "number" && !isNaN(c.volume) ? c.volume : 1.0,
                    speed: typeof c.speed === "number" && !isNaN(c.speed) && c.speed > 0 ? c.speed : 1.0,
                    textProps: c.textProps as EditorTextProps | undefined,
                };
            })
            .sort((a: EditorClip, b: EditorClip) => a.startTime - b.startTime);

        return {
            ...defTrack,
            muted: Boolean(found.muted),
            hidden: Boolean(found.hidden),
            clips: validClips,
        };
    });
}

export type EditorTrack = {
    id: string;
    type: TrackType;
    name: string;
    muted: boolean;
    hidden: boolean;
    clips: EditorClip[];
};

export const DEFAULT_TRACKS: EditorTrack[] = [
    {
        id: "track-main-video",
        type: "video",
        name: "主视频轨",
        muted: false,
        hidden: false,
        clips: [],
    },
    {
        id: "track-overlay-image",
        type: "overlay",
        name: "贴图/画中画轨",
        muted: false,
        hidden: false,
        clips: [],
    },
    {
        id: "track-audio-bgm",
        type: "audio",
        name: "背景音频轨",
        muted: false,
        hidden: false,
        clips: [],
    },
    {
        id: "track-subtitle-text",
        type: "text",
        name: "文字字幕轨",
        muted: false,
        hidden: false,
        clips: [],
    },
];

type EditorStore = {
    activeProjectId: string;
    projectTitle: string;
    aspectRatio: AspectRatio;
    fps: number;
    tracks: EditorTrack[];
    currentTime: number;
    isPlaying: boolean;
    pixelsPerSecond: number;
    selectedClipId: string | null;

    // 播放控制
    setActiveProjectId: (projectId: string) => void;
    setCurrentTime: (time: number) => void;
    setIsPlaying: (playing: boolean) => void;
    togglePlay: () => void;
    setPixelsPerSecond: (zoom: number) => void;
    setAspectRatio: (ratio: AspectRatio) => void;
    setProjectTitle: (title: string) => void;
    selectClip: (clipId: string | null) => void;

    // 片段与轨道操作
    addClipToTrack: (trackType: TrackType, clipData: Partial<EditorClip>) => string;
    importMediaClipsSequentially: (
        items: Array<{
            name: string;
            url: string;
            type: "video" | "audio" | "image";
            duration?: number;
            storageKey?: string;
        }>
    ) => void;
    updateClip: (clipId: string, patch: Partial<EditorClip>) => void;
    removeClip: (clipId: string) => void;
    splitClipAtCurrentTime: (clipId?: string) => boolean;
    moveClip: (clipId: string, newStartTime: number, targetTrackId?: string) => void;
    trimClip: (clipId: string, newTrimStart: number, newTrimEnd: number) => void;
    toggleTrackMute: (trackId: string) => void;
    toggleTrackVisibility: (trackId: string) => void;
    clearProject: () => void;
    loadUserProject: (userId?: string, projectId?: string) => void;
    loadProjectDraft: (projectId?: string, userId?: string) => void;

    // 辅助计算
    getTotalDuration: () => number;
    getSelectedClip: () => EditorClip | null;
};

let currentActiveProjectId = "default";

export const useEditorStore = create<EditorStore>()(
    persist(
        (set, get) => ({
            activeProjectId: "default",
            projectTitle: "未命名剪辑工程",
            aspectRatio: "16:9",
            fps: 30,
            tracks: normalizeEditorTracks(DEFAULT_TRACKS),
            currentTime: 0,
            isPlaying: false,
            pixelsPerSecond: 50, // 默认每秒 50px
            selectedClipId: null,

            setActiveProjectId: (projectId) => {
                currentActiveProjectId = projectId.trim() || "default";
                set({ activeProjectId: currentActiveProjectId });
            },

            setCurrentTime: (time) => {
                const total = get().getTotalDuration();
                const clamped = Math.max(0, Math.min(time, Math.max(total, 0.1)));
                set({ currentTime: clamped });
            },

            setIsPlaying: (playing) => set({ isPlaying: playing }),

            togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),

            setPixelsPerSecond: (zoom) => {
                const clamped = Math.max(10, Math.min(200, zoom));
                set({ pixelsPerSecond: clamped });
            },

            setAspectRatio: (ratio) => set({ aspectRatio: ratio }),

            setProjectTitle: (title) => set({ projectTitle: title.trim() || "未命名剪辑工程" }),

            selectClip: (clipId) => set({ selectedClipId: clipId }),

            addClipToTrack: (trackType, clipData) => {
                const state = get();
                let currentTracks = [...state.tracks];
                let targetTrack = currentTracks.find((t) => t.type === trackType);
                if (!targetTrack) {
                    targetTrack = {
                        id: `track-${trackType}-${nanoid(6)}`,
                        type: trackType,
                        name: trackType === "video" ? "视频轨" : trackType === "audio" ? "音频轨" : trackType === "text" ? "文字轨" : "贴图轨",
                        muted: false,
                        hidden: false,
                        clips: [],
                    };
                    currentTracks = [...currentTracks, targetTrack];
                }

                const duration = Math.max(0.5, clipData.duration || (clipData.type === "image" || clipData.type === "text" ? 3 : 5));
                // 默认紧接着该轨道的最后一个片段，若轨道为空则从当前播放头位置开始
                const lastClip = targetTrack.clips[targetTrack.clips.length - 1];
                const startTime = clipData.startTime !== undefined 
                    ? clipData.startTime 
                    : lastClip 
                        ? getClipEndTime(lastClip) 
                        : state.currentTime;

                const newClip: EditorClip = {
                    id: clipData.id || `clip-${nanoid(8)}`,
                    trackId: targetTrack.id,
                    name: clipData.name || (clipData.type === "video" ? "视频片段" : clipData.type === "audio" ? "音频片段" : clipData.type === "text" ? "文本字幕" : "贴图"),
                    type: clipData.type || (trackType === "audio" ? "audio" : trackType === "text" ? "text" : trackType === "overlay" ? "image" : "video"),
                    sourceUrl: clipData.sourceUrl || "",
                    storageKey: clipData.storageKey,
                    thumbnailUrl: clipData.thumbnailUrl,
                    duration,
                    startTime,
                    trimStart: Math.max(0, clipData.trimStart || 0),
                    trimEnd: Math.max(0.1, clipData.trimEnd || duration),
                    volume: clipData.volume !== undefined ? clipData.volume : 1.0,
                    speed: clipData.speed !== undefined ? clipData.speed : 1.0,
                    textProps: clipData.textProps || (clipData.type === "text" || trackType === "text" ? {
                        text: clipData.name || "添加标题文字",
                        fontSize: 28,
                        color: "#FFFFFF",
                        yPercent: 82,
                        fontStyle: "bold",
                        align: "center",
                    } : undefined),
                };

                const nextTracks = currentTracks.map((track) => {
                    if (track.id === targetTrack!.id) {
                        return {
                            ...track,
                            clips: [...track.clips, newClip].sort((a, b) => a.startTime - b.startTime),
                        };
                    }
                    return track;
                });

                set({ tracks: nextTracks, selectedClipId: newClip.id });
                return newClip.id;
            },

            importMediaClipsSequentially: (items) => {
                if (!items.length) return;
                const state = get();
                const videoTrack = state.tracks.find((t) => t.type === "video") || state.tracks[0];
                let currentStart = videoTrack?.clips.length 
                    ? getClipEndTime(videoTrack.clips[videoTrack.clips.length - 1]) 
                    : 0;

                const newClips: EditorClip[] = [];
                items.forEach((item, index) => {
                    const dur = Math.max(0.5, item.duration || 5.0);
                    newClips.push({
                        id: `clip-imported-${nanoid(6)}-${index}`,
                        trackId: videoTrack.id,
                        name: item.name || `镜头 0${index + 1}`,
                        type: item.type === "audio" ? "audio" : item.type === "image" ? "image" : "video",
                        sourceUrl: item.url,
                        storageKey: item.storageKey,
                        duration: dur,
                        startTime: currentStart,
                        trimStart: 0,
                        trimEnd: dur,
                        volume: 1.0,
                        speed: 1.0,
                    });
                    currentStart += dur;
                });

                const nextTracks = state.tracks.map((t) => {
                    if (t.id === videoTrack.id) {
                        return {
                            ...t,
                            clips: [...t.clips, ...newClips].sort((a, b) => a.startTime - b.startTime),
                        };
                    }
                    return t;
                });

                set({ tracks: nextTracks, selectedClipId: newClips[0]?.id || null });
            },

            updateClip: (clipId, patch) => {
                set((state) => ({
                    tracks: state.tracks.map((track) => ({
                        ...track,
                        clips: track.clips.map((clip) => {
                            if (clip.id !== clipId) return clip;
                            const next = { ...clip, ...patch };
                            // 确保裁剪起止区间合法
                            if (next.trimStart < 0) next.trimStart = 0;
                            if (next.trimEnd > next.duration) next.trimEnd = next.duration;
                            if (next.trimStart >= next.trimEnd) next.trimStart = Math.max(0, next.trimEnd - 0.1);
                            return next;
                        }),
                    })),
                }));
            },

            removeClip: (clipId) => {
                set((state) => ({
                    selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
                    tracks: state.tracks.map((track) => ({
                        ...track,
                        clips: track.clips.filter((clip) => clip.id !== clipId),
                    })),
                }));
            },

            splitClipAtCurrentTime: (clipId) => {
                const state = get();
                const time = state.currentTime;
                // 若未明确指定，优先取当前选中的片段，其次取播放头当前正好穿过的片段
                let targetClip: EditorClip | null = null;
                let targetTrack: EditorTrack | null = null;

                for (const t of state.tracks) {
                    for (const c of t.clips) {
                        const start = c.startTime;
                        const end = getClipEndTime(c);
                        if (clipId ? c.id === clipId : (time > start && time < end)) {
                            targetClip = c;
                            targetTrack = t;
                            break;
                        }
                    }
                    if (targetClip) break;
                }

                if (!targetClip || !targetTrack) return false;

                const start = targetClip.startTime;
                const end = getClipEndTime(targetClip);
                if (time <= start + 0.1 || time >= end - 0.1) return false;

                // 计算分割点在原始媒体中的时间偏移
                const elapsedInTimeline = time - start;
                const splitMediaOffset = targetClip.trimStart + elapsedInTimeline * targetClip.speed;

                // 前半段：保留原 ID，trimEnd 截断到分割点
                const firstClip: EditorClip = {
                    ...targetClip,
                    trimEnd: splitMediaOffset,
                };

                // 后半段：创建新 ID，startTime 设置为当前时间，trimStart 从分割点开始
                const secondClip: EditorClip = {
                    ...targetClip,
                    id: `clip-split-${nanoid(8)}`,
                    startTime: time,
                    trimStart: splitMediaOffset,
                    name: `${targetClip.name} (后半段)`,
                };

                const nextClips = targetTrack.clips
                    .map((c) => (c.id === targetClip!.id ? firstClip : c))
                    .concat(secondClip)
                    .sort((a, b) => a.startTime - b.startTime);

                const nextTracks = state.tracks.map((t) => (t.id === targetTrack!.id ? { ...t, clips: nextClips } : t));

                set({ tracks: nextTracks, selectedClipId: secondClip.id });
                return true;
            },

            moveClip: (clipId, newStartTime, targetTrackId) => {
                set((state) => {
                    let movingClip: EditorClip | null = null;
                    let fromTrackId: string | null = null;

                    for (const t of state.tracks) {
                        const found = t.clips.find((c) => c.id === clipId);
                        if (found) {
                            movingClip = found;
                            fromTrackId = t.id;
                            break;
                        }
                    }

                    if (!movingClip) return state;

                    const safeStartTime = Math.max(0, newStartTime);
                    const destTrackId = targetTrackId || fromTrackId!;

                    const updatedClip = {
                        ...movingClip,
                        trackId: destTrackId,
                        startTime: safeStartTime,
                    };

                    const nextTracks = state.tracks.map((track) => {
                        // 从原轨道移除
                        let trackClips = track.clips.filter((c) => c.id !== clipId);
                        // 如果是目标轨道，插入更新后的片段并排序
                        if (track.id === destTrackId) {
                            trackClips = [...trackClips, updatedClip].sort((a, b) => a.startTime - b.startTime);
                        }
                        return { ...track, clips: trackClips };
                    });

                    return { tracks: nextTracks };
                });
            },

            trimClip: (clipId, newTrimStart, newTrimEnd) => {
                get().updateClip(clipId, { trimStart: newTrimStart, trimEnd: newTrimEnd });
            },

            toggleTrackMute: (trackId) => {
                set((state) => ({
                    tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
                }));
            },

            toggleTrackVisibility: (trackId) => {
                set((state) => ({
                    tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, hidden: !t.hidden } : t)),
                }));
            },

            clearProject: () => {
                set({
                    projectTitle: "未命名剪辑工程",
                    currentTime: 0,
                    isPlaying: false,
                    selectedClipId: null,
                    tracks: DEFAULT_TRACKS.map((t) => ({ ...t, clips: [] })),
                });
            },

            getTotalDuration: () => {
                const { tracks } = get();
                let maxEnd = 0;
                tracks.forEach((track) => {
                    track.clips.forEach((clip) => {
                        const end = getClipEndTime(clip);
                        if (end > maxEnd) maxEnd = end;
                    });
                });
                return Math.max(maxEnd, 5.0); // 至少 5 秒展示刻度
            },

            getSelectedClip: () => {
                const { tracks, selectedClipId } = get();
                if (!selectedClipId) return null;
                for (const track of tracks) {
                    for (const clip of track.clips) {
                        if (clip.id === selectedClipId) return clip;
                    }
                }
                return null;
            },

            loadProjectDraft: (projectId = "", userId = "") => {
                if (typeof window === "undefined") return;
                const identity = captureSessionIdentity();
                const targetUserId = userId || useUserStore.getState().user?.id || "guest";
                const targetProjectId = projectId.trim() || "default";
                const key = `infinite-canvas:editor_store:${targetUserId}:${targetProjectId}`;
                const raw = window.localStorage.getItem(key);
                if (!isSessionIdentityCurrent(identity) || targetUserId !== (identity.userId || "guest")) return;
                currentActiveProjectId = targetProjectId;
                if (raw) {
                    try {
                        const parsed = JSON.parse(raw);
                        const state = parsed.state || parsed;
                        set({
                            activeProjectId: targetProjectId,
                            projectTitle: typeof state.projectTitle === "string" ? state.projectTitle : "未命名剪辑工程",
                            aspectRatio: state.aspectRatio || "16:9",
                            fps: state.fps || 30,
                            tracks: normalizeEditorTracks(state.tracks),
                            pixelsPerSecond: typeof state.pixelsPerSecond === "number" ? state.pixelsPerSecond : 50,
                            currentTime: 0,
                            isPlaying: false,
                            selectedClipId: null,
                        });
                        return;
                    } catch {}
                }
                // 未找到该项目的草稿时，重置为该项目专属的干净时间轴初始状态
                set({
                    activeProjectId: targetProjectId,
                    projectTitle: "未命名剪辑工程",
                    currentTime: 0,
                    isPlaying: false,
                    selectedClipId: null,
                    tracks: DEFAULT_TRACKS.map((t) => ({ ...t, clips: [] })),
                });
            },

            loadUserProject: (userId, projectId) => {
                get().loadProjectDraft(projectId, userId);
            },
        }),
        {
            name: "infinite-canvas:editor_store",
            storage: createJSONStorage(() => ({
                getItem: (key) => {
                    if (typeof window === "undefined") return null;
                    const scopedKey = `${key}:${captureSessionIdentity().userId || "guest"}:${currentActiveProjectId || "default"}`;
                    return window.localStorage.getItem(scopedKey);
                },
                setItem: (key, value) => {
                    if (typeof window === "undefined" || !canPersistSessionData()) return;
                    const scopedKey = `${key}:${captureSessionIdentity().userId || "guest"}:${currentActiveProjectId || "default"}`;
                    window.localStorage.setItem(scopedKey, value);
                },
                removeItem: (key) => {
                    if (typeof window === "undefined" || !canPersistSessionData()) return;
                    const scopedKey = `${key}:${captureSessionIdentity().userId || "guest"}:${currentActiveProjectId || "default"}`;
                    window.localStorage.removeItem(scopedKey);
                },
            })),
            partialize: (state) => ({
                activeProjectId: state.activeProjectId,
                projectTitle: state.projectTitle,
                aspectRatio: state.aspectRatio,
                fps: state.fps,
                tracks: state.tracks,
                pixelsPerSecond: state.pixelsPerSecond,
            }),
            onRehydrateStorage: () => (state) => {
                if (state && state.tracks) {
                    state.tracks = normalizeEditorTracks(state.tracks);
                }
            },
        }
    )
);
