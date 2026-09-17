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
	Unit                string   `json:"unit"`
	FormattedPointsCost string   `json:"formatted_points_cost"`
}

type personalPricingResponse struct {
	Success bool `json:"success"`
	Data    []struct {
		ModelPricingItem
		BillingMode  string   `json:"billing_mode"`
		BillingExpr  string   `json:"billing_expr"`
		EnableGroups []string `json:"enable_groups"`
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
		if !strings.HasPrefix(token, "sk-") {
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
		Type         string  `json:"quota_display_type"`
		Rate         float64 `json:"usd_exchange_rate"`
		CustomSymbol string  `json:"custom_currency_symbol"`
		CustomRate   float64 `json:"custom_currency_exchange_rate"`
	} `json:"data"`
}

func applyPersonalPricingCurrency(items []PersonalModelPricingItem, status personalPricingCurrencyResponse) error {
	if !status.Success {
		return errors.New("无法读取平台货币配置")
	}
	symbol, rate := "USD", 1.0
	switch status.Data.Type {
	case "USD", "TOKENS":
	case "CNY":
		symbol, rate = "¥", status.Data.Rate
	case "CUSTOM":
		symbol, rate = status.Data.CustomSymbol, status.Data.CustomRate
	default:
		return errors.New("平台货币类型不明确，暂时无法报价")
	}
	if symbol == "" || !validPersonalPrice(rate) || rate == 0 {
		return errors.New("平台货币换算配置无效")
	}
	for i := range items {
		item := &items[i]
		if item.BillingMode == "tiered_expr" || item.BillingExpr != "" {
			continue
		}
		lowest := -1.0
		label := ""
		for j := range item.GroupQuotes {
			quote := &item.GroupQuotes[j]
			if quote.USDPrice == nil {
				continue
			}
			amount := *quote.USDPrice * rate
			if !validPersonalPrice(amount) {
				return errors.New("模型报价超出有效范围")
			}
			unit := strings.TrimPrefix(quote.Unit, "USD")
			quote.FormattedPointsCost = fmt.Sprintf("%s %.6g%s", symbol, amount, unit)
			if quote.OutputUSDPrice != nil {
				output := *quote.OutputUSDPrice * rate
				if !validPersonalPrice(output) {
					return errors.New("模型输出报价超出有效范围")
				}
				quote.FormattedPointsCost = fmt.Sprintf("输入 %s %.6g / 输出 %s %.6g%s", symbol, amount, symbol, output, unit)
			}
			if lowest < 0 || amount < lowest {
				lowest, label = amount, quote.FormattedPointsCost
			}
		}
		if lowest >= 0 {
			if len(item.GroupQuotes) > 1 {
				label += " 起"
			}
			item.FormattedPointsCost = label + " · 按平台账单结算"
			item.BillingDescription = "采用平台当前货币配置及本人计费组倍率。实际用量和路由决定最终账单；积分不作确定报价。"
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
			item.FormattedPointsCost = "按实际用量结算"
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
			quote := PersonalGroupQuote{Group: group, FinalRatio: ratio, FormattedPointsCost: "按实际用量结算"}
			if !expression {
				var baseUSD float64
				switch raw.QuotaType {
				case 1:
					baseUSD, quote.Unit = raw.ModelPrice, "USD/次"
				case 0:
					baseUSD, quote.Unit = raw.ModelRatio*2/1000, "USD/千Token"
				default:
					return nil, errors.New("无法识别模型计费单位")
				}
				usd := baseUSD * ratio
				if !validPersonalPrice(baseUSD) || !validPersonalPrice(usd) {
					return nil, errors.New("本人模型单价无效")
				}
				quote.BaseUSD, quote.USDPrice = &baseUSD, &usd
				quote.FormattedPointsCost = fmt.Sprintf("%.6g %s", usd, quote.Unit)
				if raw.QuotaType == 0 {
					output := usd * raw.CompletionRatio
					if !validPersonalPrice(raw.CompletionRatio) || !validPersonalPrice(output) {
						return nil, errors.New("本人输出单价无效")
					}
					quote.OutputUSDPrice = &output
					quote.FormattedPointsCost = fmt.Sprintf("输入 %.6g / 输出 %.6g %s", usd, output, quote.Unit)
				}
			}
			item.GroupQuotes = append(item.GroupQuotes, quote)
		}
		if !expression && len(item.GroupQuotes) > 0 {
			lowest := item.GroupQuotes[0]
			for _, quote := range item.GroupQuotes[1:] {
				if *quote.USDPrice < *lowest.USDPrice {
					lowest = quote
				}
			}
			item.FormattedPointsCost = lowest.FormattedPointsCost
			if len(item.GroupQuotes) > 1 {
				item.FormattedPointsCost += " 起"
			}
			item.FormattedPointsCost += " · 按平台账单结算"
			item.BillingDescription += "当前积分换算口径待核实，仅展示美元基价及个人计费组报价，不代表确定的积分扣费。"
		}
		items = append(items, item)
	}
	return items, nil
}
