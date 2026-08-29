import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { listCanvasProjects, saveCanvasProject, syncCanvasProjects } from "@/services/api/canvas-tasks";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAgentConfig, CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasPendingAgentRequest, ViewportTransform } from "../types";

export type CanvasSidePanelState = {
    open: boolean;
    width: number;
};

export const DEFAULT_CANVAS_SIDE_PANEL: CanvasSidePanelState = { open: true, width: 280 };
export const DEFAULT_CANVAS_AGENT_PANEL: CanvasSidePanelState = { open: false, width: 390 };

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean;
    pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState;
    agentPanel: CanvasSidePanelState;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "agentConfig" | "autoTitlePending" | "backgroundMode" | "showImageInfo" | "viewport" | "sidePanel" | "agentPanel" | "pendingAgentRequest">>) => void;
    syncWithRemote: (token: string, syncEnabled: boolean) => Promise<void>;
    setSyncEnabled: (enabled: boolean) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let accountCanvasSyncEnabled = false;
const projectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function waitForUserStoreHydration() {
    if (useUserStore.persist.hasHydrated()) return Promise.resolve();

    return new Promise<void>((resolve) => {
        let unsubscribe = () => { };
        unsubscribe = useUserStore.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
        });
        if (useUserStore.persist.hasHydrated()) {
            unsubscribe();
            resolve();
        }
    });
}

function queueProjectSave(project: CanvasProject) {
    const token = useUserStore.getState().token;
    const syncEnabled = accountCanvasSyncEnabled;
    const previous = projectSaveTimers.get(project.id);
    if (previous) clearTimeout(previous);

    projectSaveTimers.set(
        project.id,
        setTimeout(() => {
            projectSaveTimers.delete(project.id);
            if (
                !token ||
                !syncEnabled ||
                !accountCanvasSyncEnabled ||
                useUserStore.getState().token !== token
            ) {
                return;
            }
            void saveCanvasProject(token, project).catch(() => undefined);
        }, 400),
    );
}

function cancelProjectSaves(ids: string[]) {
    ids.forEach((id) => {
        const timer = projectSaveTimers.get(id);
        if (!timer) return;
        clearTimeout(timer);
        projectSaveTimers.delete(id);
    });
}

async function reconcileCanvasProjects(
    token: string,
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
) {
    const normalizedRemote = (remoteProjects || []).map(normalizeCanvasProject);
    const normalizedLocal = (localProjects || []).map(normalizeCanvasProject);
    const remoteById = new Map(
        normalizedRemote.map((project) => [project.id, project]),
    );
    const missingProjects = normalizedLocal.filter(
        (project) => !remoteById.has(project.id),
    );
    const existingLocalProjects = normalizedLocal.filter((project) =>
        remoteById.has(project.id),
    );
    const projects = missingProjects.length
        ? await syncCanvasProjects(token, missingProjects)
            .then((syncedProjects) =>
                mergeCanvasProjects(
                    syncedProjects,
                    existingLocalProjects,
                ),
            )
            .catch(() =>
                mergeCanvasProjects(normalizedRemote, normalizedLocal),
            )
        : mergeCanvasProjects(normalizedRemote, existingLocalProjects);

    normalizedLocal.forEach((project) => {
        const remote = remoteById.get(project.id);
        if (
            remote &&
            Date.parse(project.updatedAt || "") >
            Date.parse(remote.updatedAt || "")
        ) {
            queueProjectSave(project);
        }
    });

    return projects;
}

export function normalizeCanvasProject(raw: unknown): CanvasProject {
    const now = new Date().toISOString();
    if (!raw || typeof raw !== "object") {
        return {
            id: nanoid(),
            title: "新元宝项目",
            createdAt: now,
            updatedAt: now,
            nodes: [],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            agentConfig: null,
            autoTitlePending: false,
            backgroundMode: "lines",
            showImageInfo: false,
            viewport: initialViewport,
            sidePanel: DEFAULT_CANVAS_SIDE_PANEL,
            agentPanel: DEFAULT_CANVAS_AGENT_PANEL,
        };
    }

    const item = raw as Partial<CanvasProject> & { name?: string; edges?: unknown };
    const title =
        typeof item.title === "string" && item.title.trim()
            ? item.title.trim()
            : typeof item.name === "string" && item.name.trim()
                ? item.name.trim()
                : "新元宝项目";

    const rawConnections = Array.isArray(item.connections)
        ? item.connections
        : Array.isArray(item.edges)
            ? item.edges
            : [];
    const connections: CanvasConnection[] = rawConnections
        .map((rawConn) => {
            if (!rawConn || typeof rawConn !== "object") return null;
            const c = rawConn as Partial<CanvasConnection> & { source?: string; target?: string; from?: string; to?: string };
            const sourceNodeId = c.sourceNodeId || c.source || c.from || "";
            const targetNodeId = c.targetNodeId || c.target || c.to || "";
            if (!sourceNodeId || !targetNodeId) return null;
            return {
                id: typeof c.id === "string" && c.id ? c.id : nanoid(),
                sourceNodeId,
                targetNodeId,
                sourceHandle: c.sourceHandle,
                targetHandle: c.targetHandle,
            } as CanvasConnection;
        })
        .filter(Boolean) as CanvasConnection[];

    const rawNodes = Array.isArray(item.nodes) ? item.nodes : [];
    const nodes: CanvasNodeData[] = rawNodes
        .map((rawNode) => {
            if (!rawNode || typeof rawNode !== "object") return null;
            const n = rawNode as Partial<CanvasNodeData> & { x?: number; y?: number };
            const position =
                n.position && typeof n.position === "object"
                    ? { x: Number(n.position.x) || 0, y: Number(n.position.y) || 0 }
                    : { x: Number(n.x) || 0, y: Number(n.y) || 0 };
            return {
                id: typeof n.id === "string" && n.id ? n.id : nanoid(),
                type: n.type || CanvasNodeType.Image,
                title: n.title || "未命名节点",
                position,
                width: Number(n.width) || 320,
                height: Number(n.height) || 320,
                metadata: n.metadata && typeof n.metadata === "object" ? n.metadata : {},
            } as CanvasNodeData;
        })
        .filter(Boolean) as CanvasNodeData[];

    const chatSessions = Array.isArray(item.chatSessions) ? (item.chatSessions as CanvasAssistantSession[]) : [];

    const viewport: ViewportTransform =
        item.viewport && typeof item.viewport === "object" && typeof item.viewport.k === "number"
            ? {
                x: Number(item.viewport.x) || 0,
                y: Number(item.viewport.y) || 0,
                k: Number(item.viewport.k) || 1,
            }
            : initialViewport;

    const sidePanel: CanvasSidePanelState =
        item.sidePanel && typeof item.sidePanel === "object"
            ? {
                open: Boolean(item.sidePanel.open),
                width: typeof item.sidePanel.width === "number" ? item.sidePanel.width : DEFAULT_CANVAS_SIDE_PANEL.width,
            }
            : DEFAULT_CANVAS_SIDE_PANEL;

    const agentPanel: CanvasSidePanelState =
        item.agentPanel && typeof item.agentPanel === "object"
            ? {
                open: Boolean(item.agentPanel.open),
                width: typeof item.agentPanel.width === "number" ? item.agentPanel.width : DEFAULT_CANVAS_AGENT_PANEL.width,
            }
            : DEFAULT_CANVAS_AGENT_PANEL;

    return {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : nanoid(),
        title,
        createdAt: item.createdAt || now,
        updatedAt: item.updatedAt || now,
        nodes,
        connections,
        chatSessions,
        activeChatId: typeof item.activeChatId === "string" ? item.activeChatId : null,
        agentConfig: item.agentConfig ?? null,
        autoTitlePending: Boolean(item.autoTitlePending),
        pendingAgentRequest: item.pendingAgentRequest,
        backgroundMode: item.backgroundMode === "dots" || item.backgroundMode === "lines" || item.backgroundMode === "blank" ? item.backgroundMode : "lines",
        showImageInfo: Boolean(item.showImageInfo),
        viewport,
        sidePanel,
        agentPanel,
    };
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        await waitForUserStoreHydration();
        const localValue = await localForageStorage.getItem(name);
        const token = useUserStore.getState().token;
        const localParsed = localValue
            ? (JSON.parse(localValue) as StorageValue<CanvasStore>)
            : null;
        const rawLocalProjects =
            (localParsed?.state as PersistedCanvasState)?.projects || [];
        const localProjects = (
            Array.isArray(rawLocalProjects) ? rawLocalProjects : []
        ).map(normalizeCanvasProject);
        const localHasData = localProjects.length > 0;

        if (token) {
            try {
                const [userConfig, rawRemoteProjects] = await Promise.all([
                    fetchUserConfig(token),
                    listCanvasProjects(token),
                ]);
                const remoteProjects = (
                    Array.isArray(rawRemoteProjects) ? rawRemoteProjects : []
                ).map(normalizeCanvasProject);
                accountCanvasSyncEnabled =
                    userConfig.syncCapabilities?.userData === true;

                if (accountCanvasSyncEnabled && localHasData) {
                    const projects = await reconcileCanvasProjects(
                        token,
                        remoteProjects,
                        localProjects,
                    );

                    const nextState = { projects };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await localForageStorage.setItem(
                        name,
                        JSON.stringify(parsed),
                    );
                    return parsed;
                }

                if (
                    remoteProjects.length > 0 &&
                    (accountCanvasSyncEnabled || !localHasData)
                ) {
                    const nextState = { projects: remoteProjects };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await localForageStorage.setItem(
                        name,
                        JSON.stringify(parsed),
                    );
                    return parsed;
                }
            } catch (error) {
                console.error(
                    "Failed to hydrate canvas projects from remote",
                    error,
                );
            }
        }

        if (!localParsed) return null;
        const nextState = { projects: localProjects };
        queuedPersistState = nextState;
        return {
            ...localParsed,
            state: nextState,
        };
    },

    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (
            queuedPersistState &&
            queuedPersistState.projects === nextState.projects
        ) {
            return;
        }
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "新元宝项目", options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project = normalizeCanvasProject({
                    id,
                    title: title || `新元宝项目 ${get().projects.length + 1}`,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    agentConfig: options?.agentConfig || null,
                    autoTitlePending: true,
                    pendingAgentRequest: options?.pendingAgentRequest,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                    sidePanel: DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: options?.pendingAgentRequest ? { ...DEFAULT_CANVAS_AGENT_PANEL, open: true } : DEFAULT_CANVAS_AGENT_PANEL,
                });
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project = normalizeCanvasProject({
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    agentConfig: source.agentConfig || null,
                    autoTitlePending: false,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    sidePanel: source.sidePanel || DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: source.agentPanel || DEFAULT_CANVAS_AGENT_PANEL,
                });
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return project.id;
            },
            openProject: (id) => {
                const found = get().projects.find((item) => item.id === id);
                return found ? normalizeCanvasProject(found) : null;
            },
            renameProject: (id, title) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = normalizeCanvasProject({
                    ...project,
                    title: title.trim() || project.title,
                    autoTitlePending: false,
                    updatedAt: new Date().toISOString(),
                });
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            deleteProjects: (ids) => {
                cancelProjectSaves(ids);
                set((state) => ({
                    projects: state.projects.filter(
                        (project) => !ids.includes(project.id),
                    ),
                }));
            },
            updateProject: (id, patch) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = normalizeCanvasProject({
                    ...project,
                    ...patch,
                    updatedAt: new Date().toISOString(),
                });
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            syncWithRemote: async (token, syncEnabled) => {
                accountCanvasSyncEnabled = syncEnabled;
                if (!syncEnabled) return;
                const localProjects = get().projects;
                const rawRemoteProjects = await listCanvasProjects(token).catch(
                    () => null,
                );
                if (!rawRemoteProjects) return;
                const remoteProjects = (
                    Array.isArray(rawRemoteProjects) ? rawRemoteProjects : []
                ).map(normalizeCanvasProject);
                const projects = await reconcileCanvasProjects(
                    token,
                    remoteProjects,
                    localProjects,
                );
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                const nextState = { projects };
                queuedPersistState = nextState;
                set(nextState);
                await localForageStorage.setItem(
                    CANVAS_STORE_KEY,
                    JSON.stringify({ state: nextState, version: 0 }),
                );
            },
            setSyncEnabled: (enabled) => {
                accountCanvasSyncEnabled = enabled;
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

export function mergeCanvasProjects(
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
): CanvasProject[] {
    const projects = new Map<string, CanvasProject>();
    [...(localProjects || []), ...(remoteProjects || [])]
        .map(normalizeCanvasProject)
        .forEach((project) => {
            const previous = projects.get(project.id);
            if (
                !previous ||
                Date.parse(project.updatedAt || "") >=
                Date.parse(previous.updatedAt || "")
            ) {
                projects.set(project.id, project);
            }
        });
    return Array.from(projects.values()).sort(
        (a, b) =>
            Date.parse(b.updatedAt || "") -
            Date.parse(a.updatedAt || ""),
    );
}