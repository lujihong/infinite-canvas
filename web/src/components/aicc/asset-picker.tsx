"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Input, QRCode, Select, Spin, Tag, Upload } from "antd";
import { Radio } from "lucide-react";
import { useUserStore } from "@/stores/use-user-store";
import { AICC_UPLOAD_LIMITS, aiccAssets, aiccChannels, aiccCheck, aiccCreateAsset, aiccCreateGroup, aiccGroups, aiccSession, aiccUpload, aiccUploadExpiry, validateAiccFile, type AiccAsset, type AiccChannel, type AiccGroup, type AiccSession, type AiccUpload } from "@/services/api/aicc";
import type { InsertAssetPayload } from "@/app/(user)/canvas/types";

const statusLabels: Record<string, string> = { ACTIVE: "可用", PROCESSING: "处理中", FAILED: "入库失败", EXPIRED: "已过期" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";

type PickerProps = { onInsert: (payload: InsertAssetPayload) => void; selectionEnabled?: boolean };

export function AiccAssetPicker({ onInsert, selectionEnabled = true }: PickerProps) {
    const identity = useUserStore(state => state.user?.id);
    return <AiccAssetPickerContent key={identity || "anonymous"} onInsert={onInsert} selectionEnabled={selectionEnabled} />;
}

function AiccAssetPickerContent({ onInsert, selectionEnabled }: PickerProps) {
    const { message } = App.useApp();
    const identity = useUserStore(state => state.user?.id);
    const channelsQuery = useQuery({ queryKey: ["aicc-channels"], queryFn: ({ signal }) => aiccChannels(signal), retry: false, enabled: !!identity });
    const channels = Array.isArray(channelsQuery.data) ? channelsQuery.data : [];
    const [selectedChannelId, setSelectedChannelId] = useState<number | undefined>(undefined);
    const activeChannelId = selectedChannelId || channels[0]?.id;
    const activeChannel = Array.isArray(channels) ? channels.find(c => c.id === activeChannelId) : undefined;

    const [type, setType] = useState<"LivenessFace" | "AIGC">("LivenessFace");
    const [groupPage, setGroupPage] = useState(1);
    const [assetPage, setAssetPage] = useState(1);
    const [selected, setSelected] = useState<AiccGroup | null>(null);
    const [session, setSession] = useState<AiccSession | null>(null);
    const [expiresAt, setExpiresAt] = useState(0);
    const [now, setNow] = useState(Date.now());
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState("");
    const [groupName, setGroupName] = useState("");
    const pollCount = useRef(0);
    const lifecycle = useRef(0);
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => { lifecycle.current++; controller.current?.abort(); }, []);
    const groups = useQuery({ queryKey: ["aicc", identity, "groups", type, groupPage, activeChannelId], queryFn: ({ signal }) => aiccGroups(type, groupPage, activeChannelId, signal), retry: false, enabled: !!identity });
    const group = groups.data?.data.find(item => item.groupId === selected?.groupId) || groups.data?.data[0];
    const assets = useQuery({ queryKey: ["aicc", identity, "assets", group?.groupId, type, assetPage, activeChannelId], queryFn: ({ signal }) => aiccAssets(group!, assetPage, activeChannelId, signal), enabled: !!identity && !!group, retry: false, refetchOnWindowFocus: false,
        refetchIntervalInBackground: false,
        refetchInterval: query => pollCount.current < 12 && !query.state.error && query.state.data?.data.some(item => item.status.toUpperCase() === "PROCESSING") ? 10_000 : false,
    });
    useEffect(() => { pollCount.current = 0; }, [group?.groupId, type, assetPage]);
    useEffect(() => { if (assets.dataUpdatedAt) pollCount.current++; }, [assets.dataUpdatedAt]);
    const refreshAssets = () => { pollCount.current = 0; void assets.refetch(); };
    useEffect(() => { setSelected(null); setGroupPage(1); setAssetPage(1); setSession(null); controller.current?.abort(); lifecycle.current++; }, [identity, activeChannelId]);
    useEffect(() => { setAssetPage(1); }, [group?.groupId]);
    useEffect(() => { if (!session) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [session]);
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
    const begin = async () => {
        controller.current?.abort(); controller.current = new AbortController();
        const version = ++lifecycle.current;
        setBusy(true); setFailure(""); setSession(null);
        try { const value = await aiccSession(controller.current.signal, activeChannelId); if (version === lifecycle.current) {setSession(value); setNow(Date.now()); setExpiresAt(Date.now() + value.expiresIn * 1000);} }
        catch (error) { if (version === lifecycle.current) setFailure(errorText(error)); }
        finally { if (version === lifecycle.current) setBusy(false); }
    };
    const check = async () => {
        if (!session || seconds === 0 || busy) return;
        const version = lifecycle.current;
        setBusy(true); setFailure("");
        try {
            const authorized = await aiccCheck(session.bytedToken, controller.current?.signal);
            if (version !== lifecycle.current) return;
            if (authorized) { setSession(null); setType("LivenessFace"); setGroupPage(1); void groups.refetch(); message.success("认证组已同步，请添加人物素材并等待入库可用"); }
            else message.info("暂未取得认证结果，请在手机完成后查询");
        } catch (error) { if (version === lifecycle.current) setFailure(errorText(error)); }
        finally { if (version === lifecycle.current) setBusy(false); }
    };
    const mutate = async (operation: () => Promise<unknown>, success: string) => {
        const version = lifecycle.current;
        setBusy(true); setFailure("");
        try { await operation(); if (version === lifecycle.current) {message.success(success); void groups.refetch(); void assets.refetch();} }
        catch (error) { if (version === lifecycle.current) setFailure(errorText(error)); }
        finally { if (version === lifecycle.current) setBusy(false); }
    };
    const insert = (asset: AiccAsset) => {
        if (asset.status.toUpperCase() !== "ACTIVE") return;
        const aiccUri = `asset://${asset.assetId}`;
        if (!/^asset:\/\/asset-[A-Za-z0-9_-]+$/.test(aiccUri)) {message.error("素材标识异常，请刷新");return;}
        const preview = /^https?:\/\//.test(asset.assetUrl || "") ? asset.assetUrl! : "";
        const base = {title: asset.assetName || "人物素材", aiccUri, aiccChannelId: asset.channelId || activeChannelId};
        if (asset.assetType === "Image") onInsert({...base, kind:"image", dataUrl:preview, mimeType:"image/jpeg"});
        else if (asset.assetType === "Video") onInsert({...base, kind:"video", url:preview, mimeType:"video/mp4"});
        else if (asset.assetType === "Audio") onInsert({...base, kind:"audio", url:preview, mimeType:"audio/mpeg"});
    };
    return <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
                {(["LivenessFace","AIGC"] as const).map(value => <Button key={value} type={type === value ? "primary" : "default"} onClick={() => {setType(value);setSelected(null);setGroupPage(1);setAssetPage(1);}}>{value === "LivenessFace" ? "真人肖像" : "虚拟人物"}</Button>)}
                {channels.length > 1 ? (
                    <div className="flex items-center gap-1.5 ml-1">
                        <span className="text-xs text-stone-500">移动云专线:</span>
                        <Select
                            size="small"
                            className="w-48"
                            value={activeChannelId}
                            options={channels.map((c) => ({ value: c.id, label: `${c.name} (${c.region || "专线"})` }))}
                            onChange={(val) => {
                                setSelectedChannelId(val);
                                setSelected(null);
                                setGroupPage(1);
                                setAssetPage(1);
                            }}
                        />
                    </div>
                ) : channels[0] ? (
                    <span className="inline-flex items-center gap-1 text-xs text-stone-500 ml-1">
                        <Radio className="size-3 text-emerald-500" />
                        接入专线: <strong className="text-stone-700 dark:text-stone-300 font-medium">{channels[0].name}</strong>
                    </span>
                ) : null}
            </div>
            <Button loading={busy} onClick={() => void begin()}>
                {channels.length > 1 && activeChannel ? `在「${activeChannel.name}」发起认证` : "发起真人认证"}
            </Button>
        </div>
        <p className="text-xs text-stone-500 dark:text-stone-400">素材来自移动云，仅展示当前账号有权访问的素材。选用后自动带入资产引用，不需要手动复制 ID。</p>
        {!selectionEnabled && <Alert type="info" showIcon message="当前模型选用真人素材将自动为您切换至匹配的移动云 Seedance 2.0 合规模型（亦可手动切换 Seedance 后再选用）。" />}
        <p className="text-xs text-stone-500 dark:text-stone-400">真人认证成功后，可在同一人物组继续添加本人的素材；移动云会进行同人一致性与最终入库校验，认证或上传成功不保证素材入库成功。</p>
        {failure && <Alert type="error" showIcon message={failure} />}
        {session && <section className="flex flex-wrap items-center gap-4 rounded-lg border border-stone-200 p-4 dark:border-stone-700">
            <QRCode value={session.h5Link} size={144} status={seconds ? "active" : "expired"} onRefresh={() => void begin()} />
            <div className="min-w-0 flex-1 space-y-2"><p className="font-medium">用手机完成活体核验与肖像授权</p><p className="text-xs">{seconds ? `链接剩余 ${Math.floor(seconds/60)}分${seconds%60}秒` : "链接已过期，请重新发起"}</p><div className="flex flex-wrap gap-2"><Button disabled={!seconds} href={session.h5Link} target="_blank" rel="noopener noreferrer">手机端打开链接</Button><Button disabled={!seconds} onClick={() => {void navigator.clipboard.writeText(session.h5Link).then(() => message.success("已复制"), () => message.error("复制失败"));}}>复制链接</Button><Button loading={busy} disabled={!seconds} onClick={() => void check()}>查询认证结果</Button></div></div>
        </section>}
        {type === "AIGC" && <div className="flex gap-2"><Input aria-label="新素材组名称" placeholder="虚拟人物组名称" maxLength={64} value={groupName} onChange={e=>setGroupName(e.target.value)} /><Button disabled={!groupName.trim() || busy} onClick={() => void mutate(()=>aiccCreateGroup(groupName.trim(), activeChannelId),"素材组已创建")}>新建组</Button></div>}
        {groups.isError ? <Alert type="error" message={errorText(groups.error)} action={<Button onClick={()=>void groups.refetch()}>重试</Button>} /> : groups.isLoading ? <Spin /> : <>
            <Select className="w-full" aria-label="选择人物素材组" placeholder="选择素材组" value={group?.groupId} options={groups.data?.data.map(item=>({value:item.groupId,label:item.groupName || item.groupId}))} onChange={id=>{setSelected(groups.data?.data.find(item=>item.groupId===id)||null);setAssetPage(1);}} />
            <nav aria-label="人物素材组分页" className="flex flex-wrap items-center justify-end" style={{ marginTop: 12, gap: 12, paddingBottom: 4 }}>
                <Button size="small" aria-label="素材组上一页" disabled={groupPage<=1 || groups.isFetching} onClick={()=>setGroupPage(p=>p-1)}>上一页</Button>
                <span className="text-xs text-stone-500 dark:text-stone-400" style={{ minWidth: 68, textAlign: "center", whiteSpace: "nowrap" }}>第 {groupPage} 页</span>
                <Button size="small" aria-label="素材组下一页" disabled={groups.isFetching || (groups.data?.total!==undefined ? groupPage*12>=groups.data.total : (groups.data?.data.length||0)<12)} onClick={()=>setGroupPage(p=>p+1)}>下一页</Button>
            </nav>
        </>}
        {group && <>
            <AssetUploadForm key={`${type}:${group.groupId}`} group={group} onSubmitted={refreshAssets} />
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-stone-500">处理中每 10 秒检查，最多 12 次；页面不可见时暂停，可手动刷新。</span><Button onClick={refreshAssets}>刷新素材</Button></div>
            {assets.isError ? <Alert type="error" message={errorText(assets.error)} /> : assets.isLoading ? <Spin /> : !assets.data?.data.length ? <Empty description="本页暂无素材" /> : <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{assets.data.data.map(asset=>{
                const matchedChannel = Array.isArray(channels) ? channels.find(c => c.id === (asset.channelId || activeChannelId)) : undefined;
                const channelTag = matchedChannel ? matchedChannel.name : "移动云专线";
                return (
                    <article key={asset.assetId} className="min-w-0 rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                        <div className="mb-2 flex aspect-video items-center justify-center overflow-hidden rounded bg-stone-100 dark:bg-stone-900">
                            {asset.assetUrl && /^https?:\/\//.test(asset.assetUrl) ? asset.assetType === "Image" ? <img src={asset.assetUrl} alt={asset.assetName} loading="lazy" className="h-full w-full object-contain" /> : asset.assetType === "Video" ? <video src={asset.assetUrl} aria-label={asset.assetName} controls playsInline preload="none" className="h-full w-full object-contain" /> : <audio src={asset.assetUrl} aria-label={asset.assetName} controls preload="none" className="w-full" /> : <span className="text-xs text-stone-500">暂无预览</span>}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-xs" title={asset.assetName}>{asset.assetName||"未命名素材"}</span>
                            <div className="flex items-center gap-1 shrink-0">
                                <Tag color="cyan" title={`专线ID: ${asset.channelId || activeChannelId}`}>{channelTag}</Tag>
                                <Tag>{statusLabels[asset.status.toUpperCase()]||asset.status}</Tag>
                            </div>
                        </div>
                        <Button className="mt-3 w-full" type="primary" disabled={!selectionEnabled || asset.status.toUpperCase()!=="ACTIVE"} onClick={()=>insert(asset)}>选用此素材</Button>
                    </article>
                );
            })}</div>}
            <nav aria-label="人物素材分页" className="flex flex-wrap items-center justify-end border-t border-stone-200 dark:border-stone-700" style={{ marginTop: 16, paddingTop: 12, gap: 12 }}>
                <Button size="small" aria-label="素材上一页" disabled={assetPage<=1 || assets.isFetching} onClick={()=>setAssetPage(p=>p-1)}>上一页</Button>
                <span className="text-xs text-stone-500 dark:text-stone-400" style={{ minWidth: 68, textAlign: "center", whiteSpace: "nowrap" }}>第 {assetPage} 页</span>
                <Button size="small" aria-label="素材下一页" disabled={assets.isFetching || (assets.data?.total!==undefined ? assetPage*12>=assets.data.total : (assets.data?.data.length||0)<12)} onClick={()=>setAssetPage(p=>p+1)}>下一页</Button>
            </nav>
        </>}
    </div>;
}

function validateDuration(file: File, assetType: AiccAsset["assetType"], signal: AbortSignal): Promise<void> {
    if (assetType === "Image") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const media = document.createElement(assetType === "Video" ? "video" : "audio");
        const url = URL.createObjectURL(file);
        const finish = (error?: Error) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            media.onloadedmetadata = null;
            media.onerror = null;
            media.removeAttribute("src");
            media.load();
            URL.revokeObjectURL(url);
            if (error) reject(error); else resolve();
        };
        const abort = () => finish(new Error("已取消"));
        const timer = setTimeout(() => finish(new Error("读取时长超时，请选择可播放的文件")), 15_000);
        media.onloadedmetadata = () => finish(Number.isFinite(media.duration) && media.duration >= 2 && media.duration <= 15 ? undefined : new Error("音视频平台保守接收时长为 2–15 秒，请先裁剪"));
        media.onerror = () => finish(new Error("无法读取音视频时长，请检查文件编码或换用兼容格式"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        media.preload = "metadata";
        media.src = url;
    });
}

function AssetUploadForm({ group, onSubmitted }: { group: AiccGroup; onSubmitted: () => void }) {
    const { message } = App.useApp();
    const [assetType, setAssetType] = useState<AiccAsset["assetType"]>("Image");
    const [mode, setMode] = useState<"local" | "url">("local");
    const [file, setFile] = useState<File | null>(null);
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [phase, setPhase] = useState<"idle" | "uploading" | "creating" | "done">("idle");
    const [failure, setFailure] = useState("");
    const uploaded = useRef<AiccUpload | null>(null);
    const request = useRef<AbortController | null>(null);
    const version = useRef(0);
    const busy = phase === "uploading" || phase === "creating";
    useEffect(() => () => { version.current++; request.current?.abort(); }, []);
    const cancel = (resetUpload = false) => {
        version.current++;
        request.current?.abort();
        request.current = null;
        if (resetUpload) uploaded.current = null;
        setPhase("idle");
        setFailure("");
    };
    const submit = async () => {
        if (request.current || !name.trim() || (mode === "local" ? !file : !/^https:\/\//.test(url.trim()))) return;
        const controller = new AbortController();
        request.current = controller;
        const current = ++version.current;
        // Pin identity across BOTH requests, including the gap between them.
        const user = useUserStore.getState();
        const valid = () => current === version.current && !controller.signal.aborted && useUserStore.getState().token === user.token && useUserStore.getState().user?.id === user.user?.id;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
        setFailure("");
        try {
            let assetUrl = url.trim();
            if (mode === "local" && file) {
                setPhase("uploading");
                if (!uploaded.current || aiccUploadExpiry(uploaded.current.expiresAt) <= Date.now() + 5_000) {
                    uploaded.current = null;
                    validateAiccFile(file, assetType);
                    await validateDuration(file, assetType, controller.signal);
                    if (!valid()) return;
                    const result = await aiccUpload(file, group.groupId, assetType, controller.signal);
                    if (!valid()) return;
                    uploaded.current = result;
                }
                assetUrl = uploaded.current.url;
            }
            if (!valid()) return;
            setPhase("creating");
            await aiccCreateAsset(group.groupId, name.trim(), assetUrl, assetType, controller.signal);
            if (!valid()) return;
            uploaded.current = null;
            setFile(null);
            setUrl("");
            setPhase("done");
            message.success("素材已提交移动云，等待入库校验；可继续添加同一人物素材");
            onSubmitted();
        } catch (error) {
            if (current === version.current) {
                setFailure(timedOut ? "请求超时，入库结果可能尚未确认，请先刷新素材；重试会复用未过期的上传链接。" : `${errorText(error)}${uploaded.current ? "；上传已完成，重试会复用未过期链接。若入库请求超时，请先刷新确认，避免重复添加。" : ""}`);
                setPhase("idle");
            }
        } finally {
            clearTimeout(timer);
            if (current === version.current) { request.current = null; setPhase(value => value === "done" ? value : "idle"); }
        }
    };
    return <section className="space-y-3 rounded-md border border-stone-200 p-3 dark:border-stone-700">
        <h3 className="font-medium">向当前人物组添加素材</h3>
        <div className="grid gap-2 sm:grid-cols-2">
            <Input disabled={phase === "creating"} aria-label="素材名称" placeholder="素材名称" maxLength={64} value={name} onChange={event => { if (busy) cancel(); else setPhase(value => value === "done" ? value : "idle"); setName(event.target.value); }} />
            <Select disabled={phase === "creating"} aria-label="素材类型" value={assetType} options={[{ value: "Image", label: "图片" }, { value: "Video", label: "视频" }, { value: "Audio", label: "音频" }]} onChange={value => { cancel(true); setFile(null); setUrl(""); setAssetType(value); }} />
        </div>
        <div className="flex flex-wrap gap-2">{(["local", "url"] as const).map(value => <Button key={value} size="small" disabled={phase === "creating"} type={mode === value ? "primary" : "default"} onClick={() => { if (mode !== value) { cancel(true); setMode(value); } }}>{value === "local" ? "本地文件" : "使用 HTTPS 链接"}</Button>)}</div>
        <p className="text-xs text-stone-500">平台限制：{AICC_UPLOAD_LIMITS[assetType].label}。最终格式、时长与同人一致性由移动云校验。</p>
        {mode === "local" ? <Upload.Dragger disabled={phase === "creating"} accept={AICC_UPLOAD_LIMITS[assetType].accept} multiple={false} maxCount={1} showUploadList={false} beforeUpload={next => {
            if (phase === "creating") return false;
            cancel(true);
            setFile(null);
            try { validateAiccFile(next, assetType); setFile(next); if (!name.trim()) setName(next.name.slice(0, 64)); }
            catch (error) { setFailure(errorText(error)); }
            return false;
        }}><p className="break-all p-2">{file ? file.name : "点击选择或拖拽本地文件到这里"}</p></Upload.Dragger> : <Input disabled={phase === "creating"} aria-label="素材链接" placeholder="公网可读取的 HTTPS 素材链接" value={url} onChange={event => { cancel(true); setUrl(event.target.value); }} />}
        <div role="status" aria-live="polite" className="text-xs text-stone-500">{phase === "uploading" ? "第 1/2 步：校验并安全上传文件…" : phase === "creating" ? "第 2/2 步：提交移动云入库…" : phase === "done" ? (mode === "local" ? "已提交，入库状态以素材列表为准。请选择新文件继续添加。" : "已提交，入库状态以素材列表为准。请输入新链接继续添加。") : uploaded.current ? "第 1/2 步已完成，等待重试入库（链接过期会重新上传）。" : "第 1/2 步：安全上传（链接模式跳过）；第 2/2 步：提交入库。"}</div>
        {failure && <Alert type="error" showIcon message={failure} />}
        <div className="flex flex-wrap gap-2"><Button type="primary" loading={busy} disabled={busy || phase === "done" || !name.trim() || (mode === "local" ? !file : !/^https:\/\//.test(url.trim()))} onClick={() => void submit()}>{failure ? "重试提交" : "提交入库"}</Button>{busy && <Button onClick={() => { cancel(); setFailure("已取消等待；若已发出入库请求，请先刷新确认结果，取消不撤销服务端已接收的请求。"); }}>取消</Button>}</div>
    </section>;
}
