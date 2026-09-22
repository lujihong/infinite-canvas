export function describeCanvasError(raw: string) {
    let message = raw.trim();
    let code = "";
    try {
        const parsed: unknown = JSON.parse(message);
        if (parsed && typeof parsed === "object") {
            const root = parsed as Record<string, unknown>;
            const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
            if (typeof error.message === "string") message = error.message;
            else if (typeof error.msg === "string") message = error.msg;
            if (typeof error.code === "string") code = error.code;
        }
    } catch {
        // Some upstreams return plain text rather than a JSON error envelope.
    }
    const privacy = /PrivacyInformation|real person/i.test(code + " " + message);
    const moderated = privacy || /(?:InputImage|InputVideo|InputAudio)SensitiveContentDetected/i.test(code + " " + message);
    return {
        code,
        message: message || "服务未返回具体原因，请查看任务记录后重试。",
        title: privacy ? "参考素材未通过人物隐私审核" : moderated ? "参考素材未通过内容审核" : "生成未完成",
        summary: privacy
            ? "AI 生成的写实人脸也可能触发人物审核。请先检查参考输入的素材类型和授权状态。"
            : moderated ? "上游拒绝了参考素材，请查看错误详情并检查输入。" : message || "暂未收到具体失败原因。",
        guidance: privacy
            ? "纯虚拟人物可按平台规则录入虚拟人物素材库；真实人物需本人认证和授权。入库后仍须通过审核，不保证生成成功。"
            : "",
        canRepairReference: moderated,
    };
}
