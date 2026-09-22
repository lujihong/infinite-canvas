package handler_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestWorkflowDraftQuoteRouteAuthentication(t *testing.T) {
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "draft-quote-route", Username: "draft-quote-route", AffCode: "draft-quote-route", Role: model.UserRoleUser, Status: model.UserStatusActive, Credits: 11}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Where("id = ?", user.ID).Delete(&model.User{}) })
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: user.ID, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(config.Cfg.JWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	route := router.New()
	for _, authenticated := range []bool{false, true} {
		r := httptest.NewRequest("POST", "/api/v1/workflows/agent-draft/quote", strings.NewReader(`{"prompt":"draft","model":"text","channelMode":"local"}`))
		if authenticated {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		route.ServeHTTP(w, r)
		if !authenticated {
			if w.Code != 401 {
				t.Fatalf("anonymous status %d", w.Code)
			}
			continue
		}
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"points":0`) || !strings.Contains(w.Body.String(), `"source":"local_credits"`) {
			t.Fatalf("route response: %d %s", w.Code, w.Body.String())
		}
	}
	r := httptest.NewRequest("POST", "/api/v1/workflows/agent-draft/quote", strings.NewReader(`{"prompt":"draft","channelMode":"local"} {"apiKey":"credential-secret"}`))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	route.ServeHTTP(w, r)
	if !strings.Contains(w.Body.String(), "报价需求格式错误") || strings.Contains(w.Body.String(), "credential-secret") {
		t.Fatal("trailing credential payload accepted or leaked")
	}
}

func TestWorkflowDraftQuoteRejectsCredentials(t *testing.T) {
	for _, extra := range []string{`,"apiKey":"credential-secret"`, `,"baseUrl":"https://credential-secret.invalid"`, `,"protocol":"credential-secret"`, `,"references":["credential-secret"]`} {
		r := httptest.NewRequest("POST", "/api/v1/workflows/agent-draft/quote", strings.NewReader(`{"prompt":"draft","channelMode":"local"`+extra+`}`))
		r = r.WithContext(service.WithUser(context.Background(), model.AuthUser{ID: "quote-user"}))
		w := httptest.NewRecorder()
		handler.QuoteUserWorkflowDraft(w, r)
		if strings.Contains(w.Body.String(), "credential-secret") || !strings.Contains(w.Body.String(), "报价需求格式错误") {
			t.Fatalf("credential input accepted or leaked: %s", w.Body.String())
		}
	}
	r := httptest.NewRequest("POST", "/api/v1/workflows/agent-draft/quote", strings.NewReader(`{"prompt":"draft","channelMode":"local","model":"text","channelId":"local-id"}`))
	r = r.WithContext(service.WithUser(context.Background(), model.AuthUser{ID: "quote-user"}))
	w := httptest.NewRecorder()
	handler.QuoteUserWorkflowDraft(w, r)
	if !strings.Contains(w.Body.String(), `"points":0`) || !strings.Contains(w.Body.String(), `"source":"local_credits"`) || !strings.Contains(w.Body.String(), "供应商费用另计") {
		t.Fatalf("wrong local quote: %s", w.Body.String())
	}
}
