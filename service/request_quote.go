package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const RequestQuoteMaxBytes = 1 << 20
const requestQuoteTimeout = 10 * time.Second

// RequestQuoteInput contains generation parameters, never credentials or billing overrides.
type RequestQuoteInput struct {
	Endpoint   string          `json:"endpoint"`
	Body       json.RawMessage `json:"body"`
	BatchCount int             `json:"batch_count,omitempty"`
}

type RequestQuoteUnitRate struct {
	Dimension           string   `json:"dimension"`
	Quota               *float64 `json:"quota"`
	Per                 float64  `json:"per"`
	Unit                string   `json:"unit"`
	Conditional         bool     `json:"conditional,omitempty"`
	PointsCost          *float64 `json:"points_cost"`
	FormattedPointsCost string   `json:"formatted_points_cost"`
}

type RequestQuoteResult struct {
	Status              string                 `json:"status"`
	Quota               *int64                 `json:"quota"`
	QuotaPerUnit        float64                `json:"quota_per_unit"`
	Group               string                 `json:"group"`
	Model               string                 `json:"model"`
	BillingMode         string                 `json:"billing_mode"`
	BillingRevision     string                 `json:"billing_revision"`
	BatchCount          int                    `json:"batch_count"`
	MissingFields       []string               `json:"missing_fields"`
	UnitRates           []RequestQuoteUnitRate `json:"unit_rates"`
	Message             string                 `json:"message"`
	PointsCost          *float64               `json:"points_cost"`
	FormattedPointsCost string                 `json:"formatted_points_cost"`
}

// DecodeRequestQuote rejects unknown wrapper fields and untrusted billing inputs.
func DecodeRequestQuote(reader io.Reader) (RequestQuoteInput, error) {
	input := RequestQuoteInput{BatchCount: 1}
	payload, err := io.ReadAll(io.LimitReader(reader, RequestQuoteMaxBytes+1))
	if err != nil || len(payload) > RequestQuoteMaxBytes {
		return input, errors.New("报价请求不得超过 1 MiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		return input, errors.New("报价请求格式无效")
	}
	return input, validateRequestQuote(input)
}

func validateRequestQuote(input RequestQuoteInput) error {
	switch input.Endpoint {
	case "/v1/images/generations", "/v1/images/edits", "/v1/videos", "/api/v3/contents/generations/tasks", "/v1/chat/completions", "/v1/audio/speech", "/v1/responses":
	default:
		return errors.New("报价端点无效")
	}
	if input.BatchCount < 1 || input.BatchCount > 20 {
		return errors.New("报价批量数无效")
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(input.Body, &body) != nil || body == nil {
		return errors.New("报价 body 必须是对象")
	}
	// Only generation inputs are forwarded. The gateway derives identity, discounts and usage.
	allowed := strings.Fields("model prompt negative_prompt messages input instructions max_tokens max_completion_tokens max_output_tokens temperature top_p stream n size quality style response_format seed stop tools tool_choice parallel_tool_calls modalities audio voice speed format output_format duration duration_seconds seconds resolution aspect_ratio fps image images image_url image_urls video video_url audio_url mask input_reference content generate_audio watermark metadata resolution_name video_generate_audio input_reference[] video_reference[] audio_reference[] first_frame_url last_frame_url preset mode image_size num_frames video_reference audio_reference partial_images image_config multi_shot multi_prompt shot_type character_orientation")
	fields := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		fields[key] = true
	}
	for key := range body {
		if !fields[key] {
			return errors.New("报价 body 包含不支持的字段")
		}
	}
	var model string
	if json.Unmarshal(body["model"], &model) != nil || strings.TrimSpace(model) == "" {
		return errors.New("缺少报价模型")
	}
	return nil
}

func unavailableRequestQuote(input RequestQuoteInput, message string) *RequestQuoteResult {
	var body struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(input.Body, &body)
	batch := input.BatchCount
	if batch == 0 {
		batch = 1
	}
	return &RequestQuoteResult{Status: "unavailable", Model: body.Model, BatchCount: batch, MissingFields: []string{}, UnitRates: []RequestQuoteUnitRate{}, Message: message, FormattedPointsCost: "暂时无法报价"}
}

// FetchRequestQuote is read-only: it does not submit generation tasks or mutate the wallet.
func FetchRequestQuote(ctx context.Context, userID string, input RequestQuoteInput, channelID, userChannelID string) (*RequestQuoteResult, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, errors.New("请先登录后查看本人报价")
	}
	if err := validateRequestQuote(input); err != nil {
		return nil, err
	}
	for _, id := range []string{channelID, userChannelID} {
		if id = strings.TrimSpace(id); id != "" && id != "xyb-official-exclusive" {
			return unavailableRequestQuote(input, "当前渠道为用户自有或非官方渠道，无法提供中转站积分报价，请以供应商实际账单为准"), nil
		}
	}
	token, err := AICCUserToken(userID)
	if err != nil {
		return unavailableRequestQuote(input, "当前账号未绑定专属中转站身份，无法获取本人报价"), nil
	}
	return fetchRequestQuote(ctx, getNewAPIBaseURL(), token, input)
}

func fetchRequestQuote(ctx context.Context, base, token string, input RequestQuoteInput) (*RequestQuoteResult, error) {
	unavailable := func() (*RequestQuoteResult, error) {
		return unavailableRequestQuote(input, "本人报价服务暂不可用，请稍后重试"), nil
	}
	target, err := url.Parse(base)
	if err != nil || target.Host == "" || target.User != nil || (target.Scheme != "http" && target.Scheme != "https") || strings.TrimSpace(token) == "" {
		return unavailable()
	}
	// The wrapper endpoint is data only. It can never select the HTTP destination.
	target.Path, target.RawPath, target.RawQuery, target.Fragment = "/api/pricing/quote", "", "", ""
	payload, err := json.Marshal(input)
	if err != nil || len(payload) > RequestQuoteMaxBytes {
		return unavailable()
	}
	ctx, cancel := context.WithTimeout(ctx, requestQuoteTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(payload))
	if err != nil {
		return unavailable()
	}
	token = strings.TrimSpace(token)
	if !strings.HasPrefix(token, "sk-") {
		token = "sk-" + token
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: requestQuoteTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return unavailable()
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return unavailable()
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, RequestQuoteMaxBytes+1))
	if err != nil || len(data) > RequestQuoteMaxBytes {
		return unavailable()
	}
	var envelope struct {
		Success bool                `json:"success"`
		Data    *RequestQuoteResult `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil || !envelope.Success || envelope.Data == nil {
		return unavailable()
	}
	result := envelope.Data
	var requested struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(input.Body, &requested)
	if result.Model != requested.Model || result.BatchCount != input.BatchCount {
		return unavailable()
	}
	if !normalizeRequestQuote(result) {
		return unavailable()
	}
	return result, nil
}

func requestQuotePoints(quota, perUnit float64) *float64 {
	if quota < 0 || perUnit <= 0 || math.IsNaN(quota) || math.IsNaN(perUnit) || math.IsInf(quota, 0) || math.IsInf(perUnit, 0) {
		return nil
	}
	points := quota / perUnit * 10
	if math.IsNaN(points) || math.IsInf(points, 0) || (quota > 0 && points == 0) {
		return nil
	}
	return &points
}

func requestQuoteAmount(points float64) string {
	// Suppress binary floating-point noise without rounding tiny positive prices to zero.
	rounded, err := strconv.ParseFloat(strconv.FormatFloat(points, 'g', 12, 64), 64)
	if err == nil && (points == 0 || rounded > 0) {
		points = rounded
	}
	return strconv.FormatFloat(points, 'f', -1, 64)
}

func normalizeRequestQuote(result *RequestQuoteResult) bool {
	// Successful G messages are fixed contract reasons; translate only recognized reasons.
	reason := ""
	switch result.Message {
	case "task quote unknown: safe submission metadata or billing facts unavailable":
		reason = "缺少安全提交参数或可靠计费信息"
	case "selected route has parameter/header overrides; effective billing inputs are unknown":
		reason = "所选路由存在参数或请求头覆盖，无法确定实际计费输入"
	case "model pricing is not configured or exceeds the supported quota range":
		reason = "模型尚未配置价格或报价超出支持范围"
	}
	result.Message = "报价仅为估算，实际用量、重试路由和计费组可能改变最终账单"
	result.PointsCost = nil
	result.FormattedPointsCost = "暂时无法报价"
	if result.MissingFields == nil {
		result.MissingFields = []string{}
	}
	if result.UnitRates == nil {
		result.UnitRates = []RequestQuoteUnitRate{}
	}
	switch result.Status {
	case "estimated":
		if result.Quota != nil {
			result.PointsCost = requestQuotePoints(float64(*result.Quota), result.QuotaPerUnit)
		}
		if result.PointsCost == nil {
			result.Status, result.Message = "unavailable", "缺少有效额度或积分换算配置，暂时无法报价"
		} else {
			result.FormattedPointsCost = "预计消耗 " + requestQuoteAmount(*result.PointsCost) + " 积分"
		}
	case "usage_required":
		result.Quota = nil
		result.Message = "需实际用量才能计算总积分，以实际账单为准"
		result.FormattedPointsCost = "需实际用量，暂无法估算总积分"
	case "unavailable":
		result.Quota = nil
		result.Message = "当前模型或请求参数暂时无法报价"
	default:
		return false
	}
	if reason != "" {
		result.Message += "；" + reason
	}
	if result.Status != "estimated" && result.Status != "usage_required" {
		result.UnitRates = []RequestQuoteUnitRate{}
		return true
	}
	for i := range result.UnitRates {
		rate := &result.UnitRates[i]
		rate.PointsCost, rate.FormattedPointsCost = nil, "单位积分暂不可用"
		if rate.Quota != nil && rate.Per > 0 && !math.IsInf(rate.Per, 0) && rate.Unit != "" {
			rate.PointsCost = requestQuotePoints(*rate.Quota, result.QuotaPerUnit)
		}
		if rate.PointsCost != nil {
			rate.FormattedPointsCost = requestQuoteAmount(*rate.PointsCost) + " 积分 / " + requestQuoteAmount(rate.Per) + " " + rate.Unit
			if rate.Conditional {
				rate.FormattedPointsCost += "（按适用条件）"
			}
		}
	}
	if result.Status == "usage_required" && len(result.UnitRates) == 0 {
		result.Message += "；当前计费规则无法可靠拆分单位积分"
	}
	return true
}
