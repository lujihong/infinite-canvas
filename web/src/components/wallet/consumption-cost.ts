import type { ConsumptionLogItem } from '@/services/api/auth';

export function consumptionCostPresentation(log: ConsumptionLogItem): { amount: string; detail: string } {
    if (log.status === 'processing') return { amount: '计算中', detail: '生成中，最终费用尚未结算' };
    const points = (log.formatted_points || '').replace(/^[+-]+/, '');
    if (log.type === 6 || log.status === 'refunded') {
        return { amount: `+${points}`, detail: log.status_label || '额度已退还' };
    }
    const charged = log.quota > 0;
    if (log.type === 5 || log.status === 'failed') {
        return charged
            ? { amount: `-${points}`, detail: '调用失败，存在扣费记录，请以账单及后续退款为准' }
            : { amount: '0.00 积分', detail: '调用未完成，本条记录未扣费' };
    }
    if (!charged) return { amount: '0.00 积分', detail: '本条记录扣费为零' };
    if (log.status_label === '差额补扣') {
        return { amount: `-${points}`, detail: `差额补扣 · 折合 ${log.formatted_money}` };
    }
    return { amount: `-${points}`, detail: `折合 ${log.formatted_money}` };
}
