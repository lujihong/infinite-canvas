package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type registerRequest struct {
	Username         string `json:"username"`
	Password         string `json:"password"`
	Email            string `json:"email"`
	VerificationCode string `json:"verification_code"`
	Code             string `json:"code"`
}

type passwordResetRequest struct {
	Email    string `json:"email"`
	Token    string `json:"token"`
	Password string `json:"password"`
}

type saveUserRequest struct {
	ID          string           `json:"id"`
	Username    string           `json:"username"`
	Password    string           `json:"password"`
	Email       string           `json:"email"`
	DisplayName string           `json:"displayName"`
	Role        model.UserRole   `json:"role"`
	Status      model.UserStatus `json:"status"`
}

type adjustUserCreditsRequest struct {
	Credits int `json:"credits"`
}

func SendEmailVerification(w http.ResponseWriter, r *http.Request) {
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	if email == "" {
		Fail(w, "请输入有效的邮箱地址")
		return
	}
	err := service.SendNewAPIVerificationEmail(email)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func SendPasswordResetEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	email := strings.TrimSpace(req.Email)
	if email == "" {
		email = strings.TrimSpace(r.URL.Query().Get("email"))
	}
	if email == "" {
		Fail(w, "请输入有效的邮箱地址")
		return
	}
	err := service.SendNewAPIPasswordResetEmail(email)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func ResetPassword(w http.ResponseWriter, r *http.Request) {
	var req passwordResetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, "参数无效")
		return
	}
	if req.Email == "" || req.Token == "" || req.Password == "" {
		Fail(w, "邮箱、重置码和新密码不能为空")
		return
	}
	err := service.ResetNewAPIPassword(req.Email, req.Token, req.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func Register(w http.ResponseWriter, r *http.Request) {
	var request registerRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	code := request.VerificationCode
	if code == "" {
		code = request.Code
	}

	if request.Email != "" && code != "" {
		session, err := service.RegisterThroughNewAPI(request.Username, request.Password, request.Email, code)
		if err != nil {
			FailError(w, err)
			return
		}
		OK(w, session)
		return
	}

	session, err := service.Register(request.Username, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, session)
}

func Login(w http.ResponseWriter, r *http.Request) {
	var request loginRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	session, err := service.LoginThroughNewAPI(request.Username, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, session)
}

func LinuxDoAuthorize(w http.ResponseWriter, r *http.Request) {
	authURL, err := service.LinuxDoAuthorizeURL(r, r.URL.Query().Get("redirect"))
	if err != nil {
		FailError(w, err)
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

func LinuxDoCallback(w http.ResponseWriter, r *http.Request) {
	session, redirect, err := service.LoginWithLinuxDo(r, r.URL.Query().Get("code"), r.URL.Query().Get("state"))
	if err != nil {
		http.Redirect(w, r, loginRedirect(r, redirect, "", err.Error()), http.StatusFound)
		return
	}
	http.Redirect(w, r, loginRedirect(r, redirect, session.Token, ""), http.StatusFound)
}

func AdminLogin(w http.ResponseWriter, r *http.Request) {
	var request loginRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	session, err := service.Login(request.Username, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	if session.User.Role != model.UserRoleAdmin {
		Fail(w, "需要管理员权限")
		return
	}
	OK(w, session)
}

func CurrentUser(w http.ResponseWriter, r *http.Request) {
	if user, ok := service.UserFromContext(r.Context()); ok {
		OK(w, user)
		return
	}
	OK(w, service.GuestUser())
}

func AdminUsers(w http.ResponseWriter, r *http.Request) {
	users, err := service.ListUsers(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, users)
}

func AdminSaveUser(w http.ResponseWriter, r *http.Request) {
	var request saveUserRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	user, err := service.SaveUser(model.User{
		ID:          request.ID,
		Username:    request.Username,
		Email:       request.Email,
		DisplayName: request.DisplayName,
		Role:        request.Role,
		Status:      request.Status,
	}, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, user)
}

func AdminAdjustUserCredits(w http.ResponseWriter, r *http.Request, id string) {
	var request adjustUserCreditsRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	user, err := service.AdjustUserCredits(id, request.Credits)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, user)
}

func AdminCreditLogs(w http.ResponseWriter, r *http.Request) {
	logs, err := service.ListCreditLogs(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}

func AdminSaveCreditLog(w http.ResponseWriter, r *http.Request) {
	var log model.CreditLog
	_ = json.NewDecoder(r.Body).Decode(&log)
	result, err := service.SaveCreditLog(log)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminDeleteCreditLog(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteCreditLog(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func loginRedirect(r *http.Request, redirect string, token string, message string) string {
	values := url.Values{}
	if strings.TrimSpace(token) != "" {
		values.Set("token", token)
	}
	if strings.TrimSpace(message) != "" {
		values.Set("error", message)
	}
	if strings.TrimSpace(redirect) != "" {
		values.Set("redirect", redirect)
	}
	return service.RequestOrigin(r) + "/login?" + values.Encode()
}

func AdminDeleteUser(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteUser(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}
