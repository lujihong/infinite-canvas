"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Plus, Search, Sparkles } from "lucide-react";
import { Popover } from "antd";

import { cn } from "@/lib/utils";
import { getModelPricing } from "@/constant/credits";
import {
    filterModelsByCapability,
    normalizeLocalChannels,
    normalizeModelList,
    useConfigStore,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    channelId?: string;
    capability?: ModelCapability;
    onChange: (model: string, channelId?: string) => void;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({
    config,
    value,
    channelId,
    capability,
    onChange,
    className,
    fullWidth = false,
    placeholder = "选择模型",
    onMissingConfig,
}: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const [searchKeyword, setSearchKeyword] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const publicSettings = useConfigStore((state) => state.publicSettings);
    const availablePlatformModels = useMemo(() => {
        return publicSettings?.modelChannel?.availableModels || [];
    }, [publicSettings]);

    const channels = useMemo(() => {
        const rawChannels = config.channelMode === "remote"
            ? config.publicChannels.map((channel) => ({
                  id: channel.id || "remote-default",
                  protocol: channel.protocol,
                  name: channel.name || "鑫元宝官方模型服务",
                  baseUrl: channel.baseUrl || "",
                  models: channel.models || [],
              }))
            : normalizeLocalChannels(config).map((channel) => ({
                  id: channel.id,
                  protocol: channel.protocol,
                  name: channel.name || "本地渠道",
                  baseUrl: channel.baseUrl,
                  models: channel.models || [],
              }));

        // 展开通配符与官方专属渠道
        const list = rawChannels.map((ch) => {
            if (ch.id === "xyb-official-exclusive" || ch.models.includes("*") || ch.models.length === 0) {
                return {
                    ...ch,
                    name: ch.name || "鑫元宝官方模型服务",
                    models: normalizeModelList([
                        ...ch.models.filter((m) => m !== "*"),
                        ...availablePlatformModels,
                    ]),
                };
            }
            return ch;
        });

        // 兜底防御：若所有渠道展开后都没有模型，直接注入官方渠道
        if (list.length === 0 || list.every((ch) => ch.models.length === 0)) {
            return [
                {
                    id: "xyb-official-exclusive",
                    protocol: "openai" as const,
                    name: "鑫元宝官方模型服务",
                    baseUrl: "https://api.xybcloud.com/",
                    models: availablePlatformModels,
                },
            ];
        }
        return list;
    }, [config, availablePlatformModels]);

    // 全部可用选项（扁平化 + 平台模型补齐）
    const allOptions = useMemo(() => {
        const seen = new Set<string>();
        const list: Array<{
            key: string;
            channelId: string;
            channelName: string;
            protocol?: string;
            model: string;
        }> = [];

        channels.forEach((channel) => {
            (channel.models ?? []).forEach((model) => {
                if (model && model !== "*" && !seen.has(model)) {
                    seen.add(model);
                    list.push({
                        key: `${channel.id}::${model}`,
                        channelId: channel.id,
                        channelName: channel.name || "鑫元宝官方模型服务",
                        protocol: channel.protocol,
                        model,
                    });
                }
            });
        });

        // 补齐平台官方未在渠道中列出的模型
        availablePlatformModels.forEach((model) => {
            if (model && !seen.has(model)) {
                seen.add(model);
                list.push({
                    key: `xyb-official-exclusive::${model}`,
                    channelId: "xyb-official-exclusive",
                    channelName: "鑫元宝官方模型服务",
                    protocol: "openai",
                    model,
                });
            }
        });

        return list;
    }, [channels, availablePlatformModels]);

    // 经 capability 过滤后的选项
    const filteredOptions = useMemo(() => {
        if (!capability) return allOptions;
        const matched = allOptions.filter(
            (item) => filterModelsByCapability([item.model], capability, item.protocol || "").length > 0
        );
        // 如果过滤后为空，智能降级展示全部模型，不给用户呈现死胡同
        return matched.length > 0 ? matched : allOptions;
    }, [allOptions, capability]);

    // 当前选中的选项信息
    const currentOption = useMemo(() => {
        if (!value) return undefined;
        return (
            allOptions.find((item) => item.model === value && item.channelId === channelId) ||
            allOptions.find((item) => item.model === value)
        );
    }, [allOptions, channelId, value]);

    // 搜索过滤后的选项
    const displayOptions = useMemo(() => {
        const kw = searchKeyword.trim().toLowerCase();
        if (!kw) return filteredOptions;
        return filteredOptions.filter(
            (item) => item.model.toLowerCase().includes(kw) || item.channelName.toLowerCase().includes(kw)
        );
    }, [filteredOptions, searchKeyword]);

    // 检查用户输入的关键词是否是一个新模型（不在当前已有的列表中）
    const trimmedInput = searchKeyword.trim();
    const exactMatch = allOptions.some((item) => item.model.toLowerCase() === trimmedInput.toLowerCase());
    const isCustomCandidate = trimmedInput.length > 0 && !exactMatch;

    const currentDisplayModel = value || "";

    const handleSelectModel = (modelName: string, targetChannelId?: string) => {
        const effectiveChannelId = targetChannelId || channelId || channels[0]?.id || "";
        
        // 如果是一个新输入的自定义模型，自动登记到当前渠道的 models 列表中并持久化
        if (effectiveChannelId && config.channelMode === "local") {
            const currentChannels = normalizeLocalChannels(config);
            const targetChannel = currentChannels.find((c) => c.id === effectiveChannelId) || currentChannels[0];
            if (targetChannel && !targetChannel.models.includes(modelName)) {
                const nextChannels = currentChannels.map((c) => {
                    if (c.id === targetChannel.id) {
                        return { ...c, models: [...c.models, modelName] };
                    }
                    return c;
                });
                useConfigStore.getState().updateConfig("localChannels", nextChannels);
                useConfigStore.getState().updateConfig("models", normalizeModelList(nextChannels.flatMap((c) => c.models)));
            }
        }

        onChange(modelName, effectiveChannelId);
        setOpen(false);
        setSearchKeyword("");
    };

    useEffect(() => {
        if (open) {
            setTimeout(() => inputRef.current?.focus(), 50);
        } else {
            setSearchKeyword("");
        }
    }, [open]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const popoverContent = (
        <div
            className="w-80 max-w-[calc(100vw-32px)] p-1 text-stone-900 dark:text-stone-100"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            {/* 顶部搜索与自定义输入栏 */}
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 dark:border-stone-700 dark:bg-stone-900">
                <Search className="size-3.5 shrink-0 text-stone-400" />
                <input
                    ref={inputRef}
                    type="text"
                    value={searchKeyword}
                    onChange={(e) => setSearchKeyword(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && trimmedInput) {
                            e.preventDefault();
                            // 如果有完全匹配项则选匹配项，否则使用自定义模型
                            const matched = displayOptions[0];
                            if (matched && matched.model.toLowerCase() === trimmedInput.toLowerCase()) {
                                handleSelectModel(matched.model, matched.channelId);
                            } else {
                                handleSelectModel(trimmedInput, channelId || channels[0]?.id);
                            }
                        }
                    }}
                    placeholder="搜索或输入自定义模型名称..."
                    className="w-full bg-transparent text-xs outline-none placeholder:text-stone-400"
                />
                {trimmedInput ? (
                    <button
                        type="button"
                        onClick={() => setSearchKeyword("")}
                        className="cursor-pointer text-[10px] text-stone-400 hover:text-stone-600 dark:hover:text-stone-200"
                    >
                        清空
                    </button>
                ) : null}
            </div>

            {/* 如果用户输入了一个未在列表里的模型，直接在顶部展示“使用自定义模型”按钮 */}
            {isCustomCandidate ? (
                <button
                    type="button"
                    onClick={() => handleSelectModel(trimmedInput, channelId || channels[0]?.id)}
                    className="mb-1.5 flex w-full cursor-pointer items-center justify-between gap-2 rounded-md bg-blue-50 px-2.5 py-2 text-left text-xs text-blue-700 transition hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/80"
                >
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                        <Sparkles className="size-3.5 shrink-0 text-blue-500" />
                        <span className="truncate">使用自定义模型: <strong className="font-semibold">{trimmedInput}</strong></span>
                    </span>
                    <span className="shrink-0 rounded bg-blue-200/80 px-1.5 py-0.5 text-[10px] dark:bg-blue-800">
                        回车添加
                    </span>
                </button>
            ) : null}

            {/* 模型列表 */}
            <div className="max-h-64 overflow-y-auto space-y-1 pr-0.5">
                {displayOptions.length > 0 ? (
                    displayOptions.map((option) => {
                        const isSelected = option.model === value && (!channelId || option.channelId === channelId);
                        const pricing = getModelPricing(option.model);
                        return (
                            <button
                                key={option.key}
                                type="button"
                                onClick={() => handleSelectModel(option.model, option.channelId)}
                                className={cn(
                                    "flex w-full flex-col gap-1 rounded-lg p-2 text-left text-xs transition cursor-pointer border",
                                    isSelected
                                        ? "bg-amber-500/10 border-amber-500/30 text-stone-950 dark:bg-amber-950/30 dark:border-amber-500/40 dark:text-white"
                                        : "border-transparent text-stone-700 hover:bg-stone-100/80 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800/80 dark:hover:text-white"
                                )}
                            >
                                {/* 第一行：模型图标 + 模型名（粗体、自动换行） */}
                                <div className="flex items-start justify-between gap-1.5 w-full">
                                    <span className="flex items-start gap-1.5 min-w-0 flex-1">
                                        <span className="mt-0.5 shrink-0">
                                            <ModelIcon model={option.model} />
                                        </span>
                                        <span className="font-semibold break-all leading-snug">
                                            {option.model}
                                        </span>
                                    </span>
                                    {isSelected ? <Check className="size-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" /> : null}
                                </div>

                                {/* 第二行：计费单价 + 渠道信息（次级弱化展示） */}
                                <div className="flex items-center justify-between gap-2 pl-5 text-[11px] text-stone-400 dark:text-stone-500">
                                    <span>
                                        {pricing ? (
                                            <span className="font-mono text-amber-600 dark:text-amber-400 font-medium">
                                                {pricing.quota_type === 1 ? `${pricing.points_cost} 积分/次` : "按量扣费"}
                                            </span>
                                        ) : (
                                            <span>按量扣费</span>
                                        )}
                                    </span>
                                    {option.channelName ? (
                                        <span className="truncate text-[10px] opacity-75">
                                            {option.channelName}
                                        </span>
                                    ) : null}
                                </div>
                            </button>
                        );
                    })
                ) : !isCustomCandidate ? (
                    <div className="py-6 text-center text-xs text-stone-400">
                        暂无匹配模型，可直接在上方输入自定义模型
                    </div>
                ) : null}
            </div>

            {/* 底部快捷操作提示 */}
            <div className="mt-2 flex items-center justify-between border-t border-stone-200/60 pt-1.5 text-[10px] text-stone-400 dark:border-stone-700/60">
                <span>共 {filteredOptions.length} 个可用模型</span>
                <span>支持直接打字输入任意模型</span>
            </div>
        </div>
    );

    return (
        <Popover
            open={open}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !allOptions.length && config.channelMode === "local" && !value) {
                    onMissingConfig?.();
                }
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            content={popoverContent}
            trigger="click"
            placement="bottomLeft"
            destroyTooltipOnHide
            overlayClassName="model-picker-popover z-[1200]"
        >
            <button
                type="button"
                className={cn(
                    "canvas-composer-model-picker inline-flex h-8 shrink-0 cursor-pointer items-center justify-between gap-2 rounded-full border border-stone-200 bg-transparent px-3 text-xs font-normal text-stone-800 shadow-sm transition hover:border-stone-300 dark:border-stone-700 dark:text-stone-200 dark:hover:border-stone-600",
                    fullWidth ? "w-full min-w-0" : "min-w-[9rem] max-w-full",
                    open && "border-blue-500 ring-2 ring-blue-500/20",
                    className
                )}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                title={currentDisplayModel || placeholder}
            >
                <span className="flex min-w-0 items-center gap-2 truncate">
                    <ModelIcon model={currentDisplayModel} />
                    <span className="truncate">{currentDisplayModel || placeholder}</span>
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-stone-400 opacity-70" />
            </button>
        </Popover>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(model);
    return icon ? <img src={icon} alt="" className="size-3.5 shrink-0 dark:invert" /> : <Cpu className="size-3.5 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai") || name.includes("dall-e")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("cogview")) return "/icons/glm.svg";
    return "";
}
