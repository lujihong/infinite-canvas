package service

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestAICCUploadProxyPreservesMultipartAndDedicatedCredential(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("groupId", "group-owned")
	_ = writer.WriteField("assetType", "Image")
	part, err := writer.CreateFormFile("file", "photo.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("sample-media"))
	_ = writer.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/aicc/uploads" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer sk-user-a" {
			t.Error("wrong upload identity/path")
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		if r.FormValue("groupId") != "group-owned" {
			t.Error("lost group")
		}
		f, _, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		content, _ := io.ReadAll(f)
		if string(content) != "sample-media" {
			t.Error("file changed")
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"url":"https://example.test/signed"}}`))
	}))
	defer upstream.Close()
	data, status, err := aiccRelayRequestContent(context.Background(), upstream.URL+"/v1", "user-a", "POST", "uploads", nil, &body, writer.FormDataContentType())
	if err != nil || status != 200 || !strings.Contains(string(data), `"success":true`) {
		t.Fatal(status, err, string(data))
	}
}

func TestAICCRequiresExclusiveIdentityEvenForAdmin(t *testing.T) {
	for _, role := range []model.UserRole{model.UserRoleUser, model.UserRoleAdmin} {
		for _, extra := range []string{"", `{}`, `{"newapi_token":"shared"}`, `{"newapi_user_id":3}`} {
			if _, err := aiccUserToken(model.User{Role: role, Status: model.UserStatusActive, Extra: extra}); err == nil {
				t.Fatal("accepted incomplete identity", role)
			}
		}
	}
	a, err := aiccUserToken(model.User{Status: model.UserStatusActive, Extra: `{"newapi_user_id":1,"newapi_token":"user-a"}`})
	if err != nil || a != "user-a" {
		t.Fatal("valid identity rejected")
	}
	b, err := aiccUserToken(model.User{Status: model.UserStatusActive, Extra: `{"newapi_user_id":2,"newapi_token":"user-b"}`})
	if err != nil || a == b {
		t.Fatal("identities collapsed")
	}
	if _, err := aiccUserToken(model.User{Status: model.UserStatusBan, Extra: `{"newapi_user_id":2,"newapi_token":"user-b"}`}); err == nil {
		t.Fatal("banned identity accepted")
	}
}

func TestAICCProxyPreservesStatusAndNeverFollowsRedirect(t *testing.T) {
	leaked := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer destination.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-user-a" {
			t.Error("wrong user credential")
		}
		if r.URL.Path != "/api/aicc/assets" {
			t.Error("incorrect API path", r.URL.Path)
		}
		if r.URL.Query().Get("pageNo") == "2" {
			w.Header().Set("Location", destination.URL)
			w.WriteHeader(302)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{"success":false,"message":"upstream unavailable"}`))
	}))
	defer upstream.Close()
	data, status, err := aiccRelayRequest(context.Background(), upstream.URL+"/v1", "user-a", "GET", "assets", url.Values{}, nil)
	if err != nil || status != 503 || !strings.Contains(string(data), "upstream unavailable") {
		t.Fatal("lost upstream failure", status, err)
	}
	_, status, err = aiccRelayRequest(context.Background(), upstream.URL, "user-a", "GET", "assets", url.Values{"pageNo": []string{"2"}}, nil)
	if err == nil || status != 502 || leaked {
		t.Fatal("redirect credential boundary failed")
	}
}
