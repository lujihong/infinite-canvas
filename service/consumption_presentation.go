package service

import (
	"errors"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// These columns are the union of the consumption cards, detail dialog and preview.
// Optional columns are emitted only when at least one matching row shows them.
type ConsumptionColumn struct {
	Label  string
	Always bool
}

var ConsumptionColumns = []ConsumptionColumn{
	{"提交时间", true}, {"完成时间", true}, {"模型", true}, {"操作类型", true},
	{"任务标识", true}, {"任务耗时", true}, {"任务状态", true}, {"任务进度", true},
	{"积分结算", true}, {"积分说明", true}, {"输入词元数", false}, {"输出词元数", false},
	{"请求标识", false}, {"失败原因", false}, {"退款说明", false}, {"异常详情", false}, {"视频地址", false},
}

func consumptionPoints(points float64, prefix string) string {
	if points < 0 || math.IsNaN(points) || math.IsInf(points, 0) {
		return "积分暂不可用"
	}
	// JS Number(points.toPrecision(12)) uses twelve significant digits, then strips zeros.
	rounded, _ := strconv.ParseFloat(strconv.FormatFloat(points, 'g', 12, 64), 64)
	return prefix + strconv.FormatFloat(rounded, 'f', -1, 64) + " 积分"
}

func ConsumptionCostPresentation(item ConsumptionLogItem) (string, string) {
	if item.Status == "processing" {
		return "计算中", "生成中，最终费用尚未结算"
	}
	if item.StatusLabel == "差额补扣" && item.PreConsumedPoints > 0 && item.ActualPoints > 0 {
		return consumptionPoints(item.PointsCost, "-"), "差额补扣：预扣 " + consumptionPoints(item.PreConsumedPoints, "") + "，最终应扣 " + consumptionPoints(item.ActualPoints, "") + "，本次补扣 " + consumptionPoints(item.PointsCost, "")
	}
	if item.PointsCost < 0 || math.IsNaN(item.PointsCost) || math.IsInf(item.PointsCost, 0) {
		return "积分暂不可用", "扣费信息暂不可用"
	}
	if item.Type == 6 || item.Status == "refunded" {
		label := item.StatusLabel
		if label == "" {
			label = "额度已退还"
		}
		return consumptionPoints(item.PointsCost, "+"), label
	}
	if item.Type == 5 || item.Status == "failed" {
		if item.PointsCost > 0 {
			return consumptionPoints(item.PointsCost, "-"), "调用失败，存在扣费记录，请以账单及后续退款为准"
		}
		return consumptionPoints(0, ""), "调用未完成，本条记录未扣费"
	}
	if item.PointsCost == 0 {
		return consumptionPoints(0, ""), "本条记录扣费为零"
	}
	label := "实际扣费"
	if item.StatusLabel == "差额补扣" {
		label = "差额补扣"
	}
	return consumptionPoints(item.PointsCost, "-"), label
}

func consumptionDate(seconds int64) string {
	if seconds <= 0 {
		return ""
	}
	return time.Unix(seconds, 0).In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02 15:04:05")
}

func safeConsumptionMedia(item ConsumptionLogItem) string {
	value := item.VideoURL
	if value == "" {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || u.User != nil || (u.Scheme != "" && u.Scheme != "https" && u.Scheme != "http") || (u.Scheme == "" && (!strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//"))) {
		return ""
	}
	for key := range u.Query() {
		switch strings.ToLower(key) {
		case "key", "token", "access_token", "api_key", "apikey", "authorization":
			if item.TaskID == "" {
				return ""
			}
			return "/api/v1/videos/" + url.PathEscape(item.TaskID) + "/content"
		}
	}
	return value
}

func ConsumptionDisplayRow(item ConsumptionLogItem) []any {
	submit := item.SubmitTime
	if submit == 0 {
		submit = item.CreatedAt
	}
	modelName := item.ModelName
	if modelName == "" {
		modelName = "未指定模型"
	}
	action := item.TaskAction
	if action == "" {
		action = "大模型调用"
	}
	taskID := item.TaskID
	if taskID == "" {
		taskID = "即时API调用"
	}
	duration := item.DurationSeconds
	if duration <= 0 && item.UseTime > 0 {
		duration = float64(item.UseTime) / 1000
	}
	status := item.StatusLabel
	if status == "" {
		status = "成功"
		if item.Status == "failed" || item.Type == 5 {
			status = "调用失败 · 未扣费"
		}
	}
	amount, detail := ConsumptionCostPresentation(item)
	row := []any{consumptionDate(submit), consumptionDate(item.CompleteTime), modelName, action, taskID,
		strconv.FormatFloat(duration, 'f', 1, 64) + " 秒", status, strconv.Itoa(item.Progress) + "%", amount, detail,
		nil, nil, nil, nil, nil, nil, nil}
	if item.PromptTokens > 0 {
		row[10] = item.PromptTokens
	}
	if item.CompletionTokens > 0 {
		row[11] = item.CompletionTokens
	}
	if item.RequestID != "" {
		row[12] = item.RequestID
	}
	if (item.Status == "failed" || item.Type == 5) && item.ErrorMessage != "" {
		row[13] = item.ErrorMessage
	}
	if (item.Status == "refunded" || item.Type == 6) && item.ErrorMessage != "" {
		row[14] = item.ErrorMessage
	}
	if item.ErrorDetail != "" {
		row[15] = item.ErrorDetail
	} else if item.ErrorMessage != "" {
		row[15] = item.ErrorMessage
	}
	if media := safeConsumptionMedia(item); media != "" {
		row[16] = media
	}
	return row
}

type ConsumptionFilter struct{ Category, Status, Keyword string }

func (f ConsumptionFilter) Validate() error {
	switch f.Category {
	case "", "all", "image", "video", "audio", "text":
	default:
		return errors.New("消费类别筛选无效")
	}
	switch f.Status {
	case "", "all", "success", "failed", "refunded":
	default:
		return errors.New("消费状态筛选无效")
	}
	if len(f.Keyword) > 512 {
		return errors.New("搜索内容过长")
	}
	return nil
}
func (f ConsumptionFilter) Matches(item ConsumptionLogItem) bool {
	name, action := strings.ToLower(item.ModelName), strings.ToLower(item.TaskAction)
	contains := func(s string, words ...string) bool {
		for _, w := range words {
			if strings.Contains(s, w) {
				return true
			}
		}
		return false
	}
	isImage := contains(action, "图") || contains(name, "image", "flux", "dall", "midjourney", "seedream")
	isVideo := contains(action, "视频") || contains(name, "video", "seedance", "kling", "sora", "hailuo", "happyhouse", "omni", "minimax-h3")
	isAudio := contains(action, "音频") || contains(name, "music", "audio", "tts", "voice", "suno", "speech")
	switch f.Category {
	case "image":
		if !isImage || isVideo {
			return false
		}
	case "video":
		if !isVideo {
			return false
		}
	case "audio":
		if !isAudio {
			return false
		}
	case "text":
		if isImage || isVideo || isAudio {
			return false
		}
	}
	switch f.Status {
	case "success":
		if item.Status != "success" {
			return false
		}
	case "failed":
		if item.Status != "failed" && item.Type != 5 {
			return false
		}
	case "refunded":
		if item.Status != "refunded" && item.Type != 6 {
			return false
		}
	}
	kw := strings.ToLower(strings.TrimSpace(f.Keyword))
	return kw == "" || strings.Contains(name, kw) || strings.Contains(action, kw) || strings.Contains(strings.ToLower(item.TaskID), kw) || strings.Contains(strings.ToLower(item.RequestID), kw)
}
