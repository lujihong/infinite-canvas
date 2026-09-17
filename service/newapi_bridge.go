package service

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const (
	defaultNewAPIBaseURL  = "http://new-api:3000"
	defaultEpayGatewayURL = "https://pay.xybcloud.com"
	epayMerchantID        = "1000"
	epayMerchantKey       = "epay_secret_key_profitly_2026"
)

type NewAPIBaseResponse struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type NewAPIActiveKeyData struct {
	Key      string `json:"key"`
	UserID   int    `json:"user_id"`
	Username string `json:"username"`
	Email    string `json:"email"`
	Role     int    `json:"role"`
	Quota    int64  `json:"quota"`
	AffCode  string `json:"aff_code"`
}

type NewAPILoginData struct {
	AccessToken string `json:"access_token"`
	User        struct {
		ID       int    `json:"id"`
		Username string `json:"username"`
		Email    string `json:"email"`
		Role     int    `json:"role"`
		Quota    int64  `json:"quota"`
	} `json:"user"`
}

type UserExtraInfo struct {
	NewAPIToken  string `json:"newapi_token,omitempty"`
	NewAPIUserID int    `json:"newapi_user_id,omitempty"`
	LinuxDo      any    `json:"linuxDo,omitempty"`
}

func getNewAPIBaseURL() string {
	if val := strings.TrimSpace(os.Getenv("NEWAPI_BASE_URL")); val != "" {
		return strings.TrimRight(val, "/")
	}
	return defaultNewAPIBaseURL
}

func getEpayGatewayURL() string {
	if val := strings.TrimSpace(os.Getenv("EPAY_GATEWAY_URL")); val != "" {
		return strings.TrimRight(val, "/")
	}
	return defaultEpayGatewayURL
}

// SendNewAPIVerificationEmail 调用中转站接口发送企业邮箱验证码
func SendNewAPIVerificationEmail(email string) error {
	email = strings.TrimSpace(email)
	if email == "" {
		return errors.New("邮箱地址不能为空")
	}

	client := &http.Client{Timeout: 10 * time.Second}
	apiURL := fmt.Sprintf("%s/api/verification?email=%s", getNewAPIBaseURL(), url.QueryEscape(email))

	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Host", "api.xybcloud.com")

	resp, err := client.Do(req)
	if err != nil {
		// 尝试降级公网访问
		fallbackURL := fmt.Sprintf("https://api.xybcloud.com/api/verification?email=%s", url.QueryEscape(email))
		resp, err = client.Get(fallbackURL)
		if err != nil {
			return fmt.Errorf("请求验证码服务失败: %w", err)
		}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result NewAPIBaseResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("解析验证码服务响应失败: %s", string(body))
	}

	if !result.Success {
		if result.Message != "" {
			return errors.New(result.Message)
		}
		return errors.New("发送验证码失败，请稍后重试")
	}

	return nil
}

// RegisterThroughNewAPI 在中转站完成注册并同步本系统用户及 API 令牌
func RegisterThroughNewAPI(username string, password string, email string, code string) (model.AuthSession, error) {
	username = strings.TrimSpace(username)
	email = strings.TrimSpace(email)
	password = strings.TrimSpace(password)
	code = strings.TrimSpace(code)

	if username == "" || password == "" {
		return model.AuthSession{}, safeMessageError{message: "用户名和密码不能为空"}
	}
	if email == "" || code == "" {
		return model.AuthSession{}, safeMessageError{message: "邮箱和验证码不能为空"}
	}

	// 1. 调用 New-API 注册接口
	regBody, _ := json.Marshal(map[string]string{
		"username":          username,
		"password":          password,
		"email":             email,
		"verification_code": code,
	})

	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodPost, getNewAPIBaseURL()+"/api/user/register", bytes.NewReader(regBody))
	if err != nil {
		return model.AuthSession{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Host", "api.xybcloud.com")

	resp, err := client.Do(req)
	if err != nil {
		return model.AuthSession{}, fmt.Errorf("连接中枢注册服务失败: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var regRes NewAPIBaseResponse
	if err := json.Unmarshal(body, &regRes); err != nil {
		return model.AuthSession{}, fmt.Errorf("注册服务响应无效: %s", string(body))
	}
	if !regRes.Success {
		if regRes.Message != "" {
			return model.AuthSession{}, safeMessageError{message: regRes.Message}
		}
		return model.AuthSession{}, safeMessageError{message: "注册失败，请检查输入或验证码"}
	}

	// 2. 注册成功后自动调用登录
	return LoginThroughNewAPI(username, password)
}

// LoginThroughNewAPI 优先通过中转站完成登录与令牌自动同步
func LoginThroughNewAPI(username string, password string) (model.AuthSession, error) {
	username = strings.TrimSpace(username)
	password = strings.TrimSpace(password)

	loginBody, _ := json.Marshal(map[string]string{
		"username": username,
		"password": password,
	})

	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodPost, getNewAPIBaseURL()+"/api/user/login", bytes.NewReader(loginBody))
	if err != nil {
		return model.AuthSession{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Host", "api.xybcloud.com")

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("login through new-api network error: %v, fallback local login", err)
		return Login(username, password)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var loginRes struct {
		Success bool            `json:"success"`
		Message string          `json:"message"`
		Data    NewAPILoginData `json:"data"`
	}
	if err := json.Unmarshal(body, &loginRes); err != nil || !loginRes.Success {
		log.Printf("new-api login response: %s, fallback local login", string(body))
		return Login(username, password)
	}

	accessToken := loginRes.Data.AccessToken
	newApiUser := loginRes.Data.User

	// 3. 通过 access_token 获取或自动创建用户专属的 sk- 令牌
	activeKeyData, err := fetchNewAPIActiveKey(accessToken)
	tokenKey := ""
	if err == nil && activeKeyData != nil {
		tokenKey = activeKeyData.Key
	}

	// 4. 同步至本系统数据库
	user, err := syncNewAPIUserToLocal(newApiUser.ID, newApiUser.Username, newApiUser.Email, password, newApiUser.Role, newApiUser.Quota, tokenKey)
	if err != nil {
		return model.AuthSession{}, err
	}

	return newSession(user)
}

// fetchNewAPIActiveKey 获取用户在 New-API 中的有效 API Token
func fetchNewAPIActiveKey(accessToken string) (*NewAPIActiveKeyData, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest(http.MethodGet, getNewAPIBaseURL()+"/api/user/active-key", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Host", "api.xybcloud.com")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var res struct {
		Success bool                `json:"success"`
		Message string              `json:"message"`
		Data    NewAPIActiveKeyData `json:"data"`
	}
	if err := json.Unmarshal(body, &res); err != nil || !res.Success {
		return nil, errors.New("获取用户API令牌失败")
	}
	return &res.Data, nil
}

// syncNewAPIUserToLocal 同步用户信息及专属模型配置
func syncNewAPIUserToLocal(newApiID int, username, email, password string, role int, quota int64, tokenKey string) (model.User, error) {
	user, ok, err := repository.GetUserByUsername(username)
	if err != nil {
		return model.User{}, err
	}

	hash, _ := hashPassword(password)
	userRole := model.UserRoleUser
	if role >= 100 {
		userRole = model.UserRoleAdmin
	}

	extraObj := UserExtraInfo{
		NewAPIToken:  tokenKey,
		NewAPIUserID: newApiID,
	}
	extraBytes, _ := json.Marshal(extraObj)

	if !ok {
		user = model.User{
			ID:          newID("user"),
			Username:    username,
			Password:    hash,
			Email:       email,
			DisplayName: username,
			Role:        userRole,
			Credits:     int(quota),
			AffCode:     newAffCode(),
			Status:      model.UserStatusActive,
			Extra:       string(extraBytes),
			CreatedAt:   now(),
			UpdatedAt:   now(),
		}
	} else {
		if hash != "" {
			user.Password = hash
		}
		if email != "" {
			user.Email = email
		}
		user.Role = userRole
		user.Credits = int(quota)
		user.Extra = string(extraBytes)
		user.UpdatedAt = now()
	}

	saved, err := repository.SaveUser(user)
	if err != nil {
		return model.User{}, err
	}

	// 自动配置该用户的专属渠道为官方中转站（无需用户感知）
	if tokenKey != "" {
		_ = autoConfigureUserOfficialChannel(saved.ID, tokenKey)
	}

	return saved, nil
}

// autoConfigureUserOfficialChannel 自动为用户绑定官方模型中转通道并锁定
func autoConfigureUserOfficialChannel(userID string, tokenKey string) error {
	config, _, err := repository.GetUserConfig(userID)
	if err != nil {
		return err
	}

	publicSetting, _ := PublicSettings()
	availableModels := publicSetting.ModelChannel.AvailableModels
	if len(availableModels) == 0 {
		availableModels = []string{"*"}
	}

	modelConfig := map[string]any{
		"channelMode": "remote",
		"localChannels": []map[string]any{
			{
				"id":       "xyb-official-exclusive",
				"protocol": "openai",
				"name":     "鑫元宝官方模型服务",
				"baseUrl":  "https://api.xybcloud.com/",
				"apiKey":   tokenKey,
				"models":   availableModels,
			},
		},
	}
	modelConfigBytes, _ := json.Marshal(modelConfig)

	current := now()
	if config.UserID == "" {
		config.UserID = userID
		config.CreatedAt = current
	}
	config.ModelConfig = string(modelConfigBytes)
	config.UpdatedAt = current

	_, err = repository.SaveUserConfig(config)
	return err
}

// GetUserExclusiveNewAPIToken 读取用户绑定的专属 New-API Token（严格多用户隔离）
func GetUserExclusiveNewAPIToken(userID string) string {
	user, ok, err := repository.GetUserByID(userID)
	if err != nil || !ok {
		return ""
	}

	var extra UserExtraInfo
	if user.Extra != "" && json.Unmarshal([]byte(user.Extra), &extra) == nil && extra.NewAPIToken != "" {
		return extra.NewAPIToken
	}

	// 仅限管理员账号在未绑定 Extra 时允许回退读取自身的自定义配置，普通用户严格物理隔离防串号
	if user.Role == model.UserRoleAdmin {
		config, ok, err := repository.GetUserConfig(userID)
		if err == nil && ok && config.ModelConfig != "" {
			var parsed struct {
				LocalChannels []struct {
					APIKey string `json:"apiKey"`
				} `json:"localChannels"`
			}
			if json.Unmarshal([]byte(config.ModelConfig), &parsed) == nil && len(parsed.LocalChannels) > 0 {
				return parsed.LocalChannels[0].APIKey
			}
		}
	}

	return ""
}

// GetUserNewAPIID 读取用户在 New-API 体系中的用户 ID
func GetUserNewAPIID(userID string) int {
	user, ok, err := repository.GetUserByID(userID)
	if err != nil || !ok {
		return 0
	}
	var extra UserExtraInfo
	if user.Extra != "" && json.Unmarshal([]byte(user.Extra), &extra) == nil && extra.NewAPIUserID > 0 {
		return extra.NewAPIUserID
	}
	return 0
}

// SendNewAPIPasswordResetEmail 发送密码重置申请邮件
func SendNewAPIPasswordResetEmail(email string) error {
	email = strings.TrimSpace(email)
	if email == "" {
		return errors.New("邮箱不能为空")
	}

	client := &http.Client{Timeout: 10 * time.Second}
	apiURL := fmt.Sprintf("%s/api/reset_password?email=%s", getNewAPIBaseURL(), url.QueryEscape(email))

	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Host", "api.xybcloud.com")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("请求密码重置服务失败: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var res NewAPIBaseResponse
	if err := json.Unmarshal(body, &res); err != nil || !res.Success {
		return errors.New("发送密码重置邮件失败，请确认邮箱是否正确")
	}
	return nil
}

// ResetNewAPIPassword 执行重置密码
func ResetNewAPIPassword(email, token, newPassword string) error {
	reqBody, _ := json.Marshal(map[string]string{
		"email":    strings.TrimSpace(email),
		"token":    strings.TrimSpace(token),
		"password": strings.TrimSpace(newPassword),
	})

	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodPost, getNewAPIBaseURL()+"/api/user/reset", bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Host", "api.xybcloud.com")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("提交重置密码失败: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var res NewAPIBaseResponse
	if err := json.Unmarshal(body, &res); err != nil || !res.Success {
		if res.Message != "" {
			return errors.New(res.Message)
		}
		return errors.New("密码重置失败，重置凭证可能已过期")
	}

	// 同步更新本地数据库密码
	if user, ok, _ := repository.GetUserByEmail(email); ok {
		hash, _ := hashPassword(newPassword)
		user.Password = hash
		user.UpdatedAt = now()
		_, _ = repository.SaveUser(user)
	}

	return nil
}

// FetchUserWalletBalance 获取当前用户的实时算力额度与折算金额（动态根据中转站配置计算）
type newAPISystemStatusCache struct {
	USDExchangeRate float64
	QuotaPerUnit    int64
	UpdatedAt       time.Time
}

var (
	systemStatusMu    sync.RWMutex
	systemStatusCache newAPISystemStatusCache
)

func getNewAPISystemStatus() (float64, int64) {
	systemStatusMu.RLock()
	if time.Since(systemStatusCache.UpdatedAt) < 30*time.Second && systemStatusCache.USDExchangeRate > 0 {
		rate := systemStatusCache.USDExchangeRate
		quota := systemStatusCache.QuotaPerUnit
		systemStatusMu.RUnlock()
		return rate, quota
	}
	systemStatusMu.RUnlock()

	systemStatusMu.Lock()
	defer systemStatusMu.Unlock()

	if time.Since(systemStatusCache.UpdatedAt) < 30*time.Second && systemStatusCache.USDExchangeRate > 0 {
		return systemStatusCache.USDExchangeRate, systemStatusCache.QuotaPerUnit
	}

	rate := 7.0
	quota := int64(500000)

	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodGet, getNewAPIBaseURL()+"/api/status", nil)
	if err == nil {
		req.Header.Set("Host", "api.xybcloud.com")
		if resp, err := client.Do(req); err == nil {
			defer resp.Body.Close()
			var res struct {
				Success bool `json:"success"`
				Data    struct {
					USDExchangeRate float64 `json:"usd_exchange_rate"`
					QuotaPerUnit    int64   `json:"quota_per_unit"`
				} `json:"data"`
			}
			if json.NewDecoder(resp.Body).Decode(&res) == nil && res.Success {
				if res.Data.USDExchangeRate > 0 {
					rate = res.Data.USDExchangeRate
				}
				if res.Data.QuotaPerUnit > 0 {
					quota = res.Data.QuotaPerUnit
				}
			}
		}
	}

	systemStatusCache = newAPISystemStatusCache{
		USDExchangeRate: rate,
		QuotaPerUnit:    quota,
		UpdatedAt:       time.Now(),
	}

	return rate, quota
}

func FetchUserWalletBalance(userID string) (map[string]any, error) {
	token := GetUserExclusiveNewAPIToken(userID)
	var quota int64 = 0

	if token != "" {
		client := &http.Client{Timeout: 5 * time.Second}
		req, err := http.NewRequest(http.MethodGet, getNewAPIBaseURL()+"/api/user/quota-by-token", nil)
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Host", "api.xybcloud.com")
			resp, doErr := client.Do(req)
			if doErr == nil {
				defer resp.Body.Close()
				var res struct {
					Success bool `json:"success"`
					Data    struct {
						Quota int64 `json:"quota"`
					} `json:"data"`
				}
				if json.NewDecoder(resp.Body).Decode(&res) == nil && res.Success {
					quota = res.Data.Quota
				}
			}
		}
	}

	if quota <= 0 {
		user, ok, _ := repository.GetUserByID(userID)
		if ok {
			quota = int64(user.Credits)
		}
	}

	_, quotaPerUnit := getNewAPISystemStatus()
	if quotaPerUnit <= 0 {
		quotaPerUnit = 500000
	}
	balanceYuan, points := quotaBillingValues(quota, quotaPerUnit)

	return map[string]any{
		"quota":            quota,
		"balanceYuan":      balanceYuan,
		"points":           points,
		"formattedPoints":  fmt.Sprintf("%.1f 积分", points),
		"formattedBalance": fmt.Sprintf("¥ %.2f", balanceYuan),
		"exchangeRate":     10.0,
		"minTopup":         1,
	}, nil
}

// quotaBillingValues converts the platform quota ledger into CNY account value.
// This is the current platform top-up convention, not a generic USD exchange rate.
func quotaBillingValues(quota, quotaPerUnit int64) (yuan, points float64) {
	if quotaPerUnit <= 0 {
		quotaPerUnit = 500000
	}
	if quota < 0 {
		quota = 0
	}
	yuan = float64(quota) / float64(quotaPerUnit)
	return yuan, yuan * 10.0
}

func consumptionStatusLabel(logType int, quota int64, localStatus string) string {
	switch logType {
	case 5:
		if quota == 0 {
			return "调用失败 · 未扣费"
		}
		return "调用失败 · 存在扣费记录"
	case 6:
		localStatus = strings.ToLower(strings.TrimSpace(localStatus))
		if localStatus == "success" || localStatus == "completed" || localStatus == "succeeded" {
			return "差额退还"
		}
		if localStatus == "failed" || localStatus == "error" {
			return "失败已退款"
		}
		return "额度退还"
	}
	return ""
}

func formatBillingPoints(points float64) string {
	if points > 0 && points < 0.001 {
		return "<0.001 积分"
	}
	if points > 0 && points < 0.01 {
		return fmt.Sprintf("%.3f 积分", points)
	}
	return fmt.Sprintf("%.2f 积分", points)
}

func formatBillingMoney(yuan float64) string {
	if yuan > 0 && yuan < 0.000001 {
		return "¥ <0.000001"
	}
	if yuan > 0 && yuan < 0.0001 {
		return fmt.Sprintf("¥ %.6f", yuan)
	}
	return fmt.Sprintf("¥ %.4f", yuan)
}

type ModelPricingItem struct {
	ModelName              string   `json:"model_name"`
	QuotaType              int      `json:"quota_type"` // 0: 按Token计费, 1: 按次计费
	ModelPrice             float64  `json:"model_price"`
	ModelRatio             float64  `json:"model_ratio"`
	CompletionRatio        float64  `json:"completion_ratio"`
	PointsCost             float64  `json:"points_cost"`
	FormattedPointsCost    string   `json:"formatted_points_cost"`
	BillingDescription     string   `json:"billing_description"`
	SupportedEndpointTypes []string `json:"supported_endpoint_types"`
}

type modelPricingCache struct {
	List      []ModelPricingItem
	UpdatedAt time.Time
}

var (
	pricingCacheMu sync.RWMutex
	pricingCache   modelPricingCache
)

// FetchModelPricingList 获取中转站全量模型实时定价并折算为积分单价
func FetchModelPricingList() ([]ModelPricingItem, error) {
	pricingCacheMu.RLock()
	if time.Since(pricingCache.UpdatedAt) < 60*time.Second && len(pricingCache.List) > 0 {
		list := pricingCache.List
		pricingCacheMu.RUnlock()
		return list, nil
	}
	pricingCacheMu.RUnlock()

	pricingCacheMu.Lock()
	defer pricingCacheMu.Unlock()

	if time.Since(pricingCache.UpdatedAt) < 60*time.Second && len(pricingCache.List) > 0 {
		return pricingCache.List, nil
	}

	exchangeRate, _ := getNewAPISystemStatus()
	if exchangeRate <= 0 {
		exchangeRate = 7.0
	}

	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequest(http.MethodGet, getNewAPIBaseURL()+"/api/pricing", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Host", "api.xybcloud.com")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求中转站定价接口失败: %w", err)
	}
	defer resp.Body.Close()

	var res struct {
		Success bool `json:"success"`
		Data    []struct {
			ModelName              string   `json:"model_name"`
			QuotaType              int      `json:"quota_type"`
			ModelPrice             float64  `json:"model_price"`
			ModelRatio             float64  `json:"model_ratio"`
			CompletionRatio        float64  `json:"completion_ratio"`
			SupportedEndpointTypes []string `json:"supported_endpoint_types"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil || !res.Success {
		return nil, errors.New("解析中转站定价数据失败")
	}

	items := make([]ModelPricingItem, 0, len(res.Data))
	for _, raw := range res.Data {
		var pointsCost float64
		var formatted string
		var desc string

		if raw.QuotaType == 1 {
			// 按次计费：美元单价 * 汇率
			pointsCost = raw.ModelPrice * exchangeRate
			pointsCost = float64(int(pointsCost*100+0.5)) / 100.0
			formatted = fmt.Sprintf("%.2f 积分/次", pointsCost)
			desc = fmt.Sprintf("按次固定扣费 ($%.4f)", raw.ModelPrice)
		} else {
			// 按 Token 计费：根据比率计算大约千 Token 积分
			// 每百万 tokens 基础价格 $2.0 * model_ratio
			estimatedUsdPer1k := (raw.ModelRatio * 2.0) / 1000.0
			pointsCost = estimatedUsdPer1k * exchangeRate
			pointsCost = float64(int(pointsCost*1000+0.5)) / 1000.0
			formatted = "按量扣费"
			desc = fmt.Sprintf("倍率 %.2f (输出倍率 %.1f)", raw.ModelRatio, raw.CompletionRatio)
		}

		items = append(items, ModelPricingItem{
			ModelName:              raw.ModelName,
			QuotaType:              raw.QuotaType,
			ModelPrice:             raw.ModelPrice,
			ModelRatio:             raw.ModelRatio,
			CompletionRatio:        raw.CompletionRatio,
			PointsCost:             pointsCost,
			FormattedPointsCost:    formatted,
			BillingDescription:     desc,
			SupportedEndpointTypes: raw.SupportedEndpointTypes,
		})
	}

	pricingCache = modelPricingCache{
		List:      items,
		UpdatedAt: time.Now(),
	}

	return items, nil
}

type ConsumptionLogItem struct {
	ID                int     `json:"id"`
	CreatedAt         int64   `json:"created_at"`
	SubmitTime        int64   `json:"submit_time"`
	CompleteTime      int64   `json:"complete_time"`
	ModelName         string  `json:"model_name"`
	Type              int     `json:"type"`             // 1: 充值, 2: 消费, 5: 失败报错, 6: 退款
	Status            string  `json:"status"`           // "success" | "failed" | "refunded" | "processing" | "free"
	StatusLabel       string  `json:"status_label"`     // "成功" | "调用失败 · 未扣费" | "失败已退款" | "处理中" | "免费体验"
	Progress          int     `json:"progress"`         // 100
	DurationSeconds   float64 `json:"duration_seconds"` // 耗时秒数，例如 145.0
	TaskID            string  `json:"task_id,omitempty"`
	TaskAction        string  `json:"task_action,omitempty"` // "图生视频" / "文生视频" / "文生图" / "图像编辑" / "文本对话" / "音频合成"
	VideoURL          string  `json:"video_url,omitempty"`
	Quota             int64   `json:"quota"`
	PointsCost        float64 `json:"points_cost"`
	FormattedPoints   string  `json:"formatted_points"`
	MoneyYuan         float64 `json:"money_yuan"`
	FormattedMoney    string  `json:"formatted_money"`
	PromptTokens      int     `json:"prompt_tokens"`
	CompletionTokens  int     `json:"completion_tokens"`
	UseTime           int     `json:"use_time"`
	IsStream          bool    `json:"is_stream"`
	ErrorMessage      string  `json:"error_message,omitempty"`
	ErrorDetail       string  `json:"error_detail,omitempty"`
	RequestID         string  `json:"request_id,omitempty"`
	UpstreamRequestID string  `json:"upstream_request_id,omitempty"`
}

func parseErrorMessage(content string, other string) (string, string) {
	content = strings.TrimSpace(content)
	other = strings.TrimSpace(other)

	var otherMap map[string]any
	if other != "" {
		_ = json.Unmarshal([]byte(other), &otherMap)
	}

	if reason, ok := otherMap["reason"].(string); ok && reason != "" {
		if strings.Contains(reason, "copyright") {
			return "生成内容触发版权安全策略，费用状态请查看扣费与退款记录", reason
		}
		return reason, reason
	}

	if strings.Contains(content, "status_code=500") || strings.Contains(other, "\"status_code\":500") {
		if strings.Contains(content, "PERMISSION_ERROR") || strings.Contains(content, "not authorized") {
			return "模型服务授权校验未通过 (500)", content
		}
		if strings.Contains(content, "endpoint not supported") {
			return "该模型对应接口端点尚未开放 (500)", content
		}
		return "上游大模型服务发生故障或超时 (500)", content
	}
	if strings.Contains(content, "status_code=403") || strings.Contains(content, "预扣费额度失败") || strings.Contains(other, "\"status_code\":403") {
		return "账户算力额度不足，请充值后使用 (403)", content
	}
	if strings.Contains(content, "status_code=429") || strings.Contains(content, "Synchronous image request limit reached") || strings.Contains(other, "\"status_code\":429") {
		return "超出服务并发限制，请稍候重试 (429)", content
	}
	if strings.Contains(content, "status_code=502") || strings.Contains(content, "rejected by content moderation") || strings.Contains(other, "\"status_code\":502") {
		return "输入提示词或素材触及安全审核 (502)", content
	}
	if strings.Contains(content, "status_code=504") || strings.Contains(other, "\"status_code\":504") {
		return "上游服务响应超时 (504)", content
	}
	if strings.Contains(content, "status_code=400") || strings.Contains(other, "\"status_code\":400") {
		if strings.Contains(content, "not supported on the Chat Completions endpoint") {
			return "该模型为绘画或专用模型，不支持对话调用 (400)", content
		}
		return "请求参数或数据格式不合规 (400)", content
	}

	if content != "" {
		if len(content) > 80 {
			return content[:80] + "...", content
		}
		return content, content
	}

	return "任务异常中断，费用状态请查看账单", other
}

func parseTaskAction(modelName string, content string, isVideo bool) string {
	lowerContent := strings.ToLower(content)
	lowerModel := strings.ToLower(modelName)

	if strings.Contains(lowerContent, "imagetovideo") || strings.Contains(lowerContent, "图生视频") {
		return "图生视频"
	}
	if strings.Contains(lowerContent, "textgenerate") || strings.Contains(lowerContent, "文生视频") {
		return "文生视频"
	}
	if strings.Contains(lowerContent, "imageedit") || strings.Contains(lowerContent, "图像编辑") {
		return "图像编辑"
	}
	if strings.Contains(lowerContent, "imagegenerate") || strings.Contains(lowerContent, "文生图") || strings.Contains(lowerContent, "1024x1024") {
		return "文生图"
	}

	if isVideo {
		return "图生视频"
	}
	if strings.Contains(lowerModel, "image") || strings.Contains(lowerModel, "flux") || strings.Contains(lowerModel, "dall") || strings.Contains(lowerModel, "midjourney") || strings.Contains(lowerModel, "seedream") {
		return "图像生成"
	}
	if strings.Contains(lowerModel, "music") || strings.Contains(lowerModel, "audio") || strings.Contains(lowerModel, "tts") || strings.Contains(lowerModel, "voice") || strings.Contains(lowerModel, "suno") || strings.Contains(lowerModel, "speech") {
		return "音频合成"
	}
	return "文本对话"
}

// FetchUserConsumptionLogs 获取当前用户在中转站的真实调用与扣费明细日志
func FetchUserConsumptionLogs(userID string) ([]ConsumptionLogItem, error) {
	token := GetUserExclusiveNewAPIToken(userID)
	if token == "" {
		return []ConsumptionLogItem{}, nil
	}

	_, quotaPerUnit := getNewAPISystemStatus()
	if quotaPerUnit <= 0 {
		quotaPerUnit = 500000
	}

	// 1. 查询本地最近的视频任务，建立任务ID和完成时间关联索引
	localTasks, _ := repository.ListRecentUserVideoTasks(userID, 100)
	localTaskByUpstreamID := make(map[string]model.VideoTask)
	localRunningTasks := make([]model.VideoTask, 0)
	for _, t := range localTasks {
		if t.UpstreamTaskID != "" {
			localTaskByUpstreamID[t.UpstreamTaskID] = t
		}
		if t.Status == "queued" || t.Status == "in_progress" || t.Status == "processing" || t.Status == "running" {
			localRunningTasks = append(localRunningTasks, t)
		}
	}

	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequest(http.MethodGet, getNewAPIBaseURL()+"/api/log/token?size=100", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Host", "api.xybcloud.com")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求消费明细失败: %w", err)
	}
	defer resp.Body.Close()

	var res struct {
		Success bool `json:"success"`
		Data    []struct {
			ID                int    `json:"id"`
			CreatedAt         int64  `json:"created_at"`
			ModelName         string `json:"model_name"`
			Type              int    `json:"type"`
			Quota             int64  `json:"quota"`
			PromptTokens      int    `json:"prompt_tokens"`
			CompletionTokens  int    `json:"completion_tokens"`
			UseTime           int    `json:"use_time"`
			IsStream          bool   `json:"is_stream"`
			Content           string `json:"content"`
			RequestID         string `json:"request_id"`
			UpstreamRequestID string `json:"upstream_request_id"`
			Other             string `json:"other"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil || !res.Success {
		return []ConsumptionLogItem{}, nil
	}

	logs := make([]ConsumptionLogItem, 0, len(res.Data)+len(localRunningTasks))

	// 2. 先把本地处于进行中的视频任务前置展示在流水最顶端
	for _, rt := range localRunningTasks {
		taskID := rt.UpstreamTaskID
		if taskID == "" {
			taskID = rt.ID
		}
		action := "图生视频"
		if strings.Contains(strings.ToLower(rt.RequestBody), "textgenerate") {
			action = "文生视频"
		}
		var subTime int64
		if t, err := time.Parse(time.RFC3339, rt.CreatedAt); err == nil {
			subTime = t.Unix()
		} else {
			subTime = time.Now().Unix()
		}
		durSec := float64(time.Now().Unix() - subTime)
		if durSec < 0 {
			durSec = 0
		}

		logs = append(logs, ConsumptionLogItem{
			ID:              -1,
			CreatedAt:       subTime,
			SubmitTime:      subTime,
			CompleteTime:    0,
			ModelName:       rt.Model,
			Type:            2,
			Status:          "processing",
			StatusLabel:     "生成中",
			Progress:        rt.Progress,
			DurationSeconds: durSec,
			TaskID:          taskID,
			TaskAction:      action,
			VideoURL:        rt.VideoURL,
			PointsCost:      0,
			FormattedPoints: "计算中",
			MoneyYuan:       0,
			FormattedMoney:  "¥ 0.00",
			UseTime:         int(durSec * 1000),
		})
	}

	// 3. 处理中转站真实物理日志
	for _, l := range res.Data {
		moneyYuan, pointsCost := quotaBillingValues(l.Quota, quotaPerUnit)

			// 解析关联任务信息
			var taskID string
			var videoURL string
			var otherReason string
			var preConsumedQuota int
			if l.Other != "" {
				var otherData struct {
					TaskID           string `json:"task_id"`
					Reason           string `json:"reason"`
					PreConsumedQuota int    `json:"pre_consumed_quota"`
					ActualQuota      int    `json:"actual_quota"`
				}
				if json.Unmarshal([]byte(l.Other), &otherData) == nil {
					if otherData.TaskID != "" {
						taskID = otherData.TaskID
					}
					if otherData.Reason != "" {
						otherReason = otherData.Reason
					}
					preConsumedQuota = otherData.PreConsumedQuota
				}
			}

		lowerModel := strings.ToLower(l.ModelName)
		isVideo := strings.Contains(lowerModel, "video") ||
			strings.Contains(lowerModel, "seedance") ||
			strings.Contains(lowerModel, "kling") ||
			strings.Contains(lowerModel, "sora") ||
			strings.Contains(lowerModel, "hailuo") ||
			strings.Contains(lowerModel, "minimax-h3") ||
			strings.Contains(lowerModel, "happyhouse")

		// 检查本地关联任务（严格按任务ID精确对应，严禁时间模糊匹配防串号）
		var localMatched *model.VideoTask
		if taskID != "" {
			if t, exists := localTaskByUpstreamID[taskID]; exists {
				localMatched = &t
			}
		}

		// 计算提交时间与完成时间
		submitTime := l.CreatedAt
		var completeTime int64
		var durationSeconds float64

		if localMatched != nil {
			if localMatched.VideoURL != "" {
				videoURL = localMatched.VideoURL
			}
			if t, err := time.Parse(time.RFC3339, localMatched.CompletedAt); err == nil && t.Unix() > 0 {
				completeTime = t.Unix()
			}
		}

		if completeTime > 0 && completeTime >= submitTime {
			durationSeconds = float64(completeTime - submitTime)
		} else if l.UseTime > 0 {
			durationSeconds = float64(l.UseTime) / 1000.0
			completeTime = submitTime + int64(durationSeconds)
		} else {
			completeTime = submitTime
			durationSeconds = 0
		}

		if isVideo && taskID != "" && videoURL == "" {
			videoURL = fmt.Sprintf("https://api.xybcloud.com/v1/videos/%s/content?key=%s", taskID, token)
		}

			taskAction := parseTaskAction(l.ModelName, l.Content, isVideo)
			if preConsumedQuota > 0 && l.Type == 2 {
				taskAction = "差额补扣"
			}

			// 判定任务状态与展示文案（彻底纠正免扣误解）
			status := "success"
			statusLabel := "成功"
			if preConsumedQuota > 0 && l.Type == 2 {
				statusLabel = "差额补扣"
			}
			progress := 100
		errMsg := ""
		errDetail := ""
		formattedPoints := formatBillingPoints(pointsCost)

		if l.Type == 5 {
			// Type 5: failed; preserve charged quota when present.
			status = "failed"
			statusLabel = consumptionStatusLabel(l.Type, l.Quota, "")
			progress = 100
			errMsg, errDetail = parseErrorMessage(l.Content, l.Other)
			if l.Quota == 0 {
				pointsCost = 0
				moneyYuan = 0
				formattedPoints = "0.00 积分"
				statusLabel = "调用失败 · 未扣费"
			} else {
				statusLabel = "调用失败 · 存在扣费记录"
				formattedPoints = formatBillingPoints(pointsCost)
			}
		} else if l.Type == 6 {
			// Type 6: refund/adjustment; do not claim failure unless confirmed.
			status = "refunded"
			localStatus := ""
			if localMatched != nil {
				localStatus = localMatched.Status
			}
			statusLabel = consumptionStatusLabel(l.Type, l.Quota, localStatus)
			progress = 100
			if otherReason != "" {
				errMsg = otherReason
				errDetail = otherReason
			} else {
				errMsg, errDetail = parseErrorMessage(l.Content, l.Other)
			}
			formattedPoints = "+" + formatBillingPoints(pointsCost)
		} else if l.Type == 2 {
			if l.Quota == 0 {
				// 消费类型但扣费为 0：检查是否有错误
				if strings.Contains(l.Content, "error") || strings.Contains(l.Content, "status_code=") {
					status = "failed"
					statusLabel = "调用失败 · 未扣费"
					errMsg, errDetail = parseErrorMessage(l.Content, l.Other)
					formattedPoints = "0.00 积分"
				} else {
					status = "free"
					statusLabel = "免费体验"
					formattedPoints = "0.00 积分"
				}
			}
		}

		logs = append(logs, ConsumptionLogItem{
			ID:                l.ID,
			CreatedAt:         l.CreatedAt,
			SubmitTime:        submitTime,
			CompleteTime:      completeTime,
			ModelName:         l.ModelName,
			Type:              l.Type,
			Status:            status,
			StatusLabel:       statusLabel,
			Progress:          progress,
			DurationSeconds:   durationSeconds,
			TaskID:            taskID,
			TaskAction:        taskAction,
			VideoURL:          videoURL,
			Quota:             l.Quota,
			PointsCost:        pointsCost,
			FormattedPoints:   formattedPoints,
			MoneyYuan:         moneyYuan,
			FormattedMoney:    formatBillingMoney(moneyYuan),
			PromptTokens:      l.PromptTokens,
			CompletionTokens:  l.CompletionTokens,
			UseTime:           l.UseTime,
			IsStream:          l.IsStream,
			ErrorMessage:      errMsg,
			ErrorDetail:       errDetail,
			RequestID:         l.RequestID,
			UpstreamRequestID: l.UpstreamRequestID,
		})
	}

	return logs, nil
}

type RechargeLogItem struct {
	ID              int     `json:"id"`
	TradeNo         string  `json:"trade_no"`
	Amount          int64   `json:"amount"`
	Money           float64 `json:"money"`
	Points          float64 `json:"points"`
	FormattedMoney  string  `json:"formatted_money"`
	FormattedPoints string  `json:"formatted_points"`
	PaymentMethod   string  `json:"payment_method"`
	PaymentName     string  `json:"payment_name"`
	Status          string  `json:"status"`
	StatusLabel     string  `json:"status_label"`
	CreateTime      int64   `json:"create_time"`
	CompleteTime    int64   `json:"complete_time"`
}

// FetchUserRechargeLogs 获取用户在线充值流水记录（本地订单与中转站双向融合）
func FetchUserRechargeLogs(userID string) ([]RechargeLogItem, error) {
	// 1. 读取本地持久化的充值订单
	localOrders, _ := repository.ListRechargeOrdersByUserID(userID, 100)

	// 对近期未完成的待支付订单自动补查状态
	for i := range localOrders {
		if localOrders[i].Status == "pending" && time.Now().Unix()-localOrders[i].CreatedAt < 86400 {
			if st, err := CheckRechargeOrderStatus(localOrders[i].TradeNo); err == nil {
				if paid, ok := st["paid"].(bool); ok && paid {
					localOrders[i].Status = "success"
					localOrders[i].StatusLabel = "充值成功"
					localOrders[i].CompletedAt = time.Now().Unix()
					_ = repository.UpdateRechargeOrderStatus(localOrders[i].TradeNo, "success", "充值成功", localOrders[i].CompletedAt)
				}
			}
		}
	}

	orderMap := make(map[string]RechargeLogItem)
	for _, ord := range localOrders {
		orderMap[ord.TradeNo] = RechargeLogItem{
			ID:              0,
			TradeNo:         ord.TradeNo,
			Amount:          ord.Amount,
			Money:           ord.Money,
			Points:          ord.Points,
			FormattedMoney:  fmt.Sprintf("¥ %.2f", ord.Money),
			FormattedPoints: fmt.Sprintf("+%.1f 积分", ord.Points),
			PaymentMethod:   ord.PaymentMethod,
			PaymentName:     ord.PaymentName,
			Status:          ord.Status,
			StatusLabel:     ord.StatusLabel,
			CreateTime:      ord.CreatedAt,
			CompleteTime:    ord.CompletedAt,
		}
	}

	// 2. 尝试从中转站拉取该 Token 的充值日志
	token := GetUserExclusiveNewAPIToken(userID)
	if token != "" {
		client := &http.Client{Timeout: 8 * time.Second}
		req, err := http.NewRequest(http.MethodGet, getNewAPIBaseURL()+"/api/user/topup-by-token?size=100", nil)
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Host", "api.xybcloud.com")
			if resp, err := client.Do(req); err == nil {
				defer resp.Body.Close()
				var res struct {
					Success bool `json:"success"`
					Data    struct {
						Items []struct {
							ID            int     `json:"id"`
							UserId        int     `json:"user_id"`
							Amount        int64   `json:"amount"`
							Money         float64 `json:"money"`
							TradeNo       string  `json:"trade_no"`
							PaymentMethod string  `json:"payment_method"`
							Status        string  `json:"status"`
							CreateTime    int64   `json:"create_time"`
							CompleteTime  int64   `json:"complete_time"`
						} `json:"items"`
						Total int `json:"total"`
					} `json:"data"`
				}
				if json.NewDecoder(resp.Body).Decode(&res) == nil && res.Success {
					for _, item := range res.Data.Items {
						payMoney := item.Money
						if payMoney <= 0 {
							payMoney = float64(item.Amount)
						}
						points := payMoney * 10.0 // 1 元 = 10 积分

						paymentName := "微信支付"
						if strings.Contains(strings.ToLower(item.PaymentMethod), "ali") {
							paymentName = "支付宝"
						}

						statusLabel := "充值成功"
						if item.Status == "pending" {
							statusLabel = "待支付"
						} else if item.Status == "failed" || item.Status == "failure" {
							statusLabel = "支付失败"
						}

						orderMap[item.TradeNo] = RechargeLogItem{
							ID:              item.ID,
							TradeNo:         item.TradeNo,
							Amount:          item.Amount,
							Money:           payMoney,
							Points:          points,
							FormattedMoney:  fmt.Sprintf("¥ %.2f", payMoney),
							FormattedPoints: fmt.Sprintf("+%.1f 积分", points),
							PaymentMethod:   item.PaymentMethod,
							PaymentName:     paymentName,
							Status:          item.Status,
							StatusLabel:     statusLabel,
							CreateTime:      item.CreateTime,
							CompleteTime:    item.CompleteTime,
						}
					}
				}
			}
		}
	}

	result := make([]RechargeLogItem, 0, len(orderMap))
	for _, it := range orderMap {
		result = append(result, it)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].CreateTime > result[j].CreateTime
	})

	return result, nil
}

// CreateWeChatRechargeOrder 在工作台为用户创建微信官方直连充值订单
func CreateWeChatRechargeOrder(userID string, amount int) (map[string]any, error) {
	if amount < 1 {
		return nil, errors.New("充值金额不能小于 1 元")
	}

	newApiUID := GetUserNewAPIID(userID)
	if newApiUID <= 0 {
		token := GetUserExclusiveNewAPIToken(userID)
		if token != "" {
			client := &http.Client{Timeout: 3 * time.Second}
			qReq, _ := http.NewRequest(http.MethodGet, getNewAPIBaseURL()+"/api/user/quota-by-token", nil)
			if qReq != nil {
				qReq.Header.Set("Authorization", "Bearer "+token)
				qReq.Header.Set("Host", "api.xybcloud.com")
				if qResp, qErr := client.Do(qReq); qErr == nil {
					defer qResp.Body.Close()
					var qData struct {
						Success bool `json:"success"`
						Data    struct {
							UserID int `json:"user_id"`
						} `json:"data"`
					}
					if json.NewDecoder(qResp.Body).Decode(&qData) == nil && qData.Success && qData.Data.UserID > 0 {
						newApiUID = qData.Data.UserID
						// 自动回写至用户 Extra，免除后续重复查询
						if u, uOk, _ := repository.GetUserByID(userID); uOk {
							var ex UserExtraInfo
							_ = json.Unmarshal([]byte(u.Extra), &ex)
							ex.NewAPIUserID = newApiUID
							exBytes, _ := json.Marshal(ex)
							u.Extra = string(exBytes)
							_, _ = repository.SaveUser(u)
						}
					}
				}
			}
		}
	}
	if newApiUID <= 0 {
		return nil, errors.New("未能识别您的专属中转站账户，请重新登录后再发起充值")
	}

	tradeNo := fmt.Sprintf("USR%dNO%s%d", newApiUID, uuid.NewString()[:6], time.Now().Unix())
	moneyStr := fmt.Sprintf("%d.00", amount)
	orderName := fmt.Sprintf("AI算力充值%d元", amount)

	params := map[string]string{
		"pid":          epayMerchantID,
		"type":         "wxpay",
		"out_trade_no": tradeNo,
		"notify_url":   "https://api.xybcloud.com/api/user/epay/notify",
		"return_url":   "https://www.xybcloud.com/canvas",
		"name":         orderName,
		"money":        moneyStr,
	}

	// 计算易支付 MD5 签名
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var buf bytes.Buffer
	for i, k := range keys {
		if i > 0 {
			buf.WriteByte('&')
		}
		buf.WriteString(k)
		buf.WriteByte('=')
		buf.WriteString(params[k])
	}
	buf.WriteString(epayMerchantKey)

	hasher := md5.New()
	hasher.Write(buf.Bytes())
	sign := hex.EncodeToString(hasher.Sum(nil))

	params["sign"] = sign
	params["sign_type"] = "MD5"

	// 请求支付网关下单接口
	formValues := url.Values{}
	for k, v := range params {
		formValues.Set(k, v)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.PostForm(getEpayGatewayURL()+"/mapi.php", formValues)
	if err != nil {
		return nil, fmt.Errorf("请求支付网关失败: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var res struct {
		Code      int    `json:"code"`
		Msg       string `json:"msg"`
		TradeNo   string `json:"trade_no"`
		QRCode    string `json:"qrcode"`
		PayURL    string `json:"payurl"`
		URLScheme string `json:"urlscheme"`
	}

	if err := json.Unmarshal(body, &res); err != nil || res.Code != 1 {
		return nil, fmt.Errorf("微信支付统一下单失败: %s", string(body))
	}

	// 本地持久化保存该笔充值订单
	localOrder := model.RechargeOrder{
		ID:            "ord-" + uuid.NewString(),
		UserID:        userID,
		TradeNo:       res.TradeNo,
		Amount:        int64(amount),
		Money:         float64(amount),
		Points:        float64(amount) * 10.0,
		PaymentMethod: "wxpay",
		PaymentName:   "微信支付",
		Status:        "pending",
		StatusLabel:   "待支付",
		QRCode:        res.QRCode,
		PayURL:        res.PayURL,
		OrderName:     orderName,
		CreatedAt:     time.Now().Unix(),
		CompletedAt:   0,
	}
	_ = repository.SaveRechargeOrder(localOrder)

	return map[string]any{
		"trade_no":  res.TradeNo,
		"qrcode":    res.QRCode,
		"payurl":    res.PayURL,
		"amount":    amount,
		"orderName": orderName,
	}, nil
}

// CheckRechargeOrderStatus 检查充值订单支付状态
func CheckRechargeOrderStatus(tradeNo string) (map[string]any, error) {
	tradeNo = strings.TrimSpace(tradeNo)
	if tradeNo == "" {
		return nil, errors.New("订单号不能为空")
	}

	client := &http.Client{Timeout: 5 * time.Second}
	statusURL := fmt.Sprintf("%s/api/order/status?trade_no=%s", getEpayGatewayURL(), url.QueryEscape(tradeNo))

	resp, err := client.Get(statusURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var res struct {
		Status    int    `json:"status"`
		ReturnURL string `json:"return_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}

	isPaid := res.Status == 1
	if isPaid {
		_ = repository.UpdateRechargeOrderStatus(tradeNo, "success", "充值成功", time.Now().Unix())
	}

	return map[string]any{
		"paid":   isPaid,
		"status": res.Status,
	}, nil
}
