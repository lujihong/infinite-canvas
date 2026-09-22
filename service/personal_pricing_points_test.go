package service

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func fetchPricingFixture(t *testing.T, body, status string) ([]PersonalModelPricingItem, error) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/status" {
			fmt.Fprint(w, status)
		} else {
			fmt.Fprint(w, body)
		}
	}))
	defer server.Close()
	return fetchPersonalModelPricingList(context.Background(), server.URL, "test")
}

func TestPersonalPricingStrictQuotaUnit(t *testing.T) {
	for _, status := range []string{
		`{"success":false,"data":{"quota_per_unit":500000}}`,
		`{"success":true,"data":{}}`,
		`{"success":true,"data":{"quota_per_unit":null}}`,
		`{"success":true,"data":{"quota_per_unit":0}}`,
		`{"success":true,"data":{"quota_per_unit":-1}}`,
		`{"success":true,"data":{"quota_per_unit":1.5}}`,
		`{"success":true,"data":{"quota_per_unit":9007199254740992}}`,
		`{"success":true,"data":{"quota_per_unit":1e309}}`,
	} {
		if _, err := fetchPricingFixture(t, personalPriceFixture(1), status); err == nil {
			t.Fatalf("accepted %s", status)
		}
	}
}

func TestPersonalPricingDiscountNotAppliedTwice(t *testing.T) {
	for _, factor := range []float64{0, .1, 1} {
		items, err := fetchPricingFixture(t, personalPriceFixture(factor), `{"success":true,"data":{"quota_per_unit":1000000}}`)
		if err != nil {
			t.Fatal(err)
		}
		for i, q := range items[0].GroupQuotes {
			want := 20 * factor * float64(i+1)
			if q.PointsCost == nil || *q.PointsCost != want {
				t.Fatalf("factor=%g group=%s points=%v want=%g", factor, q.Group, q.PointsCost, want)
			}
		}
		if items[0].PointsCost != nil || !items[0].Estimated {
			t.Fatal("multiple groups became a definite price")
		}
	}
}

func TestPersonalPricingNonDefaultUnitAndTinyPrices(t *testing.T) {
	body := `{"success":true,"data":[
 {"model_name":"image","quota_type":1,"model_price":0.0000079,"supported_endpoint_types":["image-generation"],"enable_groups":["default"]},
 {"model_name":"text","quota_type":0,"model_ratio":2,"completion_ratio":3,"enable_groups":["default"]},
 {"model_name":"tiny","quota_type":0,"model_ratio":1e-12,"completion_ratio":2,"enable_groups":["default"]},
 {"model_name":"rounded","quota_type":1,"model_price":0.0000079,"supported_endpoint_types":["openai"],"enable_groups":["default"]}],
 "model_group_ratio":{"image":{"default":0.5},"text":{"default":0.5},"tiny":{"default":1},"rounded":{"default":0.5}}}`
	items, err := fetchPricingFixture(t, body, `{"success":true,"data":{"quota_per_unit":1000000}}`)
	if err != nil {
		t.Fatal(err)
	}
	fixed := items[0].GroupQuotes[0]
	_, want := quotaBillingValues(3, 1000000)
	if fixed.Quota == nil || *fixed.Quota != 3 || *fixed.PointsCost != want || !strings.Contains(fixed.FormattedPointsCost, "3e-05") {
		t.Fatalf("incorrect truncated quota/points: %+v", fixed)
	}
	text := items[1].GroupQuotes[0]
	if *text.PointsCost != .01 || *text.OutputPointsCost != .03 || text.Quota != nil || items[1].PointsCost != nil || !strings.Contains(items[1].BillingDescription, "缓存") {
		t.Fatalf("incorrect token unit %+v", text)
	}
	tiny := items[2].GroupQuotes[0]
	if *tiny.PointsCost <= 0 || strings.Contains(tiny.FormattedPointsCost, "输入 0 ") {
		t.Fatalf("tiny points became zero: %+v", tiny)
	}
	if *items[3].GroupQuotes[0].Quota != 4 {
		t.Fatal("text settlement must round")
	}
}

func TestPersonalPricingMissingIsNotFree(t *testing.T) {
	body := `{"success":true,"data":[
 {"model_name":"missing","quota_type":1,"enable_groups":["default"]},
 {"model_name":"free","quota_type":1,"model_price":0,"enable_groups":["default"]},
 {"model_name":"missing-output","quota_type":0,"model_ratio":2,"enable_groups":["default"]},
 {"model_name":"missing-token","quota_type":0,"enable_groups":["default"]}],
 "model_group_ratio":{"missing":{"default":1},"free":{"default":1},"missing-output":{"default":1},"missing-token":{"default":1}}}`
	items, err := fetchPricingFixture(t, body, `{"success":true,"data":{"quota_per_unit":500000}}`)
	if err != nil {
		t.Fatal(err)
	}
	if items[0].PointsCost != nil || items[0].GroupQuotes[0].PointsCost != nil || items[0].GroupQuotes[0].USDPrice != nil {
		t.Fatal("missing price became free")
	}
	if items[1].PointsCost == nil || *items[1].PointsCost != 0 {
		t.Fatal("lost explicit free price")
	}
	if items[2].GroupQuotes[0].OutputPointsCost != nil || !strings.Contains(items[2].FormattedPointsCost, "输出 待参数报价") {
		t.Fatal("missing output became free")
	}
	if items[3].GroupQuotes[0].PointsCost != nil {
		t.Fatal("missing ratio became free")
	}
	encoded, err := json.Marshal(items)
	if err != nil || !strings.Contains(string(encoded), `"points_cost":null`) || !strings.Contains(string(encoded), `"points_cost":0`) {
		t.Fatalf("nullable contract %s %v", encoded, err)
	}
}

func TestPersonalPricingRejectsInvalidPrices(t *testing.T) {
	for _, fields := range []string{
		`"model_price":-1`, `"model_price":1e309`, `"model_price":1e308`,
		`"model_price":1,"model_ratio":-1`, `"model_price":1,"completion_ratio":-1`,
	} {
		body := fmt.Sprintf(`{"success":true,"data":[{"model_name":"x","quota_type":1,%s,"enable_groups":["default"]}],"model_group_ratio":{"x":{"default":1}}}`, fields)
		if _, err := fetchPricingFixture(t, body, `{"success":true,"data":{"quota_per_unit":500000}}`); err == nil {
			t.Fatalf("accepted %s", fields)
		}
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1} {
		if validPersonalPrice(value) {
			t.Fatalf("accepted %g", value)
		}
	}
	body := `{"success":true,"data":[{"model_name":"x","quota_type":0,"model_ratio":1e308,"completion_ratio":1e308,"enable_groups":["default"]}],"model_group_ratio":{"x":{"default":1}}}`
	if _, err := fetchPricingFixture(t, body, `{"success":true,"data":{"quota_per_unit":500000}}`); err == nil {
		t.Fatal("accepted token overflow")
	}
}
