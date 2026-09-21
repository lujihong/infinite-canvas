package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

var ErrAICCBindingRequired = errors.New("当前账号尚未绑定专属中转站身份，请重新登录鑫元宝账号后再使用人物素材")

func aiccUserToken(user model.User) (string, error) {
	var extra UserExtraInfo
	if user.Status != model.UserStatusActive || json.Unmarshal([]byte(user.Extra), &extra) != nil || extra.NewAPIUserID <= 0 || strings.TrimSpace(extra.NewAPIToken) == "" {
		return "", ErrAICCBindingRequired
	}
	return strings.TrimSpace(extra.NewAPIToken), nil
}

// AICCVideoChannel uses the same identity and relay as the asset library.
func AICCVideoChannel(userID string) (model.ModelChannel, error) {
	token, err := AICCUserToken(userID)
	if err != nil {
		return model.ModelChannel{}, err
	}
	return model.ModelChannel{ID: "xyb-official-exclusive", Protocol: "openai", Name: "鑫元宝官方模型服务", BaseURL: getNewAPIBaseURL(), APIKey: token, Models: []string{"*"}, Timeout: 600, Enabled: true}, nil
}

// Unlike the general channel selector, AICC must never fall back to shared keys.
func AICCUserToken(userID string) (string, error) {
	user, found, err := repository.GetUserByID(userID)
	if err != nil || !found {
		return "", ErrAICCBindingRequired
	}
	return aiccUserToken(user)
}

func AICCRequest(ctx context.Context, userID, method, path string, query url.Values, body io.Reader) ([]byte, int, error) {
	token, err := AICCUserToken(userID)
	if err != nil {
		return nil, http.StatusForbidden, err
	}
	return aiccRelayRequest(ctx, getNewAPIBaseURL(), token, method, path, query, body)
}

// AICCUploadRequest keeps uploads on the same dedicated identity as the asset API.
func AICCUploadRequest(ctx context.Context, userID, contentType string, query url.Values, body io.Reader) ([]byte, int, error) {
	token, err := AICCUserToken(userID)
	if err != nil {
		return nil, http.StatusForbidden, err
	}
	return aiccRelayRequestContent(ctx, getNewAPIBaseURL(), token, http.MethodPost, "uploads", query, body, contentType)
}

func aiccRelayRequest(ctx context.Context, base, token, method, path string, query url.Values, body io.Reader) ([]byte, int, error) {
	return aiccRelayRequestContent(ctx, base, token, method, path, query, body, "application/json")
}

func aiccRelayRequestContent(ctx context.Context, base, token, method, path string, query url.Values, body io.Reader, contentType string) ([]byte, int, error) {
	target, err := url.Parse(base)
	if err != nil || target.Host == "" || target.User != nil || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, http.StatusBadGateway, errors.New("人物素材服务地址配置异常")
	}
	target.Path = strings.TrimSuffix(strings.TrimRight(target.Path, "/"), "/v1") + "/api/aicc/" + path
	target.RawPath, target.Fragment = "", ""
	target.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, http.StatusBadGateway, errors.New("人物素材请求构建失败")
	}
	if !strings.HasPrefix(token, "sk-") {
		token = "sk-" + token
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)
	timeout := 30 * time.Second
	if path == "uploads" {
		timeout = 120 * time.Second
	}
	client := &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, errors.New("人物素材服务暂不可用，请稍后重试")
	}
	defer res.Body.Close()
	const maxResponse = 2 << 20
	payload, err := io.ReadAll(io.LimitReader(res.Body, maxResponse+1))
	if err != nil || len(payload) > maxResponse || !json.Valid(payload) || res.StatusCode >= 300 && res.StatusCode < 400 {
		return nil, http.StatusBadGateway, errors.New("人物素材服务返回异常响应")
	}
	return payload, res.StatusCode, nil
}
