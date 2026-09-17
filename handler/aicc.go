package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/service"
)

var aiccPathID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$`)

func validAICCOperation(method, path string) bool {
	if path == "auth/session" || path == "auth/group" || path == "uploads" {
		return method == http.MethodPost
	}
	parts := strings.Split(path, "/")
	if parts[0] != "asset-groups" && parts[0] != "assets" {
		return false
	}
	if len(parts) == 1 {
		return method == http.MethodGet || method == http.MethodPost
	}
	return len(parts) == 2 && aiccPathID.MatchString(parts[1]) && (method == http.MethodGet || method == http.MethodPut || method == http.MethodDelete)
}

func hasAICCVideoReference(body []byte, contentType string) (bool, error) {
	var walk func(any, string) bool
	walk = func(value any, key string) bool {
		if key == "prompt" || key == "text" || key == "negative_prompt" {
			return false
		}
		switch v := value.(type) {
		case string:
			text := strings.TrimSpace(v)
			if strings.HasPrefix(text, "asset://") || strings.HasPrefix(text, "asset-") {
				return true
			}
			if key == "metadata" || key == "content" || key == "element_list" {
				var nested any
				if json.Unmarshal([]byte(text), &nested) == nil {
					return walk(nested, key)
				}
			}
		case []any:
			for _, item := range v {
				if walk(item, key) {
					return true
				}
			}
		case map[string]any:
			for name, item := range v {
				if walk(item, name) {
					return true
				}
			}
		}
		return false
	}
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false, err
	}
	if mediaType == "multipart/form-data" {
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			if part.FileName() != "" {
				_ = part.Close()
				continue
			}
			value, err := io.ReadAll(io.LimitReader(part, 1<<20))
			_ = part.Close()
			if err != nil {
				return false, err
			}
			if walk(string(value), strings.TrimSuffix(part.FormName(), "[]")) {
				return true, nil
			}
		}
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return false, err
	}
	return walk(value, ""), nil
}

var aiccUploadSlots = make(chan struct{}, 4)

// Stage the bounded body on disk, not in memory. A truncated upload must never
// be forwarded as a successful request; the relay performs full media validation.
func aiccUploadProxy(w http.ResponseWriter, r *http.Request, userID string) {
	contentType := r.Header.Get("Content-Type")
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "multipart/form-data" || params["boundary"] == "" || len(params["boundary"]) > 70 {
		FailWithStatus(w, http.StatusBadRequest, "请通过文件上传表单提交素材")
		return
	}
	// Reject unbound users before storing any sensitive media.
	if _, err := service.AICCUserToken(userID); err != nil {
		FailWithStatus(w, http.StatusForbidden, err.Error())
		return
	}
	select {
	case aiccUploadSlots <- struct{}{}:
		defer func() { <-aiccUploadSlots }()
	default:
		FailWithStatus(w, http.StatusTooManyRequests, "上传繁忙，请稍后重试")
		return
	}
	file, err := os.CreateTemp("", "xyb-aicc-upload-*")
	if err != nil {
		FailWithStatus(w, http.StatusInternalServerError, "无法暂存上传文件")
		return
	}
	defer os.Remove(file.Name())
	defer file.Close()
	readController := http.NewResponseController(w)
	_ = readController.SetReadDeadline(time.Now().Add(120 * time.Second))
	defer readController.SetReadDeadline(time.Time{})
	const maxUpload = 51 << 20
	if _, err = io.Copy(file, http.MaxBytesReader(w, r.Body, maxUpload)); err != nil {
		FailWithStatus(w, http.StatusRequestEntityTooLarge, "上传超过限制或传输中断，请重试")
		return
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		FailWithStatus(w, http.StatusInternalServerError, "无法读取上传文件")
		return
	}
	payload, status, err := service.AICCUploadRequest(r.Context(), userID, contentType, file)
	if err != nil {
		FailWithStatus(w, status, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// AICCProxy exposes only the asset API, never arbitrary relay paths or caller-supplied credentials.
func AICCProxy(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		FailWithStatus(w, http.StatusUnauthorized, "请先登录")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/aicc/")
	if !validAICCOperation(r.Method, path) {
		FailWithStatus(w, http.StatusNotFound, "人物素材接口不存在")
		return
	}
	if path == "uploads" {
		aiccUploadProxy(w, r, user.ID)
		return
	}
	query := url.Values{}
	for _, key := range []string{"pageNo", "pageSize", "groupType", "groupName", "groupIds", "groupIds[]", "assetName", "statuses", "statuses[]"} {
		for _, v := range r.URL.Query()[key] {
			query.Add(key, v)
		}
	}
	const maxBody = 1 << 20
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		FailWithStatus(w, http.StatusRequestEntityTooLarge, "人物素材请求过大")
		return
	}
	if len(body) > 0 && !json.Valid(body) {
		FailWithStatus(w, http.StatusBadRequest, "请求必须为JSON")
		return
	}
	payload, status, err := service.AICCRequest(r.Context(), user.ID, r.Method, path, query, bytes.NewReader(body))
	if err != nil {
		FailWithStatus(w, status, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
