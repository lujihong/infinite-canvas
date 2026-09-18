"use client";

import { useMemo, useState, useEffect } from "react";
import { AutoComplete, Input, Typography } from "antd";
import { Check, ChevronDown, Cpu, Sparkles, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { RECOMMENDED_AUDIO_MODELS } from "@/lib/audio-generation";
import { getModelPricing, loadRemotePricing, personalPricingDetails, usePersonalPricing } from "@/services/api/pricing";
import {
    filterModelsByCapability,
    normalizeLocalChannels,
    normalizeModelList,
    useConfigStore,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";

type ConfigModelInputProps = {
    config: AiConfig;
    value?: string;
    channelId?: string;
    capability?: ModelCapability;
    onChange: (model: string, channelId?: string) => void;
    placeholder?: string;
};

export function ConfigModelInput({
    config,
    value,
    channelId,
    capability,
    onChange,
    placeholder = "直接输入模型名称或下拉选择",
}: ConfigModelInputProps) {
    const [inputValue, setInputValue] = useState(value || "");
    const personalPricing = usePersonalPricing();

    useEffect(() => {
        setInputValue(value || "");
    }, [value]);

    const publicSettings = useConfigStore((state) => state.publicSettings);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const availablePlatformModels = useMemo(() => {
        const publicList = publicSettings?.modelChannel?.availableModels || [];
        const personalList = Array.from(personalPricing.items.keys());
        return normalizeModelList([...publicList, ...personalList]);
    }, [publicSettings, personalPricing.items]);

    const channels = useMemo(() => {
        const rawChannels = config.channelMode === "remote"
            ? config.publicChannels.map((channel) => ({
                  id: channel.id || "remote-default",
                  protocol: channel.protocol,
                  name: channel.name || "鑫元宝官方模型服务",
                  models: channel.models || [],
              }))
            : normalizeLocalChannels(config).map((channel) => ({
                  id: channel.id,
                  protocol: channel.protocol,
                  name: channel.name || "本地渠道",
                  models: channel.models || [],
              }));

        // 展开通配符渠道和官方专属渠道为平台可用模型全集
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

        // 若当前列表无有效模型，兜底注入官方平台全量模型渠道
        if (list.length === 0 || list.every((ch) => ch.models.length === 0)) {
            return [
                {
                    id: "xyb-official-exclusive",
                    protocol: "openai" as const,
                    name: "鑫元宝官方模型服务",
                    models: availablePlatformModels,
                },
            ];
        }
        return list;
    }, [config, availablePlatformModels]);

    const allModels = useMemo(() => {
        const seen = new Set<string>();
        const list: Array<{ channelId: string; channelName: string; protocol?: string; model: string }> = [];

        channels.forEach((channel) => {
            (channel.models ?? []).forEach((m) => {
                if (m && m !== "*" && !seen.has(m)) {
                    seen.add(m);
                    list.push({
                        channelId: channel.id,
                        channelName: channel.name || "鑫元宝官方模型服务",
                        protocol: channel.protocol,
                        model: m,
                    });
                }
            });
        });

        // 额外补齐：若平台可用模型有遗漏，自动加入官方渠道模型
        availablePlatformModels.forEach((m) => {
            if (m && !seen.has(m)) {
                seen.add(m);
                list.push({
                    channelId: "xyb-official-exclusive",
                    channelName: "鑫元宝官方模型服务",
                    protocol: "openai",
                    model: m,
                });
            }
        });

        return list;
    }, [channels, availablePlatformModels]);

    const filteredModels = useMemo(() => {
        if (!capability) return allModels;
        const matched = allModels.filter((item) => {
            const pricingItem = personalPricing.items.get(item.model);
            if (pricingItem && Array.isArray(pricingItem.supported_endpoint_types) && pricingItem.supported_endpoint_types.length > 0) {
                const types = pricingItem.supported_endpoint_types.map((t) => t.toLowerCase());
                if (capability === "video" && (types.includes("video") || types.includes("videos"))) return true;
                if (capability === "image" && (types.includes("image") || types.includes("images"))) return true;
                if (capability === "audio" && (types.includes("audio") || types.includes("tts") || types.includes("speech") || types.includes("voice"))) return true;
                if (capability === "text" && (types.includes("chat") || types.includes("completions"))) return true;
            }
            return filterModelsByCapability([item.model], capability, item.protocol || "").length > 0;
        });
        if (matched.length > 0) return matched;
        if (capability === "audio") {
            return RECOMMENDED_AUDIO_MODELS.map((modelName) => ({
                channelId: "recommended-audio",
                channelName: "常用语音合成/TTS",
                protocol: "openai",
                model: modelName,
            }));
        }
        return [];
    }, [allModels, capability, personalPricing.items]);

    // 智能构建 AutoComplete 下拉选项（两行优雅排版，自动换行）
    const options = useMemo(() => {
        // 核心体验优化：如果当前输入框的值等于当前已选中的模型名称（用户尚未主动输入新搜索词），
        // 则不作为过滤条件过滤其他模型，展示当前能力下的全部可用候选模型，支持直接点击切换；
        // 仅当用户主动退格修改或键入新关键词搜索时，才执行模糊过滤。
        const isUnchangedValue = (inputValue || "").trim().toLowerCase() === (value || "").trim().toLowerCase();
        const query = isUnchangedValue ? "" : inputValue.trim().toLowerCase();

        let matched = filteredModels.filter((item) => !query || item.model.toLowerCase().includes(query));

        // 如果用户尚未进行搜索输入（展现全部模型），将当前已选中的模型优先排在最前面并保持高亮
        if (isUnchangedValue && value) {
            const currentIdx = matched.findIndex((item) => item.model.toLowerCase() === value.trim().toLowerCase());
            if (currentIdx > 0) {
                const currentItem = matched[currentIdx];
                matched = [currentItem, ...matched.slice(0, currentIdx), ...matched.slice(currentIdx + 1)];
            }
        }

        const result: Array<{ value: string; label: React.ReactNode; disabled?: boolean }> = matched.map((item) => {
            const pricing = getModelPricing(item.model);
            const isSelected = (value || "").trim().toLowerCase() === item.model.toLowerCase();
            const isRecommendedAudio = item.channelId === "recommended-audio";
            return {
                value: item.model,
                label: (
                    <div title={pricing ? personalPricingDetails(pricing) : personalPricing.error || (isRecommendedAudio ? "常用音频/TTS参考模型" : "登录后查看本人报价")} className={cn(
                        "flex flex-col gap-1 py-1.5 px-1 text-xs border-b border-stone-100/60 dark:border-stone-800/60 last:border-b-0 rounded transition-colors",
                        isSelected && "bg-stone-100/60 dark:bg-stone-800/50"
                    )}>
                        {/* 第一行：模型图标 + 模型全名 + 选中状态徽标 */}
                        <div className="flex items-start justify-between gap-1.5">
                            <div className="flex items-start gap-1.5 min-w-0">
                                <span className="mt-0.5 shrink-0">
                                    <ModelIcon model={item.model} />
                                </span>
                                <span className="font-semibold text-stone-900 dark:text-stone-100 break-all leading-snug whitespace-normal">
                                    {item.model}
                                </span>
                            </div>
                            {isSelected ? (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                                    <Check className="size-2.5 stroke-[3]" />
                                    当前
                                </span>
                            ) : isRecommendedAudio ? (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 text-[10px] font-bold text-sky-600 dark:text-sky-400">
                                    推荐语音
                                </span>
                            ) : null}
                        </div>
                        {/* 第二行：单价/积分标签 + 渠道信息（字号稍小、浅灰色次级展示） */}
                        <div className="flex items-center justify-between gap-2 pl-5 text-[11px] text-stone-400 dark:text-stone-500">
                            <span className="truncate">
                                {isRecommendedAudio ? (
                                    <span>通用标准语音模型 · 支持直接调用或自定义通道</span>
                                ) : pricing ? (
                                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-mono font-medium">
                                        <Zap className="size-3 fill-current" />
                                        {pricing.formatted_points_cost}
                                    </span>
                                ) : (
                                    <span>{personalPricing.loading ? "本人报价加载中" : personalPricing.error || "本人报价暂不可用"}</span>
                                )}
                            </span>
                            {item.channelName ? (
                                <span className="shrink-0 text-[10px] opacity-75">
                                    {item.channelName}
                                </span>
                            ) : null}
                        </div>
                        {pricing?.discount ? <span className="pl-5 text-[10px]">本人优惠倍率 {pricing.discount.factor}</span> : null}
                        {pricing ? <span className="pl-5 text-[10px] whitespace-pre-line opacity-75">{pricing.group_quotes.map(quote => `${quote.group}：${quote.formatted_points_cost}（最终倍率 ${quote.final_ratio}）`).join("\n")}{"\n"}{pricing.billing_mode === "tiered_expr" || pricing.billing_expr ? "表达式计费，按实际用量结算。" : "估算报价，实际计费组由路由决定。"}</span> : null}
                    </div>
                ),
            };
        });

        if (matched.length === 0 && !query) {
            result.push({
                value: "",
                disabled: true,
                label: (
                    <div className="py-2.5 px-2 text-center text-xs text-stone-400">
                        当前通道暂无对应模型，请在上方输入自定义模型名称
                    </div>
                ),
            });
        }

        // 如果用户主动输入了新关键词且不在匹配列表中，提供“使用自定义模型”快捷选项
        const exactMatch = filteredModels.some((item) => item.model.toLowerCase() === query);
        if (query && !exactMatch && !isUnchangedValue) {
            result.unshift({
                value: inputValue.trim(),
                label: (
                    <div className="flex items-center gap-1.5 py-1 px-0.5 text-xs font-semibold text-blue-600 dark:text-blue-400">
                        <Sparkles className="size-3.5 shrink-0" />
                        <span className="break-all whitespace-normal">使用自定义模型: {inputValue.trim()}</span>
                    </div>
                ),
            });
        }

        return result;
    }, [filteredModels, inputValue, value, personalPricing]);

    const applyModel = (targetModel: string) => {
        const trimmed = targetModel.trim();
        if (!trimmed) {
            onChange("", channelId);
            return;
        }

        // 如果用户输入了新模型，自动写入当前渠道的 models 列表并持久化保存
        const effectiveChannelId = channelId || channels[0]?.id || "";
        if (effectiveChannelId && config.channelMode === "local") {
            const currentChannels = normalizeLocalChannels(config);
            const targetChannel = currentChannels.find((c) => c.id === effectiveChannelId) || currentChannels[0];
            if (targetChannel && !targetChannel.models.includes(trimmed)) {
                const nextChannels = currentChannels.map((c) => {
                    if (c.id === targetChannel.id) {
                        return { ...c, models: [...c.models, trimmed] };
                    }
                    return c;
                });
                useConfigStore.getState().updateConfig("localChannels", nextChannels);
                useConfigStore.getState().updateConfig("models", normalizeModelList(nextChannels.flatMap((c) => c.models)));
            }
        }

        onChange(trimmed, effectiveChannelId);
    };

    return (
        <AutoComplete
            value={inputValue}
            options={options}
            popupMatchSelectWidth={false}
            dropdownStyle={{ minWidth: 300, maxWidth: 460, maxHeight: 380, overflowY: "auto" }}
            defaultActiveFirstOption={false}
            onChange={(val) => {
                setInputValue(val);
            }}
            onSelect={(val) => {
                setInputValue(val);
                applyModel(val);
            }}
            onBlur={() => {
                applyModel(inputValue);
            }}
            className="w-full"
        >
            <Input
                prefix={<ModelIcon model={inputValue} />}
                suffix={<ChevronDown className="size-3.5 text-stone-400 opacity-60 pointer-events-none" />}
                placeholder={placeholder}
                allowClear
                onFocus={(e) => {
                    // 聚焦时自动全选，并后台静默拉取中转站最新模型与本人报价
                    e.target.select();
                    void loadPublicSettings();
                    void loadRemotePricing();
                }}
                onPressEnter={() => applyModel(inputValue)}
            />
        </AutoComplete>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(model);
    return icon ? <img src={icon} alt="" className="size-3.5 shrink-0 dark:invert" /> : <Cpu className="size-3.5 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = (model || "").toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai") || name.includes("dall-e")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("cogview")) return "/icons/glm.svg";
    return "";
}
