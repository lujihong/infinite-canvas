import { apiGet, apiPost } from "@/services/api/request";

export const AUTH_TOKEN_KEY = "infinite-canvas-auth-token-v1";

export type UserRole = "guest" | "user" | "admin";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
    createdAt: string;
    updatedAt: string;
};

export type AuthSession = {
    token: string;
    user: AuthUser;
};

export type AuthPayload = {
    username: string;
    password: string;
    email?: string;
    verification_code?: string;
};

export type UserWalletInfo = {
    quota: number | null;
    balanceYuan: number | null;
    points: number | null;
    formattedPoints?: string;
    formattedBalance: string;
    exchangeRate: number | null;
    minTopup: number;
};

export type RechargeOrderResult = {
    trade_no: string;
    qrcode: string;
    payurl: string;
    amount: number;
    orderName: string;
};

export async function login(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/login", payload);
}

export async function register(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/register", payload);
}

export async function sendEmailVerification(email: string) {
    return apiGet<boolean>(`/api/auth/email/verification?email=${encodeURIComponent(email)}`);
}

export async function requestPasswordReset(email: string) {
    return apiPost<boolean>("/api/auth/password/reset-request", { email });
}

export async function submitPasswordReset(payload: { email: string; token: string; password: string }) {
    return apiPost<boolean>("/api/auth/password/reset", payload);
}

export async function fetchUserWallet(token?: string) {
    return apiGet<UserWalletInfo>("/api/v1/user/wallet", undefined, token);
}

export async function createRechargeOrder(amount: number, token?: string) {
    return apiPost<RechargeOrderResult>("/api/v1/user/recharge", { amount }, token);
}

export async function checkRechargeStatus(tradeNo: string, token?: string) {
    return apiGet<{ paid: boolean; status: number }>(`/api/v1/user/recharge/status?trade_no=${encodeURIComponent(tradeNo)}`, undefined, token);
}

export type ConsumptionLogItem = {
    id: number;
    created_at: number;
    submit_time?: number;
    complete_time?: number;
    model_name: string;
    type: number;
    status?: "success" | "failed" | "refunded" | "processing" | "free";
    status_label?: string;
    progress?: number;
    duration_seconds?: number;
    task_id?: string;
    task_action?: string;
    video_url?: string;
    quota: number;
    points_cost: number;
    formatted_points: string;
    pre_consumed_quota?: number;
    actual_quota?: number;
    pre_consumed_points?: number;
    actual_points?: number;
    money_yuan: number;
    formatted_money: string;
    prompt_tokens: number;
    completion_tokens: number;
    use_time: number;
    is_stream: boolean;
    error_message?: string;
    error_detail?: string;
    request_id?: string;
    upstream_request_id?: string;
};

export type ConsumptionLogRange = {
    startTimestamp?: number;
    endTimestamp?: number;
    category?: "all" | "image" | "video" | "audio" | "text";
    status?: "all" | "success" | "failed" | "refunded";
    keyword?: string;
};

function consumptionLogQuery(range?: ConsumptionLogRange) {
    return range ? {
        start_timestamp: range.startTimestamp,
        end_timestamp: range.endTimestamp,
        category: range.category,
        status: range.status,
        keyword: range.keyword?.trim(),
    } : undefined;
}

export async function fetchUserConsumptionLogs(token: string, range?: ConsumptionLogRange) {
    return apiGet<ConsumptionLogItem[]>("/api/v1/user/logs", consumptionLogQuery(range), token);
}

function exportErrorMessage(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const body = value as Record<string, unknown>;
    const nested = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined;
    // Only business-message fields: never stringify the response/data/other/debug payload.
    for (const candidate of [body.message, body.msg, nested?.message, typeof body.error === "string" ? body.error : undefined]) {
        if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return undefined;
}

function consumptionLogExportQuery(range?: ConsumptionLogRange) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(consumptionLogQuery(range) || {})) {
        if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return params;
}

export type PreparedConsumptionLogsExport = { download_url: string; file_name: string; row_count?: number };

export async function prepareUserConsumptionLogsExport(token: string, range: ConsumptionLogRange | undefined, signal: AbortSignal | undefined, exportRequestId: string): Promise<PreparedConsumptionLogsExport> {
    if (!exportRequestId) throw new Error("缺少导出请求标识");
    const params = consumptionLogExportQuery(range);
    params.set("export_request_id", exportRequestId);
    const response = await fetch(`/api/v1/user/logs/export/prepare?${params}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "same-origin",
        signal,
    });
    signal?.throwIfAborted();
    let body: { code?: number; data?: Partial<PreparedConsumptionLogsExport> };
    try {
        body = await response.json();
    } catch {
        signal?.throwIfAborted();
        throw new Error(response.ok ? "导出准备接口返回了无效的 JSON" : `导出准备失败（HTTP ${response.status}）`);
    }
    signal?.throwIfAborted();
    if (!response.ok || !body || body.code !== 0) {
        throw new Error(exportErrorMessage(body) || `导出准备失败（HTTP ${response.status}）`);
    }
    const data = body.data;
    // Only permit this site's export attachment endpoint, never arbitrary navigation/credentials.
    if (!data || typeof data.download_url !== "string" || !/^\/api\/v1\/user\/logs\/export\/download\/[a-f0-9]{64}$/.test(data.download_url) || /%(?:2e|2f|5c)/i.test(data.download_url) || data.download_url.includes("..")) {
        throw new Error("导出准备接口返回了无效的下载地址");
    }
    if (typeof data.file_name !== "string" || !data.file_name.toLowerCase().endsWith(".xlsx") || /[\x00-\x1f/\\]/.test(data.file_name)) {
        throw new Error("导出准备接口返回了无效的文件名");
    }
    return {
        download_url: data.download_url,
        file_name: data.file_name,
        ...(typeof data.row_count === "number" && Number.isSafeInteger(data.row_count) && data.row_count >= 0 ? { row_count: data.row_count } : {}),
    };
}

// Best-effort cleanup uses the initiating token, never a later account's credentials.
export async function cancelUserConsumptionLogsExport(token: string, exportRequestId: string): Promise<void> {
    if (!exportRequestId) return;
    try {
        const params = new URLSearchParams({ export_request_id: exportRequestId });
        await fetch(`/api/v1/user/logs/export/pending?${params}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
            credentials: "same-origin",
            keepalive: true,
        });
    } catch {
        // Cancellation must not block closing/sign-out; server expiry remains the fallback.
    }
}

export async function fetchUserConsumptionLogsExport(token: string, range?: ConsumptionLogRange, signal?: AbortSignal) {
    const response = await fetch(`/api/v1/user/logs/export?${consumptionLogExportQuery(range)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
    });
    signal?.throwIfAborted();
    const contentType = (response.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    const isWorkbook = contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (!response.ok || !isWorkbook) {
        let detail: string | undefined;
        try {
            detail = exportErrorMessage(await response.json());
        } catch {
            // Malformed JSON/HTML must stay a failure, never become a downloadable workbook.
        }
        signal?.throwIfAborted();
        throw new Error(detail || (!response.ok ? `导出失败（HTTP ${response.status}）` : "导出接口未返回有效的 Excel 文件"));
    }
    const blob = await response.blob();
    signal?.throwIfAborted();
    // Constant-size sanity check only; keep the large XLSX as a raw Blob, not a JS workbook.
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    signal?.throwIfAborted();
    if (blob.size < 22 || signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
        throw new Error("导出接口返回的 Excel 文件无效或不完整");
    }
    return blob;
}

export type RechargeLogItem = {
    id: number;
    trade_no: string;
    amount: number;
    money: number;
    points: number;
    formatted_money: string;
    formatted_points: string;
    payment_method: string;
    payment_name: string;
    status: string;
    status_label: string;
    create_time: number;
    complete_time: number;
};

export async function fetchUserRechargeLogs(token: string) {
    return apiGet<RechargeLogItem[]>("/api/v1/user/recharge-logs", undefined, token);
}

export async function fetchCurrentUser(token?: string) {
    return apiGet<AuthUser>("/api/auth/me", undefined, token);
}
