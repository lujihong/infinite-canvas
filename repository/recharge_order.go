package repository

import (
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SaveRechargeOrder 保存或更新充值订单
func SaveRechargeOrder(order model.RechargeOrder) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "trade_no"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"status", "status_label", "completed_at", "money", "points", "qrcode", "pay_url",
		}),
	}).Create(&order).Error
}

// GetRechargeOrderByTradeNo 根据订单号查询充值订单
func GetRechargeOrderByTradeNo(tradeNo string) (model.RechargeOrder, bool, error) {
	tradeNo = strings.TrimSpace(tradeNo)
	if tradeNo == "" {
		return model.RechargeOrder{}, false, nil
	}
	db, err := DB()
	if err != nil {
		return model.RechargeOrder{}, false, err
	}
	var order model.RechargeOrder
	if err := db.Where("trade_no = ?", tradeNo).First(&order).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return model.RechargeOrder{}, false, nil
		}
		return model.RechargeOrder{}, false, err
	}
	return order, true, nil
}

// UpdateRechargeOrderStatus 更新充值订单状态
func UpdateRechargeOrderStatus(tradeNo string, status string, statusLabel string, completedAt int64) error {
	tradeNo = strings.TrimSpace(tradeNo)
	if tradeNo == "" {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	updates := map[string]any{
		"status":       status,
		"status_label": statusLabel,
	}
	if completedAt > 0 {
		updates["completed_at"] = completedAt
	}
	return db.Model(&model.RechargeOrder{}).Where("trade_no = ?", tradeNo).Updates(updates).Error
}

// ListRechargeOrdersByUserID 根据用户 ID 查询充值订单列表（倒序）
func ListRechargeOrdersByUserID(userID string, limit int) ([]model.RechargeOrder, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return []model.RechargeOrder{}, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var orders []model.RechargeOrder
	if err := db.Where("user_id = ?", userID).Order("created_at desc").Limit(limit).Find(&orders).Error; err != nil {
		return nil, err
	}
	return orders, nil
}

// ListPendingRechargeOrders 查询所有待支付的订单（用于补偿对账）
func ListPendingRechargeOrders(limit int) ([]model.RechargeOrder, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var orders []model.RechargeOrder
	cutoff := time.Now().Add(-24 * time.Hour).Unix()
	if err := db.Where("status = ? AND created_at > ?", "pending", cutoff).Order("created_at desc").Limit(limit).Find(&orders).Error; err != nil {
		return nil, err
	}
	return orders, nil
}
