export type SessionIdentity = { epoch: number; token: string; userId: string };

type Listener = () => void;

let identity: SessionIdentity = { epoch: 0, token: "", userId: "" };
let transitioning = false;
const listeners = new Set<Listener>();

export function captureSessionIdentity(): SessionIdentity {
    return { ...identity };
}

export function isSessionIdentityCurrent(snapshot: SessionIdentity): boolean {
    return snapshot.epoch === identity.epoch && snapshot.token === identity.token && snapshot.userId === identity.userId;
}

export function canPersistSessionData(): boolean {
    return !transitioning;
}

export function subscribeSessionIdentity(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function initializeSessionIdentity(token: string, userId: string): SessionIdentity {
    identity = { epoch: identity.epoch + 1, token, userId };
    transitioning = false;
    listeners.forEach((listener) => listener());
    return captureSessionIdentity();
}

export function beginSessionTransition(token: string, userId: string): SessionIdentity {
    identity = { epoch: identity.epoch + 1, token, userId };
    transitioning = true;
    listeners.forEach((listener) => listener());
    return captureSessionIdentity();
}

export function finishSessionTransition(snapshot: SessionIdentity): boolean {
    if (!isSessionIdentityCurrent(snapshot)) return false;
    transitioning = false;
    listeners.forEach((listener) => listener());
    return true;
}
