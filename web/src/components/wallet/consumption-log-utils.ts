import type { ConsumptionLogItem, ConsumptionLogRange } from "@/services/api/auth";
import { canPersistSessionData, captureSessionIdentity, isSessionIdentityCurrent } from "@/lib/session-identity";

export type ConsumptionPeriod = "all" | "day" | "week" | "month" | "year" | "custom";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// datetime-local is explicitly Beijing wall time, independent of browser timezone/DST.
function parseBeijingInput(value: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!match) return null;
    const [, y, m, d, h, min, sec = "00"] = match;
    if (+y < 1000) return null;
    const wall = Date.UTC(+y, +m - 1, +d, +h, +min, +sec);
    if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== `${y}-${m}-${d}T${h}:${min}:${sec}`) return null;
    return (wall - BEIJING_OFFSET_MS) / 1000;
}

// All ranges are [start, end); a week starts on Monday, including when today is Sunday.
export function consumptionLogBounds(period: ConsumptionPeriod, start = "", end = "", now = Date.now()): ConsumptionLogRange | null {
    if (period === "all") return {};
    if (period === "custom") {
        const startTimestamp = parseBeijingInput(start);
        const endTimestamp = parseBeijingInput(end);
        return startTimestamp !== null && endTimestamp !== null && endTimestamp > startTimestamp
            ? { startTimestamp, endTimestamp } : null;
    }
    const wall = new Date(now + BEIJING_OFFSET_MS);
    const year = wall.getUTCFullYear();
    const month = wall.getUTCMonth();
    let from = Date.UTC(year, month, wall.getUTCDate());
    let to = from + DAY_MS;
    if (period === "week") {
        from -= ((wall.getUTCDay() + 6) % 7) * DAY_MS;
        to = from + 7 * DAY_MS;
    } else if (period === "month") {
        from = Date.UTC(year, month, 1);
        to = Date.UTC(year, month + 1, 1);
    } else if (period === "year") {
        from = Date.UTC(year, 0, 1);
        to = Date.UTC(year + 1, 0, 1);
    }
    return { startTimestamp: (from - BEIJING_OFFSET_MS) / 1000, endTimestamp: (to - BEIJING_OFFSET_MS) / 1000 };
}

export function formatConsumptionTime(timestamp: number): string {
    if (!Number.isFinite(timestamp)) return "-";
    const date = new Date(timestamp * 1000 + BEIJING_OFFSET_MS);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replace("T", " ") : "-";
}

// One pass over the loaded array; no copying/serialization of arbitrary raw fields.
export function filterConsumptionLogs(logs: ConsumptionLogItem[], range: ConsumptionLogRange | null): ConsumptionLogItem[] {
    if (!range) return [];
    const keyword = range.keyword?.trim().toLowerCase() || "";
    return logs.filter((item) => {
        const timestamp = item.submit_time || item.created_at;
        if (range.startTimestamp !== undefined && !(timestamp >= range.startTimestamp)) return false;
        if (range.endTimestamp !== undefined && !(timestamp < range.endTimestamp)) return false;
        if (range.status === "success" && item.status !== "success") return false;
        if (range.status === "failed" && item.status !== "failed" && item.type !== 5) return false;
        if (range.status === "refunded" && item.status !== "refunded" && item.type !== 6) return false;
        const name = (item.model_name || "").toLowerCase();
        const action = (item.task_action || "").toLowerCase();
        if (range.category && range.category !== "all") {
            const isImage = action.includes("图") || ["image", "flux", "dall", "midjourney", "seedream"].some(part => name.includes(part));
            const isVideo = action.includes("视频") || ["video", "seedance", "kling", "sora", "hailuo", "happyhouse", "omni", "minimax-h3"].some(part => name.includes(part));
            const isAudio = action.includes("音频") || ["music", "audio", "tts", "voice", "suno", "speech"].some(part => name.includes(part));
            if (range.category === "image" && (!isImage || isVideo)) return false;
            if (range.category === "video" && !isVideo) return false;
            if (range.category === "audio" && !isAudio) return false;
            if (range.category === "text" && (isImage || isVideo || isAudio)) return false;
        }
        return !keyword || [name, action, (item.task_id || "").toLowerCase(), (item.request_id || "").toLowerCase()].some(value => value.includes(keyword));
    });
}

export type ConsumptionExportTicket = { controller: AbortController; isCurrent: () => boolean; onCancel?: () => void };

// Component-owned gate. It never mutates the shared auth store/session identity.
export function createConsumptionExportGuard() {
    let epoch = 0;
    let active: ConsumptionExportTicket | null = null;
    return {
        cancel() {
            epoch++;
            const previous = active;
            active = null;
            previous?.controller.abort();
            previous?.onCancel?.();
        },
        start(token: string, userId: string, onCancel?: () => void): ConsumptionExportTicket | null {
            if (active || !token || !userId || !canPersistSessionData()) return null;
            const identity = captureSessionIdentity();
            if (identity.token !== token || identity.userId !== userId) return null;
            const requestEpoch = ++epoch;
            const controller = new AbortController();
            const ticket: ConsumptionExportTicket = {
                controller,
                onCancel,
                isCurrent: () => active === ticket && epoch === requestEpoch && !controller.signal.aborted && isSessionIdentityCurrent(identity) && canPersistSessionData(),
            };
            active = ticket;
            return ticket;
        },
        finish(ticket: ConsumptionExportTicket) {
            if (active !== ticket) return false;
            active = null;
            return true;
        },
    };
}
