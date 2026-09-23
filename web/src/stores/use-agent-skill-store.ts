"use client";

import localforage from "localforage";
import { nanoid } from "nanoid";
import { create } from "zustand";

import { AGENT_SKILL_CONTENT_MAX_LENGTH, deleteUserAgentSkill, fetchSystemAgentSkills, fetchUserAgentSkills, saveUserAgentSkill, type AgentSkill } from "@/services/api/agent-skills";
import { deleteStoredImages } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { captureSessionIdentity, isSessionIdentityCurrent, subscribeSessionIdentity } from "@/lib/session-identity";

type AgentSkillStore = {
    systemSkills: AgentSkill[];
    userSkills: AgentSkill[];
    isLoading: boolean;
    loadSkills: () => Promise<void>;
    importSkill: (file: File) => Promise<AgentSkill>;
    updateSkill: (id: string, patch: Pick<AgentSkill, "name" | "description" | "coverUrl" | "coverStorageKey" | "content">) => Promise<AgentSkill>;
    deleteSkill: (id: string) => Promise<void>;
};

const localSkillStore = localforage.createInstance({ name: "infinite-canvas", storeName: "agent_skills" });
const localSkillKey = "items";
let loadedSkillsKey = "";
let loadSkillsPromise: { key: string; promise: Promise<void> } | null = null;
let skillLoadVersion = 0;

export function resetAgentSkillCache() {
    loadedSkillsKey = "";
    loadSkillsPromise = null;
    skillLoadVersion++;
    useAgentSkillStore?.setState({ systemSkills: [], userSkills: [], isLoading: false });
}

export const invalidateAgentSkillCache = resetAgentSkillCache;
let lastIdentityKey = "";
subscribeSessionIdentity(() => {
    const identity = captureSessionIdentity();
    const key = `${identity.epoch}:${identity.token}:${identity.userId}`;
    if (lastIdentityKey && key === lastIdentityKey) return;
    lastIdentityKey = key;
    resetAgentSkillCache();
});

function assertCurrentSkillIdentity(identity: ReturnType<typeof captureSessionIdentity>) {
    if (!isSessionIdentityCurrent(identity)) throw new Error("Session changed during Skill operation");
}

export const useAgentSkillStore = create<AgentSkillStore>((set, get) => ({
    systemSkills: [],
    userSkills: [],
    isLoading: false,
    loadSkills: async () => {
        const identity = captureSessionIdentity();
        const token = useUserStore.getState().token;
        const key = `${identity.epoch}:${token || "local"}:${identity.userId}`;
        if (loadedSkillsKey === key) return;
        if (loadSkillsPromise?.key === key) return loadSkillsPromise.promise;
        const version = ++skillLoadVersion;
        set({ isLoading: true });
        const promise = Promise.all([
            fetchSystemAgentSkills(),
            token ? fetchUserAgentSkills(token) : loadLocalAgentSkills(),
        ]).then(([systemSkills, userSkills]) => {
            if (!isSessionIdentityCurrent(identity) || version !== skillLoadVersion) return;
            loadedSkillsKey = key;
            set({ systemSkills, userSkills });
        }).catch((error) => {
            if (isSessionIdentityCurrent(identity) && version === skillLoadVersion) throw error;
        }).finally(() => {
            if (version === skillLoadVersion) {
                loadSkillsPromise = null;
                set({ isLoading: false });
            }
        });
        loadSkillsPromise = { key, promise };
        return promise;
    },
    importSkill: async (file) => {
        const identity = captureSessionIdentity();
        const token = useUserStore.getState().token;
        const content = (await file.text()).trim();
        assertCurrentSkillIdentity(identity);
        if (!content) throw new Error("Skill 内容不能为空");
        if (Array.from(content).length > AGENT_SKILL_CONTENT_MAX_LENGTH) throw new Error("Skill 内容不能超过 20000 字");
        const name = file.name.replace(/\.(?:md|markdown|txt)$/i, "").trim() || "未命名 Skill";
        const now = new Date().toISOString();
        const skill = token
            ? await saveUserAgentSkill(token, { name, content })
            : { id: `local-skill-${nanoid()}`, ownerUserId: "", source: "user" as const, name, description: "", coverUrl: "", coverStorageKey: "", content, enabled: true, sort: 0, createdAt: now, updatedAt: now };
        assertCurrentSkillIdentity(identity);
        const userSkills = [skill, ...get().userSkills.filter((item) => item.id !== skill.id)];
        if (!token) {
            await localSkillStore.setItem(localSkillKey, userSkills);
            assertCurrentSkillIdentity(identity);
        }
        set({ userSkills });
        return skill;
    },
    updateSkill: async (id, patch) => {
        const identity = captureSessionIdentity();
        const token = useUserStore.getState().token;
        const existing = get().userSkills.find((item) => item.id === id);
        if (!existing) throw new Error("Skill 不存在");
        const name = patch.name.trim();
        const content = patch.content.trim();
        if (!name) throw new Error("请输入 Skill 名称");
        if (!content) throw new Error("请输入 Skill 内容");
        if (Array.from(content).length > AGENT_SKILL_CONTENT_MAX_LENGTH) throw new Error("Skill 内容不能超过 20000 字");
        const next = { ...existing, ...patch, name, description: patch.description.trim(), coverUrl: patch.coverUrl.trim(), coverStorageKey: patch.coverStorageKey.trim(), content };
        const skill = token
            ? await saveUserAgentSkill(token, next)
            : { ...next, updatedAt: new Date().toISOString() };
        assertCurrentSkillIdentity(identity);
        const userSkills = get().userSkills.map((item) => item.id === id ? skill : item);
        if (!token) {
            await localSkillStore.setItem(localSkillKey, userSkills);
            assertCurrentSkillIdentity(identity);
        }
        set({ userSkills });
        if (existing.coverStorageKey && existing.coverStorageKey !== skill.coverStorageKey) {
            assertCurrentSkillIdentity(identity);
            await deleteStoredImages([existing.coverStorageKey]);
            assertCurrentSkillIdentity(identity);
        }
        return skill;
    },
    deleteSkill: async (id) => {
        const identity = captureSessionIdentity();
        const token = useUserStore.getState().token;
        const coverStorageKey = get().userSkills.find((item) => item.id === id)?.coverStorageKey;
        if (token) await deleteUserAgentSkill(token, id);
        assertCurrentSkillIdentity(identity);
        const userSkills = get().userSkills.filter((item) => item.id !== id);
        if (!token) {
            await localSkillStore.setItem(localSkillKey, userSkills);
            assertCurrentSkillIdentity(identity);
        }
        set({ userSkills });
        if (coverStorageKey) {
            assertCurrentSkillIdentity(identity);
            await deleteStoredImages([coverStorageKey]);
            assertCurrentSkillIdentity(identity);
        }
    },
}));

export async function loadLocalAgentSkills() {
    const items = await localSkillStore.getItem<AgentSkill[]>(localSkillKey);
    return Array.isArray(items) ? items : [];
}
