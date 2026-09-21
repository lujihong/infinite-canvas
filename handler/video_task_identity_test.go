package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "canvas-handler-test-")
	if err != nil {
		panic(err)
	}
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(dir, "test.db")
	db, err := repository.DB()
	if err != nil {
		panic(err)
	}
	code := m.Run()
	if sqlDB, err := db.DB(); err == nil {
		_ = sqlDB.Close()
	}
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func TestVideoTaskFrozenIdentity(t *testing.T) {
	previous := config.Cfg
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "video-identity.db")
	t.Cleanup(func() { config.Cfg = previous })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "video-identity", Username: "video-identity", AffCode: "video-identity", Status: model.UserStatusActive, Role: model.UserRoleAdmin, Credits: 100, Extra: `{"newapi_user_id":42,"newapi_token":"original-token"}`}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Where("user_id = ?", user.ID).Delete(&model.VideoTask{})
		db.Where("user_id = ?", user.ID).Delete(&model.UserConfig{})
		db.Where("id = ?", user.ID).Delete(&model.User{})
	})
	var officialCalls, wrongCalls atomic.Int32
	wrong := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { wrongCalls.Add(1); http.Error(w, "wrong identity", 500) }))
	defer wrong.Close()
	var mutateOnSubmit atomic.Bool
	var expectedToken atomic.Value
	expectedToken.Store("Bearer original-token")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		officialCalls.Add(1)
		if r.Header.Get("Authorization") != expectedToken.Load().(string) {
			t.Errorf("wrong credential: %q", r.Header.Get("Authorization"))
		}
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/videos":
			if mutateOnSubmit.Load() {
				if err := db.Model(&model.User{}).Where("id = ?", user.ID).Update("extra", `{"newapi_user_id":99,"newapi_token":"other-token"}`).Error; err != nil {
					t.Error(err)
				}
				if err := os.Setenv("NEWAPI_BASE_URL", wrong.URL); err != nil {
					t.Error(err)
				}
			}
			fmt.Fprint(w, `{"id":"upstream-task","status":"queued"}`)
		case r.URL.Path == "/v1/videos/upstream-task/content":
			w.Header().Set("Content-Type", "video/mp4")
			fmt.Fprint(w, "video-bytes")
		case r.URL.Path == "/v1/videos/upstream-task":
			fmt.Fprint(w, `{"id":"upstream-task","status":"processing","progress":30}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	t.Setenv("NEWAPI_BASE_URL", upstream.URL)
	saveLocal := func(id string) {
		t.Helper()
		data, _ := json.Marshal(map[string]any{"localChannels": []model.ModelChannel{{ID: id, BaseURL: wrong.URL, APIKey: "local-secret", Models: []string{"seedance-2.0"}}}})
		if _, err := repository.SaveUserConfig(model.UserConfig{UserID: user.ID, ModelConfig: string(data)}); err != nil {
			t.Fatal(err)
		}
	}
	saveLocal("local-first")
	setBinding := func(extra string) {
		t.Helper()
		if err := db.Model(&model.User{}).Where("id = ?", user.ID).Update("extra", extra).Error; err != nil {
			t.Fatal(err)
		}
	}
	request := func(method, path string) *http.Request {
		req := httptest.NewRequest(method, path, strings.NewReader(`{"model":"seedance-2.0","prompt":"test"}`))
		req.Header.Set("Content-Type", "application/json")
		return req.WithContext(service.WithUser(req.Context(), model.AuthUser{ID: user.ID, Role: user.Role}))
	}
	// The upstream changes both binding and environment before returning: snapshot must already be frozen.
	mutateOnSubmit.Store(true)
	rec := httptest.NewRecorder()
	proxyAIVideoTaskRequest(rec, request("POST", "/videos"))
	task, found, err := repository.GetUserVideoTask(user.ID, "upstream-task")
	if err != nil || !found {
		t.Fatalf("creation failed: %v %s", err, rec.Body.String())
	}
	if task.SourceKind != service.VideoTaskSourceOfficial || task.GatewayUserID != "42" || task.GatewayBaseURL != upstream.URL || task.ChannelIdentity != "xyb-official-exclusive" {
		t.Fatalf("snapshot captured too late: %+v", task)
	}
	encoded, _ := json.Marshal(task)
	if strings.Contains(string(encoded), "token") || strings.Contains(string(encoded), "local-secret") {
		t.Fatal("credential persisted in task")
	}
	task.Credits = 9
	if _, err := repository.SaveVideoTask(task); err != nil {
		t.Fatal(err)
	}
	assertBlocked := func(name string, candidate model.VideoTask) {
		t.Helper()
		before := officialCalls.Load()
		_, err := pollVideoTaskFromUpstream(candidate)
		if err == nil {
			t.Fatalf("%s poll accepted changed identity", name)
		}
		if err := service.UpdateVideoTaskFromPoll(candidate, service.VideoTaskPollUpdate{Status: candidate.Status, ErrorDetail: err.Error()}); err != nil {
			t.Fatal(err)
		}
		saved, _, err := repository.GetUserVideoTask(user.ID, candidate.ID)
		if err != nil || saved.Status != candidate.Status || saved.Credits != 9 {
			t.Fatalf("%s changed task status or refunded: %+v %v", name, saved, err)
		}
		response := service.VideoTaskResponse(saved)
		detail, ok := response["error"].(map[string]any)
		if !ok || detail["recoverable"] != true || response["status"] != candidate.Status {
			t.Fatalf("%s API hides recoverable error: %+v", name, response)
		}
		rec := httptest.NewRecorder()
		AIVideoContent(rec, request("GET", "/videos/"+candidate.ID+"/content"), candidate.ID)
		if rec.Code != http.StatusConflict {
			t.Fatalf("%s content accepted: %d %s", name, rec.Code, rec.Body.String())
		}
		if officialCalls.Load() != before || wrongCalls.Load() != 0 {
			t.Fatalf("%s invalid identity reached upstream", name)
		}
		current, _, _ := repository.GetUserByID(user.ID)
		if current.Credits != 100 {
			t.Fatal("configuration error refunded credits")
		}
	}
	assertBlocked("changed during submit", task)
	t.Setenv("NEWAPI_BASE_URL", upstream.URL)
	assertBlocked("changed binding", task)
	setBinding(`{"newapi_user_id":42,"newapi_token":"rotated-token"}`)
	expectedToken.Store("Bearer rotated-token")
	saveLocal("different-local-first")
	update, err := pollVideoTaskFromUpstream(task)
	if err != nil || update.Status != "processing" {
		t.Fatalf("same identity rotation failed: %+v %v", update, err)
	}
	rec = httptest.NewRecorder()
	AIVideoContent(rec, request("GET", "/videos/"+task.ID+"/content"), task.ID)
	if rec.Code != 200 || rec.Body.String() != "video-bytes" {
		t.Fatalf("non-Gemini download failed: %d %s", rec.Code, rec.Body.String())
	}
	t.Setenv("NEWAPI_BASE_URL", wrong.URL)
	assertBlocked("changed base URL", task)
	t.Setenv("NEWAPI_BASE_URL", upstream.URL)
	setBinding(`{}`)
	assertBlocked("unbound admin with local channel", task)
	setBinding(`{"newapi_user_id":42,"newapi_token":"rotated-token"}`)
	legacy := task
	legacy.SourceKind = ""
	legacy.GatewayUserID = ""
	legacy.GatewayBaseURL = ""
	legacy.ChannelIdentity = ""
	assertBlocked("legacy without snapshot", legacy)
	if wrongCalls.Load() != 0 {
		t.Fatal("fallback upstream used")
	}
	// A vendor result URL cannot turn the content proxy into a credential forwarder.
	gemini := model.ModelChannel{ID: "gemini-local", BaseURL: upstream.URL, Protocol: "gemini", APIKey: "private-gemini-key", Enabled: true, Models: []string{"seedance-2.0"}}
	data, _ := json.Marshal(map[string]any{"localChannels": []model.ModelChannel{gemini}})
	if _, err := repository.SaveUserConfig(model.UserConfig{UserID: user.ID, ModelConfig: string(data)}); err != nil {
		t.Fatal(err)
	}
	_, snapshot, err := service.CaptureVideoTaskChannel(user.ID, gemini, gemini.ID)
	if err != nil {
		t.Fatal(err)
	}
	unsafe := task
	unsafe.ID = "foreign-video"
	unsafe.ChannelID, unsafe.UserChannelID = gemini.ID, gemini.ID
	unsafe.SourceKind, unsafe.ChannelIdentity = snapshot.SourceKind, snapshot.ChannelIdentity
	unsafe.GatewayBaseURL, unsafe.GatewayUserID = snapshot.GatewayBaseURL, snapshot.GatewayUserID
	unsafe.ChannelFingerprint = snapshot.ChannelFingerprint
	unsafe.VideoURL = wrong.URL + "/download.mp4"
	if _, err := repository.SaveVideoTask(unsafe); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	AIVideoContent(rec, request("GET", "/videos/foreign-video/content"), unsafe.ID)
	if rec.Code != http.StatusConflict || wrongCalls.Load() != 0 {
		t.Fatalf("external URL received credentials: %d calls=%d", rec.Code, wrongCalls.Load())
	}
}
