package service

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "canvas-service-test-")
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

func TestVideoTaskExactChannelResolution(t *testing.T) {
	previous := config.Cfg
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "video-service.db")
	t.Cleanup(func() { config.Cfg = previous })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	settings, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = repository.SaveSettings(settings, now())
		db.Where("user_id = ?", "video-local-test").Delete(&model.UserConfig{})
	})
	a := model.ModelChannel{ID: "exact-a", BaseURL: "https://a.invalid", APIKey: "key-a", Models: []string{"test-video"}, Enabled: true, Weight: 1}
	b := model.ModelChannel{ID: "fallback-b", BaseURL: "https://b.invalid", APIKey: "key-b", Models: []string{"test-video"}, Enabled: true, Weight: 1}
	for _, kind := range []string{VideoTaskSourcePublic, VideoTaskSourceUserLocal} {
		t.Run(kind, func(t *testing.T) {
			save := func(channels []model.ModelChannel) {
				t.Helper()
				if kind == VideoTaskSourcePublic {
					_, err = repository.SaveSettings(model.Settings{Private: model.PrivateSetting{Channels: channels}}, now())
				} else {
					data, _ := json.Marshal(map[string]any{"localChannels": channels})
					_, err = repository.SaveUserConfig(model.UserConfig{UserID: "video-local-test", ModelConfig: string(data)})
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			task := model.VideoTask{UserID: "video-local-test", Model: "test-video", SourceKind: kind, ChannelID: a.ID, ChannelIdentity: a.ID, GatewayBaseURL: a.BaseURL, ChannelFingerprint: videoTaskChannelFingerprint(a, kind)}
			if kind == VideoTaskSourceUserLocal {
				task.UserChannelID = a.ID
			}
			save([]model.ModelChannel{b, a})
			channel, err := ResolveVideoTaskChannel(task)
			if err != nil || channel.ID != a.ID {
				t.Fatalf("exact channel rejected: %+v %v", channel, err)
			}
			save([]model.ModelChannel{b})
			if _, err := ResolveVideoTaskChannel(task); !errors.Is(err, ErrVideoTaskChannelConfiguration) {
				t.Fatalf("deleted channel fell back: %v", err)
			}
			modified := a
			modified.BaseURL = b.BaseURL
			save([]model.ModelChannel{modified, b})
			if _, err := ResolveVideoTaskChannel(task); !errors.Is(err, ErrVideoTaskChannelConfiguration) {
				t.Fatalf("changed base accepted: %v", err)
			}
			modified = a
			modified.APIKey = "rotated"
			save([]model.ModelChannel{modified, b})
			if _, err = ResolveVideoTaskChannel(task); !errors.Is(err, ErrVideoTaskChannelConfiguration) {
				t.Fatalf("unverified external account/key change accepted: %v", err)
			}
			modified = a
			modified.Protocol = "gemini"
			save([]model.ModelChannel{modified, b})
			if _, err = ResolveVideoTaskChannel(task); !errors.Is(err, ErrVideoTaskChannelConfiguration) {
				t.Fatalf("protocol change accepted: %v", err)
			}
			task.ChannelID = ""
			task.ChannelIdentity = ""
			if _, err := ResolveVideoTaskChannel(task); err == nil {
				t.Fatal("missing ID accepted")
			}
		})
	}
	if _, err := CreateVideoTask(VideoTaskCreateInput{UserID: "video-local-test", UpstreamTaskID: "recovered-without-snapshot"}); !errors.Is(err, ErrVideoTaskChannelSnapshotUnavailable) {
		t.Fatalf("recovery silently accepted missing provenance: %v", err)
	}
}
