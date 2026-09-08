package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type UserConfigPayload struct {
	ModelConfig      json.RawMessage       `json:"modelConfig,omitempty"`
	StorageProvider  *UserStorageProviders `json:"storageProvider,omitempty"`
	ImageHistory     json.RawMessage       `json:"imageHistory,omitempty"`
	AssetData        json.RawMessage       `json:"assetData,omitempty"`
	SyncCapabilities map[string]bool       `json:"syncCapabilities,omitempty"`
}

type StorageObjectProviderInput struct {
	Enabled         *bool  `json:"enabled,omitempty"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	PublicBaseURL   string `json:"publicBaseUrl"`
	PathPrefix      string `json:"pathPrefix"`
	Username        string `json:"username"`
	Password        string `json:"password"`
}

type UserStorageProviders struct {
	S3     *StorageObjectProviderInput `json:"s3,omitempty"`
	WebDAV *StorageObjectProviderInput `json:"webdav,omitempty"`
}

type userModelConfigInput struct {
	LocalChannels []userLocalModelChannelInput `json:"localChannels"`
}

type userLocalModelChannelInput struct {
	ID       string   `json:"id"`
	Protocol string   `json:"protocol"`
	Name     string   `json:"name"`
	BaseURL  string   `json:"baseUrl"`
	APIKey   string   `json:"apiKey"`
	Models   []string `json:"models"`
}

func SelectUserLocalModelChannelForModel(userID string, modelName string, channelID string) (model.ModelChannel, error) {
	userID = strings.TrimSpace(userID)
	modelName = strings.TrimSpace(modelName)
	channelID = strings.TrimSpace(channelID)
	if userID == "" {
		return model.ModelChannel{}, errors.New("请先登录")
	}
	config, ok, err := repository.GetUserConfig(userID)
	if err != nil {
		return model.ModelChannel{}, err
	}
	if !ok || strings.TrimSpace(config.ModelConfig) == "" {
		return model.ModelChannel{}, errors.New("本地渠道不存在")
	}
	var modelConfig userModelConfigInput
	if err := json.Unmarshal([]byte(config.ModelConfig), &modelConfig); err != nil {
		return model.ModelChannel{}, err
	}
	if len(modelConfig.LocalChannels) == 0 {
		return model.ModelChannel{}, errors.New("本地渠道不存在")
	}
	// 查找匹配的渠道
	var targetChannel *userLocalModelChannelInput
	if channelID != "" {
		for i := range modelConfig.LocalChannels {
			if strings.TrimSpace(modelConfig.LocalChannels[i].ID) == channelID {
				targetChannel = &modelConfig.LocalChannels[i]
				break
			}
		}
	}
	// 如果未指定 channelID 或没找到，尝试通过 modelName 匹配
	if targetChannel == nil && modelName != "" {
		for i := range modelConfig.LocalChannels {
			models := userLocalChannelModels(modelConfig.LocalChannels[i].Models)
			if userLocalChannelHasModel(models, modelName) {
				targetChannel = &modelConfig.LocalChannels[i]
				break
			}
		}
	}
	// 依然没有匹配，默认使用第一个有效本地渠道
	if targetChannel == nil {
		targetChannel = &modelConfig.LocalChannels[0]
	}

	baseURL := strings.TrimSpace(targetChannel.BaseURL)
	apiKey := strings.TrimSpace(targetChannel.APIKey)
	if baseURL == "" || apiKey == "" {
		return model.ModelChannel{}, errors.New("本地渠道配置不完整")
	}
	models := userLocalChannelModels(targetChannel.Models)
	protocol := strings.ToLower(strings.TrimSpace(targetChannel.Protocol))
	if protocol == "" {
		protocol = "openai"
	}
	return model.ModelChannel{
		ID:       firstVideoTaskValue(targetChannel.ID, "local-1"),
		Protocol: protocol,
		Name:     firstVideoTaskValue(strings.TrimSpace(targetChannel.Name), "本地直连"),
		BaseURL:  baseURL,
		APIKey:   apiKey,
		Models:   models,
		Weight:   1,
		Timeout:  600,
		Enabled:  true,
	}, nil
}

func userLocalChannelModels(models []string) []string {
	result := make([]string, 0, len(models))
	seen := map[string]bool{}
	for _, item := range models {
		modelName := strings.TrimSpace(item)
		if modelName == "" || seen[modelName] {
			continue
		}
		result = append(result, modelName)
		seen[modelName] = true
	}
	return result
}

func userLocalChannelHasModel(models []string, modelName string) bool {
	for _, item := range models {
		if strings.EqualFold(strings.TrimSpace(item), modelName) {
			return true
		}
	}
	return false
}

func CurrentUserConfig(ctx context.Context) (UserConfigPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UserConfigPayload{}, errors.New("请先登录")
	}
	config, ok, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return UserConfigPayload{}, err
	}
	result := UserConfigPayload{
		SyncCapabilities: map[string]bool{
			"userData":  true,
			"workflows": true,
			"assets":    true,
		},
	}
	if !ok {
		return result, nil
	}
	if strings.TrimSpace(config.ModelConfig) != "" {
		var parsed map[string]any
		if json.Unmarshal([]byte(config.ModelConfig), &parsed) == nil {
			publicSetting, _ := PublicSettings()
			availableModels := publicSetting.ModelChannel.AvailableModels
			if len(availableModels) > 0 {
				if rawChannels, ok := parsed["localChannels"].([]any); ok {
					hasChange := false
					for i, chRaw := range rawChannels {
						if chMap, ok := chRaw.(map[string]any); ok {
							id, _ := chMap["id"].(string)
							if id == "xyb-official-exclusive" {
								chMap["models"] = availableModels
								rawChannels[i] = chMap
								hasChange = true
							}
						}
					}
					if hasChange {
						parsed["localChannels"] = rawChannels
						if newBytes, err := json.Marshal(parsed); err == nil {
							config.ModelConfig = string(newBytes)
						}
					}
				}
			}
		}
		result.ModelConfig = json.RawMessage(config.ModelConfig)
	}
	if strings.TrimSpace(config.StorageProvider) != "" {
		providers := readUserStorageProviders(config.StorageProvider)
		var syncFlags struct {
			SyncStorageConfig       bool `json:"syncStorageConfig"`
			SyncWebDAVStorageConfig bool `json:"syncWebDAVStorageConfig"`
		}
		_ = json.Unmarshal(result.ModelConfig, &syncFlags)
		if !syncFlags.SyncStorageConfig {
			providers.S3 = nil
		}
		if !syncFlags.SyncWebDAVStorageConfig {
			providers.WebDAV = nil
		}
		if providers.S3 != nil || providers.WebDAV != nil {
			result.StorageProvider = &providers
		}
	}
	if strings.TrimSpace(config.ImageHistory) != "" {
		result.ImageHistory = json.RawMessage(config.ImageHistory)
	}
	if strings.TrimSpace(config.AssetData) != "" {
		result.AssetData = json.RawMessage(config.AssetData)
	}
	return result, nil
}

func readUserStorageProviders(raw string) UserStorageProviders {
	var providers UserStorageProviders
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &providers)
	}
	return providers
}

func SaveCurrentUserModelConfig(ctx context.Context, raw json.RawMessage) (UserConfigPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UserConfigPayload{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return UserConfigPayload{}, err
	}
	current := now()
	if config.UserID == "" {
		config.UserID = user.ID
		config.CreatedAt = current
	}
	config.ModelConfig = string(raw)
	config.UpdatedAt = current
	if _, err := repository.SaveUserConfig(config); err != nil {
		return UserConfigPayload{}, err
	}
	return CurrentUserConfig(ctx)
}

func CurrentUserImageHistory(ctx context.Context) (json.RawMessage, error) {
	config, err := currentUserConfig(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.ImageHistory) == "" {
		return json.RawMessage(`{"logs":[],"categories":[]}`), nil
	}
	return json.RawMessage(config.ImageHistory), nil
}

func SaveCurrentUserImageHistory(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	config, err := saveCurrentUserConfigField(ctx, func(config *model.UserConfig) {
		config.ImageHistory = string(raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(config.ImageHistory), nil
}

func CurrentUserAssetData(ctx context.Context) (json.RawMessage, error) {
	config, err := currentUserConfig(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.AssetData) == "" {
		return json.RawMessage(`{"assets":[]}`), nil
	}
	return json.RawMessage(config.AssetData), nil
}

func SaveCurrentUserAssetData(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	config, err := saveCurrentUserConfigField(ctx, func(config *model.UserConfig) {
		config.AssetData = string(raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(config.AssetData), nil
}

func currentUserConfig(ctx context.Context) (model.UserConfig, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.UserConfig{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return model.UserConfig{}, err
	}
	if config.UserID == "" {
		config.UserID = user.ID
	}
	return config, nil
}

func saveCurrentUserConfigField(ctx context.Context, patch func(config *model.UserConfig)) (model.UserConfig, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.UserConfig{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return model.UserConfig{}, err
	}
	current := now()
	if config.UserID == "" {
		config.UserID = user.ID
		config.CreatedAt = current
	}
	patch(&config)
	config.UpdatedAt = current
	return repository.SaveUserConfig(config)
}
