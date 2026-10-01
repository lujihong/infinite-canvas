package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/tigerowo/infinite-canvas/repository"
)

const ConsumptionBatchSize = 500
const MaxConsumptionExportRows = 100000
const maxConsumptionPageBytes = 32 << 20

type upstreamTokenLog struct {
	ID                int    `json:"id"`
	CreatedAt         int64  `json:"created_at"`
	ModelName         string `json:"model_name"`
	Type              int    `json:"type"`
	Quota             int64  `json:"quota"`
	PromptTokens      int    `json:"prompt_tokens"`
	CompletionTokens  int    `json:"completion_tokens"`
	UseTime           int    `json:"use_time"`
	IsStream          bool   `json:"is_stream"`
	Content           string `json:"content"`
	RequestID         string `json:"request_id"`
	UpstreamRequestID string `json:"upstream_request_id"`
	Other             string `json:"other"`
}

type consumptionPage struct {
	Items        []upstreamTokenLog `json:"items"`
	Total        *int64             `json:"total"`
	SnapshotID   int                `json:"snapshot_id"`
	NextBeforeID int                `json:"next_before_id"`
	HasMore      bool               `json:"has_more"`
}

// IterateUserConsumptionLogs retains at most one upstream and task-join batch.
// Returning an error from yield immediately stops HTTP and database work.
func IterateUserConsumptionLogs(ctx context.Context, userID string, start, end int64, yield func([]ConsumptionLogItem) error) error {
	if userID == "" || start <= 0 || end <= start || yield == nil {
		return errors.New("消费明细查询参数无效")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	user, exists, err := repository.GetUserByID(userID)
	if err != nil {
		return fmt.Errorf("读取当前用户失败: %w", err)
	}
	if !exists {
		return errors.New("当前用户不存在")
	}
	var extra UserExtraInfo
	if err := json.Unmarshal([]byte(user.Extra), &extra); err != nil || extra.NewAPIToken == "" || extra.NewAPIUserID <= 0 {
		return errors.New("当前账户未绑定独立账单，请先完成账户绑定")
	}
	token := extra.NewAPIToken
	_, quotaPerUnit := getNewAPISystemStatus()
	if quotaPerUnit <= 0 {
		return errors.New("账单积分换算暂不可用")
	}
	emitted := 0
	for before := ""; ; {
		if err := ctx.Err(); err != nil {
			return err
		}
		tasks, err := repository.ConsumptionRunningTaskPage(ctx, userID, before, ConsumptionBatchSize)
		if err != nil {
			return fmt.Errorf("读取进行中任务失败: %w", err)
		}
		batch := mapConsumptionLogs(nil, tasks, token, quotaPerUnit, start, end, true)
		emitted += len(batch)
		if emitted > MaxConsumptionExportRows {
			return errors.New("导出超过十万条记录，请缩小时间范围")
		}
		if len(batch) > 0 {
			if err := yield(batch); err != nil {
				return err
			}
		}
		if len(tasks) < ConsumptionBatchSize {
			break
		}
		next := tasks[len(tasks)-1].ID
		if next == "" || (before != "" && next >= before) {
			return errors.New("任务分页未前进")
		}
		before = next
	}
	client := &http.Client{Timeout: 30 * time.Second}
	snapshot, before, count := 0, 0, int64(0)
	var expected int64
	for pageNo := 0; ; pageNo++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		query := url.Values{"start_timestamp": {strconv.FormatInt(start, 10)}, "end_timestamp": {strconv.FormatInt(end, 10)}, "limit": {strconv.Itoa(ConsumptionBatchSize)}}
		if pageNo > 0 {
			query.Set("snapshot_id", strconv.Itoa(snapshot))
			query.Set("before_id", strconv.Itoa(before))
			query.Set("skip_total", "1")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, getNewAPIBaseURL()+"/api/log/token/page?"+query.Encode(), nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("请求消费明细失败: %w", err)
		}
		var envelope struct {
			Success *bool            `json:"success"`
			Message string           `json:"message"`
			Data    *consumptionPage `json:"data"`
		}
		decoder := json.NewDecoder(io.LimitReader(resp.Body, maxConsumptionPageBytes+1))
		decodeErr := decoder.Decode(&envelope)
		if decodeErr == nil {
			var trailing any
			if decoder.Decode(&trailing) != io.EOF {
				decodeErr = errors.New("响应超限或包含额外数据")
			}
		}
		_ = resp.Body.Close()
		if decodeErr != nil {
			return fmt.Errorf("解析消费明细失败: %w", decodeErr)
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 || (envelope.Success != nil && !*envelope.Success) {
			return fmt.Errorf("中转站消费明细查询失败（HTTP %d），未生成导出文件", resp.StatusCode)
		}
		p := envelope.Data
		if p == nil || p.Items == nil || len(p.Items) > ConsumptionBatchSize {
			return errors.New("账单分页响应不完整，已中止导出")
		}
		if pageNo == 0 {
			if p.Total == nil || *p.Total < 0 {
				return errors.New("账单分页缺少总数")
			}
			expected, snapshot = *p.Total, p.SnapshotID
			if expected+int64(emitted) > MaxConsumptionExportRows {
				return errors.New("导出超过十万条记录，请缩小时间范围")
			}
		} else if p.SnapshotID != snapshot {
			return errors.New("消费明细分页快照发生变化，已中止导出")
		}
		if len(p.Items) > 0 && snapshot <= 0 {
			return errors.New("账单快照无效")
		}
		last := before
		ids := make([]string, 0, len(p.Items))
		for _, item := range p.Items {
			if item.ID <= 0 || item.ID > snapshot || (last > 0 && item.ID >= last) || item.CreatedAt < start || item.CreatedAt >= end {
				return errors.New("账单页重复、越界或顺序异常，已中止导出")
			}
			last = item.ID
			var other struct {
				TaskID string `json:"task_id"`
			}
			if json.Unmarshal([]byte(item.Other), &other) == nil && other.TaskID != "" {
				ids = append(ids, other.TaskID)
			}
		}
		count += int64(len(p.Items))
		if count > expected || count+int64(emitted) > MaxConsumptionExportRows {
			return errors.New("账单条数超过快照范围")
		}
		if p.HasMore && (len(p.Items) == 0 || p.NextBeforeID != last || count >= expected) {
			return errors.New("账单分页游标未前进或提前结束")
		}
		if !p.HasMore && count != expected {
			return errors.New("账单分页记录缺失，请重新导出")
		}
		localTasks, err := repository.ConsumptionTaskBatch(ctx, userID, ids)
		if err != nil {
			return fmt.Errorf("读取账单关联任务失败: %w", err)
		}
		if len(p.Items) > 0 {
			if err := yield(mapConsumptionLogs(p.Items, localTasks, token, quotaPerUnit, start, end, false)); err != nil {
				return err
			}
		}
		if !p.HasMore {
			return nil
		}
		before = last
	}
}
