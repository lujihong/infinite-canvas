package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type workflowQuoteNoNetwork struct{ calls *atomic.Int32 }

func (rt workflowQuoteNoNetwork) RoundTrip(*http.Request) (*http.Response, error) {
	rt.calls.Add(1)
	return nil, fmt.Errorf("quote attempted network IO")
}

func TestWorkflowDraftQuoteCostAndNoSideEffects(t *testing.T) {
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	saved, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(saved, now()) })
	user := model.User{ID: "workflow-quote-user", Username: "workflow-quote-user", AffCode: "workflow-quote-user", Credits: 100, Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.CreditLog{})
		db.Where("user_id = ?", user.ID).Delete(&model.AICallLog{})
		db.Where("id = ?", user.ID).Delete(&model.User{})
	})
	ctx := WithUser(context.Background(), model.PublicUser(user))
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		fmt.Fprint(w, `{"choices":[{"message":{"content":"{\"name\":\"test\"}"}}]}`)
	}))
	defer upstream.Close()
	settings := model.Settings{}
	allowed := true
	settings.Public.ModelChannel.AllowUserRemoteChannel = &allowed
	settings.Public.ModelChannel.DefaultTextModel = "gpt-quote"
	settings.Private.Channels = []model.ModelChannel{{ID: "quote-channel", Enabled: true, BaseURL: upstream.URL, APIKey: "server-secret-must-not-leak", Models: []string{"gpt-quote"}, Weight: 1}}
	save := func() {
		t.Helper()
		if _, err := repository.SaveSettings(settings, now()); err != nil {
			t.Fatal(err)
		}
	}
	count := func(table any) int64 {
		t.Helper()
		var n int64
		if err := db.Model(table).Count(&n).Error; err != nil {
			t.Fatal(err)
		}
		return n
	}
	balance := func() int {
		t.Helper()
		var u model.User
		if err := db.First(&u, "id = ?", user.ID).Error; err != nil {
			t.Fatal(err)
		}
		return u.Credits
	}
	quote := func(ctx context.Context, req WorkflowAgentDraftQuoteRequest) (WorkflowAgentDraftQuote, error) {
		t.Helper()
		var network atomic.Int32
		original := http.DefaultTransport
		http.DefaultTransport = workflowQuoteNoNetwork{&network}
		defer func() { http.DefaultTransport = original }()
		b := balance()
		logs := count(&model.CreditLog{})
		calls := count(&model.AICallLog{})
		workflows := count(&model.CreativeWorkflow{})
		q, err := QuoteCreativeWorkflowDraft(ctx, req)
		if network.Load() != 0 || balance() != b || count(&model.CreditLog{}) != logs || count(&model.AICallLog{}) != calls || count(&model.CreativeWorkflow{}) != workflows {
			t.Fatal("quote had IO or persistence side effects")
		}
		raw, _ := json.Marshal(q)
		if strings.Contains(string(raw), "server-secret") || strings.Contains(string(raw), "apiKey") {
			t.Fatal("credential exposed")
		}
		return q, err
	}
	for _, tc := range []struct {
		name       string
		cost       int
		configured bool
	}{{"fixed", 7, true}, {"zero", 0, true}, {"unconfigured", 0, false}} {
		t.Run(tc.name, func(t *testing.T) {
			settings.Public.ModelChannel.ModelCosts = nil
			if tc.configured {
				settings.Public.ModelChannel.ModelCosts = []model.ModelCost{{Model: "gpt-quote", Credits: tc.cost}}
			}
			save()
			q, err := quote(ctx, WorkflowAgentDraftQuoteRequest{Prompt: "draft", ChannelMode: "remote"})
			if err != nil {
				t.Fatal(err)
			}
			cost, err := ModelCost(q.Model)
			if err != nil {
				t.Fatal(err)
			}
			if q.Points != cost || q.Points != tc.cost || q.Source != "local_credits" || q.Unit != "request" || q.Model != "gpt-quote" {
				t.Fatalf("wrong quote: %+v", q)
			}
			before := balance()
			hits := upstreamCalls.Load()
			if _, err := DraftCreativeWorkflow(ctx, WorkflowAgentDraftRequest{Prompt: "draft", Model: q.Model, ChannelMode: "remote"}); err != nil {
				t.Fatal(err)
			}
			if before-balance() != q.Points || upstreamCalls.Load() != hits+1 {
				t.Fatal("quote and actual draft debit differ")
			}
		})
	}
	req := WorkflowAgentDraftQuoteRequest{Prompt: "draft", Model: "gpt-quote", ChannelMode: "remote"}
	normal := WithUser(context.Background(), model.AuthUser{ID: user.ID, Role: model.UserRoleUser})
	if _, err := quote(normal, req); err != nil {
		t.Fatal(err)
	}
	allowed = false
	save()
	if _, err := quote(normal, req); err == nil {
		t.Fatal("remote permission bypassed")
	}
	if _, err := quote(ctx, req); err != nil {
		t.Fatal("admin should be allowed", err)
	}
	if _, err := quote(context.Background(), req); err == nil {
		t.Fatal("anonymous allowed")
	}
	if _, err := quote(ctx, WorkflowAgentDraftQuoteRequest{Prompt: " "}); err == nil {
		t.Fatal("empty prompt allowed")
	}
	settings.Private.Channels = nil
	settings.Public.ModelChannel.DefaultTextModel = ""
	save()
	if _, err := quote(ctx, req); err == nil {
		t.Fatal("missing channel accepted")
	}
	if _, err := quote(ctx, WorkflowAgentDraftQuoteRequest{Prompt: "draft"}); err == nil {
		t.Fatal("missing model configuration accepted")
	}
	q, err := quote(normal, WorkflowAgentDraftQuoteRequest{Prompt: "draft", ChannelMode: "local"})
	if err != nil || q.Points != 0 || q.Source != "local_credits" || !strings.Contains(q.Message, "供应商费用另计") {
		t.Fatalf("local quote: %+v %v", q, err)
	}
}
