package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Personal prices are intentionally not cached: both discounts and identity can change.
type PersonalModelPricingItem struct {
	ModelPricingItem
	// Null means no verified points quote; zero is reserved for an actual zero price.
	PointsCost   *float64               `json:"points_cost"`
	BillingMode  string                 `json:"billing_mode"`
	BillingExpr  string                 `json:"billing_expr"`
	EnableGroups []string               `json:"enable_groups"`
	Discount     *PersonalModelDiscount `json:"discount,omitempty"`
	GroupQuotes  []PersonalGroupQuote   `json:"group_quotes"`
	Estimated    bool                   `json:"estimated"`
}

type PersonalModelDiscount struct {
	Factor   float64         `json:"factor"`
	Source   string          `json:"source"`
	Revision json.RawMessage `json:"revision,omitempty"`
	Model    string          `json:"model"`
}

type PersonalGroupQuote struct {
	Group               string   `json:"group"`
	FinalRatio          float64  `json:"final_ratio"`
	BaseUSD             *float64 `json:"base_usd,omitempty"`
	USDPrice            *float64 `json:"usd_price,omitempty"`
	OutputUSDPrice      *float64 `json:"output_usd_price,omitempty"`
	PointsCost          *float64 `json:"points_cost"`
	OutputPointsCost    *float64 `json:"output_points_cost"`
	Quota               *int64   `json:"quota"`
	Unit                string   `json:"unit"`
	FormattedPointsCost string   `json:"formatted_points_cost"`
}

type personalPricingResponse struct {
	Success bool `json:"success"`
	Data    []struct {
		ModelPricingItem
		// Presence matters: an omitted price is not a free model.
		ModelPrice      *float64 `json:"model_price"`
		ModelRatio      *float64 `json:"model_ratio"`
		CompletionRatio *float64 `json:"completion_ratio"`
		BillingMode     string   `json:"billing_mode"`
		BillingExpr     string   `json:"billing_expr"`
		EnableGroups    []string `json:"enable_groups"`
	} `json:"data"`
	GroupRatio      map[string]float64               `json:"group_ratio"`
	ModelGroupRatio map[string]map[string]float64    `json:"model_group_ratio"`
	ModelDiscounts  map[string]PersonalModelDiscount `json:"model_discounts"`
}

func FetchPersonalModelPricingList(ctx context.Context, userID string) ([]PersonalModelPricingItem, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, errors.New("请先登录后查看本人报价")
	}
	token, err := AICCUserToken(userID)
	if err != nil {
		return nil, errors.New("当前账号未绑定专属中转站身份，无法获取本人报价")
	}
	return fetchPersonalModelPricingList(ctx, getNewAPIBaseURL(), token)
}

func personalPricingJSON(ctx context.Context, client *http.Client, base, path, token string, result any) error {
	target, err := url.Parse(base)
	if err != nil || target.Host == "" || target.User != nil || (target.Scheme != "http" && target.Scheme != "https") {
		return errors.New("本人报价服务地址配置异常")
	}
	target.Path = strings.TrimSuffix(strings.TrimRight(target.Path, "/"), "/v1") + path
	target.RawPath, target.RawQuery, target.Fragment = "", "", ""
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return errors.New("本人报价请求构建失败")
	}
	if token != "" {
		if path == "/api/user/quota-by-token" {
			// This legacy wallet endpoint looks up the raw database key directly.
			token = strings.TrimPrefix(token, "sk-")
		} else if !strings.HasPrefix(token, "sk-") {
			token = "sk-" + token
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("本人报价服务暂不可用，请稍后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("本人报价服务返回异常状态（%d）", resp.StatusCode)
	}
	const maxResponse = 8 << 20
	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil || len(payload) > maxResponse || !json.Valid(payload) || json.Unmarshal(payload, result) != nil {
		return errors.New("本人报价服务返回异常数据")
	}
	return nil
}

func fetchPersonalModelPricingList(ctx context.Context, base, token string) ([]PersonalModelPricingItem, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, errors.New("缺少本人报价身份")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var res personalPricingResponse
	if err := personalPricingJSON(ctx, client, base, "/api/pricing/self", token, &res); err != nil {
		return nil, err
	}
	if !res.Success || res.Data == nil {
		return nil, errors.New("无法获取本人报价，请稍后重试")
	}

	items, err := personalPricingItems(res)
	if err != nil {
		return nil, err
	}
	var status personalPricingCurrencyResponse
	// Public currency configuration is read without sending the customer's key.
	if err := personalPricingJSON(ctx, client, base, "/api/status", "", &status); err != nil {
		return nil, err
	}
	if err := applyPersonalPricingCurrency(items, status); err != nil {
		return nil, err
	}
	return items, nil
}

type personalPricingCurrencyResponse struct {
	Success bool `json:"success"`
	Data    struct {
		QuotaPerUnit *int64 `json:"quota_per_unit"`
	} `json:"data"`
}

func applyPersonalPricingCurrency(items []PersonalModelPricingItem, status personalPricingCurrencyResponse) error {
	if !status.Success || status.Data.QuotaPerUnit == nil || *status.Data.QuotaPerUnit <= 0 || *status.Data.QuotaPerUnit > 1<<53-1 {
		return errors.New("平台 quota_per_unit 缺失或无效，无法换算积分")
	}
	quotaPerUnit := *status.Data.QuotaPerUnit
	for i := range items {
		item := &items[i]
		if item.BillingMode == "tiered_expr" || strings.TrimSpace(item.BillingExpr) != "" {
			continue
		}
		labels := make([]string, 0, len(item.GroupQuotes))
		for j := range item.GroupQuotes {
			quote := &item.GroupQuotes[j]
			quote.Unit = "积分/千Token"
			if item.QuotaType == 1 {
				quote.Unit = "积分/次"
			}
			if quote.USDPrice != nil {
				if item.QuotaType == 1 {
					// The ordinary fixed-price reservation/task/image path truncates quota.
					// Text settlement rounds instead; endpoint metadata disambiguates it.
					value := *quote.BaseUSD * float64(quotaPerUnit) * quote.FinalRatio
					if !validPersonalPrice(value) || value > math.MaxInt32 {
						return errors.New("模型报价超出有效配额范围")
					}
					rounded := math.Trunc(value)
					for _, endpoint := range item.SupportedEndpointTypes {
						if endpoint == "openai" || endpoint == "openai-response" || endpoint == "anthropic" || endpoint == "gemini" {
							rounded = math.Round(value)
							if value > 0 && rounded == 0 {
								rounded = 1
							}
						}
					}
					quota := int64(rounded)
					_, points := quotaBillingValues(quota, quotaPerUnit)
					quote.Quota, quote.PointsCost = &quota, &points
				} else {
					// Unit rates stay fractional; actual token usage is rounded at settlement.
					points := item.ModelRatio * quote.FinalRatio * (1000 / float64(quotaPerUnit)) * 10
					if !validPersonalPrice(points) {
						return errors.New("模型积分单价无效")
					}
					quote.PointsCost = &points
					if quote.OutputUSDPrice != nil {
						output := points * item.CompletionRatio
						if !validPersonalPrice(output) {
							return errors.New("模型输出积分单价无效")
						}
						quote.OutputPointsCost = &output
					}
				}
				quote.FormattedPointsCost = fmt.Sprintf("%.10g %s", *quote.PointsCost, quote.Unit)
				if item.QuotaType == 0 {
					output := "待参数报价"
					if quote.OutputPointsCost != nil {
						output = fmt.Sprintf("%.10g %s", *quote.OutputPointsCost, quote.Unit)
					}
					quote.FormattedPointsCost = "输入 " + quote.FormattedPointsCost + " / 输出 " + output
				}
			}
			labels = append(labels, quote.Group+"："+quote.FormattedPointsCost)
		}
		item.PointsCost = nil
		if len(item.GroupQuotes) == 1 && item.QuotaType == 1 {
			item.PointsCost = item.GroupQuotes[0].PointsCost
		}
		item.FormattedPointsCost = strings.Join(labels, "；") + " · 按平台账单结算"
		item.BillingDescription = "按本人各计费组最终倍率估算积分，优惠已计入。实际路由、请求数量和用量决定最终扣费。"
		if item.QuotaType == 0 {
			item.BillingDescription += "输入/输出为每千Token普通单价；缓存、音频、工具等特殊计费项无法代表全价，按实际用量结算。"
		}
	}
	return nil
}

func validPersonalPrice(value float64) bool {
	return value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func personalPricingItems(res personalPricingResponse) ([]PersonalModelPricingItem, error) {
	items := make([]PersonalModelPricingItem, 0, len(res.Data))
	for _, raw := range res.Data {
		for _, value := range []*float64{raw.ModelPrice, raw.ModelRatio, raw.CompletionRatio} {
			if value != nil && !validPersonalPrice(*value) {
				return nil, errors.New("本人模型价格字段无效")
			}
		}
		if raw.ModelPrice != nil {
			raw.ModelPricingItem.ModelPrice = *raw.ModelPrice
		}
		if raw.ModelRatio != nil {
			raw.ModelPricingItem.ModelRatio = *raw.ModelRatio
		}
		if raw.CompletionRatio != nil {
			raw.ModelPricingItem.CompletionRatio = *raw.CompletionRatio
		}
		item := PersonalModelPricingItem{ModelPricingItem: raw.ModelPricingItem, BillingMode: raw.BillingMode, BillingExpr: raw.BillingExpr, EnableGroups: raw.EnableGroups, GroupQuotes: []PersonalGroupQuote{}, Estimated: true}
		item.PointsCost = nil
		item.FormattedPointsCost = "暂时无法报价"
		item.BillingDescription = "实际计费组由路由决定；报价为估算，以实际扣费为准。"
		if discount, ok := res.ModelDiscounts[raw.ModelName]; ok {
			if !validPersonalPrice(discount.Factor) || discount.Factor > 1 {
				return nil, errors.New("本人优惠数据无效，暂时无法报价")
			}
			item.Discount = &discount
		}
		expression := raw.BillingMode == "tiered_expr" || strings.TrimSpace(raw.BillingExpr) != ""
		if expression {
			item.FormattedPointsCost = "待参数报价 · 按实际用量结算"
			item.BillingDescription += "此模型采用阶梯/表达式计费，需根据实际用量、时长等参数结算，不能用基础单价判断免费。"
		}
		enabled := make(map[string]bool, len(raw.EnableGroups))
		for _, group := range raw.EnableGroups {
			enabled[group] = true
		}
		groups := make([]string, 0)
		for group := range res.ModelGroupRatio[raw.ModelName] {
			if enabled[group] || enabled["all"] {
				groups = append(groups, group)
			}
		}
		if len(groups) == 0 {
			continue
		} // No group available to this identity, including expression models.
		sort.Strings(groups)
		item.EnableGroups = groups
		for _, group := range groups {
			// The gateway already applied the personal discount. Never multiply factor again.
			ratio, ok := res.ModelGroupRatio[raw.ModelName][group]
			if !ok || !validPersonalPrice(ratio) {
				return nil, errors.New("本人计费组报价不完整，暂时无法报价")
			}
			quote := PersonalGroupQuote{Group: group, FinalRatio: ratio, FormattedPointsCost: "待参数报价 · 按实际用量结算"}
			if !expression {
				var baseUSD float64
				switch raw.QuotaType {
				case 1:
					if raw.ModelPrice == nil {
						quote.FormattedPointsCost = "待参数报价"
						item.GroupQuotes = append(item.GroupQuotes, quote)
						continue
					}
					baseUSD, quote.Unit = *raw.ModelPrice, "USD/次"
				case 0:
					if raw.ModelRatio == nil {
						quote.FormattedPointsCost = "待参数报价"
						item.GroupQuotes = append(item.GroupQuotes, quote)
						continue
					}
					baseUSD, quote.Unit = *raw.ModelRatio/500, "USD/千Token"
				default:
					return nil, errors.New("无法识别模型计费单位")
				}
				usd := baseUSD * ratio
				if !validPersonalPrice(baseUSD) || !validPersonalPrice(usd) {
					return nil, errors.New("本人模型单价无效")
				}
				quote.BaseUSD, quote.USDPrice = &baseUSD, &usd
				quote.FormattedPointsCost = fmt.Sprintf("%.6g %s", usd, quote.Unit)
				if raw.QuotaType == 0 && raw.CompletionRatio != nil {
					output := usd * *raw.CompletionRatio
					if !validPersonalPrice(output) {
						return nil, errors.New("本人输出单价无效")
					}
					quote.OutputUSDPrice = &output
					quote.FormattedPointsCost = fmt.Sprintf("输入 %.6g / 输出 %.6g %s", usd, output, quote.Unit)
				}
			}
			item.GroupQuotes = append(item.GroupQuotes, quote)
		}
		items = append(items, item)
	}
	return items, nil
}
