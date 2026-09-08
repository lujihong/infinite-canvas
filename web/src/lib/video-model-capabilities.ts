export function modelKey(modelName: string) {
    return modelName.trim().toLowerCase().replace(/[._/]+/g, "-");
}

export function isCogVideoX3Model(modelName: string) {
    return modelKey(modelName) === "cogvideox-3";
}

export function isAgnesVideoV25Model(modelName: string) {
    return modelKey(modelName) === "agnes-video-2-5";
}

export const COGVIDEOX3_DURATIONS = ["5", "10"] as const;

export function normalizeCogVideoX3Duration(value: string) {
    const seconds = Number(value) || 5;
    return Math.abs(seconds - 5) <= Math.abs(seconds - 10) ? COGVIDEOX3_DURATIONS[0] : COGVIDEOX3_DURATIONS[1];
}

export function supportsVideoFrameReferences(modelName: string, protocol = "") {
    const model = modelKey(modelName);
    return (
        isAgnesVideoV25Model(model) ||
        isCogVideoX3Model(model) ||
        model.includes("seedance") ||
        model.includes("wan-2-7") ||
        model.includes("wan2-7") ||
        model.includes("hailuo-02") ||
        model.includes("kling-v2-1") ||
        model.includes("kling-v2-5") ||
        model.includes("kling-2-6") ||
        model.includes("kling-v2-6") ||
        model.includes("kling-3") ||
        model.includes("kling-v3") ||
        model.includes("minimax-h3") ||
        model.includes("happyhorse") ||
        model.includes("happyhouse") ||
        (protocol === "gemini" && (model.startsWith("veo-3-1") || model.startsWith("veo3-1"))) ||
        (model.includes("veo3-1") && model.includes("official")) ||
        model.includes("skyreels-v4") ||
        model.includes("pixverse-v6") ||
        model.includes("viduq3") ||
        model.includes("vidu-q3")
    );
}

export function supportsVideoAudioGeneration(modelName: string) {
    const model = modelKey(modelName);
    if (model.includes("motion-control")) return false;
    return (
        isCogVideoX3Model(model) ||
        model.includes("seedance") ||
        model.includes("kling-2-6") ||
        model.includes("kling-v2-6") ||
        model.includes("kling-3") ||
        model.includes("kling-v3") ||
        model.includes("wan-2-6") ||
        model.includes("wan2-6") ||
        model.includes("pixverse-v6") ||
        model.includes("viduq3") ||
        model.includes("vidu-q3") ||
        (model.includes("veo") && model.includes("official"))
    );
}
