"use client";

export const dynamic = "force-dynamic";

import { Component, useEffect, useState, useRef, Suspense, type ErrorInfo, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { App, Button } from "antd";
import { AlertCircle, LogIn, RotateCcw } from "lucide-react";

import { EditorTopBar } from "@/components/editor/editor-top-bar";
import { EditorMediaSidebar } from "@/components/editor/editor-media-sidebar";
import { EditorPreview } from "@/components/editor/editor-preview";
import { EditorPropertiesPanel } from "@/components/editor/editor-properties-panel";
import { EditorTimeline } from "@/components/editor/editor-timeline";
import { EditorExportModal } from "@/components/editor/editor-export-modal";
import { useEditorStore, type AspectRatio } from "@/stores/use-editor-store";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { CanvasNodeType } from "@/app/(user)/canvas/types";

function EditorContent() {
    const searchParams = useSearchParams();
    const { message } = App.useApp();
    const [exportOpen, setExportOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const consumedParamsRef = useRef<string | null>(null);

    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const openLoginModal = useUserStore((state) => state.openLoginModal);

    const projectId = searchParams.get("projectId") || "";
    const addClipToTrack = useEditorStore((state) => state.addClipToTrack);
    const importMediaClipsSequentially = useEditorStore((state) => state.importMediaClipsSequentially);
    const setAspectRatio = useEditorStore((state) => state.setAspectRatio);
    const setProjectTitle = useEditorStore((state) => state.setProjectTitle);
    const projects = useCanvasStore((state) => state.projects);

    useEffect(() => {
        setMounted(true);
        if (user?.id) {
            useEditorStore.getState().loadProjectDraft(projectId, user.id);
        }
    }, [user?.id, projectId]);

    // 响应来自画布或其他页面的 URL 跳转参数，实现单次消费与防重复
    useEffect(() => {
        if (!mounted || !user) return;
        const currentQuery = searchParams.toString();
        if (!currentQuery || consumedParamsRef.current === currentQuery) return;

        const nodeId = searchParams.get("nodeId");
        const batchIds = searchParams.get("batchNodes");
        const clipUrl = searchParams.get("clipUrl");
        const clipTitle = searchParams.get("title");
        const ratioParam = searchParams.get("aspectRatio");

        // 仅在有实际载入指令时才触发消费
        if (!nodeId && !batchIds && !clipUrl && !ratioParam) return;

        if (ratioParam && ["16:9", "9:16", "1:1", "4:3"].includes(ratioParam)) {
            setAspectRatio(ratioParam as AspectRatio);
        }
        if (clipTitle) {
            setProjectTitle(clipTitle);
        }

        let consumed = false;

        if (clipUrl) {
            addClipToTrack("video", {
                name: clipTitle || "导入视频片段",
                type: "video",
                sourceUrl: clipUrl,
                duration: 6,
            });
            message.success("已自动载入所选视频片段至时间轴");
            consumed = true;
        } else if (batchIds) {
            const ids = batchIds.split(",").map((s) => s.trim()).filter(Boolean);
            const batchClips: Array<{ name: string; url: string; type: "video"; duration: number }> = [];

            // 优先只在当前 projectId 画布中提取节点，杜绝与其他画布工程串号
            const currentProj = projects.find((p) => p.id === projectId);
            const targetProjects = currentProj ? [currentProj] : projects;

            const nodeMap = new Map<string, any>();
            targetProjects.forEach((p) => {
                (p.nodes || []).forEach((n) => {
                    if (ids.includes(n.id) && n.type === CanvasNodeType.Video && n.metadata?.content) {
                        nodeMap.set(n.id, n);
                    }
                });
            });

            // 严格遵循由智能拓扑/编号排序引擎传来的顺序注入时间轴
            ids.forEach((id) => {
                const n = nodeMap.get(id);
                if (n) {
                    const dur = Number(n.metadata?.seconds) || (n.metadata?.durationMs ? n.metadata.durationMs / 1000 : 6);
                    batchClips.push({
                        name: n.title || "画布分镜",
                        url: n.metadata.content,
                        type: "video",
                        duration: dur,
                    });
                }
            });

            if (batchClips.length) {
                importMediaClipsSequentially(batchClips);
                message.success(`已自动将「${currentProj?.title || "画布"}」选中的 ${batchClips.length} 个镜头按顺序排入主时间轴`);
                consumed = true;
            }
        } else if (nodeId) {
            let found = false;
            const currentProj = projects.find((p) => p.id === projectId);
            const targetProjects = currentProj ? [currentProj] : projects;
            targetProjects.forEach((p) => {
                const node = (p.nodes || []).find((n) => n.id === nodeId);
                if (node && node.type === CanvasNodeType.Video && node.metadata?.content) {
                    const dur = Number(node.metadata?.seconds) || (node.metadata?.durationMs ? node.metadata.durationMs / 1000 : 6);
                    addClipToTrack("video", {
                        name: node.title || "画布分镜",
                        type: "video",
                        sourceUrl: node.metadata.content,
                        duration: dur,
                    });
                    found = true;
                }
            });
            if (found) {
                message.success("已自动载入画布视频节点至时间轴");
                consumed = true;
            }
        }

        if (consumed) {
            consumedParamsRef.current = currentQuery;
            // 清理 URL 中的临时节点参数，保留 projectId
            if (typeof window !== "undefined") {
                const cleanUrl = window.location.pathname + (projectId ? `?projectId=${encodeURIComponent(projectId)}` : "");
                window.history.replaceState(null, "", cleanUrl);
            }
        }
    }, [mounted, user, searchParams, projects, addClipToTrack, importMediaClipsSequentially, setAspectRatio, setProjectTitle, projectId, message]);

    if (!mounted || !isReady) {
        return (
            <div className="flex flex-col h-[calc(100dvh-4rem)] w-full bg-stone-950 text-stone-400 items-center justify-center select-none">
                <div className="flex items-center gap-3">
                    <div className="size-6 animate-spin rounded-full border-2 border-stone-700 border-t-amber-500" />
                    <span className="text-sm font-medium">正在准备剪辑环境...</span>
                </div>
            </div>
        );
    }

    if (!user) {
        return (
            <div className="flex flex-col h-[calc(100dvh-4rem)] w-full bg-stone-950 text-stone-200 items-center justify-center p-6 text-center select-none">
                <div className="max-w-md p-8 rounded-3xl bg-stone-900 border border-stone-800 shadow-2xl flex flex-col items-center gap-4">
                    <div className="size-14 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
                        <LogIn className="size-7" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-stone-100">请登录后使用视频剪辑工作台</h2>
                        <p className="text-xs text-stone-400 leading-relaxed mt-1.5">
                            登录后即可使用纯端侧多轨剪辑、调速调音、对白字幕与本地极速导出功能，并与画布分镜及素材库无缝互通。
                        </p>
                    </div>
                    <div className="flex items-center gap-3 mt-2 w-full">
                        <Button
                            type="primary"
                            icon={<LogIn className="size-4" />}
                            onClick={openLoginModal}
                            className="flex-1 !h-10 !rounded-xl !bg-amber-500 hover:!bg-amber-400 !text-stone-950 !font-bold !border-none"
                        >
                            立即登录
                        </Button>
                        <Button
                            onClick={() => {
                                window.location.href = "/canvas";
                            }}
                            className="flex-1 !h-10 !rounded-xl !bg-stone-800 !border-stone-700 !text-stone-300 hover:!text-white"
                        >
                            返回画布
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-[calc(100dvh-4rem)] w-full bg-stone-950 text-stone-100 overflow-hidden select-none">
            {/* 顶栏控制条 */}
            <EditorTopBar projectId={projectId} onExport={() => setExportOpen(true)} />

            {/* 中间核心工作区：左侧素材面板 + 中间预览视口 + 右侧属性面板 */}
            <div className="flex-1 flex min-h-0 relative overflow-hidden">
                <EditorMediaSidebar projectId={projectId} />
                <EditorPreview />
                <EditorPropertiesPanel />
            </div>

            {/* 底部专业多轨时间轴 */}
            <EditorTimeline />

            {/* 纯本地导出合成弹窗 (0 服务器算力消耗) */}
            <EditorExportModal open={exportOpen} onClose={() => setExportOpen(false)} projectId={projectId} />
        </div>
    );
}

class EditorErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
    constructor(props: { children: ReactNode }) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("[Editor] 剪辑工作台渲染异常:", error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col h-[calc(100dvh-4rem)] w-full bg-stone-950 text-stone-200 items-center justify-center p-6 text-center select-none">
                    <div className="max-w-md p-6 rounded-2xl bg-stone-900 border border-stone-800 shadow-2xl flex flex-col items-center gap-3">
                        <div className="size-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                            <AlertCircle className="size-6" />
                        </div>
                        <h2 className="text-base font-bold text-stone-100">剪辑工作台已准备就绪</h2>
                        <p className="text-xs text-stone-400 leading-relaxed">
                            检测到客户端渲染状态已自动重置。点击下方按钮即可一键重新载入。
                        </p>
                        {this.state.error ? (
                            <div className="w-full text-left bg-stone-950 p-2.5 rounded-lg border border-stone-800 text-[11px] font-mono text-stone-400 truncate">
                                {this.state.error.message}
                            </div>
                        ) : null}
                        <Button
                            type="primary"
                            icon={<RotateCcw className="size-3.5" />}
                            onClick={() => {
                                this.setState({ hasError: false, error: null });
                                window.location.reload();
                            }}
                            className="!rounded-lg !bg-amber-500 !text-stone-950 !font-bold !border-none mt-2"
                        >
                            重新载入工作台
                        </Button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

export default function EditorPage() {
    return (
        <EditorErrorBoundary>
            <Suspense fallback={<div className="h-[calc(100dvh-4rem)] w-full flex items-center justify-center bg-stone-950 text-stone-400">正在载入剪辑工作台...</div>}>
                <EditorContent />
            </Suspense>
        </EditorErrorBoundary>
    );
}
