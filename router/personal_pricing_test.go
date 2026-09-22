package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestPersonalPricingRoutesAuthenticateIdentity(t *testing.T) {
	old := config.Cfg
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "pricing-route.db")
	config.Cfg.JWTSecret = "pricing-route-test-secret"
	t.Cleanup(func() { config.Cfg = old })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "pricing-route", Username: "pricing-route", AffCode: "pricing-route", Role: model.UserRoleUser, Status: model.UserStatusActive, Extra: `{"newapi_user_id":100,"newapi_token":"route-user"}`}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/status" {
			_, _ = w.Write([]byte(`{"success":true,"data":{"quota_display_type":"CNY","usd_exchange_rate":1,"quota_per_unit":500000}}`))
			return
		}
		upstreamCalls++
		if r.URL.Path != "/api/pricing/self" || r.Header.Get("Authorization") != "Bearer sk-route-user" {
			t.Error("wrong upstream identity/path")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":[{"model_name":"m","quota_type":1,"model_price":2,"enable_groups":["default"]}],"model_group_ratio":{"m":{"default":0.5}}}`))
	}))
	defer upstream.Close()
	t.Setenv("NEWAPI_BASE_URL", upstream.URL)
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: user.ID, Username: user.Username, Role: user.Role, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(config.Cfg.JWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	router := New()
	for _, path := range []string{"/api/model-pricing", "/api/v1/model-pricing"} {
		for _, authenticated := range []bool{false, true} {
			req := httptest.NewRequest("GET", path, nil)
			if authenticated {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if !authenticated {
				if rec.Code != 401 {
					t.Fatalf("anonymous %s got %d", path, rec.Code)
				}
				continue
			}
			var body struct {
				Code int                                `json:"code"`
				Data []service.PersonalModelPricingItem `json:"data"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if rec.Code != 200 || body.Code != 0 || len(body.Data) != 1 {
				t.Fatalf("authenticated %s: %d %s", path, rec.Code, rec.Body.String())
			}
			if body.Data[0].GroupQuotes[0].USDPrice == nil || *body.Data[0].GroupQuotes[0].USDPrice != 1 {
				t.Fatal("incorrect quote")
			}
		}
	}
	if upstreamCalls != 2 {
		t.Fatalf("unexpected upstream calls %d", upstreamCalls)
	}
}
