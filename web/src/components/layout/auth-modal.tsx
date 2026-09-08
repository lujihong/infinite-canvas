"use client";

import { useEffect, useState } from "react";
import { LockOutlined, MailOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Checkbox, Form, Input, Modal, Segmented, Space } from "antd";

import { BrandLogo } from "@/components/layout/brand-logo";
import { LegalModal, type LegalDocType } from "@/components/layout/legal-modal";
import { requestPasswordReset, sendEmailVerification } from "@/services/api/auth";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type AuthFormValues = {
    username?: string;
    email?: string;
    verification_code?: string;
    password?: string;
    confirmPassword?: string;
};

export function AuthModal() {
    const { message } = App.useApp();
    const isLoginModalOpen = useUserStore((state) => state.isLoginModalOpen);
    const closeLoginModal = useUserStore((state) => state.closeLoginModal);
    const login = useUserStore((state) => state.login);
    const register = useUserStore((state) => state.register);
    const isLoading = useUserStore((state) => state.isLoading);
    const user = useUserStore((state) => state.user);
    const allowRegister = useConfigStore((state) => state.publicSettings?.auth?.allowRegister !== false);
    const linuxDoEnabled = useConfigStore((state) => state.publicSettings?.auth?.linuxDo?.enabled === true);

    const [mode, setMode] = useState<"login" | "register" | "reset">("login");
    const [form] = Form.useForm<AuthFormValues>();

    const [countdown, setCountdown] = useState(0);
    const [isSendingCode, setIsSendingCode] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [legalDoc, setLegalDoc] = useState<LegalDocType>(null);

    useEffect(() => {
        if (user) {
            closeLoginModal();
        }
    }, [user, closeLoginModal]);

    useEffect(() => {
        if (countdown <= 0) return;
        const timer = setInterval(() => {
            setCountdown((prev) => prev - 1);
        }, 1000);
        return () => clearInterval(timer);
    }, [countdown]);

    // 发送邮箱验证码
    const handleSendCode = async () => {
        const email = form.getFieldValue("email")?.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            message.warning("请先输入有效的电子邮箱地址");
            return;
        }

        setIsSendingCode(true);
        try {
            await sendEmailVerification(email);
            message.success("验证码邮件已发送，请前往企业邮箱查收");
            setCountdown(60);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "发送验证码失败，请稍后重试");
        } finally {
            setIsSendingCode(false);
        }
    };

    // 发送密码重置邮件
    const handleSendResetEmail = async () => {
        const email = form.getFieldValue("email")?.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            message.warning("请输入您注册时绑定的电子邮箱");
            return;
        }

        setIsResetting(true);
        try {
            await requestPasswordReset(email);
            message.success("密码重置邮件已成功下发，请查收邮件并完成重置");
            setMode("login");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "请求密码重置失败");
        } finally {
            setIsResetting(false);
        }
    };

    const submit = async (values: AuthFormValues) => {
        try {
            if (mode === "reset") {
                await handleSendResetEmail();
                return;
            }

            if (mode === "register") {
                if (!allowRegister) {
                    message.error("当前未开放注册");
                    return;
                }
                if (values.password !== values.confirmPassword) {
                    message.error("两次输入的密码不一致");
                    return;
                }
                if (!values.email || !values.verification_code) {
                    message.error("请填写电子邮箱并输入验证码");
                    return;
                }
                await register({
                    username: values.username || "",
                    password: values.password || "",
                    email: values.email,
                    verification_code: values.verification_code,
                });
                message.success("注册成功！账户与模型云已自动打通");
            } else {
                await login({
                    username: values.username || "",
                    password: values.password || "",
                });
                message.success("登录成功");
            }

            form.resetFields();
            closeLoginModal();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败，请检查输入");
        }
    };

    return (
        <Modal
            open={isLoginModalOpen}
            onCancel={closeLoginModal}
            footer={null}
            centered
            width={420}
            destroyOnClose
        >
            <div className="pt-2 pb-1">
                <div className="mb-6 text-center">
                    <div className="mx-auto mb-3.5 flex h-14 w-full items-center justify-center">
                        <BrandLogo className="h-full w-auto max-w-[180px]" alt="鑫元宝视频创作工作台" />
                    </div>
                    <h2 className="text-xl font-bold tracking-tight text-stone-950 dark:text-stone-100">
                        {mode === "register"
                            ? "注册新账号"
                            : mode === "reset"
                            ? "找回密码"
                            : "登录鑫元宝视频创作工作台"}
                    </h2>
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                        {mode === "reset"
                            ? "输入注册绑定的邮箱，获取官方安全重置邮件"
                            : "账号与鑫元宝模型服务平台统一互通"}
                    </p>
                </div>

                <Form<AuthFormValues>
                    form={form}
                    layout="vertical"
                    size="large"
                    requiredMark={false}
                    onFinish={submit}
                >
                    {mode !== "reset" ? (
                        <Form.Item className="mb-4">
                            <Segmented
                                block
                                value={mode}
                                onChange={(value) => setMode(value as "login" | "register")}
                                options={
                                    allowRegister
                                        ? [
                                              { label: "账号登录", value: "login" },
                                              { label: "邮箱注册", value: "register" },
                                          ]
                                        : [{ label: "账号登录", value: "login" }]
                                }
                            />
                        </Form.Item>
                    ) : null}

                    {mode !== "reset" ? (
                        <Form.Item
                            name="username"
                            label={<span className="text-xs font-medium text-stone-700 dark:text-stone-300">用户名</span>}
                            rules={[{ required: true, message: "请输入用户名" }]}
                            className="mb-3"
                        >
                            <Input prefix={<UserOutlined className="text-stone-400" />} placeholder="请输入用户名" autoComplete="username" />
                        </Form.Item>
                    ) : null}

                    {mode === "register" || mode === "reset" ? (
                        <Form.Item
                            name="email"
                            label={<span className="text-xs font-medium text-stone-700 dark:text-stone-300">电子邮箱</span>}
                            rules={[
                                { required: true, message: "请输入电子邮箱" },
                                { type: "email", message: "邮箱格式不正确" },
                            ]}
                            className="mb-3"
                        >
                            <Input prefix={<MailOutlined className="text-stone-400" />} placeholder="请输入电子邮箱" autoComplete="email" />
                        </Form.Item>
                    ) : null}

                    {mode === "register" ? (
                        <Form.Item
                            label={<span className="text-xs font-medium text-stone-700 dark:text-stone-300">邮箱验证码</span>}
                            className="mb-3"
                        >
                            <div className="flex gap-2">
                                <Form.Item
                                    name="verification_code"
                                    noStyle
                                    rules={[{ required: true, message: "请输入6位验证码" }]}
                                >
                                    <Input
                                        prefix={<SafetyCertificateOutlined className="text-stone-400" />}
                                        placeholder="6位验证码"
                                        maxLength={6}
                                        className="font-mono tracking-widest"
                                    />
                                </Form.Item>
                                <Button
                                    type="default"
                                    disabled={countdown > 0}
                                    loading={isSendingCode}
                                    onClick={handleSendCode}
                                    className="shrink-0 min-w-[110px]"
                                >
                                    {countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
                                </Button>
                            </div>
                        </Form.Item>
                    ) : null}

                    {mode !== "reset" ? (
                        <>
                            <div className="mb-1.5 flex items-center justify-between">
                                <span className="text-xs font-medium text-stone-700 dark:text-stone-300">密码</span>
                                {mode === "login" ? (
                                    <button
                                        type="button"
                                        onClick={() => setMode("reset")}
                                        className="text-xs font-normal text-sky-600 hover:text-sky-500 dark:text-sky-400 cursor-pointer transition-colors"
                                    >
                                        忘记密码？
                                    </button>
                                ) : null}
                            </div>
                            <Form.Item
                                name="password"
                                rules={[{ required: true, message: "请输入密码" }]}
                                className="mb-3"
                            >
                                <Input.Password prefix={<LockOutlined className="text-stone-400" />} placeholder="请输入密码" autoComplete="current-password" />
                            </Form.Item>
                        </>
                    ) : null}

                    {mode === "register" ? (
                        <Form.Item
                            name="confirmPassword"
                            label={<span className="text-xs font-medium text-stone-700 dark:text-stone-300">确认密码</span>}
                            rules={[{ required: true, message: "请再次输入密码" }]}
                            className="mb-3"
                        >
                            <Input.Password prefix={<LockOutlined className="text-stone-400" />} placeholder="请再次输入密码" autoComplete="new-password" />
                        </Form.Item>
                    ) : null}

                    {mode === "register" ? (
                        <Form.Item
                            name="agreement"
                            valuePropName="checked"
                            rules={[
                                {
                                    validator: (_, value) =>
                                        value
                                            ? Promise.resolve()
                                            : Promise.reject(new Error("请先阅读并同意《用户服务协议》与《隐私政策》")),
                                },
                            ]}
                            className="mb-4"
                        >
                            <Checkbox className="text-xs text-stone-600 dark:text-stone-400">
                                <span>我已阅读并同意</span>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setLegalDoc("agreement");
                                    }}
                                    className="ml-1 cursor-pointer font-medium text-sky-600 hover:text-sky-500 underline"
                                >
                                    《用户服务协议》
                                </button>
                                <span>与</span>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setLegalDoc("privacy");
                                    }}
                                    className="ml-0.5 cursor-pointer font-medium text-sky-600 hover:text-sky-500 underline"
                                >
                                    《隐私政策》
                                </button>
                            </Checkbox>
                        </Form.Item>
                    ) : null}

                    <Space direction="vertical" size={10} style={{ width: "100%", marginTop: 8 }}>
                        {mode === "reset" ? (
                            <>
                                <Button block type="primary" htmlType="submit" loading={isResetting}>
                                    发送重置密码邮件
                                </Button>
                                <Button block type="text" onClick={() => setMode("login")}>
                                    返回登录
                                </Button>
                            </>
                        ) : (
                            <>
                                <Button block type="primary" htmlType="submit" loading={isLoading}>
                                    {mode === "register" ? "立即注册并开始创作" : "立即登录"}
                                </Button>
                                {linuxDoEnabled ? (
                                    <Button block href="/api/auth/linux-do/authorize" icon={<img src="/icons/linuxdo.svg" alt="" width={16} height={16} />}>
                                        使用 Linux.do 登录
                                    </Button>
                                ) : null}
                            </>
                        )}
                    </Space>

                    {mode === "login" ? (
                        <div className="mt-3 text-center text-[11px] text-stone-400 dark:text-stone-500">
                            <span>登录即代表您已阅读并同意</span>
                            <button
                                type="button"
                                onClick={() => setLegalDoc("agreement")}
                                className="mx-0.5 cursor-pointer text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 underline"
                            >
                                《用户服务协议》
                            </button>
                            <span>与</span>
                            <button
                                type="button"
                                onClick={() => setLegalDoc("privacy")}
                                className="ml-0.5 cursor-pointer text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 underline"
                            >
                                《隐私政策》
                            </button>
                        </div>
                    ) : null}
                </Form>
            </div>

            <LegalModal
                type={legalDoc}
                open={Boolean(legalDoc)}
                onClose={() => setLegalDoc(null)}
            />
        </Modal>
    );
}
