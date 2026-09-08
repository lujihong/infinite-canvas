"use client";

import { useState, useRef, useEffect } from "react";
import { Download, Film, FolderPlus, LoaderCircle, CheckCircle2, AlertCircle, ArrowUpRight, XCircle } from "lucide-react";
import { Modal, Button, Progress, App } from "antd";
import { nanoid } from "nanoid";

import { useEditorStore } from "@/stores/use-editor-store";
import { exportTimelineVideoLocally, getResolutionForAspectRatio } from "@/services/editor-engine";
import { useAssetStore } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/app/(user)/canvas/types";

export function EditorExportModal({
    open,
    onClose,
    projectId,
}: {
    open: boolean;
    onClose: () => void;
    projectId?: string;
}) {
    const { message } = App.useApp();
    const tracks = useEditorStore((state) => state.tracks);
    const aspectRatio = useEditorStore((state) => state.aspectRatio);
    const projectTitle = useEditorStore((state) => state.projectTitle);
    const addAsset = useAssetStore((state) => state.addAsset);

    const [isExporting, setIsExporting] = useState(false);
    const [progressPercent, setProgressPercent] = useState(0);
    const [statusText, setStatusText] = useState("");
    const [exportedResult, setExportedResult] = useState<{ blob: Blob; extension: string } | null>(null);
    const [savedToAssets, setSavedToAssets] = useState(false);
    const [insertedToCanvas, setInsertedToCanvas] = useState(false);

    const abortControllerRef = useRef<AbortController | null>(null);

    // 组件卸载或弹窗外部关闭时，自动中止可能正在运行的导出任务与内存解码句柄
    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!open && isExporting) {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
            }
            setIsExporting(false);
        }
    }, [open, isExporting]);

    const resolution = getResolutionForAspectRatio(aspectRatio);

    const handleCancelExport = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setIsExporting(false);
        setStatusText("视频导出任务已取消");
        message.info("已取消视频导出任务");
    };

    const handleCloseModal = () => {
        if (isExporting) {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
            }
            setIsExporting(false);
            message.info("已中止视频导出并关闭窗口");
        }
        onClose();
    };

    const handleStartExport = async () => {
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsExporting(true);
        setProgressPercent(0);
        setStatusText("正在初始化纯本地视频合成器...");
        setExportedResult(null);
        setSavedToAssets(false);

        try {
            const result = await exportTimelineVideoLocally({
                tracks,
                aspectRatio,
                fps: 30,
                signal: controller.signal,
                onProgress: (percent, text) => {
                    setProgressPercent(percent);
                    setStatusText(text);
                },
            });

            setProgressPercent(100);
            setStatusText("视频导出合成完毕！已触发本地下载");
            setExportedResult({ blob: result.blob, extension: result.extension });
            message.success("视频本地高速合成完成！");

            // 自动触发本地浏览器下载
            const downloadUrl = URL.createObjectURL(result.blob);
            const a = document.createElement("a");
            a.href = downloadUrl;
            a.download = `${projectTitle.replace(/\s+/g, "_")}_${aspectRatio.replace(":", "x")}.${result.extension}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(downloadUrl);
        } catch (error) {
            if ((error as any)?.name === "AbortError" || controller.signal.aborted) {
                setStatusText("视频导出任务已取消");
                return;
            }
            message.error(error instanceof Error ? error.message : "导出视频失败");
            setStatusText(error instanceof Error ? error.message : "导出失败");
        } finally {
            setIsExporting(false);
            abortControllerRef.current = null;
        }
    };

    const handleSaveToAssets = async () => {
        if (!exportedResult) return;
        try {
            const { uploadMediaFile } = await import("@/services/file-storage");
            const uploaded = await uploadMediaFile(exportedResult.blob, "editor-export");

            addAsset({
                kind: "video",
                title: `${projectTitle} (剪辑导出)`,
                coverUrl: "",
                tags: ["剪辑成片", aspectRatio],
                source: "视频剪辑台",
                data: {
                    url: uploaded.url,
                    storageKey: uploaded.storageKey,
                    width: resolution.width,
                    height: resolution.height,
                    bytes: uploaded.bytes,
                    mimeType: uploaded.mimeType,
                },
            });

            setSavedToAssets(true);
            message.success("成片已持久化保存至「我的素材」！可在画布中随时调用");
        } catch (err) {
            message.error("保存素材库失败: " + (err instanceof Error ? err.message : "未知错误"));
        }
    };

    const handleInsertToCanvas = async () => {
        if (!exportedResult || !projectId) return;
        try {
            const { uploadMediaFile } = await import("@/services/file-storage");
            const uploaded = await uploadMediaFile(exportedResult.blob, "editor-export");
            const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
            const canvasStore = useCanvasStore.getState();
            const proj = canvasStore.projects.find((p) => p.id === projectId);
            if (!proj) {
                message.warning("未找到原画布工程，请直接保存至素材库");
                return;
            }

            const rightmostX = (proj.nodes || []).reduce((max, n) => Math.max(max, n.position.x + n.width), 0);
            const nodeWidth = 420;
            const nodeHeight = Math.round((nodeWidth * resolution.height) / resolution.width);

            const newNode: CanvasNodeData = {
                id: `video-edited-${nanoid(6)}`,
                type: CanvasNodeType.Video,
                title: `${projectTitle} (剪辑成片)`,
                position: { x: rightmostX + 120, y: 120 },
                width: nodeWidth,
                height: nodeHeight,
                metadata: {
                    content: uploaded.url,
                    storageKey: uploaded.storageKey,
                    status: "success",
                    mimeType: uploaded.mimeType,
                    bytes: uploaded.bytes,
                    naturalWidth: resolution.width,
                    naturalHeight: resolution.height,
                    model: "local-editor",
                },
            };

            canvasStore.updateProject(projectId, {
                nodes: [...proj.nodes, newNode],
            });
            setInsertedToCanvas(true);
            message.success("已成功将剪辑成片持久化插入原画布新节点！");
        } catch (err) {
            message.error("插入原画布失败: " + (err instanceof Error ? err.message : "未知错误"));
        }
    };

    return (
        <Modal
            title={
                <div className="flex items-center gap-2 text-stone-100">
                    <Film className="size-4 text-amber-500" />
                    <span>本地极速导出视频成片</span>
                </div>
            }
            open={open}
            onCancel={handleCloseModal}
            maskClosable={!isExporting}
            footer={null}
            centered
            width={480}
            destroyOnHidden
        >
            <div className="space-y-4 pt-2 select-none text-stone-200">
                {/* 导出规格概要卡片 */}
                <div className="p-3 rounded-xl bg-stone-900 border border-stone-800 space-y-2 text-xs">
                    <div className="flex justify-between items-center text-stone-400">
                        <span>成片分辨率:</span>
                        <span className="font-mono text-stone-200 font-bold">
                            {resolution.width} x {resolution.height} ({aspectRatio})
                        </span>
                    </div>
                    <div className="flex justify-between items-center text-stone-400">
                        <span>渲染模式:</span>
                        <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                            <span className="size-1.5 rounded-full bg-emerald-400" />
                            纯浏览器端硬件加速 (0 消耗服务器算力)
                        </span>
                    </div>
                    <div className="flex justify-between items-center text-stone-400">
                        <span>导出文件格式:</span>
                        <span className="font-mono text-stone-200">MP4 / WebM 高清视频</span>
                    </div>
                </div>

                {/* 进度条与状态显示 */}
                {isExporting || progressPercent > 0 || statusText ? (
                    <div className="p-4 rounded-xl bg-stone-900/60 border border-stone-800/80 space-y-2.5">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-stone-300 font-medium flex items-center gap-2">
                                {isExporting ? (
                                    <LoaderCircle className="size-3.5 animate-spin text-amber-500" />
                                ) : progressPercent === 100 ? (
                                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                                ) : statusText.includes("取消") ? (
                                    <AlertCircle className="size-3.5 text-amber-500" />
                                ) : (
                                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                                )}
                                {statusText || "正在处理..."}
                            </span>
                            <span className="font-mono text-amber-400 font-bold text-sm">
                                {progressPercent}%
                            </span>
                        </div>
                        <Progress
                            percent={progressPercent}
                            status={isExporting ? "active" : progressPercent === 100 ? "success" : "normal"}
                            strokeColor={{ "0%": "#F59E0B", "100%": "#10B981" }}
                            showInfo={false}
                        />
                    </div>
                ) : null}

                {/* 导出后操作按钮 */}
                <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-stone-800">
                    {isExporting ? (
                        <Button
                            danger
                            onClick={handleCancelExport}
                            icon={<XCircle className="size-3.5" />}
                            className="!rounded-lg !border-red-500/40 !text-red-400 hover:!bg-red-500/10"
                        >
                            取消导出任务
                        </Button>
                    ) : (
                        <Button onClick={handleCloseModal} className="!rounded-lg">
                            {exportedResult ? "关闭" : "取消"}
                        </Button>
                    )}

                    {exportedResult ? (
                        <>
                            <Button
                                onClick={handleSaveToAssets}
                                disabled={savedToAssets}
                                icon={<FolderPlus className="size-3.5" />}
                                className="!rounded-lg !bg-stone-800 !border-stone-700 !text-stone-200"
                            >
                                {savedToAssets ? "已存入素材库" : "存入我的素材"}
                            </Button>

                            {projectId ? (
                                <Button
                                    onClick={handleInsertToCanvas}
                                    disabled={insertedToCanvas}
                                    icon={<ArrowUpRight className="size-3.5 text-amber-400" />}
                                    className="!rounded-lg !bg-stone-800 !border-stone-700 !text-stone-200"
                                >
                                    {insertedToCanvas ? "已插入画布" : "插入原画布"}
                                </Button>
                            ) : null}
                        </>
                    ) : null}

                    <Button
                        type="primary"
                        loading={isExporting}
                        disabled={isExporting}
                        onClick={handleStartExport}
                        className="!rounded-lg !bg-amber-500 hover:!bg-amber-400 !text-stone-950 !font-bold !border-none"
                    >
                        {isExporting ? "正在本地极速合成中..." : exportedResult ? "重新导出" : "开始极速导出"}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
