// Quotes never need to flood the gateway when a canvas or series mounts at once.
const maxActive = 4;
let active = 0;
const queue: Array<() => void> = [];
export function acquireQuoteSlot(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            const index = queue.indexOf(start);
            if (index >= 0) queue.splice(index, 1);
            reject(new Error("报价已取消"));
        };
        const start = () => {
            signal.removeEventListener("abort", abort);
            if (signal.aborted) { reject(new Error("报价已取消")); return; }
            active++;
            let released = false;
            resolve(() => {
                if (released) return;
                released = true;
                active--;
                while (active < maxActive && queue.length) queue.shift()!();
            });
        };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        if (active < maxActive) start(); else queue.push(start);
    });
}
