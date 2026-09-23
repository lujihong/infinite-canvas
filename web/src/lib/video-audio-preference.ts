import { modelKey } from "@/lib/video-model-capabilities";

const DEFAULT_AUDIO_MODELS = new Set(["moma-seedance-2-0", "nm-moma-seedance-2-0"]);

export type VideoAudioPreferences = Record<string, boolean>;

export function resolveVideoAudioPreference(
    model: string,
    configuredValue?: string | boolean | null,
    preferences?: VideoAudioPreferences,
    explicitNodeValue?: boolean,
) {
    if (explicitNodeValue !== undefined) return explicitNodeValue;
    const key = modelKey(model);
    if (preferences && Object.prototype.hasOwnProperty.call(preferences, key)) return preferences[key];
    if (DEFAULT_AUDIO_MODELS.has(key)) return true;
    return configuredValue === "true" || configuredValue === true;
}
