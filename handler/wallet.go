package handler

import (
	"encoding/json"
	"net/http"

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

// UserConsumptionLogs 获取当前用户在中转站的实时消费流水记录
func UserConsumptionLogs(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "未登录或权限不足")
		return
	}

	logs, err := service.FetchUserConsumptionLogs(user.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
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
