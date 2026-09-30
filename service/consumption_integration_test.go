package service

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestConsumptionDisplayWalletAndLogHTTPAgreement(t *testing.T) {
	old := config.Cfg
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "consumption.db")
	t.Cleanup(func() { config.Cfg = old })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "consumption-display", Username: "consumption-display", AffCode: "consumption-display", Status: model.UserStatusActive, Role: model.UserRoleUser, Extra: `{"newapi_user_id":101,"newapi_token":"display-test"}`}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Where("id = ?", user.ID).Delete(&model.User{}) })
	systemStatusMu.Lock()
	oldCache := systemStatusCache
	systemStatusCache = newAPISystemStatusCache{}
	systemStatusMu.Unlock()
	t.Cleanup(func() { systemStatusMu.Lock(); systemStatusCache = oldCache; systemStatusMu.Unlock() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/status":
			fmt.Fprint(w, `{"success":true,"data":{"quota_per_unit":500000,"usd_exchange_rate":1}}`)
		case "/api/user/quota-by-token":
			fmt.Fprint(w, `{"success":true,"data":{"quota":1000}}`)
		case "/api/log/token/page":
			if r.URL.Query().Get("start_timestamp") == "" || r.URL.Query().Get("end_timestamp") == "" {
				t.Errorf("missing required time range")
			}
			if r.URL.Query().Get("before_id") == "" {
				fmt.Fprint(w, `{"success":true,"data":{"items":[{"id":5,"type":5,"quota":0,"model_name":"text"},{"id":4,"type":6,"quota":1,"model_name":"text"},{"id":3,"type":5,"quota":1000,"model_name":"text","content":"upstream failed"}],"total":5,"snapshot_id":5,"next_before_id":3,"has_more":true}}`)
			} else {
				fmt.Fprint(w, `{"success":true,"data":{"items":[{"id":2,"type":2,"quota":1,"model_name":"text"},{"id":1,"type":2,"quota":1000,"model_name":"text"}],"total":5,"snapshot_id":5,"next_before_id":1,"has_more":false}}`)
			}
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	t.Setenv("NEWAPI_BASE_URL", upstream.URL)
	wallet, err := FetchUserWalletBalance(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	logs, err := FetchUserConsumptionLogs(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 5 {
		t.Fatalf("logs count %d", len(logs))
	}
	byQuota := make(map[int64]ConsumptionLogItem)
	for _, item := range logs {
		byQuota[item.Quota] = item
	}
	charged := byQuota[1000]
	if charged.MoneyYuan != wallet["balanceYuan"].(float64) || charged.PointsCost != wallet["points"].(float64) {
		t.Fatalf("wallet/log disagree: wallet=%v log=%+v", wallet, charged)
	}
	if charged.MoneyYuan != .002 || charged.PointsCost != .02 {
		t.Fatal("extra multiplier remains")
	}
	if tiny := byQuota[1]; tiny.Status == "free" || tiny.PointsCost <= 0 || tiny.FormattedPoints != "<0.001 积分" {
		t.Fatalf("tiny debit misclassified: %+v", tiny)
	}
	var chargedFailure, refund, unchargedFailure *ConsumptionLogItem
	for i := range logs {
		item := &logs[i]
		if item.Type == 5 && item.Quota > 0 {
			chargedFailure = item
		}
		if item.Type == 6 {
			refund = item
		}
		if item.Type == 5 && item.Quota == 0 {
			unchargedFailure = item
		}
	}
	if chargedFailure == nil || chargedFailure.Status != "failed" || chargedFailure.PointsCost <= 0 || !strings.Contains(chargedFailure.StatusLabel, "存在扣费记录") {
		t.Fatal("charged error concealed")
	}
	if refund == nil || refund.StatusLabel != "额度退还" || refund.FormattedPoints != "+<0.001 积分" {
		t.Fatalf("small refund wrong: %+v", refund)
	}
	if unchargedFailure == nil || unchargedFailure.StatusLabel != "调用失败 · 未扣费" || unchargedFailure.PointsCost != 0 {
		t.Fatal("uncharged error wrong")
	}
}
