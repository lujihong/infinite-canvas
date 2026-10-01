package handler

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/service"
	"github.com/xuri/excelize/v2"
)

func TestConsumptionExportVisibleColumnsAndAmounts(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "statement.xlsx")
	items := []service.ConsumptionLogItem{
		{ID: 1, CreatedAt: 1704067200, SubmitTime: 1704067200, CompleteTime: 1704067204, ModelName: "模型甲", TaskID: "000123456789123456789", TaskAction: "文生视频", Status: "success", StatusLabel: "差额补扣", Progress: 100, DurationSeconds: 4, PointsCost: .414, PreConsumedPoints: 49.68, ActualPoints: 50.094, RequestID: "request-1", FormattedPoints: "0.41 积分", VideoURL: "https://api.example/video?key=SECRET", UpstreamRequestID: "must-not-export"},
		{ID: 2, CreatedAt: 1704067200, ModelName: "=1+1", Status: "failed", Type: 5, StatusLabel: "调用失败 · 未扣费", ErrorMessage: "失败摘要", ErrorDetail: "完整失败\n细节", CompletionTokens: 12},
	}
	err := buildConsumptionExport(context.Background(), filename, service.ConsumptionFilter{}, func(yield func([]service.ConsumptionLogItem) error) error { return yield(items) })
	if err != nil {
		t.Fatal(err)
	}
	book, err := excelize.OpenFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer book.Close()
	if !reflect.DeepEqual(book.GetSheetList(), []string{"消费明细"}) {
		t.Fatal(book.GetSheetList())
	}
	rows, err := book.GetRows("消费明细")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"提交时间", "完成时间", "模型", "操作类型", "任务标识", "任务耗时", "任务状态", "任务进度", "积分结算", "积分说明", "输出词元数", "请求标识", "失败原因", "异常详情", "视频地址"}
	if !reflect.DeepEqual(rows[0], want) {
		t.Fatalf("headers %q", rows[0])
	}
	if rows[1][0] != "2024-01-01 08:00:00" || rows[1][4] != "000123456789123456789" || rows[1][8] != "-0.414 积分" {
		t.Fatal(rows[1])
	}
	if rows[1][9] != "差额补扣：预扣 49.68 积分，最终应扣 50.094 积分，本次补扣 0.414 积分" {
		t.Fatal(rows[1][9])
	}
	if rows[1][14] != "/api/v1/videos/000123456789123456789/content" {
		t.Fatal(rows[1][14])
	}
	if rows[2][2] != "=1+1" || rows[2][12] != "失败摘要" || rows[2][13] != "完整失败\n细节" {
		t.Fatal(rows[2])
	}
	formula, err := book.GetCellFormula("消费明细", "C3")
	if err != nil || formula != "" {
		t.Fatal(formula, err)
	}
	info, _ := os.Stat(filename)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
}

func TestConsumptionExportFiltersCancelAndErrors(t *testing.T) {
	for _, tc := range []struct {
		name    string
		ctx     context.Context
		source  consumptionSource
		wantErr bool
	}{
		{"upstream-error", context.Background(), func(func([]service.ConsumptionLogItem) error) error { return errors.New("upstream failed") }, true},
		{"callback-error", context.Background(), func(y func([]service.ConsumptionLogItem) error) error {
			return y([]service.ConsumptionLogItem{{ModelName: string(make([]byte, 32768))}})
		}, true},
		{"filtered", context.Background(), func(y func([]service.ConsumptionLogItem) error) error {
			return y([]service.ConsumptionLogItem{{ModelName: "seedance", Status: "success"}, {ModelName: "text", Status: "failed", Type: 5, TaskAction: "文本对话"}})
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "x.xlsx")
			err := buildConsumptionExport(tc.ctx, p, service.ConsumptionFilter{Category: "text", Status: "failed"}, tc.source)
			// Invalid records excluded by the filter need not be projected.
			if tc.name == "callback-error" {
				err = buildConsumptionExport(tc.ctx, filepath.Join(t.TempDir(), "bad.xlsx"), service.ConsumptionFilter{}, tc.source)
			}
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v", err)
			}
			if tc.name == "filtered" {
				b, e := excelize.OpenFile(p)
				if e != nil {
					t.Fatal(e)
				}
				defer b.Close()
				r, _ := b.GetRows("消费明细")
				if len(r) != 2 || r[1][2] != "text" {
					t.Fatal(r)
				}
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := buildConsumptionExport(ctx, filepath.Join(t.TempDir(), "c.xlsx"), service.ConsumptionFilter{}, func(y func([]service.ConsumptionLogItem) error) error { return y(nil) })
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	release, ok := acquireConsumptionExport("a")
	if !ok {
		t.Fatal("gate")
	}
	defer release()
	if _, ok = acquireConsumptionExport("a"); ok {
		t.Fatal("duplicate export allowed")
	}
	second, ok := acquireConsumptionExport("b")
	if !ok {
		t.Fatal("second slot")
	}
	defer second()
	if _, ok = acquireConsumptionExport("c"); ok {
		t.Fatal("global concurrency unlimited")
	}
}

func TestConsumptionExportScale(t *testing.T) {
	value := os.Getenv("CONSUMPTION_EXPORT_ROWS")
	if value == "" {
		t.Skip("set CONSUMPTION_EXPORT_ROWS=1000/10000/100000 for isolated measurements")
	}
	count, err := strconv.Atoi(value)
	if err != nil || count < 1 || count > 100000 {
		t.Fatal(value)
	}
	filename := filepath.Join(t.TempDir(), "scale.xlsx")
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	start := time.Now()
	err = buildConsumptionExport(context.Background(), filename, service.ConsumptionFilter{}, func(y func([]service.ConsumptionLogItem) error) error {
		for offset := 0; offset < count; offset += 500 {
			size := 500
			if size > count-offset {
				size = count - offset
			}
			batch := make([]service.ConsumptionLogItem, size)
			for i := range batch {
				n := offset + i
				batch[i] = service.ConsumptionLogItem{ID: n + 1, SubmitTime: 1704067200 + int64(n), CompleteTime: 1704067204 + int64(n), ModelName: "中文模型", TaskID: fmt.Sprintf("task-%012d", n), TaskAction: "文生视频", Status: "success", StatusLabel: "成功", Progress: 100, DurationSeconds: 4, PointsCost: .414, PromptTokens: 30000, RequestID: fmt.Sprint(n)}
			}
			if err := y(batch); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(start)
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	info, _ := os.Stat(filename)
	t.Logf("rows=%d elapsed=%s bytes=%d heap_before=%d heap_after=%d total_alloc_delta=%d", count, elapsed, info.Size(), base.HeapAlloc, after.HeapAlloc, after.TotalAlloc-base.TotalAlloc)
	b, err := excelize.OpenFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	rows, err := b.Rows("消费明细")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	var last []string
	for rows.Next() {
		last, err = rows.Columns()
		if err != nil {
			t.Fatal(err)
		}
		n++
	}
	if n != count+1 || last[4] != fmt.Sprintf("task-%012d", count-1) {
		t.Fatalf("rows=%d last=%v", n, last)
	}
}
