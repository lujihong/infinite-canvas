export function isKnownPoints(points: unknown): points is number {
    return typeof points === "number" && Number.isFinite(points) && points >= 0;
}

// Match the server's display precision without rounding tiny positive balances to zero.
export function formatPoints(points: unknown, prefix = ""): string {
    return isKnownPoints(points) ? `${prefix}${Number(points.toPrecision(12))} 积分` : "积分暂不可用";
}
