package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func withConsumptionFixture(t *testing.T, handle func(http.ResponseWriter, *http.Request)) string {
	t.Helper()
	old := config.Cfg
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "iterator.db")
	t.Cleanup(func() { config.Cfg = old })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	id := "iterator-" + t.Name()
	user := model.User{ID: id, Username: id, AffCode: id, Status: model.UserStatusActive, Role: model.UserRoleUser, Extra: `{"newapi_user_id":101,"newapi_token":"iterator-owned-token"}`}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Where("id = ?", id).Delete(&model.User{}) })
	systemStatusMu.Lock()
	oldCache := systemStatusCache
	systemStatusCache = newAPISystemStatusCache{}
	systemStatusMu.Unlock()
	t.Cleanup(func() { systemStatusMu.Lock(); systemStatusCache = oldCache; systemStatusMu.Unlock() })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/status" {
			fmt.Fprint(w, `{"success":true,"data":{"quota_per_unit":500000,"usd_exchange_rate":1}}`)
			return
		}
		if r.URL.Path != "/api/log/token/page" {
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		if r.Header.Get("Authorization") != "Bearer iterator-owned-token" {
			t.Error("wrong account token")
		}
		handle(w, r)
	}))
	t.Cleanup(server.Close)
	t.Setenv("NEWAPI_BASE_URL", server.URL)
	return id
}

func TestConsumptionIteratorMultiplePagesAndCallbackStop(t *testing.T) {
	calls := 0
	id := withConsumptionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit != 500 {
			t.Errorf("limit=%d", limit)
		}
		before, _ := strconv.Atoi(r.URL.Query().Get("before_id"))
		if before == 0 {
			before = 1102
		} else {
			if r.URL.Query().Get("snapshot_id") != "1101" || r.URL.Query().Get("skip_total") != "1" {
				t.Error("snapshot/skip_total missing")
			}
		}
		last := before - limit
		if last < 1 {
			last = 1
		}
		items := make([]upstreamTokenLog, 0, limit)
		for n := before - 1; n >= last; n-- {
			items = append(items, upstreamTokenLog{ID: n, CreatedAt: 50, Type: 2, Quota: 1, ModelName: "text"})
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"items": items, "total": 1101, "snapshot_id": 1101, "next_before_id": last, "has_more": last > 1}})
	})
	count, last := 0, 1102
	err := IterateUserConsumptionLogs(context.Background(), id, 1, 100, func(batch []ConsumptionLogItem) error {
		if len(batch) > 500 {
			t.Fatal("unbounded batch")
		}
		for _, item := range batch {
			if item.ID >= last {
				t.Fatalf("duplicate/order %d", item.ID)
			}
			last = item.ID
			count++
		}
		return nil
	})
	if err != nil || count != 1101 || calls != 3 {
		t.Fatalf("err=%v count=%d calls=%d", err, count, calls)
	}
	calls = 0
	stop := errors.New("stop")
	err = IterateUserConsumptionLogs(context.Background(), id, 1, 100, func([]ConsumptionLogItem) error { return stop })
	if !errors.Is(err, stop) || calls != 1 {
		t.Fatalf("callback cancellation err=%v calls=%d", err, calls)
	}
}

func TestConsumptionIteratorRejectsMalformedBusinessPages(t *testing.T) {
	cases := map[string]string{
		"false":         `{"success":false,"message":"database failed"}`,
		"missing-data":  `{"success":true}`,
		"missing-items": `{"success":true,"data":{"total":0}}`,
		"missing-total": `{"data":{"items":[],"snapshot_id":0}}`,
		"missing-rows":  `{"data":{"items":[],"total":2,"snapshot_id":2}}`,
		"stalled":       `{"data":{"items":[{"id":2,"created_at":50}],"total":2,"snapshot_id":2,"has_more":true,"next_before_id":3}}`,
		"wrong-time":    `{"data":{"items":[{"id":2,"created_at":100}],"total":1,"snapshot_id":2}}`,
		"duplicate":     `{"data":{"items":[{"id":2,"created_at":50},{"id":2,"created_at":50}],"total":2,"snapshot_id":2}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			id := withConsumptionFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) })
			called := false
			err := IterateUserConsumptionLogs(context.Background(), id, 1, 100, func([]ConsumptionLogItem) error { called = true; return nil })
			if err == nil || called {
				t.Fatalf("invalid body accepted: err=%v callback=%v", err, called)
			}
		})
	}
}

func TestConsumptionIteratorEmptyAndCanceled(t *testing.T) {
	calls := 0
	id := withConsumptionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		fmt.Fprint(w, `{"data":{"items":[],"total":0,"snapshot_id":0,"has_more":false}}`)
	})
	err := IterateUserConsumptionLogs(context.Background(), id, 1, 100, func([]ConsumptionLogItem) error { t.Fatal("empty callback"); return nil })
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = IterateUserConsumptionLogs(ctx, id, 1, 100, func([]ConsumptionLogItem) error { return nil })
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatal(err, calls)
	}
}
