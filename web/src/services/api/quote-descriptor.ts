import type { AiConfig } from "@/stores/use-config-store";
import { createImageRequestDescription, createImageRequestParams, imageUsesSeparateRequests } from "./image";
import { createVideoRequestScalars, withVideoSystemPrompt } from "./video";

export type QuoteDescriptor = {
    endpoint: string;
    body: Record<string, unknown>;
    batch_count: number;
    missing_fields?: string[];
};

/** Metadata only. Existing ReferenceImage/ReferenceVideo/ReferenceAudio are assignable. */
export type QuoteReference = { url?: string; dataUrl?: string; storageKey?: string; aiccUri?: string; aiccChannelId?: number };
export type QuoteReferenceInput = {
    references?: QuoteReference[];
    videoReferences?: QuoteReference[];
    audioReferences?: QuoteReference[];
    firstFrame?: QuoteReference | null;
    lastFrame?: QuoteReference | null;
};
export type QuoteDescriptorInput = {
    config: AiConfig;
    mode: "image" | "video";
    prompt?: string;
    references?: QuoteReferenceInput;
    /** Actual outer task count. Video defaults to one; image defaults to normalized config.count. */
    batchCount?: number;
    /** Canvas uses separate; single treats count as images per request (subject to its n limit) and follows forced splitting. */
    batchMode?: "single" | "separate";
};

function publicReferenceUrl(value?: string) {
    if (!value || /^(?:blob:|data:|asset:)/i.test(value)) return "";
    try {
        const url = new URL(value, typeof window === "undefined" ? undefined : window.location.origin);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
        if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost")) return "";
        return url.href;
    } catch {
        return "";
    }
}

/** Synchronous and side-effect free: never resolves storage, reads a Blob, uploads or fetches. */
export function buildQuoteDescriptor({ config, mode, prompt, references = {}, batchCount, batchMode = "separate" }: QuoteDescriptorInput): QuoteDescriptor {
    const missing: string[] = [];
    if (!prompt?.trim()) missing.push("prompt");
    const model = mode === "video" ? config.model || config.videoModel : config.model;
    if (!model?.trim()) missing.push("model");
    if (batchCount !== undefined && (!Number.isSafeInteger(batchCount) || batchCount < 1)) missing.push("batch_count");
    const count = batchCount !== undefined && Number.isSafeInteger(batchCount) && batchCount > 0 ? batchCount : mode === "image" ? createImageRequestParams(config).n : 1;
    const result = (endpoint: string, body: Record<string, unknown>, batch_count = count): QuoteDescriptor => ({ endpoint, body, batch_count, ...(missing.length ? { missing_fields: [...new Set(missing)] } : {}) });
    const sourceChannels = new Set<number>();
    const referenceValue = (ref: QuoteReference, field: string): string | undefined => {
        if (ref.aiccUri) {
            if (mode !== "video" || !model.toLowerCase().includes("seedance")) missing.push(`${field}.unsupported_aicc`);
            if (!/^asset:\/\/asset-[A-Za-z0-9_-]+$/.test(ref.aiccUri)) {
                missing.push(`${field}.aiccUri`);
                return undefined;
            }
            if (!Number.isSafeInteger(ref.aiccChannelId) || (ref.aiccChannelId ?? 0) <= 0) missing.push(`${field}.aiccChannelId`);
            else sourceChannels.add(ref.aiccChannelId!);
            return ref.aiccUri;
        }
        const url = publicReferenceUrl(ref.url) || publicReferenceUrl(ref.dataUrl);
        if (!url) missing.push(`${field}.public_url`);
        return url || undefined;
    };
    const values = (items: QuoteReference[], field: string) => items.map((ref, i) => referenceValue(ref, `${field}[${i}]`)).filter((value): value is string => value !== undefined);
    const images = references.references || [];
    if (mode === "image") {
        const separate = batchMode === "separate" || imageUsesSeparateRequests(config);
        const requestConfig = { ...config, count: separate ? "1" : String(count) };
        const urls = values(images, "references");
        const request = createImageRequestDescription(requestConfig, prompt || "", urls, images.length > 0);
        if (!request) {
            missing.push("unsupported.image_protocol");
            return result(images.length ? "/v1/images/edits" : "/v1/images/generations", { model }, separate ? count : 1);
        }
        if (images.length && /^(glm-image|cogview-)/i.test(model)) missing.push("unsupported.image_references");
        return result(request.endpoint, request.body, separate ? count : 1);
    }

    const request = createVideoRequestScalars(config, model, withVideoSystemPrompt(config, prompt || ""));
    if (!request) {
        missing.push("unsupported.video_protocol");
        return result("/v1/videos", { model });
    }
    const body: Record<string, unknown> = { ...request.body };
    const { referencePolicy } = request;
    const addReferences = (field: string, items: QuoteReference[]) => {
        if (!items.length) return;
        const urls = values(items, field);
        if (urls.length) body[field] = urls;
    };
    addReferences("input_reference[]", images.slice(0, referencePolicy.imageLimit));
    addReferences("video_reference[]", (references.videoReferences || []).slice(0, referencePolicy.videoLimit));
    if (referencePolicy.audio) addReferences("audio_reference[]", references.audioReferences || []);
    if (referencePolicy.frames) {
        for (const [field, ref] of [["first_frame_url", references.firstFrame], ["last_frame_url", references.lastFrame]] as const) {
            if (ref) {
                const value = referenceValue(ref, field);
                if (value) body[field] = value;
            }
        }
    }
    if (request.klingV3 && request.kieKlingOmni !== "transformation" && config.videoElementList?.some(item => item.references?.length)) missing.push("unsupported.element_list");
    if (sourceChannels.size > 1) missing.push("references.aiccChannelId_mismatch");
    return result("/v1/videos", body);
}
