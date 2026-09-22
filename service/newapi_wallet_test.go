package service

import (
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestWalletZeroLocalAndFailures(t *testing.T) {
	old := config.Cfg
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "wallet.db")
	t.Cleanup(func() { config.Cfg = old })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, extra, quota, status string
		httpCode                   int
		want                       float64
		local, failure             bool
	}{
		{name: "zero", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{"quota":0}}`},
		{name: "tiny", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{"quota":1}}`, want: .00002},
		{name: "non-default", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{"quota":1}}`, status: `{"success":true,"data":{"quota_per_unit":1000000}}`, want: .00001},
		{name: "local", local: true, want: 123},
		{name: "malformed-binding", extra: `{`, failure: true},
		{name: "missing-quota", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{}}`, failure: true},
		{name: "null-quota", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{"quota":null}}`, failure: true},
		{name: "negative-quota", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{"quota":-1}}`, failure: true},
		{name: "overflow-quota", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{"quota":9007199254740992}}`, failure: true},
		{name: "upstream-failure", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":false,"data":{"quota":0}}`, failure: true},
		{name: "http-failure", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{"quota":0}}`, httpCode: 503, failure: true},
		{name: "malformed", extra: `{"newapi_token":"wallet-test"}`, quota: `{`, failure: true},
		{name: "missing-unit", extra: `{"newapi_token":"wallet-test"}`, quota: `{"success":true,"data":{"quota":0}}`, status: `{"success":true,"data":{}}`, failure: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			user := model.User{ID: "wallet-test-" + tc.name, Username: "wallet-test-" + tc.name, AffCode: "wallet-test-" + tc.name, Status: model.UserStatusActive, Role: model.UserRoleUser, Credits: 123, Extra: tc.extra}
			if err := db.Create(&user).Error; err != nil {
				t.Fatal(err)
			}
			defer db.Where("id = ?", user.ID).Delete(&model.User{})
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				switch r.URL.Path {
				case "/api/status":
					if r.Header.Get("Authorization") != "" {
						t.Error("credential leaked to status")
					}
					status := tc.status
					if status == "" {
						status = `{"success":true,"data":{"quota_per_unit":500000,"quota_display_type":"CNY","usd_exchange_rate":100}}`
					}
					fmt.Fprint(w, status)
				case "/api/user/quota-by-token":
					if r.Header.Get("Authorization") != "Bearer sk-wallet-test" {
						t.Error("wrong identity")
					}
					if tc.httpCode != 0 {
						w.WriteHeader(tc.httpCode)
					}
					fmt.Fprint(w, tc.quota)
				default:
					t.Error("unexpected path", r.URL.Path)
				}
			}))
			defer server.Close()
			t.Setenv("NEWAPI_BASE_URL", server.URL)
			wallet, err := FetchUserWalletBalance(user.ID)
			if tc.failure {
				if err == nil || wallet != nil {
					t.Fatalf("failure returned stale wallet: %+v %v", wallet, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(wallet["points"].(float64)-tc.want) > 1e-18 {
				t.Fatalf("points %+v want %g", wallet, tc.want)
			}
			if tc.local {
				if calls != 0 || wallet["quota"] != nil || wallet["balanceYuan"] != nil || wallet["exchangeRate"] != nil || wallet["source"] != "local" {
					t.Fatalf("local units reinterpreted: %+v calls=%d", wallet, calls)
				}
			} else {
				if calls != 2 || wallet["source"] != "newapi" {
					t.Fatalf("upstream wallet not used: %+v calls=%d", wallet, calls)
				}
				if tc.want > 0 && !strings.Contains(wallet["formattedPoints"].(string), "<0.001") {
					t.Fatal("tiny wallet rounded to zero")
				}
			}
		})
	}
	if _, err := FetchUserWalletBalance("wallet-nonexistent"); err == nil {
		t.Fatal("missing local user accepted")
	}
}

func TestWalletTransportAndRedirectFailure(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("wallet credential redirected") }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	if _, err := fetchNewAPIWalletBalance(redirect.URL, "secret"); err == nil {
		t.Fatal("accepted redirect")
	}
	redirect.Close()
	if _, err := fetchNewAPIWalletBalance(redirect.URL, "secret"); err == nil {
		t.Fatal("accepted unreachable upstream")
	}
}
