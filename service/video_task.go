package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const videoTaskPollInterval = 5 * time.Second
const videoTaskFinishedRetention = 10 * time.Minute
const videoTaskCleanupInterval = 10 * time.Minute

var (
	videoTaskPollerOnce  sync.Once
	videoTaskPollWake    = make(chan struct{}, 1)
	videoTaskPollerMu    sync.RWMutex
	videoTaskPoller      VideoTaskPollFunc
	videoTaskRunningMu   sync.Mutex
	videoTaskRunning     bool
	videoTaskWakePending bool
)

type VideoTaskCreateInput struct {
	UserID             string
	UserDisplayName    string
	Model              string
	ChannelID          string
	UserChannelID      string
	ChannelName        string
	SourceKind         string
	GatewayBaseURL     string
	GatewayUserID      string
	ChannelIdentity    string
	ChannelFingerprint string
	Source             string
	SourceID           string
	ClientTaskID       string
	UpstreamTaskID     string
	UpstreamVideoID    string
	Status             string
	Progress           int
	Seconds            string
	Size               string
	VideoURL           string
	Error              string
	ErrorDetail        string
	RequestBody        string
	ResponseBody       string
	Credits            int
}

type VideoTaskPollUpdate struct {
	Status       string
	Progress     int
	Seconds      string
	Size         string
	VideoURL     string
	Error        string
	ErrorDetail  string
	ResponseBody string
}

type VideoTaskPollFunc func(model.VideoTask) (VideoTaskPollUpdate, error)

func CreateVideoTask(input VideoTaskCreateInput) (model.VideoTask, error) {
	current := now()
	status := NormalizeVideoTaskStatus(input.Status)
	if status == "" {
		status = "queued"
	}
	task := model.VideoTask{
		ID:                 firstVideoTaskValue(input.ClientTaskID, input.UpstreamTaskID, input.UpstreamVideoID, "video-task-"+uuid.NewString()),
		UserID:             strings.TrimSpace(input.UserID),
		UserDisplayName:    strings.TrimSpace(input.UserDisplayName),
		Model:              strings.TrimSpace(input.Model),
		ChannelID:          strings.TrimSpace(input.ChannelID),
		UserChannelID:      strings.TrimSpace(input.UserChannelID),
		ChannelName:        strings.TrimSpace(input.ChannelName),
		SourceKind:         normalizeVideoTaskSourceKind(input.SourceKind),
		GatewayBaseURL:     strings.TrimRight(strings.TrimSpace(input.GatewayBaseURL), "/"),
		GatewayUserID:      strings.TrimSpace(input.GatewayUserID),
		ChannelIdentity:    strings.TrimSpace(input.ChannelIdentity),
		ChannelFingerprint: input.ChannelFingerprint,
		Source:             normalizeVideoTaskSource(input.Source),
		SourceID:           strings.TrimSpace(input.SourceID),
		UpstreamTaskID:     strings.TrimSpace(input.UpstreamTaskID),
		UpstreamVideoID:    strings.TrimSpace(input.UpstreamVideoID),
		Status:             status,
		Progress:           clampProgress(input.Progress),
		Seconds:            strings.TrimSpace(input.Seconds),
		Size:               strings.TrimSpace(input.Size),
		VideoURL:           strings.TrimSpace(input.VideoURL),
		Error:              strings.TrimSpace(input.Error),
		ErrorDetail:        strings.TrimSpace(input.ErrorDetail),
		RequestBody:        input.RequestBody,
		ResponseBody:       input.ResponseBody,
		LastResponse:       input.ResponseBody,
		Credits:            input.Credits,
		CreatedAt:          current,
		UpdatedAt:          current,
	}
	if task.SourceKind == "" || task.ChannelIdentity == "" || task.GatewayBaseURL == "" || (task.SourceKind == VideoTaskSourceOfficial && task.GatewayUserID == "") {
		return model.VideoTask{}, ErrVideoTaskChannelSnapshotUnavailable
	}
	if IsCompletedVideoTaskStatus(task.Status) || task.VideoURL != "" {
		task.Status = "completed"
		task.Progress = 100
		task.CompletedAt = current
	} else if IsFailedVideoTaskStatus(task.Status) || task.Error != "" {
		task.Status = "failed"
		task.CompletedAt = current
	}
	saved, err := repository.SaveVideoTask(task)
	if err == nil && !IsCompletedVideoTaskStatus(saved.Status) && !IsFailedVideoTaskStatus(saved.Status) {
		WakeVideoTaskPoller()
	}
	return saved, err
}

func GetUserVideoTask(userID string, id string) (model.VideoTask, bool, error) {
	return repository.GetUserVideoTask(strings.TrimSpace(userID), strings.TrimSpace(id))
}

func ListUserVideoTasks(userID string, source string, limit int) ([]map[string]any, error) {
	tasks, err := repository.ListUserVideoTasks(strings.TrimSpace(userID), normalizeVideoTaskSource(source), limit)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		result = append(result, VideoTaskResponse(task))
	}
	return result, nil
}

func DeleteUserVideoTask(userID string, id string) error {
	return repository.DeleteUserVideoTask(strings.TrimSpace(userID), strings.TrimSpace(id))
}

func VideoTaskResponse(task model.VideoTask) map[string]any {
	result := map[string]any{
		"id":            task.ID,
		"object":        "video",
		"model":         task.Model,
		"channelId":     task.ChannelID,
		"userChannelId": task.UserChannelID,
		"channelName":   task.ChannelName,
		"source":        task.Source,
		"source_id":     task.SourceID,
		"status":        task.Status,
		"progress":      task.Progress,
		"task_id":       firstVideoTaskValue(task.UpstreamTaskID, task.ID),
		"video_id":      task.UpstreamVideoID,
		"seconds":       task.Seconds,
		"size":          task.Size,
		"created_at":    task.CreatedAt,
		"updated_at":    task.UpdatedAt,
		"started_at":    task.StartedAt,
		"completed_at":  task.CompletedAt,
		"createdAt":     task.CreatedAt,
		"updatedAt":     task.UpdatedAt,
		"request_body":  task.RequestBody,
	}
	if task.VideoURL != "" {
		result["url"] = task.VideoURL
		result["video_url"] = task.VideoURL
		result["data"] = []map[string]any{{"url": task.VideoURL}}
	}
	if IsFailedVideoTaskStatus(task.Status) && (task.Error != "" || task.ErrorDetail != "") {
		result["error"] = map[string]any{"message": firstVideoTaskValue(task.Error, task.ErrorDetail)}
		result["error_detail"] = task.ErrorDetail
	}
	if _, err := ResolveVideoTaskChannel(task); err != nil {
		result["error"] = map[string]any{"code": "video_task_channel_configuration", "message": err.Error(), "recoverable": true}
		result["error_detail"] = err.Error()
	}
	return result
}

func StartVideoTaskPoller(poll VideoTaskPollFunc) {
	if poll == nil {
		return
	}
	videoTaskPollerMu.Lock()
	videoTaskPoller = poll
	videoTaskPollerMu.Unlock()
	videoTaskPollerOnce.Do(func() {
		go runVideoTaskPoller()
	})
	WakeVideoTaskPoller()
}

func WakeVideoTaskPoller() {
	videoTaskRunningMu.Lock()
	if videoTaskRunning {
		videoTaskWakePending = true
		videoTaskRunningMu.Unlock()
		return
	}
	videoTaskRunning = true
	videoTaskWakePending = false
	videoTaskRunningMu.Unlock()
	select {
	case videoTaskPollWake <- struct{}{}:
	default:
		videoTaskRunningMu.Lock()
		videoTaskRunning = false
		videoTaskRunningMu.Unlock()
	}
}

func runVideoTaskPoller() {
	inFlight := sync.Map{}
	lastCleanupAt := time.Time{}
	for range videoTaskPollWake {
		for {
			current := time.Now()
			tasks, err := repository.ListDueVideoTasks(200)
			if err != nil {
				log.Printf("list due video tasks failed err=%v", err)
				waitForNextVideoTaskPoll()
				continue
			}
			if len(tasks) == 0 {
				videoTaskRunningMu.Lock()
				if videoTaskWakePending {
					videoTaskWakePending = false
					videoTaskRunningMu.Unlock()
					continue
				}
				videoTaskRunning = false
				videoTaskRunningMu.Unlock()
				break
			}
			if lastCleanupAt.IsZero() || current.Sub(lastCleanupAt) >= videoTaskCleanupInterval {
				// 严禁自动物理删除用户的已完成视频任务，确保创作成果长期安全保留在系统中
				lastCleanupAt = current
			}
			for _, task := range tasks {
				if _, loaded := inFlight.LoadOrStore(task.ID, true); loaded {
					continue
				}
				go func(task model.VideoTask) {
					defer inFlight.Delete(task.ID)
					poll := currentVideoTaskPoller()
					if poll == nil {
						return
					}
					update, err := poll(task)
					if err != nil {
						update = VideoTaskPollUpdate{Status: task.Status, ErrorDetail: err.Error()}
					}
					if err := UpdateVideoTaskFromPoll(task, update); err != nil {
						log.Printf("update video task failed id=%s err=%v", task.ID, err)
					}
				}(task)
			}
			waitForNextVideoTaskPoll()
		}
	}
}

func currentVideoTaskPoller() VideoTaskPollFunc {
	videoTaskPollerMu.RLock()
	defer videoTaskPollerMu.RUnlock()
	return videoTaskPoller
}

func waitForNextVideoTaskPoll() {
	time.Sleep(videoTaskPollInterval)
}

func UpdateVideoTaskFromPoll(task model.VideoTask, update VideoTaskPollUpdate) error {
	current := now()
	task.Status = NormalizeVideoTaskStatus(firstVideoTaskValue(update.Status, task.Status))
	if task.Status == "" {
		task.Status = "processing"
	}
	if update.Progress > 0 || task.Progress == 0 {
		task.Progress = clampProgress(update.Progress)
	}
	if strings.TrimSpace(update.Seconds) != "" {
		task.Seconds = strings.TrimSpace(update.Seconds)
	}
	if strings.TrimSpace(update.Size) != "" {
		task.Size = strings.TrimSpace(update.Size)
	}
	if strings.TrimSpace(update.VideoURL) != "" {
		task.VideoURL = strings.TrimSpace(update.VideoURL)
	}
	if strings.TrimSpace(update.Error) != "" {
		task.Error = strings.TrimSpace(update.Error)
	}
	if strings.TrimSpace(update.ErrorDetail) != "" {
		task.ErrorDetail = strings.TrimSpace(update.ErrorDetail)
	}
	if update.ResponseBody != "" {
		task.LastResponse = update.ResponseBody
	}
	task.UpdatedAt = current
	task.LastPolledAt = videoTaskTime(time.Now())
	if task.VideoURL != "" || IsCompletedVideoTaskStatus(task.Status) {
		task.Status = "completed"
		task.Progress = 100
		task.CompletedAt = current
		task.Error = ""
		task.ErrorDetail = ""

		// 自动异步转存至本地存储，杜绝外部临时链接过期失效导致视频丢失
		if task.VideoURL != "" && !strings.HasPrefix(task.VideoURL, "/api/files/") {
			targetURL := task.VideoURL
			taskID := task.ID
			userID := task.UserID
			go func() {
				bgCtx := context.Background()
				if userID != "" {
					bgCtx = WithUser(bgCtx, model.AuthUser{ID: userID})
				}
				if persisted, pErr := PersistRemoteMediaToStorage(bgCtx, targetURL, "canvas_video_"+taskID+".mp4", "video/mp4"); pErr == nil && persisted.URL != "" {
					if cur, found, _ := repository.GetVideoTask(taskID); found && cur.VideoURL != persisted.URL {
						cur.VideoURL = persisted.URL
						cur.UpdatedAt = now()
						_, _ = repository.SaveVideoTask(cur)
					}
				}
			}()
		}
	} else if task.Error != "" || IsFailedVideoTaskStatus(task.Status) {
		task.Status = "failed"
		task.CompletedAt = current
		if task.Credits > 0 && strings.TrimSpace(task.UserID) != "" {
			_ = RefundUserCredits(task.UserID, task.Model, task.Credits, "/videos")
			task.Credits = 0
		}
	}
	_, err := repository.SaveVideoTask(task)
	return err
}

func NormalizeVideoTaskStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "done", "succeeded", "success":
		return "completed"
	case "failed", "fail", "error", "cancelled", "canceled":
		return "failed"
	case "running", "processing", "in_progress", "in-progress":
		return "processing"
	case "queued", "queue", "pending", "":
		return "queued"
	default:
		return strings.ToLower(strings.TrimSpace(status))
	}
}

func IsCompletedVideoTaskStatus(status string) bool {
	return NormalizeVideoTaskStatus(status) == "completed"
}

func IsFailedVideoTaskStatus(status string) bool {
	return NormalizeVideoTaskStatus(status) == "failed"
}

func videoTaskTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func firstVideoTaskValue(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

const (
	VideoTaskSourceOfficial  = "official"
	VideoTaskSourceUserLocal = "user-local"
	VideoTaskSourcePublic    = "public"
)

var ErrVideoTaskChannelSnapshotUnavailable = errors.New("视频任务缺少渠道来源快照，请恢复原始任务快照后重试")
var ErrVideoTaskChannelConfiguration = errors.New("视频任务渠道配置已变化，请恢复原绑定与配置后重试")

const officialVideoChannelID = "xyb-official-exclusive"

// CaptureVideoTaskChannel freezes the actual request identity before submission.
// Credentials only live in the returned channel, never in the persisted snapshot.
func CaptureVideoTaskChannel(userID string, channel model.ModelChannel, userChannelID string) (model.ModelChannel, VideoTaskCreateInput, error) {
	snapshot := VideoTaskCreateInput{SourceKind: VideoTaskSourcePublic, ChannelIdentity: strings.TrimSpace(channel.ID)}
	if userChannelID == officialVideoChannelID || channel.ID == officialVideoChannelID {
		current, gatewayUserID, err := officialVideoTaskChannel(userID)
		if err != nil {
			return model.ModelChannel{}, VideoTaskCreateInput{}, err
		}
		channel = current
		snapshot.SourceKind = VideoTaskSourceOfficial
		snapshot.ChannelIdentity = officialVideoChannelID
		snapshot.GatewayUserID = gatewayUserID
	} else if strings.TrimSpace(userChannelID) != "" {
		snapshot.SourceKind = VideoTaskSourceUserLocal
	}
	snapshot.GatewayBaseURL = strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/")
	snapshot.ChannelFingerprint = videoTaskChannelFingerprint(channel, snapshot.SourceKind)
	if snapshot.ChannelIdentity == "" || snapshot.GatewayBaseURL == "" {
		return model.ModelChannel{}, VideoTaskCreateInput{}, ErrVideoTaskChannelSnapshotUnavailable
	}
	return channel, snapshot, nil
}

func officialVideoTaskChannel(userID string) (model.ModelChannel, string, error) {
	user, found, err := repository.GetUserByID(strings.TrimSpace(userID))
	if err != nil || !found {
		return model.ModelChannel{}, "", ErrVideoTaskChannelConfiguration
	}
	token, err := aiccUserToken(user)
	if err != nil {
		return model.ModelChannel{}, "", ErrVideoTaskChannelConfiguration
	}
	var extra UserExtraInfo
	if json.Unmarshal([]byte(user.Extra), &extra) != nil {
		return model.ModelChannel{}, "", ErrVideoTaskChannelConfiguration
	}
	return model.ModelChannel{ID: officialVideoChannelID, Name: "鑫元宝官方模型服务", Protocol: "openai", BaseURL: getNewAPIBaseURL(), APIKey: token, Models: []string{"*"}, Timeout: 600, Enabled: true}, strconv.Itoa(extra.NewAPIUserID), nil
}

// ResolveVideoTaskChannel never chooses another channel when a saved identity is missing.
func ResolveVideoTaskChannel(task model.VideoTask) (model.ModelChannel, error) {
	if normalizeVideoTaskSourceKind(task.SourceKind) == "" || task.ChannelIdentity == "" || task.GatewayBaseURL == "" {
		return model.ModelChannel{}, ErrVideoTaskChannelSnapshotUnavailable
	}
	var channel model.ModelChannel
	var err error
	switch task.SourceKind {
	case VideoTaskSourceOfficial:
		if task.GatewayUserID == "" {
			return model.ModelChannel{}, ErrVideoTaskChannelSnapshotUnavailable
		}
		if task.ChannelIdentity != officialVideoChannelID || task.ChannelID != officialVideoChannelID || task.UserChannelID != officialVideoChannelID {
			return model.ModelChannel{}, ErrVideoTaskChannelConfiguration
		}
		var gatewayUserID string
		channel, gatewayUserID, err = officialVideoTaskChannel(task.UserID)
		if err == nil && gatewayUserID != task.GatewayUserID {
			err = ErrVideoTaskChannelConfiguration
		}
	case VideoTaskSourceUserLocal:
		if task.UserChannelID == "" || task.UserChannelID == officialVideoChannelID || task.UserChannelID != task.ChannelIdentity || task.ChannelID != task.ChannelIdentity {
			return model.ModelChannel{}, ErrVideoTaskChannelConfiguration
		}
		channel, err = SelectUserLocalModelChannelForModel(task.UserID, task.Model, task.UserChannelID)
	case VideoTaskSourcePublic:
		if task.UserChannelID != "" || task.ChannelID == "" || task.ChannelID == officialVideoChannelID || task.ChannelID != task.ChannelIdentity {
			return model.ModelChannel{}, ErrVideoTaskChannelConfiguration
		}
		channel, err = SelectModelChannelForModel(task.Model, task.ChannelID)
	default:
		return model.ModelChannel{}, ErrVideoTaskChannelSnapshotUnavailable
	}
	if err != nil || channel.ID != task.ChannelIdentity || strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/") != task.GatewayBaseURL || task.ChannelFingerprint == "" || task.ChannelFingerprint != videoTaskChannelFingerprint(channel, task.SourceKind) {
		return model.ModelChannel{}, ErrVideoTaskChannelConfiguration
	}
	return channel, nil
}

func videoTaskChannelFingerprint(channel model.ModelChannel, sourceKind string) string {
	key := channel.APIKey
	if sourceKind == VideoTaskSourceOfficial {
		key = ""
	} // Dedicated gateway identity is checked separately; its token may rotate.
	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	if protocol == "" {
		protocol = "openai"
	}
	wire, _ := json.Marshal([]string{channel.ID, strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/"), protocol, key})
	digest := sha256.Sum256(wire)
	return hex.EncodeToString(digest[:])
}

func normalizeVideoTaskSourceKind(sourceKind string) string {
	switch strings.ToLower(strings.TrimSpace(sourceKind)) {
	case VideoTaskSourceOfficial, VideoTaskSourceUserLocal, VideoTaskSourcePublic:
		return strings.ToLower(strings.TrimSpace(sourceKind))
	default:
		return ""
	}
}

func normalizeVideoTaskSource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "canvas":
		return "canvas"
	case "video-workbench", "":
		return "video-workbench"
	default:
		return "video-workbench"
	}
}

func clampProgress(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}
