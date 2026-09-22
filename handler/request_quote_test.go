package handler_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestRequestQuoteRouteSessionIdentityAndNoSideEffects(t *testing.T) {
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	users := []model.User{
		{ID: "quote-user-a", Username: "quote-user-a", AffCode: "quote-user-a", Status: model.UserStatusActive, Role: model.UserRoleUser, Credits: 31, Extra: `{"newapi_user_id":41,"newapi_token":"quote-a"}`},
		{ID: "quote-user-b", Username: "quote-user-b", AffCode: "quote-user-b", Status: model.UserStatusActive, Role: model.UserRoleUser, Credits: 72, Extra: `{"newapi_user_id":42,"newapi_token":"quote-b"}`},
	}
	for _, user := range users {
		if err := db.Create(&user).Error; err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Where("id = ?", user.ID).Delete(&model.User{}) })
	}
	count := func(table any) int64 {
		t.Helper()
		var n int64
		if err := db.Model(table).Count(&n).Error; err != nil {
			t.Fatal(err)
		}
		return n
	}
	tables := []any{&model.VideoTask{}, &model.CanvasImageTask{}, &model.CanvasAudioTask{}, &model.CreditLog{}, &model.AICallLog{}}
	before := make([]int64, len(tables))
	for i, table := range tables {
		before[i] = count(table)
	}
	var calls atomic.Int32
	var expectedToken atomic.Value
	expectedToken.Store("Bearer sk-quote-a")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/pricing/quote" || r.Method != "POST" || r.Header.Get("Authorization") != expectedToken.Load().(string) {
			t.Error("quote escaped fixed route or session identity")
		}
		var body service.RequestQuoteInput
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.BatchCount != 3 || body.Endpoint != "/v1/videos" || !strings.Contains(string(body.Body), `"prompt":"private"`) {
			t.Error("wrapper lost")
		}
		fmt.Fprint(w, `{"success":true,"data":{"status":"estimated","quota":1,"quota_per_unit":500000,"model":"video","batch_count":3,"unit_rates":[],"missing_fields":[]}}`)
	}))
	defer server.Close()
	t.Setenv("NEWAPI_BASE_URL", server.URL+"/v1")
	route := router.New()
	session := func(user model.User) string {
		claims := service.TokenClaims{UserID: user.ID, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}
		token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	call := func(token, body string, headers map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/v1/model-pricing/quote", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		route.ServeHTTP(w, r)
		if w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("response may be cached")
		}
		return w
	}
	wrapper := `{"endpoint":"/v1/videos","body":{"model":"video","prompt":"private","duration":5},"batch_count":3}`
	for i, user := range users {
		expectedToken.Store([]string{"Bearer sk-quote-a", "Bearer sk-quote-b"}[i])
		w := call(session(user), wrapper, map[string]string{"X-Model-Channel-ID": "xyb-official-exclusive", "X-User-ID": users[1-i].ID})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"formatted_points_cost":"预计消耗 0.00002 积分"`) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls.Load() != 2 {
		t.Fatal("missing quote calls")
	}
	for _, header := range []string{"X-Model-Channel-ID", "X-User-Model-Channel-ID"} {
		w := call(session(users[0]), wrapper, map[string]string{header: "external-vendor"})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"unavailable"`) || !strings.Contains(w.Body.String(), `"points_cost":null`) {
			t.Fatal(w.Body.String())
		}
	}
	for _, token := range []string{"", "sk-someone-else"} {
		if call(token, wrapper, nil).Code != http.StatusUnauthorized {
			t.Fatal("accepted non-session auth")
		}
	}
	for _, body := range []string{strings.Replace(wrapper, `"duration":5`, `"api_key":"secret"`, 1), strings.Replace(wrapper, `"duration":5`, `"usage":{"output_tokens":0}`, 1)} {
		if call(session(users[0]), body, nil).Code != 400 {
			t.Fatal("accepted client authority")
		}
	}
	if call(session(users[0]), strings.Repeat(" ", service.RequestQuoteMaxBytes+1), nil).Code != 413 {
		t.Fatal("oversize body accepted")
	}
	if calls.Load() != 2 {
		t.Fatal("unexpected upstream side effect")
	}
	for i, table := range tables {
		if count(table) != before[i] {
			t.Fatal("quote wrote task/log records")
		}
	}
	for _, user := range users {
		var got model.User
		if err := db.First(&got, "id = ?", user.ID).Error; err != nil || got.Credits != user.Credits || got.Extra != user.Extra {
			t.Fatal("quote mutated user/wallet", err)
		}
	}
}
