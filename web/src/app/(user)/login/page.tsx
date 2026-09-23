"use client";

import { Suspense, useEffect, useState } from "react";
import { LockOutlined, MailOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Form, Input, Segmented, Space } from "antd";
import { useRouter, useSearchParams } from "next/navigation";

import { BrandLogo } from "@/components/layout/brand-logo";
import { fetchCurrentUser, requestPasswordReset, sendEmailVerification } from "@/services/api/auth";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { captureSessionIdentity, isSessionIdentityCurrent } from "@/lib/session-identity";

type AuthFormValues = {
    username?: string;
    email?: string;
    verification_code?: string;
    password?: string;
    confirmPassword?: string;
};

function safeRedirect(value: string | null): string {
    const cleaned = (value ?? "").replace(/[\t\n\r]/g, "");
    if (!cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.startsWith("/\\")) {
        return "/";
    }
    return cleaned;
}

export default function LoginPage() {
    return (
        <Suspense fallback={null}>
            <LoginContent />
        </Suspense>
    );
}

function LoginContent() {
    const { message } = App.useApp();
    const router = useRouter();
    const searchParams = useSearchParams();
    const login = useUserStore((state) => state.login);
    const register = useUserStore((state) => state.register);
    const setSession = useUserStore((state) => state.setSession);
    const isLoading = useUserStore((state) => state.isLoading);
    const linuxDoEnabled = useConfigStore((state) => state.publicSettings?.auth?.linuxDo?.enabled === true);
    const allowRegister = useConfigStore((state) => state.publicSettings?.auth?.allowRegister !== false);
    
    const [mode, setMode] = useState<"login" | "register" | "reset">("login");
    const [form] = Form.useForm<AuthFormValues>();
    const [countdown, setCountdown] = useState(0);
    const [isSendingCode, setIsSendingCode] = useState(false);
    const [isResetting, setIsResetting] = useState(false);

    const redirect = safeRedirect(searchParams.get("redirect"));

    useEffect(() => {
        const token = searchParams.get("token");
        const error = searchParams.get("error");
        if (error) message.error(error);
        if (!token) return;
        const callbackIdentity = captureSessionIdentity();
        void fetchCurrentUser(token).then(async (user) => {
            if (!isSessionIdentityCurrent(callbackIdentity)) return;
            await setSession(token, user);
            const active = captureSessionIdentity();
            if (active.token !== token || active.userId !== user.id) return;
            message.success("登录成功");
            router.replace(redirect);
            router.refresh();
        }).catch((error) => {
            if (isSessionIdentityCurrent(callbackIdentity)) message.error(error instanceof Error ? error.message : "登录验证失败");
        });
    }, [message, redirect, router, searchParams, setSession]);

    useEffect(() => {
        if (!allowRegister && mode === "register") setMode("login");
    }, [allowRegister, mode]);

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

    // 发送重置密码邮件
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
                const user = await register({
                    username: values.username || "",
                    password: values.password || "",
                    email: values.email,
                    verification_code: values.verification_code,
                });
                message.success("注册成功！账户与官方模型服务已全自动打通");
                router.replace(redirect);
                router.refresh();
                if (user.role !== "admin") router.replace("/");
            } else {
                const user = await login({
                    username: values.username || "",
                    password: values.password || "",
                });
                message.success("登录成功");
                router.replace(redirect);
                router.refresh();
                if (user.role !== "admin") router.replace("/");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败，请检查账号密码");
        }
    };

    return (
        <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1.2px,transparent_1.2px)] px-4 py-12 [background-size:20px_20px] dark:bg-[radial-gradient(rgba(245,245,244,.12)_1.2px,transparent_1.2px)]">
            <section className="w-full max-w-[460px] rounded-3xl border border-stone-200/80 bg-white/90 p-8 shadow-2xl backdrop-blur-2xl dark:border-stone-800/80 dark:bg-stone-900/90 dark:shadow-[0_25px_65px_-15px_rgba(0,0,0,0.7)] sm:p-10">
                <div className="mb-8 text-center">
                    <div className="mx-auto mb-5 flex h-20 w-full items-center justify-center">
                        <BrandLogo className="h-full w-auto max-w-[240px] drop-shadow-md transition-transform duration-500 hover:scale-105" alt="鑫元宝视频创作工作台" />
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100 sm:text-[26px]">
                        {mode === "register"
                            ? "注册新账号"
                            : mode === "reset"
                            ? "找回密码"
                            : "鑫元宝视频创作工作台"}
                    </h1>
                    <p className="mt-2 text-sm font-normal leading-relaxed text-stone-500 dark:text-stone-400">
                        {mode === "reset"
                            ? "输入注册邮箱获取官方安全密码重置邮件"
                            : "账号与鑫元宝模型服务平台统一互通 · 算力即时同步"}
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
                        <Form.Item className="mb-6">
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
                            className="mb-4"
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
                            className="mb-4"
                        >
                            <Input prefix={<MailOutlined className="text-stone-400" />} placeholder="请输入电子邮箱" autoComplete="email" />
                        </Form.Item>
                    ) : null}

                    {mode === "register" ? (
                        <Form.Item
                            label={<span className="text-xs font-medium text-stone-700 dark:text-stone-300">邮箱验证码</span>}
                            className="mb-4"
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
                                className="mb-4"
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
                            className="mb-6"
                        >
                            <Input.Password prefix={<LockOutlined className="text-stone-400" />} placeholder="请再次输入密码" autoComplete="new-password" />
                        </Form.Item>
                    ) : null}

                    <Space direction="vertical" size={12} style={{ width: "100%", marginTop: 8 }}>
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
                                    <Button block href={`/api/auth/linux-do/authorize?redirect=${encodeURIComponent(redirect)}`} icon={<img src="/icons/linuxdo.svg" alt="" width={18} height={18} />}>
                                        使用 Linux.do 登录
                                    </Button>
                                ) : null}
                            </>
                        )}
                    </Space>
                </Form>
            </section>
        </main>
    );
}
