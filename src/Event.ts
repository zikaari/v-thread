export interface IDisposable {
    dispose: () => void;
}

class EventManager {
    private listeners: Map<string, any[]>;
    constructor() {
        this.listeners = new Map();
    }

    public dispatch(event: string, ...args: any[]) {
        const callbacks = this.listeners.get(event) || [];
        callbacks.forEach((cb) => cb(...args));
    }

    public async pDispatch(event: string, ...args: any[]) {
        const callbacks = this.listeners.get(event) || [];
        await Promise.all(callbacks.map((cb) => cb(...args)));
    }

    public add(event: string, cb: any) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        const existing = this.listeners.get(event) as any[];
        existing.push(cb);
        return {
            dispose() {
                const idx = existing.indexOf(cb);
                existing.splice(idx, 1);
            },
        };
    }
}

export default EventManager;
