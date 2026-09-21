import axios from "axios";
import { useUserStore } from "@/stores/use-user-store";

export type AiccGroup = { groupId: string; groupName: string; groupType: "AIGC" | "LivenessFace"; channelId?: number };
export type AiccAsset = { assetId: string; groupId: string; assetName: string; assetType: "Image" | "Video" | "Audio"; assetUrl?: string; status: string; channelId?: number };
export type AiccPage<T> = { data: T[]; total?: number };
export type AiccSession = { bytedToken: string; h5Link: string; expiresIn: number };
export type AiccUpload = { id: string; url: string; assetType: AiccAsset["assetType"]; mimeType: string; bytes: number; expiresAt: number };
export type AiccChannel = { id: number; name: string; region?: string; models: string[] };

export const AICC_UPLOAD_LIMITS = {
    Image: { maxBytes: 30 * 1024 * 1024, accept: ".jpg,.jpeg,.png,.webp", extensions: /\.(jpe?g|png|webp)$/i, mimeTypes: ["image/jpeg", "image/png", "image/webp"], label: "JPEG / PNG / WebP，最大 30 MiB" },
    Video: { maxBytes: 50 * 1024 * 1024, accept: ".mp4,.mov", extensions: /\.(mp4|mov)$/i, mimeTypes: ["video/mp4", "video/quicktime"], label: "MP4 / MOV，最大 50 MiB，2–15 秒" },
    Audio: { maxBytes: 15 * 1024 * 1024, accept: ".mp3,.wav", extensions: /\.(mp3|wav)$/i, mimeTypes: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"], label: "MP3 / WAV，最大 15 MiB，2–15 秒" },
};

export function validateAiccFile(file: File, assetType: AiccAsset["assetType"]) {
    const limits = AICC_UPLOAD_LIMITS[assetType];
    if (!limits.extensions.test(file.name) || (file.type && !limits.mimeTypes.includes(file.type.toLowerCase()))) throw new Error(`文件格式不支持，请选择 ${limits.label}`);
    if (!file.size || file.size > limits.maxBytes) throw new Error(`文件大小不符合限制：${limits.label}`);
}

export function aiccUploadExpiry(value: number): number {
    return Number.isSafeInteger(value) && value > 0 ? value * 1000 : NaN;
}

async function request(path: string, method: "GET" | "POST", data?: unknown, params?: Record<string, unknown>, signal?: AbortSignal) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后使用人物素材");
    const response = await axios.request({ url: `/api/aicc/${path}`, method, data, params, signal, timeout: path === "uploads" ? 120_000 : 60_000, headers: { Authorization: `Bearer ${token}` } });
    if (signal?.aborted || useUserStore.getState().token !== token) throw new Error("请求已取消或登录身份已改变");
    const envelope = response.data;
    if (!envelope || envelope.success !== true) throw new Error(envelope?.message || envelope?.msg || "人物素材请求失败");
    if (envelope.data?.state && envelope.data.state !== "OK") throw new Error("移动云素材服务返回异常");
    return envelope.data;
}
function page<T>(value: unknown): AiccPage<T> {
    const body = (value as { body?: unknown })?.body;
    if (!body || typeof body !== "object" || !Array.isArray((body as AiccPage<T>).data)) throw new Error("素材列表格式异常，请刷新重试");
    const result = body as AiccPage<T>;
    if (!result.data.every(item => item && typeof item === "object")) throw new Error("素材记录格式异常");
    return { data: result.data, total: typeof result.total === "number" && result.total >= 0 ? result.total : undefined };
}
export async function aiccChannels(signal?: AbortSignal): Promise<AiccChannel[]> {
    const value = await request("channels", "GET", undefined, undefined, signal);
    if (!Array.isArray(value) || !value.every(item => item && Number.isSafeInteger(item.id) && item.id > 0 && typeof item.name === "string" && Array.isArray(item.models) && item.models.every((model: unknown) => typeof model === "string"))) throw new Error("素材渠道响应格式异常，请刷新重试");
    return value;
}

export async function aiccGroups(type: string, pageNo: number, channelIdOrSignal?: number | AbortSignal, maybeSignal?: AbortSignal) {
    const channelId = typeof channelIdOrSignal === "number" ? channelIdOrSignal : undefined;
    const signal = channelIdOrSignal instanceof AbortSignal ? channelIdOrSignal : maybeSignal;
    const params: Record<string, unknown> = { groupType: type, pageNo, pageSize: 12 };
    if (channelId && channelId > 0) params.channel_id = channelId;
    return page<AiccGroup>(await request("asset-groups", "GET", undefined, params, signal));
}

export async function aiccAssets(group: AiccGroup, pageNo: number, channelIdOrSignal?: number | AbortSignal, maybeSignal?: AbortSignal) {
    const channelId = typeof channelIdOrSignal === "number" ? channelIdOrSignal : undefined;
    const signal = channelIdOrSignal instanceof AbortSignal ? channelIdOrSignal : maybeSignal;
    const params: Record<string, unknown> = { groupType: group.groupType, groupIds: group.groupId, pageNo, pageSize: 12 };
    const effectiveChannelId = channelId || group.channelId;
    if (effectiveChannelId && effectiveChannelId > 0) params.channel_id = effectiveChannelId;
    return page<AiccAsset>(await request("assets", "GET", undefined, params, signal));
}

export async function aiccSession(signalOrChannelId?: AbortSignal | number, maybeChannelId?: number, maybeSignal?: AbortSignal): Promise<AiccSession> {
    const signal = signalOrChannelId instanceof AbortSignal ? signalOrChannelId : maybeSignal;
    const channelId = typeof signalOrChannelId === "number" ? signalOrChannelId : maybeChannelId;
    const params = channelId && channelId > 0 ? { channel_id: channelId } : undefined;
    const value = await request("auth/session", "POST", {}, params, signal);
    if (!value?.bytedToken || !/^https:\/\//.test(value?.h5Link || "") || !Number.isFinite(value.expiresIn) || value.expiresIn <= 0) throw new Error("认证链接格式异常");
    return value;
}

export async function aiccCheck(token: string, signal?: AbortSignal): Promise<boolean> {
    const value = await request("auth/group", "POST", { bytedToken: token }, undefined, signal);
    return value?.authenticated === true;
}

export async function aiccCreateGroup(groupName: string, channelId?: number, signal?: AbortSignal) {
    return request("asset-groups", "POST", { groupName }, aiccChannelParams(channelId), signal);
}

function aiccChannelParams(channelId?: number) {
    if (!Number.isSafeInteger(channelId) || (channelId ?? 0) <= 0) throw new Error("请先选择有效的移动云素材渠道");
    return { channel_id: channelId };
}

export async function aiccCreateAsset(groupId: string, assetName: string, assetUrl: string, assetType: string, signal?: AbortSignal, channelId?: number) {
    return request("assets", "POST", { groupId, assetName, assetUrl, assetType }, aiccChannelParams(channelId), signal);
}

export async function aiccUpload(file: File, groupId: string, assetType: AiccAsset["assetType"], signal?: AbortSignal, channelId?: number): Promise<AiccUpload> {
    validateAiccFile(file, assetType);
    const data = new FormData();
    data.append("file", file);
    data.append("groupId", groupId);
    data.append("assetType", assetType);
    // Leave Content-Type/boundary to the browser; use the current workbench bearer.
    const value = await request("uploads", "POST", data, aiccChannelParams(channelId), signal);
    if (!value?.id || !/^https:\/\//.test(value?.url || "") || value.assetType !== assetType || !(aiccUploadExpiry(value.expiresAt) > Date.now())) throw new Error("上传响应无效或已过期，请重新上传");
    return value;
}
