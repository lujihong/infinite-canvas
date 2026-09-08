"use client";

import { useState, useRef, useMemo } from "react";
import { FolderPlus, Image as ImageIcon, Music2, Plus, Scissors, Type, Upload, Video, Sparkles, Film } from "lucide-react";
import { App, Button, Empty, Tabs } from "antd";

import { useAssetStore, type VideoAsset, type AudioAsset, type ImageAsset } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/app/(user)/canvas/types";
import { useEditorStore } from "@/stores/use-editor-store";
import { sortStoryboardVideoNodes } from "@/app/(user)/canvas/utils/canvas-storyboard-sort";

export function EditorMediaSidebar({ projectId }: { projectId?: string } = {}) {
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState<string>("assets");

    // 直通全局素材库
    const assets = useAssetStore((state) => state.assets);
    const videoAssets = useMemo(() => assets.filter((a): a is VideoAsset => a.kind === "video"), [assets]);
    const audioAssets = useMemo(() => assets.filter((a): a is AudioAsset => a.kind === "audio"), [assets]);
    const imageAssets = useMemo(() => assets.filter((a): a is ImageAsset => a.kind === "image"), [assets]);

    // 直通当前画布项目的已生成视频分镜（严格按项目隔离，杜绝与其他画布混淆）
    const projects = useCanvasStore((state) => state.projects);
    const currentProject = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

    const canvasVideos = useMemo(() => {
        const targetProjects = currentProject ? [currentProject] : projects;
        const list: Array<{ id: string; title: string; url: string; projectTitle: string; duration: number }> = [];

        targetProjects.forEach((proj) => {
            const rawVideoNodes = (proj.nodes || []).filter(
                (node): node is CanvasNodeData => node.type === CanvasNodeType.Video && Boolean(node.metadata?.content)
            );
            // 基于智能拓扑连线流向、分镜编号及空间故事板阅读顺序精准排序
            const sortedNodes = sortStoryboardVideoNodes(rawVideoNodes, proj.connections || []);

            sortedNodes.forEach((node) => {
                const dur = Number(node.metadata?.seconds) || (node.metadata?.durationMs ? node.metadata.durationMs / 1000 : 6);
                list.push({
                    id: node.id,
                    title: node.title || "画布分镜",
                    url: node.metadata!.content!,
                    projectTitle: proj.title || "未命名画布",
                    duration: dur,
                });
            });
        });
        return list;
    }, [projects, currentProject]);

    const addClipToTrack = useEditorStore((state) => state.addClipToTrack);
    const importMediaClipsSequentially = useEditorStore((state) => state.importMediaClipsSequentially);

    // 本地文件上传处理
    const handleLocalUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;

        const importedItems: Array<{ name: string; url: string; type: "video" | "audio" | "image"; duration?: number }> = [];

        files.forEach((file) => {
            const blobUrl = URL.createObjectURL(file);
            const isVideo = file.type.startsWith("video/");
            const isAudio = file.type.startsWith("audio/");
            const isImage = file.type.startsWith("image/");

            if (isVideo) {
                let added = false;
                const tempVideo = document.createElement("video");
                tempVideo.preload = "metadata";
                const add = (dur: number) => {
                    if (added) return;
                    added = true;
                    addClipToTrack("video", {
                        name: file.name.replace(/\.[^/.]+$/, ""),
                        type: "video",
                        sourceUrl: blobUrl,
                        duration: dur && !isNaN(dur) && dur > 0 ? dur : 5,
                    });
                };
                tempVideo.onloadedmetadata = () => add(tempVideo.duration);
                tempVideo.onerror = () => add(5);
                setTimeout(() => add(5), 2000);
                tempVideo.src = blobUrl;
            } else if (isAudio) {
                let added = false;
                const tempAudio = document.createElement("audio");
                tempAudio.preload = "metadata";
                const add = (dur: number) => {
                    if (added) return;
                    added = true;
                    addClipToTrack("audio", {
                        name: file.name.replace(/\.[^/.]+$/, ""),
                        type: "audio",
                        sourceUrl: blobUrl,
                        duration: dur && !isNaN(dur) && dur > 0 ? dur : 10,
                    });
                };
                tempAudio.onloadedmetadata = () => add(tempAudio.duration);
                tempAudio.onerror = () => add(10);
                setTimeout(() => add(10), 2000);
                tempAudio.src = blobUrl;
            } else if (isImage) {
                addClipToTrack("overlay", {
                    name: file.name.replace(/\.[^/.]+$/, ""),
                    type: "image",
                    sourceUrl: blobUrl,
                    duration: 3,
                });
            }
        });

        message.success(`已导入 ${files.length} 个本地素材到时间轴`);
        e.target.value = "";
    };

    return (
        <aside className="w-64 sm:w-72 shrink-0 border-r border-stone-200/80 bg-stone-900/60 flex flex-col h-full select-none text-stone-200 dark:border-stone-800">
            {/* 顶栏快速导入按钮 */}
            <div className="p-3 border-b border-stone-800 flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-stone-300">素材媒体库</span>
                <Button
                    size="small"
                    onClick={() => fileInputRef.current?.click()}
                    icon={<Upload className="size-3.5" />}
                    className="!rounded-lg !text-xs !bg-stone-800 !border-stone-700 !text-stone-200 hover:!bg-stone-700"
                >
                    本地文件
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="video/mp4,video/webm,video/quicktime,audio/mp3,audio/wav,image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={handleLocalUpload}
                />
            </div>

            {/* 素材分类选项卡 */}
            <div className="flex-1 flex flex-col min-h-0">
                <div className="grid grid-cols-4 p-1.5 gap-1 border-b border-stone-800 text-[11px] font-medium bg-stone-950/40">
                    <button
                        type="button"
                        onClick={() => setActiveTab("assets")}
                        className={`py-1.5 rounded-md text-center transition-colors cursor-pointer ${
                            activeTab === "assets"
                                ? "bg-stone-800 text-amber-400 font-bold"
                                : "text-stone-400 hover:text-stone-200"
                        }`}
                    >
                        我的素材
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab("canvas")}
                        className={`py-1.5 rounded-md text-center transition-colors cursor-pointer ${
                            activeTab === "canvas"
                                ? "bg-stone-800 text-amber-400 font-bold"
                                : "text-stone-400 hover:text-stone-200"
                        }`}
                    >
                        画布分镜
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab("audio")}
                        className={`py-1.5 rounded-md text-center transition-colors cursor-pointer ${
                            activeTab === "audio"
                                ? "bg-stone-800 text-amber-400 font-bold"
                                : "text-stone-400 hover:text-stone-200"
                        }`}
                    >
                        音频BGM
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab("text")}
                        className={`py-1.5 rounded-md text-center transition-colors cursor-pointer ${
                            activeTab === "text"
                                ? "bg-stone-800 text-amber-400 font-bold"
                                : "text-stone-400 hover:text-stone-200"
                        }`}
                    >
                        文字字幕
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-2.5 space-y-2 thin-scrollbar">
                    {/* 选项卡 1：我的素材 (视频/图片) */}
                    {activeTab === "assets" ? (
                        videoAssets.length === 0 && imageAssets.length === 0 ? (
                            <div className="py-8 text-center text-xs text-stone-500">
                                素材库中暂无可用视频或图片，可通过上方按钮导入本地文件。
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {videoAssets.map((asset) => (
                                    <div
                                        key={asset.id}
                                        onClick={() => {
                                            addClipToTrack("video", {
                                                name: asset.title || "素材视频",
                                                type: "video",
                                                sourceUrl: asset.data.url,
                                                storageKey: asset.data.storageKey,
                                                duration: 6, // 默认 6s
                                            });
                                            message.success(`已添加「${asset.title}」至主视频轨`);
                                        }}
                                        className="group relative flex items-center gap-2.5 p-2 rounded-xl border border-stone-800 bg-stone-800/40 hover:bg-stone-800 hover:border-amber-500/40 transition-all cursor-pointer"
                                    >
                                        <div className="size-10 rounded-lg bg-black/60 flex items-center justify-center shrink-0 border border-stone-700/60 overflow-hidden">
                                            <Video className="size-5 text-amber-400" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-semibold text-stone-200 truncate">{asset.title}</div>
                                            <div className="text-[10px] text-stone-400 mt-0.5">点击加入时间轴</div>
                                        </div>
                                        <Plus className="size-4 text-stone-400 group-hover:text-amber-400 shrink-0" />
                                    </div>
                                ))}

                                {imageAssets.map((asset) => (
                                    <div
                                        key={asset.id}
                                        onClick={() => {
                                            addClipToTrack("overlay", {
                                                name: asset.title || "贴图",
                                                type: "image",
                                                sourceUrl: asset.data.dataUrl,
                                                duration: 3,
                                            });
                                            message.success(`已添加「${asset.title}」至贴图轨`);
                                        }}
                                        className="group relative flex items-center gap-2.5 p-2 rounded-xl border border-stone-800 bg-stone-800/40 hover:bg-stone-800 hover:border-sky-500/40 transition-all cursor-pointer"
                                    >
                                        <div className="size-10 rounded-lg bg-black/60 flex items-center justify-center shrink-0 border border-stone-700/60 overflow-hidden">
                                            <img src={asset.data.dataUrl} alt="" className="size-full object-cover" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-semibold text-stone-200 truncate">{asset.title}</div>
                                            <div className="text-[10px] text-stone-400 mt-0.5">点击作为贴图/画中画</div>
                                        </div>
                                        <Plus className="size-4 text-stone-400 group-hover:text-sky-400 shrink-0" />
                                    </div>
                                ))}
                            </div>
                        )
                    ) : null}

                    {/* 选项卡 2：画布已生成视频分镜（严格按项目隔离） */}
                    {activeTab === "canvas" ? (
                        canvasVideos.length === 0 ? (
                            <div className="py-8 text-center text-xs text-stone-500">
                                {currentProject
                                    ? `当前画布《${currentProject.title}》中暂无生成的视频分镜。`
                                    : "当前画布中未检测到生成的视频片段。可在画布中生成后直接点击进入。"}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between px-1 pb-1">
                                    <div className="flex flex-col min-w-0 pr-1">
                                        <span className="text-[11px] font-semibold text-stone-300 truncate">
                                            {currentProject ? `当前画布分镜 (${canvasVideos.length})` : `全部画布分镜 (${canvasVideos.length})`}
                                        </span>
                                        {currentProject ? (
                                            <span className="text-[10px] text-amber-400/90 truncate">
                                                《{currentProject.title}》
                                            </span>
                                        ) : null}
                                    </div>
                                    <Button
                                        size="small"
                                        type="link"
                                        className="!p-0 !text-xs !text-amber-400 shrink-0 font-medium cursor-pointer"
                                        onClick={() => {
                                            importMediaClipsSequentially(
                                                canvasVideos.map((v) => ({
                                                    name: v.title,
                                                    url: v.url,
                                                    type: "video" as const,
                                                    duration: v.duration,
                                                }))
                                            );
                                            message.success(`已将「${currentProject?.title || "当前画布"}」的 ${canvasVideos.length} 个镜头按顺序排入主时间轴`);
                                        }}
                                    >
                                        全部顺序排轨
                                    </Button>
                                </div>
                                {canvasVideos.map((item, idx) => (
                                    <div
                                        key={item.id}
                                        onClick={() => {
                                            addClipToTrack("video", {
                                                name: item.title || `分镜 0${idx + 1}`,
                                                type: "video",
                                                sourceUrl: item.url,
                                                duration: item.duration,
                                            });
                                            message.success(`已添加分镜至时间轴`);
                                        }}
                                        className="group relative flex items-center gap-2.5 p-2 rounded-xl border border-stone-800 bg-stone-800/40 hover:bg-stone-800 hover:border-amber-500/40 transition-all cursor-pointer"
                                    >
                                        <div className="size-10 rounded-lg bg-black/60 flex items-center justify-center shrink-0 border border-stone-700/60 overflow-hidden">
                                            <Film className="size-4 text-amber-400" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-semibold text-stone-200 truncate">{item.title}</div>
                                            <div className="text-[10px] text-stone-500 truncate">{item.projectTitle}</div>
                                        </div>
                                        <Plus className="size-4 text-stone-400 group-hover:text-amber-400 shrink-0" />
                                    </div>
                                ))}
                            </div>
                        )
                    ) : null}

                    {/* 选项卡 3：背景音频 BGM */}
                    {activeTab === "audio" ? (
                        <div className="space-y-2">
                            {audioAssets.map((asset) => (
                                <div
                                    key={asset.id}
                                    onClick={() => {
                                        addClipToTrack("audio", {
                                            name: asset.title || "背景音频",
                                            type: "audio",
                                            sourceUrl: asset.data.url,
                                            duration: 15,
                                            volume: 0.8,
                                        });
                                        message.success(`已添加「${asset.title}」至音频轨`);
                                    }}
                                    className="group relative flex items-center gap-2.5 p-2 rounded-xl border border-stone-800 bg-stone-800/40 hover:bg-stone-800 hover:border-emerald-500/40 transition-all cursor-pointer"
                                >
                                    <div className="size-10 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0 border border-emerald-500/25">
                                        <Music2 className="size-4 text-emerald-400" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs font-semibold text-stone-200 truncate">{asset.title}</div>
                                        <div className="text-[10px] text-stone-400 mt-0.5">点击加入背景音轨</div>
                                    </div>
                                    <Plus className="size-4 text-stone-400 group-hover:text-emerald-400 shrink-0" />
                                </div>
                            ))}
                            <div className="p-3 rounded-xl border border-dashed border-stone-800 text-center">
                                <p className="text-xs text-stone-400 mb-2">可通过上方「本地文件」上传自定义背景音乐（MP3/WAV）</p>
                            </div>
                        </div>
                    ) : null}

                    {/* 选项卡 4：文字字幕 */}
                    {activeTab === "text" ? (
                        <div className="space-y-2">
                            <div
                                onClick={() => {
                                    addClipToTrack("text", {
                                        name: "大标题文字",
                                        type: "text",
                                        duration: 3,
                                        textProps: {
                                            text: "高定醒目大标题",
                                            fontSize: 36,
                                            color: "#F59E0B",
                                            yPercent: 40,
                                            fontStyle: "bold",
                                            align: "center",
                                        },
                                    });
                                    message.success("已添加大标题至文字轨");
                                }}
                                className="p-3 rounded-xl border border-stone-800 bg-stone-800/40 hover:bg-stone-800 hover:border-amber-500/40 cursor-pointer transition-all"
                            >
                                <div className="flex items-center gap-2 text-amber-400 text-xs font-bold mb-1">
                                    <Type className="size-4" />
                                    <span>大标题预设</span>
                                </div>
                                <div className="text-[11px] text-stone-400">位于画面中上方，醒目震撼</div>
                            </div>

                            <div
                                onClick={() => {
                                    addClipToTrack("text", {
                                        name: "对白字幕",
                                        type: "text",
                                        duration: 4,
                                        textProps: {
                                            text: "生活如此美好，尽享惬意时光。",
                                            fontSize: 24,
                                            color: "#FFFFFF",
                                            bgColor: "rgba(0, 0, 0, 0.55)",
                                            yPercent: 84,
                                            fontStyle: "normal",
                                            align: "center",
                                        },
                                    });
                                    message.success("已添加对白字幕至文字轨");
                                }}
                                className="p-3 rounded-xl border border-stone-800 bg-stone-800/40 hover:bg-stone-800 hover:border-indigo-500/40 cursor-pointer transition-all"
                            >
                                <div className="flex items-center gap-2 text-indigo-400 text-xs font-bold mb-1">
                                    <Type className="size-4" />
                                    <span>对白字幕条</span>
                                </div>
                                <div className="text-[11px] text-stone-400">底部半透明药丸背景气泡，标准字幕排版</div>
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
        </aside>
    );
}
