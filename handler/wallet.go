package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"

	"github.com/tigerowo/infinite-canvas/service"
)

// UserWallet 查询当前登录用户的算力钱包余额与折算金额
func UserWallet(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "未登录或权限不足")
		return
	}

	wallet, err := service.FetchUserWalletBalance(user.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, wallet)
}

// UserRecharge 创作工作台直接发起微信官方直连充值下单
func UserRecharge(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "未登录或权限不足")
		return
	}

	var req struct {
		Amount int `json:"amount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Amount < 1 {
		Fail(w, "充值金额无效，最小充值 1 元")
		return
	}

	order, err := service.CreateWeChatRechargeOrder(user.ID, req.Amount)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, order)
}

// UserRechargeStatus 查询充值订单支付状态
func UserRechargeStatus(w http.ResponseWriter, r *http.Request) {
	tradeNo := r.URL.Query().Get("trade_no")
	if tradeNo == "" {
		Fail(w, "缺少订单号")
		return
	}

	status, err := service.CheckRechargeOrderStatus(tradeNo)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, status)
}

// ModelPricing 只返回当前登录用户的专属报价，不缓存、不回退到公共价格。
func ModelPricing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "请先登录后查看本人报价")
		return
	}
	pricing, err := service.FetchPersonalModelPricingList(r.Context(), user.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, pricing)
}

// UserConsumptionLogs 获取当前用户在中转站的消费流水，可指定 Unix 秒半开区间。
func UserConsumptionLogs(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "未登录或权限不足")
		return
	}
	start, end, err := consumptionRange(r, false)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	logs, err := service.FetchUserConsumptionLogsRange(user.ID, start, end)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}

// UserConsumptionLogsExport streams an XLSX containing every field returned by the detail API.
func UserConsumptionLogsExport(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "未登录或权限不足")
		return
	}
	start, end, err := consumptionRange(r, true)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	logs, err := service.FetchUserConsumptionLogsRange(user.ID, start, end)
	if err != nil {
		FailError(w, err)
		return
	}
	file := excelize.NewFile()
	defer file.Close()
	sheet := "消费明细"
	file.SetSheetName(file.GetSheetName(0), sheet)
	headers := []string{"ID", "创建时间Unix", "提交时间Unix", "完成时间Unix", "模型", "类型", "状态", "状态说明", "进度", "耗时秒", "任务ID", "任务类型", "视频URL", "Quota", "积分", "积分展示", "预扣Quota", "实际Quota", "预扣积分", "最终积分", "金额元", "金额展示", "输入Tokens", "输出Tokens", "耗时毫秒", "流式", "错误信息", "错误详情", "请求ID", "上游请求ID"}
	for col, header := range headers {
		cell, _ := excelize.CoordinatesToCellName(col+1, 1)
		if err := file.SetCellStr(sheet, cell, header); err != nil {
			FailError(w, err)
			return
		}
	}
	for row, item := range logs {
		values := []any{item.ID, item.CreatedAt, item.SubmitTime, item.CompleteTime, item.ModelName, item.Type, item.Status, item.StatusLabel, item.Progress, item.DurationSeconds, item.TaskID, item.TaskAction, item.VideoURL, item.Quota, item.PointsCost, item.FormattedPoints, item.PreConsumedQuota, item.ActualQuota, item.PreConsumedPoints, item.ActualPoints, item.MoneyYuan, item.FormattedMoney, item.PromptTokens, item.CompletionTokens, item.UseTime, item.IsStream, item.ErrorMessage, item.ErrorDetail, item.RequestID, item.UpstreamRequestID}
		for col, value := range values {
			cell, _ := excelize.CoordinatesToCellName(col+1, row+2)
			if text, ok := value.(string); ok && len(text) > 0 && strings.ContainsRune("=+-@", []rune(text)[0]) {
				value = "'" + text
			}
			if err := file.SetCellValue(sheet, cell, value); err != nil {
				FailError(w, err)
				return
			}
		}
	}
	var output bytes.Buffer
	if err := file.Write(&output); err != nil {
		FailError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="consumption-logs.xlsx"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(output.Bytes())
}

func consumptionRange(r *http.Request, allHistory bool) (int64, int64, error) {
	query := r.URL.Query()
	startValue, endValue := query.Get("start_timestamp"), query.Get("end_timestamp")
	if startValue == "" && endValue == "" {
		end := time.Now().Unix()
		if allHistory {
			return 1, end, nil
		}
		return end - 365*24*60*60, end, nil
	}
	if startValue == "" || endValue == "" {
		return 0, 0, fmt.Errorf("开始和结束时间必须同时提供")
	}
	start, err := strconv.ParseInt(startValue, 10, 64)
	if err != nil || start <= 0 {
		return 0, 0, fmt.Errorf("开始时间无效")
	}
	end, err := strconv.ParseInt(endValue, 10, 64)
	if err != nil || end <= start {
		return 0, 0, fmt.Errorf("结束时间必须晚于开始时间")
	}
	return start, end, nil
}

// UserRechargeLogs 获取当前用户的在线充值记录
func UserRechargeLogs(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "未登录或权限不足")
		return
	}

	logs, err := service.FetchUserRechargeLogs(user.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}
