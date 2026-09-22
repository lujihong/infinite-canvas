package handler

import (
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

// RequestQuote uses only the authenticated session identity, never client credentials.
func RequestQuote(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		FailWithStatus(w, http.StatusUnauthorized, "请先登录后查看本人报价")
		return
	}
	if r.Method != http.MethodPost {
		FailWithStatus(w, http.StatusMethodNotAllowed, "报价仅支持 POST")
		return
	}
	if r.ContentLength > service.RequestQuoteMaxBytes {
		FailWithStatus(w, http.StatusRequestEntityTooLarge, "报价请求不得超过 1 MiB")
		return
	}
	input, err := service.DecodeRequestQuote(r.Body)
	if err != nil {
		// Do not log or echo generation parameters, URLs or credentials.
		FailWithStatus(w, http.StatusBadRequest, err.Error())
		return
	}
	channelID, userChannelID := r.Header.Get("X-Model-Channel-ID"), r.Header.Get(userModelChannelHeader)
	if len(r.Header.Values("X-Model-Channel-ID")) > 1 || len(r.Header.Values(userModelChannelHeader)) > 1 {
		FailWithStatus(w, http.StatusBadRequest, "报价渠道参数无效")
		return
	}
	result, err := service.FetchRequestQuote(r.Context(), user.ID, input, channelID, userChannelID)
	if err != nil {
		FailWithStatus(w, http.StatusBadRequest, "报价请求无效")
		return
	}
	OK(w, result)
}
