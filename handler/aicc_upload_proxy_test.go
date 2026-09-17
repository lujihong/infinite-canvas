package handler

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestAICCUploadHandlerPreservesFileAndRejectsUnboundIdentity(t *testing.T) {
	previous := config.Cfg
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "aicc-upload.db")
	t.Cleanup(func() { config.Cfg = previous })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range []model.User{
		{ID: "aicc-upload-a", Username: "aicc-upload-a", Status: model.UserStatusActive, Extra: `{"newapi_user_id":42,"newapi_token":"test-exclusive-a"}`},
		{ID: "aicc-upload-unbound", Username: "aicc-upload-unbound", Status: model.UserStatusActive},
	} {
		u.AffCode = u.ID
		if err := db.Create(&u).Error; err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { db.Where("id IN ?", []string{"aicc-upload-a", "aicc-upload-unbound"}).Delete(&model.User{}) })
	temporary := t.TempDir()
	t.Setenv("TMPDIR", temporary)
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer sk-test-exclusive-a" || r.URL.Path != "/api/aicc/uploads" {
			t.Error("identity or path changed")
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		f, _, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		data, _ := io.ReadAll(f)
		if string(data) != "file-content" || r.FormValue("groupId") != "group-a" {
			t.Error("multipart corrupted")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"id":"temporary"}}`))
	}))
	defer upstream.Close()
	t.Setenv("NEWAPI_BASE_URL", upstream.URL)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("groupId", "group-a")
	_ = writer.WriteField("assetType", "Image")
	part, err := writer.CreateFormFile("file", "test.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("file-content"))
	_ = writer.Close()
	for _, tc := range []struct {
		id   string
		want int
	}{{"aicc-upload-a", 200}, {"aicc-upload-unbound", 403}} {
		req := httptest.NewRequest("POST", "/api/aicc/uploads", bytes.NewReader(body.Bytes()))
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req = req.WithContext(service.WithUser(req.Context(), model.AuthUser{ID: tc.id}))
		recorder := httptest.NewRecorder()
		AICCProxy(recorder, req)
		if recorder.Code != tc.want {
			t.Fatalf("%s status=%d body=%s", tc.id, recorder.Code, recorder.Body.String())
		}
	}
	if calls != 1 {
		t.Fatal("unbound identity reached upstream", calls)
	}
	files, err := os.ReadDir(temporary)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasPrefix(f.Name(), "xyb-aicc-upload-") {
			t.Fatal("sensitive temporary upload not removed")
		}
	}
}
