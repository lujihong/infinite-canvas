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
		case "/api/log/token":
			fmt.Fprint(w, `{"success":true,"data":[{"id":1,"type":2,"quota":1000,"model_name":"text"},{"id":2,"type":2,"quota":1,"model_name":"text"},{"id":3,"type":5,"quota":1000,"model_name":"text","content":"upstream failed"},{"id":4,"type":6,"quota":1,"model_name":"text"},{"id":5,"type":5,"quota":0,"model_name":"text"}]}`)
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
	if logs[0].MoneyYuan != wallet["balanceYuan"].(float64) || logs[0].PointsCost != wallet["points"].(float64) {
		t.Fatalf("wallet/log disagree: wallet=%v log=%+v", wallet, logs[0])
	}
	if logs[0].MoneyYuan != .002 || logs[0].PointsCost != .02 {
		t.Fatal("extra multiplier remains")
	}
	if logs[1].Status == "free" || logs[1].PointsCost <= 0 || logs[1].FormattedPoints != "<0.001 积分" {
		t.Fatalf("tiny debit misclassified: %+v", logs[1])
	}
	if logs[2].Status != "failed" || logs[2].PointsCost <= 0 || !strings.Contains(logs[2].StatusLabel, "存在扣费记录") {
		t.Fatal("charged error concealed")
	}
	if logs[3].StatusLabel != "额度退还" || logs[3].FormattedPoints != "+<0.001 积分" {
		t.Fatalf("small refund wrong: %+v", logs[3])
	}
	if logs[4].StatusLabel != "调用失败 · 未扣费" || logs[4].PointsCost != 0 {
		t.Fatal("uncharged error wrong")
	}
}
