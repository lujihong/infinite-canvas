package handler

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"

	"github.com/tigerowo/infinite-canvas/service"
)

type workbenchFileZipWriter struct {
	file *os.File
	zip  *zip.Writer
}

func (w *workbenchFileZipWriter) Create(name string) (io.Writer, error) { return w.zip.Create(name) }
func (w *workbenchFileZipWriter) AddFS(fsys fs.FS) error                { return w.zip.AddFS(fsys) }
func (w *workbenchFileZipWriter) Close() error {
	if err := w.zip.Close(); err != nil {
		return err
	}
	if w.file != nil {
		if err := w.file.Sync(); err != nil {
			_ = w.file.Close()
			return err
		}
		return w.file.Close()
	}
	return nil
}

func tempFile(name string) *os.File {
	f, err := os.OpenFile(name, os.O_RDWR|os.O_TRUNC, 0600)
	if err != nil {
		return nil
	}
	return f
}

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
	headers := []string{"提交时间", "完成时间", "模型", "操作类型", "任务标识", "任务耗时", "状态", "进度", "积分金额", "积分说明", "输入词元数", "输出词元数", "请求标识", "错误或退款说明"}
	for col, header := range headers {
		cell, _ := excelize.CoordinatesToCellName(col+1, 1)
		if err := file.SetCellStr(sheet, cell, header); err != nil {
			FailError(w, err)
			return
		}
	}
	for row, item := range logs {
		values := []any{formatExportDateTime(item.SubmitTime), formatExportDateTime(item.CompleteTime), item.ModelName, item.TaskAction, item.TaskID, formatExportDuration(item.DurationSeconds), item.StatusLabel, formatExportProgress(item.Progress), formatExportPoints(item), item.FormattedPoints, item.PromptTokens, item.CompletionTokens, item.RequestID, exportErrorOrRefund(item)}
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
	temp, err := os.CreateTemp("", "infinite-canvas-consumption-*.xlsx")
	if err != nil {
		FailError(w, err)
		return
	}
	name := temp.Name()
	if err := temp.Close(); err != nil {
		_ = os.Remove(name)
		FailError(w, err)
		return
	}
	defer os.Remove(name)
	outputFile := tempFile(name)
	if outputFile == nil {
		Fail(w, "创建导出文件失败")
		return
	}
	file.SetZipWriter(func(io.Writer) excelize.ZipWriter {
		return &workbenchFileZipWriter{file: outputFile, zip: zip.NewWriter(outputFile)}
	})
	// Rebuild through the file-backed writer so the HTTP response never buffers the workbook.
	if err := file.Write(io.Discard); err != nil {
		FailError(w, err)
		return
	}
	output, err := os.Open(name)
	if err != nil {
		FailError(w, err)
		return
	}
	defer output.Close()
	info, err := output.Stat()
	if err != nil {
		FailError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="consumption-logs.xlsx"`)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	http.ServeContent(w, r, "consumption-logs.xlsx", info.ModTime(), output)
}

func formatExportDuration(seconds float64) string {
	if seconds <= 0 {
		return "0.0 秒"
	}
	return fmt.Sprintf("%.1f 秒", seconds)
}

func formatExportProgress(progress int) string {
	if progress <= 0 {
		return "0%"
	}
	return fmt.Sprintf("%d%%", progress)
}

func formatExportPoints(item service.ConsumptionLogItem) string {
	if item.FormattedPoints != "" {
		return item.FormattedPoints
	}
	return "暂不可用"
}

func exportErrorOrRefund(item service.ConsumptionLogItem) string {
	if item.ErrorDetail != "" {
		return item.ErrorDetail
	}
	return item.ErrorMessage
}

func formatExportDateTime(unixSeconds int64) string {
	if unixSeconds <= 0 {
		return ""
	}
	return time.Unix(unixSeconds, 0).In(time.FixedZone("Asia/Shanghai", 8*60*60)).Format("2006-01-02 15:04:05")
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
