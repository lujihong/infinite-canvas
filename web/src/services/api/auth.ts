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

export async function fetchUserConsumptionLogs(token: string) {
    return apiGet<ConsumptionLogItem[]>("/api/v1/user/logs", undefined, token);
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
