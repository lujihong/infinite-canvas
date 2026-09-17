package handler

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAICCUploadOnlyAcceptsPost(t *testing.T) {
	if !validAICCOperation("POST", "uploads") {
		t.Fatal("upload route absent")
	}
	for _, method := range []string{"GET", "PUT", "DELETE", "HEAD"} {
		if validAICCOperation(method, "uploads") {
			t.Fatal("unsafe upload method", method)
		}
	}
	for _, path := range []string{"upload-content/secret", "uploads/../admin", "admin/assets"} {
		if validAICCOperation("POST", path) || validAICCOperation("GET", path) {
			t.Fatal("unsafe path", path)
		}
	}
}

func TestAICCProxyOperationAllowlist(t *testing.T) {
	for _, p := range []string{"assets", "asset-groups"} {
		if !validAICCOperation("GET", p) || !validAICCOperation("POST", p) || !validAICCOperation("DELETE", p+"/asset-test") {
			t.Fatal("valid operation rejected")
		}
	}
	for _, p := range []string{"admin/recover-group", "assets/../channels", "assets/%2e%2e", "assets/a/b", "assets/a?host=x", "auth/session/stolen", "http://example.com", "../option"} {
		if validAICCOperation("GET", p) || validAICCOperation("POST", p) || validAICCOperation("DELETE", p) {
			t.Fatal("unsafe operation allowed", p)
		}
	}
	if validAICCOperation("DELETE", "assets") || validAICCOperation("GET", "auth/session") {
		t.Fatal("unexpected method allowed")
	}
}

func TestAICCVideoIdentityGateDetectsJSONAndMultipart(t *testing.T) {
	for _, body := range []string{`{"image":"asset://asset-one"}`, `{"metadata":"{\"content\":[{\"image_url\":{\"url\":\"asset://asset-one\"}}]}"}`, `{"asset_id":"asset-one"}`} {
		found, err := hasAICCVideoReference([]byte(body), "application/json")
		if err != nil || !found {
			t.Fatal("missed JSON reference", err)
		}
	}
	found, err := hasAICCVideoReference([]byte(`{"prompt":"explain asset://asset-one","image":"https://example.com/photo.png"}`), "application/json")
	if err != nil || found {
		t.Fatal("prompt is not an asset reference")
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	_ = writer.WriteField("input_reference[]", "asset://asset-one")
	_ = writer.Close()
	found, err = hasAICCVideoReference(buffer.Bytes(), writer.FormDataContentType())
	if err != nil || !found {
		t.Fatal("missed multipart reference", err)
	}
}

func TestAICCProxyRejectsAnonymous(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/aicc/assets", nil)
	w := httptest.NewRecorder()
	AICCProxy(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatal("anonymous access permitted", w.Code)
	}
}
