package service

import "testing"

func TestLocalCreditsFromQuota(t *testing.T) {
	for _, tc := range []struct {
		name       string
		quota      int64
		quotaUnit  int64
		wantCredit int
	}{
		{name: "one thousand points at default unit", quota: 50_000_000, quotaUnit: 500_000, wantCredit: 1000},
		{name: "fraction truncates toward zero", quota: 525_000, quotaUnit: 500_000, wantCredit: 10},
		{name: "zero quota", quota: 0, quotaUnit: 500_000, wantCredit: 0},
		{name: "negative quota", quota: -1, quotaUnit: 500_000, wantCredit: 0},
		{name: "missing unit", quota: 50_000_000, quotaUnit: 0, wantCredit: 0},
		{name: "negative unit", quota: 50_000_000, quotaUnit: -1, wantCredit: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := localCreditsFromQuota(tc.quota, tc.quotaUnit); got != tc.wantCredit {
				t.Fatalf("localCreditsFromQuota(%d, %d) = %d, want %d", tc.quota, tc.quotaUnit, got, tc.wantCredit)
			}
		})
	}
}
