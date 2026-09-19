"use client";

import { FileText, FolderPlus, Image as ImageIcon, Music2, Plus, ShieldCheck, Video, X } from "lucide-react";
import { Popover } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { buildAllCanvasResourceReferences, type CanvasResourceReference } from "../utils/canvas-resource-references";
import type { CanvasNodeData } from "../types";

export function CanvasNodeReferenceBar({
    nodeId,
    connectedNodes,
    onDisconnect,
    onStartSelection,
    onOpenAiccPicker,
    onOpenMyAssetsPicker,
}: {
    nodeId: string;
    connectedNodes: CanvasNodeData[];
    onDisconnect?: (fromNodeId: string, toNodeId: string) => void;
    onStartSelection?: (nodeId: string) => void;
    onOpenAiccPicker?: (nodeId: string) => void;
    onOpenMyAssetsPicker?: (nodeId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const references = buildAllCanvasResourceReferences(connectedNodes);

    const addReferenceMenu = (
        <div className="flex flex-col gap-1 p-1 min-w-[200px] text-xs" onMouseDown={(e) => e.stopPropagation()}>
            <div className="px-2.5 py-1 text-[11px] font-medium text-stone-400 border-b border-stone-200/50 dark:border-stone-700/50">添加参考内容</div>
            {onOpenAiccPicker ? (
                <button
                    type="button"
                    className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-stone-100 dark:hover:bg-stone-800 text-left transition cursor-pointer text-cyan-600 dark:text-cyan-400 font-medium"
                    onClick={() => onOpenAiccPicker(nodeId)}
                >
                    <ShieldCheck className="size-4 shrink-0 text-cyan-500" />
                    <span>从真人素材库选用 (AICC)</span>
                </button>
            ) : null}
            {onOpenMyAssetsPicker ? (
                <button
                    type="button"
                    className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-stone-100 dark:hover:bg-stone-800 text-left transition cursor-pointer text-stone-700 dark:text-stone-200"
                    onClick={() => onOpenMyAssetsPicker(nodeId)}
                >
                    <FolderPlus className="size-4 shrink-0 text-amber-500" />
                    <span>从我的素材库选用</span>
                </button>
            ) : null}
            {onStartSelection ? (
                <button
                    type="button"
                    className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-stone-100 dark:hover:bg-stone-800 text-left transition cursor-pointer text-stone-600 dark:text-stone-300"
                    onClick={() => onStartSelection(nodeId)}
                >
                    <Plus className="size-4 shrink-0 text-stone-400" />
                    <span>从画布节点选择连线</span>
                </button>
            ) : null}
        </div>
    );

    return (
        <div className="mb-2">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>参考内容</div>
            <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
                {references.map((reference) => <ReferenceItem key={reference.id} reference={reference} onRemove={() => onDisconnect?.(reference.nodeId, nodeId)} />)}
                <Popover
                    content={addReferenceMenu}
                    trigger="click"
                    placement="top"
                    destroyTooltipOnHide
                    overlayClassName="z-[1250]"
                >
                    <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70 cursor-pointer" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} title="添加参考内容">
                        <Plus className="size-4" />
                    </button>
                </Popover>
            </div>
        </div>
    );
}

function ReferenceItem({ reference, onRemove }: { reference: CanvasResourceReference; onRemove: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const Icon = reference.kind === "image" ? ImageIcon : reference.kind === "video" ? Video : reference.kind === "audio" ? Music2 : FileText;
    const isMedia = reference.kind === "image" || reference.kind === "video";
    return (
        <Popover placement="topLeft" mouseEnterDelay={0.15} content={<ReferencePreview reference={reference} />} arrow={!isMedia} destroyOnHidden={reference.kind === "video"} styles={isMedia ? { container: { padding: 0, background: "transparent", boxShadow: "none" } } : undefined}>
            <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }}>
                <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]">
                    {reference.kind === "image" && reference.previewUrl ? <img src={reference.previewUrl} alt="" className="size-full object-cover" /> : reference.kind === "video" && reference.previewUrl ? <video src={reference.previewUrl} className="size-full object-cover" muted /> : <Icon className="size-4 opacity-65" />}
                </span>
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label="断开参考连接" title="断开参考连接" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
            </div>
        </Popover>
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt={reference.title} className="block max-h-52 max-w-72 rounded-lg object-contain" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="block max-h-52 max-w-72 rounded-lg" autoPlay muted playsInline preload="metadata" />;
    if (reference.kind === "audio" && reference.previewUrl) return <audio src={reference.previewUrl} className="w-72" controls />;
    return <div className="max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{reference.text || reference.title || "暂无内容"}</div>;
}
