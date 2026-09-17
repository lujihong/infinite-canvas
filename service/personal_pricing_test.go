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
)

func personalPriceFixture(ratio float64) string {
	return fmt.Sprintf(`{"success":true,"data":[{"model_name":"image","quota_type":1,"model_price":2,"enable_groups":["vip","default"]}],"group_ratio":{"default":1,"vip":2},"model_group_ratio":{"image":{"default":%g,"vip":%g}},"model_discounts":{"image":{"factor":%g,"source":"user","revision":3,"model":"image"}}}`, ratio, ratio*2, ratio)
}

func personalCurrencyFixture(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/status" {
		return false
	}
	if r.Header.Get("Authorization") != "" {
		panic("public currency request leaked credential")
	}
	fmt.Fprint(w, `{"success":true,"data":{"quota_display_type":"CNY","usd_exchange_rate":1}}`)
	return true
}

func TestPersonalPricingTwoIdentities(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if personalCurrencyFixture(w, r) {
			return
		}
		if r.URL.Path != "/api/pricing/self" {
			t.Errorf("wrong path: %s", r.URL.Path)
		}
		factor := 0.25
		if r.Header.Get("Authorization") == "Bearer sk-user-b" {
			factor = 0.5
		} else if r.Header.Get("Authorization") != "Bearer sk-user-a" {
			t.Error("wrong identity")
		}
		fmt.Fprint(w, personalPriceFixture(factor))
	}))
	defer upstream.Close()
	for _, tc := range []struct {
		token string
		want  float64
	}{{"user-a", 0.5}, {"sk-user-b", 1}, {"user-a", 0.5}} {
		items, err := fetchPersonalModelPricingList(context.Background(), upstream.URL+"/v1/", tc.token)
		if err != nil {
			t.Fatal(err)
		}
		if len(items) != 1 || len(items[0].GroupQuotes) != 2 {
			t.Fatalf("missing groups: %+v", items)
		}
		item := items[0]
		if *item.GroupQuotes[0].USDPrice != tc.want || !item.Estimated || !strings.Contains(item.FormattedPointsCost, " 起") || !strings.Contains(item.FormattedPointsCost, "按平台账单结算") {
			t.Fatalf("incorrect personal quote: %+v", item)
		}
		if item.Discount == nil || item.Discount.Revision == nil {
			t.Fatal("missing discount provenance")
		}
	}
}

func TestPersonalPricingRejectsRedirect(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusMovedPermanently)
	}))
	defer upstream.Close()
	_, err := fetchPersonalModelPricingList(context.Background(), upstream.URL, "secret")
	if err == nil || hits.Load() != 0 || strings.Contains(err.Error(), "secret") {
		t.Fatalf("redirect/token failure: %v; hits %d", err, hits.Load())
	}
}

func TestPersonalPricingRejectsInvalidResponses(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"false", `{"success":false,"data":[]}`, 200},
		{"missing data", `{"success":true}`, 200},
		{"invalid JSON", `{`, 200},
		{"trailing JSON", `{"success":true,"data":[]} {}`, 200},
		{"HTTP failure", `{"success":true,"data":[]}`, 401},
		{"too large", strings.Repeat(" ", (8<<20)+1), 200},
		{"invalid discount", `{"success":true,"data":[{"model_name":"x","enable_groups":["default"]}],"model_discounts":{"x":{"factor":1.1}}}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); fmt.Fprint(w, tc.body) }))
			defer server.Close()
			if _, err := fetchPersonalModelPricingList(context.Background(), server.URL, "test"); err == nil {
				t.Fatal("expected failure")
			}
		})
	}
}

func TestPersonalPricingOnlyAccessibleGroups(t *testing.T) {
	body := `{"success":true,"data":[{"model_name":"image","quota_type":1,"model_price":2,"enable_groups":["default","unavailable"]},{"model_name":"all-groups","quota_type":1,"model_price":3,"enable_groups":["all"]},{"model_name":"blocked","billing_mode":"tiered_expr","billing_expr":"duration","enable_groups":["private"]}],"model_group_ratio":{"image":{"default":0.5,"other":1},"all-groups":{"vip":0.25,"default":0.5},"blocked":{"default":1}}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !personalCurrencyFixture(w, r) {
			fmt.Fprint(w, body)
		}
	}))
	defer server.Close()
	items, err := fetchPersonalModelPricingList(context.Background(), server.URL, "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || len(items[0].GroupQuotes) != 1 || items[0].GroupQuotes[0].Group != "default" || len(items[1].GroupQuotes) != 2 {
		t.Fatalf("wrong allowed groups: %+v", items)
	}
	encoded, err := json.Marshal(items[0])
	if err != nil || !strings.Contains(string(encoded), `"points_cost":null`) {
		t.Fatalf("unverified points must be null: %s, %v", encoded, err)
	}
}

func TestPersonalPricingCurrencyMatchesGatewayConfiguration(t *testing.T) {
	for _, tc := range []struct {
		kind  string
		rate  float64
		want  string
		valid bool
	}{
		{"CNY", 7, "¥ 14/次", true}, {"CNY", 1, "¥ 2/次", true}, {"USD", 0, "USD 2/次", true}, {"CNY", 0, "", false}, {"invalid", 1, "", false},
	} {
		base, price := 2.0, 2.0
		items := []PersonalModelPricingItem{{GroupQuotes: []PersonalGroupQuote{{BaseUSD: &base, USDPrice: &price, Unit: "USD/次"}}}}
		status := personalPricingCurrencyResponse{Success: true}
		status.Data.Type = tc.kind
		status.Data.Rate = tc.rate
		err := applyPersonalPricingCurrency(items, status)
		if (err == nil) != tc.valid {
			t.Fatalf("currency %s error %v", tc.kind, err)
		}
		if tc.valid && !strings.Contains(items[0].FormattedPointsCost, tc.want) {
			t.Fatalf("want %s got %s", tc.want, items[0].FormattedPointsCost)
		}
	}
}

func TestPersonalPricingMissingIdentity(t *testing.T) {
	if _, err := FetchPersonalModelPricingList(context.Background(), ""); err == nil {
		t.Fatal("accepted absent user")
	}
	if _, err := fetchPersonalModelPricingList(context.Background(), "https://invalid.example", ""); err == nil {
		t.Fatal("accepted absent token")
	}
}

func TestPersonalPricingTieredAndZeroDiscount(t *testing.T) {
	body := `{"success":true,"data":[{"model_name":"tier","quota_type":1,"model_price":0,"billing_mode":"tiered_expr","billing_expr":"duration * 0.3","enable_groups":["default"]},{"model_name":"free","quota_type":1,"model_price":2,"enable_groups":["default"]},{"model_name":"text","quota_type":0,"model_ratio":2,"completion_ratio":3,"enable_groups":["default"]}],"model_group_ratio":{"tier":{"default":0.5},"free":{"default":0},"text":{"default":0.5}},"model_discounts":{"free":{"factor":0,"source":"user","model":"free"}}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !personalCurrencyFixture(w, r) {
			fmt.Fprint(w, body)
		}
	}))
	defer server.Close()
	items, err := fetchPersonalModelPricingList(context.Background(), server.URL, "test")
	if err != nil {
		t.Fatal(err)
	}
	if items[0].FormattedPointsCost != "按实际用量结算" || items[0].GroupQuotes[0].USDPrice != nil || items[0].BillingExpr == "" {
		t.Fatal("tiered incorrectly presented as zero/free")
	}
	if items[1].GroupQuotes[0].USDPrice == nil || *items[1].GroupQuotes[0].USDPrice != 0 || items[1].Discount.Factor != 0 {
		t.Fatal("lost legitimate zero discount")
	}
	quote := items[2].GroupQuotes[0]
	if *quote.USDPrice != 0.002 || *quote.OutputUSDPrice != 0.006 || quote.Unit != "USD/千Token" {
		t.Fatalf("incorrect token units: %+v", quote)
	}
}
