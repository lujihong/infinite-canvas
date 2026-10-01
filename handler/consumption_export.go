package handler

import (
	"archive/zip"
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/tigerowo/infinite-canvas/service"
	"github.com/xuri/excelize/v2"
)

const exportDiskLimit int64 = 256 << 20
const exportZipLimit int64 = 128 << 20

var consumptionExportGate = struct {
	sync.Mutex
	users map[string]bool
}{users: make(map[string]bool)}

func acquireConsumptionExport(userID string) (func(), bool) {
	consumptionExportGate.Lock()
	defer consumptionExportGate.Unlock()
	if consumptionExportGate.users[userID] || len(consumptionExportGate.users) >= 2 {
		return nil, false
	}
	consumptionExportGate.users[userID] = true
	return func() {
		consumptionExportGate.Lock()
		delete(consumptionExportGate.users, userID)
		consumptionExportGate.Unlock()
	}, true
}

func UserConsumptionLogsExport(w http.ResponseWriter, r *http.Request) {
	serveConsumptionExport(w, r, false)
}
func PrepareUserConsumptionExport(w http.ResponseWriter, r *http.Request) {
	serveConsumptionExport(w, r, true)
}

func serveConsumptionExport(w http.ResponseWriter, r *http.Request, prepare bool) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		FailWithStatus(w, http.StatusUnauthorized, "请先登录")
		return
	}
	start, end, err := consumptionRange(r, true)
	if err != nil {
		FailWithStatus(w, http.StatusBadRequest, err.Error())
		return
	}
	filter := service.ConsumptionFilter{Category: r.URL.Query().Get("category"), Status: r.URL.Query().Get("status"), Keyword: r.URL.Query().Get("keyword")}
	if err = filter.Validate(); err != nil {
		FailWithStatus(w, http.StatusBadRequest, err.Error())
		return
	}
	release, ok := acquireConsumptionExport(user.ID)
	if !ok {
		FailWithStatus(w, http.StatusTooManyRequests, "正在导出或系统繁忙，请稍后重试")
		return
	}
	defer release()
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	dir, err := os.MkdirTemp("", "consumption-export-*")
	if err != nil {
		FailError(w, err)
		return
	}
	retained := false
	defer func() {
		if !retained {
			_ = os.RemoveAll(dir)
		}
	}()
	filename := filepath.Join(dir, "consumption.xlsx")
	err = buildConsumptionExport(ctx, filename, filter, func(yield func([]service.ConsumptionLogItem) error) error {
		return service.IterateUserConsumptionLogs(ctx, user.ID, start, end, yield)
	})
	if err != nil {
		FailError(w, err)
		return
	}
	if ctx.Err() != nil {
		FailError(w, ctx.Err())
		return
	}
	if prepare {
		if err := registerConsumptionDownload(w, r, user.ID, filename, dir, r.URL.Query().Get("export_request_id")); err != nil {
			FailError(w, err)
			return
		}
		retained = true
		return
	}
	output, err := os.Open(filename)
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
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="consumption-logs.xlsx"`)
	http.ServeContent(w, r.WithContext(ctx), "consumption-logs.xlsx", info.ModTime(), output)
}

type consumptionSource func(func([]service.ConsumptionLogItem) error) error

// A disk spool discovers the union of optional visible columns without retaining
// all rows or rescanning a live database. Only already-authorized display values are spooled.
func buildConsumptionExport(ctx context.Context, filename string, filter service.ConsumptionFilter, source consumptionSource) error {
	if err := filter.Validate(); err != nil {
		return err
	}
	dir := filepath.Dir(filename)
	spool, err := os.CreateTemp(dir, ".rows-*")
	if err != nil {
		return err
	}
	defer func() { _ = spool.Close(); _ = os.Remove(spool.Name()) }()
	limited := &consumptionLimitedWriter{out: spool, ctx: ctx, max: exportDiskLimit}
	buffer := bufio.NewWriterSize(limited, 64<<10)
	encoder := json.NewEncoder(buffer)
	visible := make([]bool, len(service.ConsumptionColumns))
	for i, c := range service.ConsumptionColumns {
		visible[i] = c.Always
	}
	count := 0
	err = source(func(batch []service.ConsumptionLogItem) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(batch) > service.ConsumptionBatchSize {
			return errors.New("账单批次超过上限")
		}
		for _, item := range batch {
			if !filter.Matches(item) {
				continue
			}
			count++
			if count > service.MaxConsumptionExportRows {
				return errors.New("导出超过十万条记录，请缩小时间范围")
			}
			row := service.ConsumptionDisplayRow(item)
			if len(row) != len(visible) {
				return errors.New("导出字段数量不匹配")
			}
			for i, value := range row {
				if err := validateConsumptionCell(value); err != nil {
					return fmt.Errorf("第%d行%s：%w", count, service.ConsumptionColumns[i].Label, err)
				}
				if value != nil {
					visible[i] = true
				}
			}
			if err := encoder.Encode(row); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err = buffer.Flush(); err != nil {
		return err
	}
	if _, err = spool.Seek(0, io.SeekStart); err != nil {
		return err
	}
	book := excelize.NewFile(excelize.Options{TmpDir: dir})
	defer book.Close()
	if err = book.SetSheetName(book.GetSheetName(0), "消费明细"); err != nil {
		return err
	}
	stream, err := book.NewStreamWriter("消费明细")
	if err != nil {
		return err
	}
	headers := make([]any, 0, len(visible))
	for i, on := range visible {
		if on {
			headers = append(headers, service.ConsumptionColumns[i].Label)
		}
	}
	if err = stream.SetRow("A1", headers); err != nil {
		return err
	}
	decoder := json.NewDecoder(bufio.NewReaderSize(spool, 64<<10))
	decoder.UseNumber()
	for rowNo := 2; rowNo < count+2; rowNo++ {
		if err = ctx.Err(); err != nil {
			return err
		}
		var raw []any
		if err = decoder.Decode(&raw); err != nil {
			return err
		}
		if len(raw) != len(visible) {
			return errors.New("导出暂存字段损坏")
		}
		row := make([]any, 0, len(headers))
		for i, on := range visible {
			if !on {
				continue
			}
			value := raw[i]
			if number, ok := value.(json.Number); ok {
				n, e := number.Int64()
				if e != nil {
					return e
				}
				value = n
			}
			row = append(row, value)
		}
		if err = stream.SetRow("A"+strconv.Itoa(rowNo), row); err != nil {
			return err
		}
	}
	if err = stream.Flush(); err != nil {
		return err
	}
	output, err := os.OpenFile(filename, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer output.Close()
	zipOutput := &consumptionLimitedWriter{out: output, ctx: ctx, max: exportZipLimit}
	zw := &consumptionZipWriter{writer: zip.NewWriter(zipOutput), ctx: ctx}
	book.SetZipWriter(func(io.Writer) excelize.ZipWriter { return zw })
	if err = book.Write(io.Discard); err != nil {
		return err
	}
	return output.Sync()
}

func validateConsumptionCell(value any) error {
	s, ok := value.(string)
	if !ok {
		if f, ok := value.(float64); ok && (math.IsNaN(f) || math.IsInf(f, 0)) {
			return errors.New("数值无效")
		}
		return nil
	}
	if !utf8.ValidString(s) {
		return errors.New("文本编码无效")
	}
	units, lines := 0, 0
	for _, r := range s {
		if (r < 32 && r != '\t' && r != '\r' && r != '\n') || r == 0xfffe || r == 0xffff {
			return errors.New("文本含非法控制字符")
		}
		units++
		if r > 0xffff {
			units++
		}
		if r == '\n' {
			lines++
		}
		if units > 32767 || lines > 253 {
			return errors.New("单元格超过Excel文本上限，请缩小或调整数据，未截断内容")
		}
	}
	return nil
}

type consumptionLimitedWriter struct {
	out          io.Writer
	ctx          context.Context
	max, written int64
}

func (w *consumptionLimitedWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if int64(len(p)) > w.max-w.written {
		return 0, errors.New("导出文件超过安全大小，请缩小范围")
	}
	n, err := w.out.Write(p)
	w.written += int64(n)
	return n, err
}

type consumptionZipWriter struct {
	writer *zip.Writer
	ctx    context.Context
	raw    int64
}
type consumptionZipEntry struct {
	out   io.Writer
	owner *consumptionZipWriter
	size  int64
}

func (w *consumptionZipWriter) Create(name string) (io.Writer, error) {
	out, err := w.writer.Create(name)
	if err != nil {
		return nil, err
	}
	return &consumptionZipEntry{out: out, owner: w}, nil
}
func (w *consumptionZipWriter) AddFS(fs.FS) error { return errors.New("不支持额外文件") }
func (w *consumptionZipWriter) Close() error      { return w.writer.Close() }
func (w *consumptionZipEntry) Write(p []byte) (int, error) {
	if err := w.owner.ctx.Err(); err != nil {
		return 0, err
	}
	if int64(len(p)) > exportDiskLimit-w.size || int64(len(p)) > 2*exportDiskLimit-w.owner.raw {
		return 0, errors.New("导出内容超过安全大小")
	}
	n, err := w.out.Write(p)
	w.size += int64(n)
	w.owner.raw += int64(n)
	return n, err
}
