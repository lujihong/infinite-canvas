package model

// RechargeOrder 本地充值订单实体记录
type RechargeOrder struct {
	ID            string  `json:"id" gorm:"primaryKey"`
	UserID        string  `json:"userId" gorm:"index"`
	TradeNo       string  `json:"tradeNo" gorm:"uniqueIndex"`
	Amount        int64   `json:"amount"` // 充值金额(元)
	Money         float64 `json:"money"`
	Points        float64 `json:"points"`
	PaymentMethod string  `json:"paymentMethod"`
	PaymentName   string  `json:"paymentName"`
	Status        string  `json:"status"` // pending / success / failed
	StatusLabel   string  `json:"statusLabel"`
	QRCode        string  `json:"qrcode" gorm:"type:text"`
	PayURL        string  `json:"payurl" gorm:"type:text"`
	OrderName     string  `json:"orderName"`
	CreatedAt     int64   `json:"createdAt"`
	CompletedAt   int64   `json:"completedAt"`
}
