package service

import "testing"

func TestConsumptionDisplayBilling(t *testing.T) {
	yuan, points := quotaBillingValues(1000, 500000)
	if yuan != 0.002 || points != 0.02 {
		t.Fatalf("billing values = %v yuan, %v points; want 0.002, 0.02", yuan, points)
	}
	if got := formatBillingPoints(points); got != "0.02 积分" {
		t.Fatalf("points display = %q", got)
	}
	if got := formatBillingMoney(yuan); got == "¥ 0.0000" {
		t.Fatalf("small positive money must not display as zero: %q", got)
	}

	_, tinyPoints := quotaBillingValues(1, 500000)
	if got := formatBillingPoints(tinyPoints); got == "0.00 积分" || got == "0.000 积分" {
		t.Fatalf("tiny positive points must remain non-zero: %q", got)
	}
}

func TestConsumptionDisplayStatuses(t *testing.T) {
	cases := []struct {
		typ         int
		quota       int64
		local, want string
	}{
		{5, 0, "", "调用失败 · 未扣费"},
		{5, 1000, "", "调用失败 · 存在扣费记录"},
		{6, 1000, "success", "差额退还"},
		{6, 1000, "completed", "差额退还"},
		{6, 1000, " SUCCEEDED ", "差额退还"},
		{6, 1000, "failed", "失败已退款"},
		{6, 1000, "", "额度退还"},
	}
	for _, tc := range cases {
		if got := consumptionStatusLabel(tc.typ, tc.quota, tc.local); got != tc.want {
			t.Errorf("status(%d,%d,%q)=%q, want %q", tc.typ, tc.quota, tc.local, got, tc.want)
		}
	}
	_, points := quotaBillingValues(1, 500000)
	if points <= 0 {
		t.Fatal("type 2 positive quota must remain billable")
	}
}

func TestConsumptionDisplayErrorTextDoesNotInventRefunds(t *testing.T) {
	message, _ := parseErrorMessage("", "")
	if message != "任务异常中断，费用状态请查看账单" {
		t.Fatal(message)
	}
	message, _ = parseErrorMessage("", `{"reason":"copyright policy"}`)
	if message != "生成内容触发版权安全策略，费用状态请查看扣费与退款记录" {
		t.Fatal(message)
	}
}

func TestConsumptionDisplayRawQuotaSemantics(t *testing.T) {
	_, points := quotaBillingValues(1, 500000)
	if points <= 0 {
		t.Fatal("positive quota must remain billable")
	}
	if got := formatBillingPoints(points); got == "0.00 积分" {
		t.Fatalf("rounded display must not drive free classification: %q", got)
	}
}
