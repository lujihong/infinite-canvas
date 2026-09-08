"use client";

import {
    AspectRatio,
    EditorClip,
    EditorTrack,
    getClipEffectiveDuration,
    getClipEndTime,
} from "@/stores/use-editor-store";

export type ViewportDimensions = {
    width: number;
    height: number;
};

export function getResolutionForAspectRatio(ratio: AspectRatio): ViewportDimensions {
    switch (ratio) {
        case "9:16":
            return { width: 1080, height: 1920 };
        case "1:1":
            return { width: 1080, height: 1080 };
        case "4:3":
            return { width: 1440, height: 1080 };
        case "16:9":
        default:
            return { width: 1920, height: 1080 };
    }
}

// 客户端媒体元素内存缓存池
const videoElementPool = new Map<string, HTMLVideoElement>();
const imageElementPool = new Map<string, HTMLImageElement>();
const audioElementPool = new Map<string, HTMLAudioElement>();

export function getCachedVideoElement(url: string): HTMLVideoElement {
    if (typeof window === "undefined" || !url || typeof url !== "string" || !url.trim()) {
        return (typeof document !== "undefined" ? document.createElement("video") : {}) as HTMLVideoElement;
    }
    const cleanUrl = url.trim();
    let video = videoElementPool.get(cleanUrl);
    if (!video) {
        video = document.createElement("video");
        video.crossOrigin = "anonymous";
        video.playsInline = true;
        video.muted = true;
        video.preload = "auto";
        video.src = cleanUrl;
        videoElementPool.set(cleanUrl, video);
    }
    return video;
}

export function getCachedImageElement(url: string): HTMLImageElement {
    if (typeof window === "undefined" || !url || typeof url !== "string" || !url.trim()) {
        return (typeof Image !== "undefined" ? new window.Image() : {}) as HTMLImageElement;
    }
    const cleanUrl = url.trim();
    let img = imageElementPool.get(cleanUrl);
    if (!img) {
        img = new window.Image();
        img.crossOrigin = "anonymous";
        img.src = cleanUrl;
        imageElementPool.set(cleanUrl, img);
    }
    return img;
}

export function getCachedAudioElement(url: string): HTMLAudioElement {
    if (typeof window === "undefined" || !url || typeof url !== "string" || !url.trim()) {
        return (typeof document !== "undefined" ? document.createElement("audio") : {}) as HTMLAudioElement;
    }
    const cleanUrl = url.trim();
    let audio = audioElementPool.get(cleanUrl);
    if (!audio) {
        audio = document.createElement("audio");
        audio.crossOrigin = "anonymous";
        audio.preload = "auto";
        audio.src = cleanUrl;
        audioElementPool.set(cleanUrl, audio);
    }
    return audio;
}

/**
 * 格式化秒数为时间码展示：00:00:00 或 00:00.0
 */
export function formatTimecode(seconds: number, includeMs = false): string {
    const s = Math.max(0, seconds);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);

    const pad = (n: number) => n.toString().padStart(2, "0");
    if (includeMs) {
        return `${pad(mins)}:${pad(secs)}.${ms}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
}

/**
 * 等待视频精准定位到特定时间帧并完成显存解码
 */
function seekVideoToTime(video: HTMLVideoElement, time: number): Promise<void> {
    return new Promise((resolve) => {
        if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2 && !video.seeking) {
            resolve();
            return;
        }

        let resolved = false;
        const done = () => {
            if (resolved) return;
            resolved = true;
            video.removeEventListener("seeked", onSeeked);
            video.removeEventListener("error", done);
            if (timer) clearTimeout(timer);
            resolve();
        };

        const onSeeked = () => {
            if ("requestVideoFrameCallback" in video) {
                (video as any).requestVideoFrameCallback(() => done());
            } else {
                done();
            }
        };

        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", done, { once: true });
        // 给予充分的时间（600ms）确保关键帧寻道与解码完成，杜绝早退导致黑帧
        const timer = window.setTimeout(done, 600);
        video.currentTime = Math.max(0, time);
    });
}

/**
 * 绘制一帧合成画面到指定 Canvas
 */
export function renderCompositedFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    time: number,
    tracks: EditorTrack[],
    options?: {
        frameOverrides?: Map<string, CanvasImageSource>;
    }
) {
    // 1. 底层背景填充（影院级纯黑底色）
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // 2. 按轨道层级自底向上叠加：视频主轨 -> 贴图/画中画轨 -> 文字字幕轨
    const sortedTracks = [...tracks].sort((a, b) => {
        const order: Record<string, number> = { video: 1, audio: 2, overlay: 3, text: 4 };
        return (order[a.type] || 0) - (order[b.type] || 0);
    });

    for (const track of sortedTracks) {
        if (track.hidden) continue;

        const activeClip = track.clips.find((clip) => {
            const start = clip.startTime;
            const end = getClipEndTime(clip);
            return time >= start && time < end;
        });

        if (!activeClip) continue;

        if (activeClip.type === "video") {
            const override = options?.frameOverrides?.get(activeClip.id);
            if (override) {
                drawMediaCover(ctx, override, width, height);
            } else {
                const video = getCachedVideoElement(activeClip.sourceUrl);
                // 纯渲染函数仅读取当前视频显存帧，绝不在绘制管线中突发触发任何破坏性 seek
                if (video.readyState >= 2) {
                    drawMediaCover(ctx, video, width, height);
                }
            }
        } else if (activeClip.type === "image") {
            const img = getCachedImageElement(activeClip.sourceUrl);
            if (img.complete && img.naturalWidth > 0) {
                drawMediaCover(ctx, img, width, height);
            }
        } else if (activeClip.type === "text" && activeClip.textProps) {
            drawTextSubtitle(ctx, activeClip.textProps, width, height);
        }
    }
}

/**
 * 等比居中填充绘制媒体（Cover 模式，画面充盈无黑边）
 */
function drawMediaCover(
    ctx: CanvasRenderingContext2D,
    media: CanvasImageSource,
    canvasWidth: number,
    canvasHeight: number
) {
    let mediaWidth = 0;
    let mediaHeight = 0;
    if ("videoWidth" in (media as any) && (media as any).videoWidth) {
        mediaWidth = (media as any).videoWidth;
        mediaHeight = (media as any).videoHeight;
    } else if ("naturalWidth" in (media as any) && (media as any).naturalWidth) {
        mediaWidth = (media as any).naturalWidth;
        mediaHeight = (media as any).naturalHeight;
    } else if ("width" in (media as any) && typeof (media as any).width === "number") {
        mediaWidth = (media as any).width;
        mediaHeight = (media as any).height;
    }

    if (mediaWidth <= 0 || mediaHeight <= 0) return;

    const scale = Math.max(canvasWidth / mediaWidth, canvasHeight / mediaHeight);
    const scaledWidth = mediaWidth * scale;
    const scaledHeight = mediaHeight * scale;
    const x = (canvasWidth - scaledWidth) / 2;
    const y = (canvasHeight - scaledHeight) / 2;

    ctx.drawImage(media, 0, 0, mediaWidth, mediaHeight, x, y, scaledWidth, scaledHeight);
}

/**
 * 绘制文字字幕与标题
 */
function drawTextSubtitle(
    ctx: CanvasRenderingContext2D,
    props: NonNullable<EditorClip["textProps"]>,
    canvasWidth: number,
    canvasHeight: number
) {
    const text = (props.text || "").trim();
    if (!text) return;

    ctx.save();
    const fontSize = Math.round(props.fontSize * (canvasWidth / 1080));
    const fontWeight = props.fontStyle === "bold" ? "700" : "500";
    ctx.font = `${fontWeight} ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = props.align || "center";
    ctx.textBaseline = "middle";

    const x = props.align === "left" ? canvasWidth * 0.1 : props.align === "right" ? canvasWidth * 0.9 : canvasWidth / 2;
    const y = (canvasHeight * (props.yPercent || 80)) / 100;

    if (props.bgColor) {
        const metrics = ctx.measureText(text);
        const paddingX = fontSize * 0.6;
        const paddingY = fontSize * 0.35;
        const bgWidth = metrics.width + paddingX * 2;
        const bgHeight = fontSize + paddingY * 2;
        const bgX = x - (props.align === "left" ? 0 : props.align === "right" ? bgWidth : bgWidth / 2);
        const bgY = y - bgHeight / 2;

        ctx.fillStyle = props.bgColor;
        ctx.beginPath();
        ctx.roundRect(bgX, bgY, bgWidth, bgHeight, 8);
        ctx.fill();
    }

    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = Math.round(fontSize * 0.25);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    ctx.fillStyle = props.color || "#FFFFFF";
    ctx.fillText(text, x, y);

    ctx.restore();
}

export type LocalExportResult = {
    blob: Blob;
    extension: "mp4" | "webm";
    mimeType: string;
};

/**
 * 基于 Web Audio API 的离线混音引擎：将时间轴的所有音轨无损混合为单一音频缓冲流
 */
async function buildMixedAudioBuffer(
    tracks: EditorTrack[],
    totalDuration: number,
    signal?: AbortSignal
): Promise<AudioBuffer | null> {
    try {
        if (signal?.aborted) return null;
        const audioTracks = tracks.filter((t) => !t.muted && (t.type === "audio" || t.type === "video"));
        const clipsWithAudio = audioTracks.flatMap((t) => t.clips.filter((c) => (c.type === "audio" || c.type === "video") && c.sourceUrl));
        if (!clipsWithAudio.length) return null;

        const sampleRate = 44100;
        const totalSamples = Math.ceil(totalDuration * sampleRate);
        const OfflineCtxClass = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
        if (!OfflineCtxClass) return null;

        const offlineCtx = new OfflineCtxClass(2, totalSamples, sampleRate);

        // 异步抓取并解码各片段音频
        await Promise.all(
            clipsWithAudio.map(async (clip) => {
                try {
                    if (signal?.aborted) return;
                    const res = await fetch(clip.sourceUrl, { signal }).catch(() => null);
                    if (!res || !res.ok) return;
                    const arrayBuffer = await res.arrayBuffer();
                    if (signal?.aborted) return;
                    const decoded = await offlineCtx.decodeAudioData(arrayBuffer);

                    const source = offlineCtx.createBufferSource();
                    source.buffer = decoded;
                    source.playbackRate.value = clip.speed || 1.0;

                    const gain = offlineCtx.createGain();
                    gain.gain.value = clip.volume !== undefined ? clip.volume : 1.0;

                    source.connect(gain);
                    gain.connect(offlineCtx.destination);

                    const durationToPlay = Math.max(0.1, clip.trimEnd - clip.trimStart);
                    source.start(clip.startTime, clip.trimStart, durationToPlay);
                } catch {
                    // 单个文件音频解码失败不阻断整体流程
                }
            })
        );

        if (signal?.aborted) return null;
        return await offlineCtx.startRendering();
    } catch {
        return null;
    }
}

/**
 * 纯客户端硬件加速视频导出器（完全在浏览器本地执行，0 服务器算力开销）
 */
export async function exportTimelineVideoLocally({
    tracks,
    aspectRatio,
    fps = 30,
    onProgress,
    signal,
}: {
    tracks: EditorTrack[];
    aspectRatio: AspectRatio;
    fps?: number;
    onProgress: (progressPercent: number, statusText: string) => void;
    signal?: AbortSignal;
}): Promise<LocalExportResult> {
    if (signal?.aborted) {
        throw new DOMException("用户已取消视频导出", "AbortError");
    }

    const { width, height } = getResolutionForAspectRatio(aspectRatio);

    // 1. 计算总有效时长
    let maxDuration = 0;
    tracks.forEach((t) => {
        t.clips.forEach((c) => {
            const end = getClipEndTime(c);
            if (end > maxDuration) maxDuration = end;
        });
    });

    if (maxDuration <= 0.2) {
        throw new Error("时间轴中没有任何片段，无法导出视频");
    }

    onProgress(5, "正在预热本地合成引擎与硬件编码器...");

    // 2. 创建隐藏离线 Canvas
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) {
        throw new Error("无法创建离线 Canvas 渲染环境");
    }

    // 3. 预载所有视频与图片（带多实例事件监听与 3s 超时兜底，防止相同 URL 覆盖冲突与网络挂起）
    onProgress(10, "正在预加载媒体关键帧与图层...");
    const allClips = tracks.flatMap((t) => t.clips);
    await Promise.all(
        allClips.map((clip) => {
            if (signal?.aborted) return Promise.resolve(true);
            if (clip.type === "video") {
                const v = getCachedVideoElement(clip.sourceUrl);
                if (v.readyState >= 2) return Promise.resolve(true);
                return new Promise((resolve) => {
                    let timer: number | null = null;
                    const onDone = () => {
                        if (timer) clearTimeout(timer);
                        v.removeEventListener("loadeddata", onDone);
                        v.removeEventListener("error", onDone);
                        resolve(true);
                    };
                    timer = window.setTimeout(onDone, 3000);
                    v.addEventListener("loadeddata", onDone);
                    v.addEventListener("error", onDone);
                });
            }
            if (clip.type === "image") {
                const img = getCachedImageElement(clip.sourceUrl);
                if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
                return new Promise((resolve) => {
                    let timer: number | null = null;
                    const onDone = () => {
                        if (timer) clearTimeout(timer);
                        img.removeEventListener("load", onDone);
                        img.removeEventListener("error", onDone);
                        resolve(true);
                    };
                    timer = window.setTimeout(onDone, 3000);
                    img.addEventListener("load", onDone);
                    img.addEventListener("error", onDone);
                });
            }
            return Promise.resolve(true);
        })
    );

    if (signal?.aborted) {
        throw new DOMException("用户已取消视频导出", "AbortError");
    }

    // 4. 构建无损混合音频流
    onProgress(15, "正在合成混音多轨立体声音频...");
    const mixedAudioBuffer = await buildMixedAudioBuffer(tracks, maxDuration, signal);

    if (signal?.aborted) {
        throw new DOMException("用户已取消视频导出", "AbortError");
    }

    // 5. 优先尝试 Mediabunny WebCodecs 逐帧硬件加速编码（参考 OpenCut 离线精确时间戳）
    if (typeof window !== "undefined" && typeof (window as any).VideoEncoder !== "undefined") {
        try {
            onProgress(18, "启用 Mediabunny 逐帧编码引擎...");
            return await exportViaMediabunny({
                canvas,
                ctx,
                width,
                height,
                fps,
                maxDuration,
                tracks,
                mixedAudioBuffer,
                onProgress,
                signal,
            });
        } catch (err) {
            // 如果是用户主动取消，则直接抛出，严禁降级触发 MediaRecorder 重新录制
            if (signal?.aborted || (err as any)?.name === "AbortError") {
                throw err;
            }
            console.warn("[EditorEngine] Mediabunny 逐帧编码异常，自动降级至 MediaRecorder 录制:", err);
            onProgress(20, "自动切换至标准本地录制引擎...");
        }
    }

    if (signal?.aborted) {
        throw new DOMException("用户已取消视频导出", "AbortError");
    }

    // 6. 降级使用 MediaRecorder 录制合成
    return exportViaMediaRecorder({
        canvas,
        ctx,
        width,
        height,
        fps,
        maxDuration,
        tracks,
        mixedAudioBuffer,
        onProgress,
        signal,
    });
}

/**
 * 基于 Mediabunny (WebCodecs) 的逐帧无丢帧离线合成编码器（参考 OpenCut 核心架构）
 */
async function exportViaMediabunny({
    canvas,
    ctx,
    width,
    height,
    fps,
    maxDuration,
    tracks,
    mixedAudioBuffer,
    onProgress,
    signal,
}: {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
    fps: number;
    maxDuration: number;
    tracks: EditorTrack[];
    mixedAudioBuffer: AudioBuffer | null;
    onProgress: (percent: number, text: string) => void;
    signal?: AbortSignal;
}): Promise<LocalExportResult> {
    const {
        Output,
        Mp4OutputFormat,
        BufferTarget,
        CanvasSource,
        AudioBufferSource,
        QUALITY_HIGH,
        Input,
        ALL_FORMATS,
        BlobSource,
        CanvasSink,
    } = await import("mediabunny");

    if (signal?.aborted) {
        throw new DOMException("用户已取消视频导出", "AbortError");
    }

    // 1. 预加载所有视频片段至 WebCodecs CanvasSink，以最大硬件解码速度直接逐帧取图，完全规避 DOM <video> 频繁 seek 导致的丢帧与黑屏
    onProgress(12, "正在初始化原生硬件逐帧解码管线 (WebCodecs)...");
    const clipSinks = new Map<string, any>();
    const clipInputs = new Map<string, any>();
    let output: any = null;

    const videoClips = tracks
        .filter((t) => !t.hidden && t.type === "video")
        .flatMap((t) => t.clips)
        .filter((c) => c.type === "video" && c.sourceUrl);

    try {
        await Promise.all(
            videoClips.map(async (clip) => {
                try {
                    if (signal?.aborted) return;
                    const res = await fetch(clip.sourceUrl, { signal });
                    if (!res.ok) return;
                    const blob = await res.blob();
                    if (signal?.aborted) return;
                    const input = new Input({
                        source: new BlobSource(blob),
                        formats: ALL_FORMATS,
                    });
                    const videoTrack = await input.getPrimaryVideoTrack();
                    if (videoTrack && (await videoTrack.canDecode())) {
                        const sink = new CanvasSink(videoTrack, { width, height });
                        clipSinks.set(clip.id, sink);
                        clipInputs.set(clip.id, input);
                    }
                } catch (err) {
                    if (signal?.aborted) return;
                    console.warn("[EditorEngine] 无法为视频片段创建 CanvasSink，将使用 DOM 显存渲染兜底:", clip.name, err);
                }
            })
        );

        if (signal?.aborted) {
            throw new DOMException("用户已取消视频导出", "AbortError");
        }

        const totalFrames = Math.ceil(maxDuration * fps);
        const outputFormat = new Mp4OutputFormat();
        const target = new BufferTarget();
        output = new Output({
            format: outputFormat,
            target,
        });

        const videoSource = new CanvasSource(canvas, {
            codec: "avc",
            bitrate: QUALITY_HIGH,
        });
        output.addVideoTrack(videoSource, { frameRate: fps });

        let audioSource: any = null;
        if (mixedAudioBuffer) {
            let audioCodec: "aac" | "opus" = "aac";
            if (typeof (window as any).AudioEncoder !== "undefined") {
                try {
                    const { supported } = await (window as any).AudioEncoder.isConfigSupported({
                        codec: "mp4a.40.2",
                        sampleRate: mixedAudioBuffer.sampleRate,
                        numberOfChannels: mixedAudioBuffer.numberOfChannels,
                        bitrate: 192000,
                    });
                    if (!supported) audioCodec = "opus";
                } catch {
                    audioCodec = "opus";
                }
            }
            audioSource = new AudioBufferSource({
                codec: audioCodec,
                bitrate: QUALITY_HIGH,
            });
            output.addAudioTrack(audioSource);
        }

        await output.start();

        if (audioSource && mixedAudioBuffer) {
            await audioSource.add(mixedAudioBuffer);
            audioSource.close();
        }

        const frameOverrides = new Map<string, CanvasImageSource>();

        for (let i = 0; i < totalFrames; i++) {
            // 实时检查取消信号
            if (signal?.aborted) {
                try {
                    await output.cancel();
                } catch {}
                throw new DOMException("用户已取消视频导出", "AbortError");
            }

            // 关键：每帧主动让出浏览器主线程宏任务事件循环，彻底消除页面卡顿假死，使取消按钮与窗口关闭即时响应
            await new Promise((resolve) => setTimeout(resolve, 0));

            const currentTime = i / fps;
            frameOverrides.clear();

            const activeVideoClips = tracks
                .filter((t) => !t.hidden && t.type === "video")
                .flatMap((t) => t.clips)
                .filter((c) => c.type === "video" && currentTime >= c.startTime && currentTime < getClipEndTime(c));

            if (activeVideoClips.length > 0) {
                await Promise.all(
                    activeVideoClips.map(async (clip) => {
                        if (signal?.aborted) return;
                        const mediaTimeOffset = clip.trimStart + (currentTime - clip.startTime) * clip.speed;
                        const sink = clipSinks.get(clip.id);
                        if (sink) {
                            try {
                                const wrapped = await sink.getCanvas(mediaTimeOffset);
                                if (wrapped && wrapped.canvas) {
                                    frameOverrides.set(clip.id, wrapped.canvas);
                                    return;
                                }
                            } catch {
                                // ignore and fallback
                            }
                        }
                        // 兜底降级：使用带有 requestVideoFrameCallback 保证的视频元素寻道
                        const v = getCachedVideoElement(clip.sourceUrl);
                        await seekVideoToTime(v, mediaTimeOffset);
                        if (v.readyState >= 2) {
                            frameOverrides.set(clip.id, v);
                        }
                    })
                );
            }

            if (signal?.aborted) {
                try {
                    await output.cancel();
                } catch {}
                throw new DOMException("用户已取消视频导出", "AbortError");
            }

            renderCompositedFrame(ctx, width, height, currentTime, tracks, { frameOverrides });
            await videoSource.add(currentTime, 1 / fps);

            if (i % 5 === 0 || i === totalFrames - 1) {
                const percent = Math.min(98, Math.round(20 + (i / totalFrames) * 78));
                onProgress(percent, `正在本地逐帧编码合成 (${i + 1}/${totalFrames} 帧)...`);
            }
        }

        if (signal?.aborted) {
            try {
                await output.cancel();
            } catch {}
            throw new DOMException("用户已取消视频导出", "AbortError");
        }

        onProgress(99, "正在封装视频轨道与元数据...");
        videoSource.close();
        await output.finalize();

        const buffer = target.buffer;
        if (!buffer) {
            throw new Error("视频导出缓冲生成失败");
        }

        onProgress(100, "视频本地高速合成完成！已触发下载");

        return {
            blob: new Blob([buffer], { type: "video/mp4" }),
            extension: "mp4",
            mimeType: "video/mp4",
        };
    } catch (err) {
        if (signal?.aborted || (err as any)?.name === "AbortError") {
            try {
                if (output && output.state === "started") {
                    await output.cancel();
                }
            } catch {}
        }
        throw err;
    } finally {
        // 无论成功、取消还是异常，均彻底释放所有解封装器内存资源与硬件句柄
        clipInputs.forEach((input) => {
            try {
                input.dispose();
            } catch {}
        });
    }
}

/**
 * 降级导出引擎：基于 MediaRecorder 实时流捕获
 */
function exportViaMediaRecorder({
    canvas,
    ctx,
    width,
    height,
    fps,
    maxDuration,
    tracks,
    mixedAudioBuffer,
    onProgress,
    signal,
}: {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
    fps: number;
    maxDuration: number;
    tracks: EditorTrack[];
    mixedAudioBuffer: AudioBuffer | null;
    onProgress: (percent: number, text: string) => void;
    signal?: AbortSignal;
}): Promise<LocalExportResult> {
    let audioStreamTrack: MediaStreamTrack | null = null;
    let liveAudioCtx: AudioContext | null = null;

    if (signal?.aborted) {
        return Promise.reject(new DOMException("用户已取消视频导出", "AbortError"));
    }

    if (mixedAudioBuffer) {
        try {
            const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            liveAudioCtx = new AudioCtxClass();
            const dest = liveAudioCtx.createMediaStreamDestination();
            const bufferSource = liveAudioCtx.createBufferSource();
            bufferSource.buffer = mixedAudioBuffer;
            bufferSource.connect(dest);
            bufferSource.start(0);
            audioStreamTrack = dest.stream.getAudioTracks()[0] || null;
        } catch {
            // 音频混音失败时降级纯画面录制
        }
    }

    const canvasStream = canvas.captureStream(fps);
    const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...(audioStreamTrack ? [audioStreamTrack] : []),
    ]);

    let mimeType = "video/webm;codecs=vp9,opus";
    let ext: "mp4" | "webm" = "webm";

    if (MediaRecorder.isTypeSupported("video/mp4")) {
        mimeType = "video/mp4";
        ext = "mp4";
    } else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")) {
        mimeType = "video/webm;codecs=vp9,opus";
        ext = "webm";
    } else if (MediaRecorder.isTypeSupported("video/webm")) {
        mimeType = "video/webm";
        ext = "webm";
    }

    const recorder = new MediaRecorder(combinedStream, {
        mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : undefined,
        videoBitsPerSecond: width >= 1920 ? 12_000_000 : 8_000_000,
    });

    const recordedChunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    return new Promise<LocalExportResult>((resolve, reject) => {
        let isAborted = false;
        let animFrameId: number | null = null;

        const cleanup = () => {
            if (animFrameId !== null) {
                cancelAnimationFrame(animFrameId);
                animFrameId = null;
            }
            if (liveAudioCtx) {
                try {
                    void liveAudioCtx.close();
                } catch {}
                liveAudioCtx = null;
            }
            try {
                combinedStream.getTracks().forEach((t) => t.stop());
            } catch {}
        };

        const onAbort = () => {
            isAborted = true;
            cleanup();
            if (recorder.state !== "inactive") {
                try {
                    recorder.stop();
                } catch {}
            }
            reject(new DOMException("用户已取消视频导出", "AbortError"));
        };

        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        }

        recorder.onstop = () => {
            if (isAborted) return;
            onProgress(100, "导出完成！正在保存视频文件...");
            const finalBlob = new Blob(recordedChunks, { type: mimeType });
            cleanup();
            resolve({
                blob: finalBlob,
                extension: ext,
                mimeType,
            });
        };

        recorder.onerror = (e) => {
            if (isAborted) return;
            cleanup();
            reject(new Error("本地录制合成失败: " + (e as ErrorEvent).message));
        };

        recorder.start(100);

        const totalFrames = Math.ceil(maxDuration * fps);
        let currentFrame = 0;

        async function stepRender() {
            if (isAborted || signal?.aborted) {
                cleanup();
                return;
            }

            if (currentFrame > totalFrames) {
                recorder.stop();
                return;
            }

            const currentTime = currentFrame / fps;

            const activeVideoClips = tracks
                .filter((t) => !t.hidden && t.type === "video")
                .flatMap((t) => t.clips)
                .filter((c) => c.type === "video" && currentTime >= c.startTime && currentTime < getClipEndTime(c));

            if (activeVideoClips.length > 0) {
                await Promise.all(
                    activeVideoClips.map((clip) => {
                        const v = getCachedVideoElement(clip.sourceUrl);
                        const mediaTimeOffset = clip.trimStart + (currentTime - clip.startTime) * clip.speed;
                        return seekVideoToTime(v, mediaTimeOffset);
                    })
                );
            }

            renderCompositedFrame(ctx, width, height, currentTime, tracks);

            const percent = Math.min(99, Math.round(20 + (currentFrame / totalFrames) * 78));
            if (currentFrame % 5 === 0) {
                onProgress(percent, `正在本地逐帧高速合成渲染 (${currentFrame}/${totalFrames} 帧)...`);
            }

            currentFrame += 1;
            animFrameId = requestAnimationFrame(stepRender);
        }

        void stepRender();
    });
}
