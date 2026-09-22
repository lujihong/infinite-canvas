package service

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func quoteTestInput() RequestQuoteInput {
	return RequestQuoteInput{Endpoint: "/v1/videos", Body: json.RawMessage(`{"model":"video","prompt":"private","duration":5}`), BatchCount: 2}
}

func TestRequestQuoteWrapperAndPoints(t *testing.T) {
	for _, tc := range []struct {
		name, quota, perUnit, status, wantStatus string
		points                                   *float64
	}{
		{"zero", "0", "500000", "estimated", "estimated", quoteFloat(0)},
		{"tiny", "1", "500000", "estimated", "estimated", quoteFloat(.00002)},
		{"normal", "1000", "500000", "estimated", "estimated", quoteFloat(.02)},
		{"nil", "null", "500000", "estimated", "unavailable", nil},
		{"missing scale", "0", "0", "estimated", "unavailable", nil},
		{"negative", "-1", "500000", "estimated", "unavailable", nil},
		{"usage", "0", "500000", "usage_required", "usage_required", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.Path != "/api/pricing/quote" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer sk-own" {
					t.Error("incorrect route/identity")
				}
				var got RequestQuoteInput
				if json.NewDecoder(r.Body).Decode(&got) != nil || !reflect.DeepEqual(got, quoteTestInput()) {
					t.Errorf("wrapper changed: %+v", got)
				}
				fmt.Fprintf(w, `{"success":true,"data":{"status":%q,"quota":%s,"quota_per_unit":%s,"group":"personal","model":"video","billing_mode":"tokens","billing_revision":"rev","batch_count":2,"missing_fields":["output_tokens"],"unit_rates":[{"dimension":"input_tokens","quota":0.5,"per":1,"unit":"token"}],"points_cost":999,"formatted_points_cost":"wrong"}}`, tc.status, tc.quota, tc.perUnit)
			}))
			defer upstream.Close()
			got, err := fetchRequestQuote(context.Background(), upstream.URL+"/v1?api_key=not-forwarded", "own", quoteTestInput())
			if err != nil || got.Status != tc.wantStatus || calls.Load() != 1 {
				t.Fatalf("result: %+v %v", got, err)
			}
			if tc.points == nil {
				if got.PointsCost != nil {
					t.Fatal("unknown became zero")
				}
			} else if got.PointsCost == nil || math.Abs(*got.PointsCost-*tc.points) > 1e-15 {
				t.Fatalf("wrong conversion: %+v", got)
			}
			if tc.name == "zero" && got.FormattedPointsCost != "预计消耗 0 积分" {
				t.Fatal(got.FormattedPointsCost)
			}
			if tc.name == "tiny" && got.FormattedPointsCost != "预计消耗 0.00002 积分" {
				t.Fatal(got.FormattedPointsCost)
			}
			if tc.name == "usage" && (got.Quota != nil || got.UnitRates[0].PointsCost == nil || math.Abs(*got.UnitRates[0].PointsCost-.00001) > 1e-15 || !strings.Contains(got.Message, "实际用量")) {
				t.Fatalf("usage contract: %+v", got)
			}
		})
	}
}

func TestRequestQuoteBindingNeverFallsBackToChannelKeys(t *testing.T) {
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		t.Error("unbound quote contacted upstream with a fallback credential")
	}))
	defer upstream.Close()
	t.Setenv("NEWAPI_BASE_URL", upstream.URL)
	settings, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(settings, "") })
	withPublicKey := settings
	withPublicKey.Private.Channels = []model.ModelChannel{{ID: "channel-xyb", BaseURL: upstream.URL, APIKey: "public-secret", Models: []string{"video"}, Enabled: true}}
	if _, err := repository.SaveSettings(withPublicKey, ""); err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "quote-no-binding", Username: "quote-no-binding", AffCode: "quote-no-binding", Status: model.UserStatusActive, Role: model.UserRoleAdmin}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.UserConfig{})
		db.Where("id = ?", user.ID).Delete(&model.User{})
	})
	local := fmt.Sprintf(`{"localChannels":[{"id":"local-history","baseUrl":%q,"apiKey":"private-secret","models":["video"]}]}`, upstream.URL)
	if _, err := repository.SaveUserConfig(model.UserConfig{UserID: user.ID, ModelConfig: local}); err != nil {
		t.Fatal(err)
	}
	for _, extra := range []string{"", `{}`, `{"newapi_token":"token-only"}`, `{"newapi_user_id":3}`, `{"newapi_user_id":0,"newapi_token":"token"}`, `{"newapi_user_id":-1,"newapi_token":"token"}`, `{"newapi_user_id":3,"newapi_token":" "}`, `{bad`} {
		if err := db.Model(&model.User{}).Where("id = ?", user.ID).Update("extra", extra).Error; err != nil {
			t.Fatal(err)
		}
		for _, headers := range [][2]string{{"", ""}, {"xyb-official-exclusive", ""}, {"channel-xyb", ""}, {"", "local-history"}, {"channel-xyb", "local-history"}} {
			got, err := FetchRequestQuote(context.Background(), user.ID, quoteTestInput(), headers[0], headers[1])
			if err != nil || got.Status != "unavailable" || got.PointsCost != nil || !strings.Contains(got.Message, "未绑定") {
				t.Fatalf("unbound quote must stay unknown: %+v %v", got, err)
			}
		}
	}
	if calls.Load() != 0 {
		t.Fatal("borrowed public/private key")
	}
}

func quoteFloat(value float64) *float64 { return &value }

func TestRequestQuoteFailuresAndBounds(t *testing.T) {
	var leaked atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1) }))
	defer destination.Close()
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"failed", 503, `{"success":false,"message":"secret-token private prompt URL"}`},
		{"redirect", 307, ""},
		{"success false", 200, `{"success":false}`},
		{"empty", 200, `{}`},
		{"bad JSON", 200, `{`},
		{"too long", 200, strings.Repeat(" ", RequestQuoteMaxBytes+1)},
		{"missing scale", 200, `{"success":true,"data":{"model":"video","batch_count":2,"status":"estimated","quota":0}}`},
		{"bad status", 200, `{"success":true,"data":{"model":"video","batch_count":2,"status":"free","quota":0,"quota_per_unit":1}}`},
		{"wrong model", 200, `{"success":true,"data":{"model":"other","batch_count":2,"status":"estimated","quota":100,"quota_per_unit":500000}}`},
		{"wrong batch", 200, `{"success":true,"data":{"model":"video","batch_count":1,"status":"estimated","quota":100,"quota_per_unit":500000}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", destination.URL)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			got, err := fetchRequestQuote(context.Background(), server.URL, "sk-own", quoteTestInput())
			if err != nil || got.Status != "unavailable" || got.PointsCost != nil || strings.Contains(got.Message, "secret-token") {
				t.Fatalf("unsafe failure: %+v %v", got, err)
			}
		})
	}
	if leaked.Load() != 0 {
		t.Fatal("redirect followed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	defer server.Close()
	defer close(release)
	started := time.Now()
	got, _ := fetchRequestQuote(ctx, server.URL, "own", quoteTestInput())
	if got.Status != "unavailable" || time.Since(started) > time.Second {
		t.Fatal("context deadline ignored")
	}
	if requestQuoteTimeout > 15*time.Second {
		t.Fatal("unbounded timeout")
	}
}

func TestRequestQuoteValidation(t *testing.T) {
	for _, raw := range []string{
		`{"endpoint":"/v1/videos","body":{"model":"video"},"key":"bad"}`,
		`{"endpoint":"/v1/videos","body":null}`,
		`{"endpoint":"/v1/videos","body":[]}`,
		`{"endpoint":"/v1/videos","body":{"model":12}}`,
		`{"endpoint":"https://other.test","body":{"model":"video"}}`,
		`{"endpoint":"/api/user/self","body":{"model":"video"}}`,
		`{"endpoint":"/v1/videos?url=x","body":{"model":"video"}}`,
		`{"endpoint":"/v1/videos","body":{"model":"video"},"batch_count":0}`,
		`{"endpoint":"/v1/videos","body":{"model":"video"},"batch_count":21}`,
		`{"endpoint":"/v1/videos","body":{"model":"video"}} {}`,
		strings.Repeat(" ", RequestQuoteMaxBytes+1),
	} {
		if _, err := DecodeRequestQuote(strings.NewReader(raw)); err == nil {
			t.Fatal("accepted invalid wrapper")
		}
	}
	for _, key := range []string{"usage", "key", "api_key", "baseURL", "group", "discount", "groupRatio", "modelPrice", "quota", "otherRatios", "user_id", "token"} {
		raw := fmt.Sprintf(`{"endpoint":"/v1/videos","body":{"model":"video",%q:1}}`, key)
		if _, err := DecodeRequestQuote(strings.NewReader(raw)); err == nil {
			t.Fatalf("accepted override %s", key)
		}
	}
	input, err := DecodeRequestQuote(strings.NewReader(`{"endpoint":"/v1/videos","body":{"model":"video","resolution_name":"720p","video_generate_audio":true,"input_reference[]":["https://image.test"],"preset":"x","mode":"normal"}}`))
	if err != nil || input.BatchCount != 1 {
		t.Fatal("valid wrapper", err)
	}
	got, err := FetchRequestQuote(context.Background(), "someone", quoteTestInput(), "local-channel", "")
	if err != nil || got.Status != "unavailable" || got.PointsCost != nil {
		t.Fatal("missing binding must remain unknown regardless of channel ID")
	}
}
