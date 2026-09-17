package service

import (
	"testing"
)

func TestParseErrorMessage(t *testing.T) {
	tests := []struct {
		name        string
		content     string
		other       string
		expectedMsg string
	}{
		{
			name:        "500 error",
			content:     "status_code=500, endpoint not supported",
			other:       `{"channel_id":1,"error_code":"convert_request_failed","status_code":500}`,
			expectedMsg: "该模型对应接口端点尚未开放 (500)",
		},
		{
			name:        "403 quota error",
			content:     "status_code=403, 预扣费额度失败, 用户剩余额度: ¥4.58, 需要预扣费额度: ¥17.40",
			other:       `{"status_code":403}`,
			expectedMsg: "账户算力额度不足，请充值后使用 (403)",
		},
		{
			name:        "429 rate limit",
			content:     "status_code=429, Synchronous image request limit reached. Retry later",
			other:       `{"status_code":429}`,
			expectedMsg: "超出服务并发限制，请稍候重试 (429)",
		},
		{
			name:        "502 content moderation",
			content:     "status_code=502, Your prompt or reference material was rejected by content moderation.",
			other:       `{"status_code":502}`,
			expectedMsg: "输入提示词或素材触及安全审核 (502)",
		},
		{
			name:        "refund with reason",
			content:     "",
			other:       `{"reason":"The request failed because the output video may be related to copyright restrictions."}`,
			expectedMsg: "生成内容触发版权安全策略，费用状态请查看扣费与退款记录",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg, _ := parseErrorMessage(tt.content, tt.other)
			if msg != tt.expectedMsg {
				t.Errorf("expected %q, got %q", tt.expectedMsg, msg)
			}
		})
	}
}

func TestParseTaskAction(t *testing.T) {
	tests := []struct {
		name      string
		modelName string
		content   string
		isVideo   bool
		expected  string
	}{
		{
			name:      "image to video",
			modelName: "doubao-seedance-2.0",
			content:   "操作 imageToVideo, 计算参数：seconds: 6.00",
			isVideo:   true,
			expected:  "图生视频",
		},
		{
			name:      "text to video",
			modelName: "doubao-seedance-2.0",
			content:   "操作 textGenerate, 计算参数：seconds: 15.00",
			isVideo:   true,
			expected:  "文生视频",
		},
		{
			name:      "image generation",
			modelName: "gpt-image-2-1k",
			content:   "大小 1024x1024, 品质 auto, 生成数量 1",
			isVideo:   false,
			expected:  "文生图",
		},
		{
			name:      "chat text",
			modelName: "gpt-5.6-sol",
			content:   "",
			isVideo:   false,
			expected:  "文本对话",
		},
		{
			name:      "music audio",
			modelName: "gemini-music",
			content:   "",
			isVideo:   false,
			expected:  "音频合成",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			action := parseTaskAction(tt.modelName, tt.content, tt.isVideo)
			if action != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, action)
			}
		})
	}
}
