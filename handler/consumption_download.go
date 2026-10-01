package handler

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/service"
)

const consumptionDownloadPath = "/api/v1/user/logs/export/download/"
const consumptionCookieName = "consumption-export-proof"

type consumptionDownload struct {
	userID, auth, filename, dir, requestID string
	proof                                  [32]byte
	expires                                time.Time
	timer                                  *time.Timer
}

var consumptionDownloads = struct {
	sync.Mutex
	files map[string]*consumptionDownload
}{files: make(map[string]*consumptionDownload)}

type consumptionGeneration struct {
	cancel context.CancelFunc
	ctx    context.Context
}

var consumptionGenerations = struct {
	sync.Mutex
	items map[[32]byte]consumptionGeneration
}{items: make(map[[32]byte]consumptionGeneration)}

func consumptionRequestKey(auth, id string) [32]byte {
	return sha256.Sum256([]byte(auth + "\x00" + id))
}
func validConsumptionRequestID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for _, c := range id {
		if c != '-' && (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func randomExportID() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func consumptionBearer(r *http.Request) string {
	return strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
}
func registerConsumptionDownload(w http.ResponseWriter, r *http.Request, userID, filename, dir, requestID string) error {
	auth := consumptionBearer(r)
	current, ok := service.CurrentAuthUser(auth)
	if !ok || current.ID != userID {
		return errors.New("登录状态已失效，请重新登录")
	}
	id, err := randomExportID()
	if err != nil {
		return err
	}
	proof, err := randomExportID()
	if err != nil {
		return err
	}
	if !validConsumptionRequestID(requestID) {
		return errors.New("导出请求编号无效")
	}
	entry := &consumptionDownload{userID: userID, auth: auth, filename: filename, dir: dir, requestID: requestID, proof: sha256.Sum256([]byte(proof)), expires: time.Now().Add(2 * time.Minute)}
	consumptionGenerations.Lock()
	defer consumptionGenerations.Unlock()
	generation, exists := consumptionGenerations.items[consumptionRequestKey(auth, requestID)]
	if !exists || generation.ctx.Err() != nil {
		return errors.New("导出已取消")
	}
	consumptionDownloads.Lock()
	// Bound retained disk separately from the generation gate: one file per user, eight total.
	for oldID, old := range consumptionDownloads.files {
		if old.userID == userID {
			delete(consumptionDownloads.files, oldID)
			old.timer.Stop()
			_ = os.RemoveAll(old.dir)
		}
	}
	if len(consumptionDownloads.files) >= 8 {
		consumptionDownloads.Unlock()
		return errors.New("导出下载队列已满，请稍后重试")
	}
	consumptionDownloads.files[id] = entry
	entry.timer = time.AfterFunc(2*time.Minute, func() {
		consumptionDownloads.Lock()
		if consumptionDownloads.files[id] == entry {
			delete(consumptionDownloads.files, id)
			_ = os.RemoveAll(entry.dir)
		}
		consumptionDownloads.Unlock()
	})
	consumptionDownloads.Unlock()
	target := consumptionDownloadPath + id
	secure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{Name: consumptionCookieName, Value: proof, Path: target, HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: 120})
	w.Header().Set("Cache-Control", "private, no-store")
	OK(w, map[string]string{"download_url": target, "file_name": "消费明细.xlsx"})
	return nil
}

// Only a file-scoped, short-lived proof cookie authorizes this route; a URL alone
// or another user's ordinary login cookie cannot retrieve an export.
func DownloadUserConsumptionExport(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != "GET" {
		FailWithStatus(w, http.StatusMethodNotAllowed, "仅允许下载")
		return
	}
	cookie, err := r.Cookie(consumptionCookieName)
	if err != nil {
		FailWithStatus(w, http.StatusUnauthorized, "下载授权无效或已过期")
		return
	}
	given := sha256.Sum256([]byte(cookie.Value))
	consumptionDownloads.Lock()
	entry := consumptionDownloads.files[id]
	if entry == nil || time.Now().After(entry.expires) || subtle.ConstantTimeCompare(given[:], entry.proof[:]) != 1 {
		consumptionDownloads.Unlock()
		FailWithStatus(w, http.StatusUnauthorized, "下载授权无效或已过期")
		return
	}
	delete(consumptionDownloads.files, id)
	entry.timer.Stop()
	consumptionDownloads.Unlock()
	defer os.RemoveAll(entry.dir)
	current, ok := service.CurrentAuthUser(entry.auth)
	if !ok || current.ID != entry.userID {
		FailWithStatus(w, http.StatusUnauthorized, "登录状态已失效")
		return
	}
	f, err := os.Open(entry.filename)
	if err != nil {
		FailWithStatus(w, http.StatusGone, "导出文件已过期，请重新导出")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		FailError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: consumptionCookieName, Value: "", Path: consumptionDownloadPath + id, HttpOnly: true, Secure: cookie.Secure || r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteStrictMode, MaxAge: -1})
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="consumption-logs.xlsx"; filename*=UTF-8''%E6%B6%88%E8%B4%B9%E6%98%8E%E7%BB%86.xlsx`)
	http.ServeContent(w, r, "consumption-logs.xlsx", info.ModTime(), f)
}

func CancelPendingConsumptionExports(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		FailWithStatus(w, http.StatusUnauthorized, "请先登录")
		return
	}
	auth := consumptionBearer(r)
	requestID := r.URL.Query().Get("export_request_id")
	if !validConsumptionRequestID(requestID) {
		FailWithStatus(w, http.StatusBadRequest, "导出请求编号无效")
		return
	}
	consumptionGenerations.Lock()
	if generation, exists := consumptionGenerations.items[consumptionRequestKey(auth, requestID)]; exists {
		generation.cancel()
	}
	consumptionDownloads.Lock()
	for id, entry := range consumptionDownloads.files {
		if entry.userID == user.ID && entry.auth == auth && entry.requestID == requestID {
			delete(consumptionDownloads.files, id)
			entry.timer.Stop()
			_ = os.RemoveAll(entry.dir)
		}
	}
	consumptionDownloads.Unlock()
	consumptionGenerations.Unlock()
	OK(w, true)
}
