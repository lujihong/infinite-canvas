import type { ConsumptionLogItem } from '@/services/api/auth';
import { formatPoints, isKnownPoints } from '@/lib/points';

export function consumptionCostPresentation(log: ConsumptionLogItem): { amount: string; detail: string } {
    if (log.status === 'processing') return { amount: '计算中', detail: '生成中，最终费用尚未结算' };
    if (log.status_label === '差额补扣' && (log.pre_consumed_points ?? 0) > 0 && (log.actual_points ?? 0) > 0) {
        const pre = formatPoints(log.pre_consumed_points);
        const actual = formatPoints(log.actual_points);
        return { amount: formatPoints(log.points_cost, '-'), detail: `差额补扣：预扣 ${pre}，最终应扣 ${actual}，本次补扣 ${formatPoints(log.points_cost)}` };
    }
    if (!isKnownPoints(log.points_cost)) return { amount: formatPoints(null), detail: '扣费信息暂不可用' };
    if (log.type === 6 || log.status === 'refunded') {
        return { amount: formatPoints(log.points_cost, '+'), detail: log.status_label || '额度已退还' };
    }
    const charged = log.points_cost > 0;
    if (log.type === 5 || log.status === 'failed') {
        return charged
            ? { amount: formatPoints(log.points_cost, '-'), detail: '调用失败，存在扣费记录，请以账单及后续退款为准' }
            : { amount: formatPoints(0), detail: '调用未完成，本条记录未扣费' };
    }
    if (!charged) return { amount: formatPoints(0), detail: '本条记录扣费为零' };
    return { amount: formatPoints(log.points_cost, '-'), detail: log.status_label === '差额补扣' ? '差额补扣' : '实际扣费' };
}
