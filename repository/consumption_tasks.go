package repository

import (
	"context"
	"errors"

	"github.com/tigerowo/infinite-canvas/model"
)

// A statement never loads the user's full history; only the current log batch is joined.
func ConsumptionTaskBatch(ctx context.Context, userID string, ids []string) ([]model.VideoTask, error) {
	if userID == "" {
		return nil, errors.New("缺少当前用户")
	}
	if len(ids) == 0 {
		return []model.VideoTask{}, nil
	}
	if len(ids) > 500 {
		return nil, errors.New("账单任务关联批次过大")
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var tasks []model.VideoTask
	err = db.WithContext(ctx).Select("id", "upstream_task_id", "upstream_video_id", "created_at", "completed_at", "status", "video_url").
		Where("user_id = ? AND (upstream_task_id IN ? OR upstream_video_id IN ? OR id IN ?)", userID, ids, ids, ids).
		Order("created_at DESC, id DESC").Find(&tasks).Error
	return tasks, err
}

// Running task creation dates can contain timezone offsets, so the service compares
// parsed timestamps rather than relying on lexical ordering of RFC3339 strings.
func ConsumptionRunningTaskPage(ctx context.Context, userID, beforeID string, limit int) ([]model.VideoTask, error) {
	if userID == "" {
		return nil, errors.New("缺少当前用户")
	}
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	query := db.WithContext(ctx).Select("id", "upstream_task_id", "created_at", "status", "model", "progress", "video_url", "request_body").
		Where("user_id = ? AND status IN ?", userID, []string{"queued", "in_progress", "processing", "running"})
	if beforeID != "" {
		query = query.Where("id < ?", beforeID)
	}
	var tasks []model.VideoTask
	err = query.Order("id DESC").Limit(limit).Find(&tasks).Error
	return tasks, err
}
