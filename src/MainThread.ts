import { parse as extractStackFrames, StackFrame } from 'error-stack-parser';
import * as serializeError from 'serialize-error';
import EventManager, { IDisposable } from './Event';
import { processMessage } from './utils';
import { IVTranserableData, wiredTransferables } from './VTransferable';

enum WorkerState {
    Loading,
    Listening,
    Ready,
    Killed,
}

/**
 * `WebWorker`(s) on steroids
 *
 * Hides the pain of `postMessage` and `onmessage` internally and gives you neat goodies.
 * Goodies include but not limited to being able to kill workers gracefully, giving them
 * time to do clean up and stuff, also ability to pass additional data when workers are created,
 * `VThread` will also throw beautiful errors, by merging stack traces of worker thread and main
 * thread.
 *
 * And the best of all, being able to call methods defined in worker directly, just like you're used to.
 *
 * Too good to be true??? Yes. `VThread` doesn't leverage any hacky techniques, like creating workers off
 * of stringified functions or Blobs as URI's. Internally it uses 100% pure workers, created as you'd create
 * anyway, except `VThread` just wraps around them to hide the pain they come with by default.
 */
export class VThread<T extends object> {

    /**
     * Creates a new `VThread`
     *
     * @param scriptUrl Same as what `Worker` constructor expects to be passed
     * @param workerInitOptions Any data that should be passed to other side when thread is created
     * @param host Define an object with some methods in it, and those methods can be called by thread on the other side
     */
    public static start<K extends object>(scriptUrl: string, workerInitOptions?, host?: any) {
        VThread.preCheck();
        return new VThread<K>(scriptUrl, workerInitOptions, host);
    }

    /**
     * Registers a callback to be called whenever `VThread#start` is called.
     * Callback is passed script URL as the only argument and must return an instance of Worker.
     *
     * Useful if you want to transform script URL in one way or another, or want a custom worker
     * that sub-classes stock `Worker`, for example, `ProxyWorker` if you need cross-origin Workers.
     *
     * `ProxyWorker` = `co-web-worker` (https://www.npmjs.com/package/co-web-worker) for when you need cross-origin workers.
     *
     * @param onBeforeSpawnCallback callback that should be called
     */
    public static use(onBeforeSpawnCallback: (scriptUrl: string) => Worker) {
        if (typeof onBeforeSpawnCallback !== 'function') {
            throw new TypeError(`VThread#use expects a callback that must return instance of Worker, it's called when VThread#start is called`);
        }
        this.onBeforeSpawnCallback = onBeforeSpawnCallback;
    }

    private static onBeforeSpawnCallback: (scriptUrl: string) => Worker;

    private static preCheck() {
        if (typeof window === 'undefined'
            || typeof document === 'undefined'
            || typeof importScripts === 'function') {
            throw new Error(`VThreads are only available in window context (main thread)`);
        }
    }

    private scriptUrl: string;
    private worker: Worker;
    private workerInitOptions: any;
    private workerInitPromise: Promise<boolean>;
    private proxy: T;
    private host: any;
    private pendingTransactionCount: number;
    private workerState: WorkerState;
    private emitter: EventManager;

    private constructor(scriptUrl: string, initOptions?, host?: any) {
        this.scriptUrl = scriptUrl;
        this.workerState = WorkerState.Loading;
        this.workerInitOptions = initOptions;
        this.host = host;
        this.emitter = new EventManager();
        this.pendingTransactionCount = 0;
        this.generateProxy();
        if (typeof VThread.onBeforeSpawnCallback === 'function') {
            const maybeWorker = VThread.onBeforeSpawnCallback(scriptUrl);
            if (maybeWorker instanceof Worker) {
                this.worker = maybeWorker;
            } else {
                throw new TypeError(`VThread#use callback is expected to return instance of Worker`);
            }
        } else {
            this.worker = new Worker(scriptUrl);
        }
        this.worker.addEventListener('message', this.handleWorkerMessage);
        this.startWorker();
    }

    /**
     * Terminates the worker. By default, this will trigger `onWillTerminate` callback inside Worker if registered,
     * and actual termination will happen after `onWillTerminate` resolves. This allows Worker to do clean-up
     * if needed.
     *
     * Alternatively to terminate the worker immediately, set graceful to false. `onWillTerminate`
     * will still be called but wont be awaited.
     *
     * @param lastWords Any last words you might want to send of to Worker before termination, becomes first argument of `onWillTerminate` callback
     * @param graceful If true(default), actual termination wont occur until after Worker's `onWillTerminate` resolves, also this is second argument of `onWillTerminate` callback
     */
    public async kill(lastWords?, graceful = true) {
        await this.ensureWorkerReady();
        this.workerState = WorkerState.Killed;
        const localErrForStack = new Error();
        const res = await this.delegateMessage({
            options: {
                graceful,
                lastWords,
            },
            type: '__vthread_worker_terminate_begin',
        });
        processMessage(res, localErrForStack);
        this.worker.terminate();
    }

    /**
     * Returns an exact clone of current VThread
     *
     * Literally same as calling VThread#start
     */
    public fork(): VThread<T> {
        return new VThread(this.scriptUrl, this.workerInitOptions, this.host);
    }

    /**
     * Returns a proxied handle to `VThreadable` provider on the other side (Worker)
     *
     * Regardless of how `VThreadable` defines itself, all it's methods will now return `Promise`
     * which will resolve (or reject) to whatever that respective function returns (or throws) on the other side
     */
    public getWorkerProxy(): T {
        return this.proxy;
    }

    private generateProxy() {
        let errForStackGen: Error = null;
        let queuedWorkerFnChain = [];
        this.proxy = new Proxy<T>((() => { /** noop */ }) as any, {
            apply: (subtarget, thisArg, args) => {
                if (!(errForStackGen instanceof Error)) {
                    errForStackGen = new Error();
                }
                return new Promise(async (resolve) => {
                    const localErrForStack = errForStackGen;
                    // prep for next immediate use
                    errForStackGen = null;
                    const transferables: IVTranserableData[] = [];
                    args.forEach((arg) => {
                        if (wiredTransferables.has(arg)) {
                            transferables.push(wiredTransferables.get(arg));
                            wiredTransferables.delete(arg);
                        }
                    });
                    const msgPayload = {
                        args,
                        fnChain: queuedWorkerFnChain,
                        type: '__vthread_parent_exec_child',
                    };
                    queuedWorkerFnChain = [];
                    const t = await this.delegateMsgEnsured(msgPayload, transferables);
                    resolve(processMessage(t, localErrForStack));
                });
            },
            get: (subtarget, subtprop) => {
                // We allow unlimited chaining up until a function call is made
                queuedWorkerFnChain.push(subtprop);
                return this.proxy;
            },
        }) as T;
    }

    private onTransactionComplete(cb) {
        return this.emitter.add('transaction-complete', cb);
    }

    private onTransactionStart(cb) {
        return this.emitter.add('transaction-start', cb);
    }

    private async delegateMsgEnsured(payload, transferables) {
        return this.delegateMessage(new Promise(async (res) => {
            await this.ensureWorkerReady();
            res(payload);
        }), transferables);
    }

    private async delegateMessage(payload, transferables: any[] = []): Promise<MessageEvent> {
        this.pendingTransactionCount++;
        this.emitter.dispatch('transaction-start');
        return new Promise(async (resolve: (value: MessageEvent) => void) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (e: MessageEvent) => {
                resolve(e);
                this.pendingTransactionCount--;
                this.emitter.dispatch('transaction-complete');
            };
            const data = await payload;
            this.worker.postMessage(data, [channel.port2, ...transferables]);
        });

    }

    private async ensureWorkerReady() {
        if (this.workerState === WorkerState.Killed) {
            throw new Error(`This worker has been killed`);
        }
        if (this.workerState !== WorkerState.Ready) {
            await this.startWorker();
        }
    }

    private startWorker(): Promise<boolean> {
        if (!(this.workerInitPromise instanceof Promise)) {
            this.workerInitPromise = new Promise(async (resolve: (v: boolean) => void, reject) => {
                if (this.workerState === WorkerState.Killed) {
                    reject(new Error(`Workers once killed cannot be started again. Use 'VThread.start' to start one from scratch`));
                }

                if (this.workerState < WorkerState.Listening) {
                    await this.pingWorker();
                }

                // Maybe got ready in the meantime
                if (this.workerState === WorkerState.Ready) {
                    resolve(true);
                } else {
                    const localErrForStack = new Error();
                    const res = await this.delegateMessage({
                        isParentAvailable: typeof this.host === 'object',
                        options: this.workerInitOptions,
                        type: '__vthread_worker_init',
                    });

                    // Might've been killed in the meantime
                    if (this.workerState === WorkerState.Killed) {
                        reject(new Error(`This worker has been killed. Use 'VThread.start' to start one from scratch`));
                    } else {
                        this.workerState = WorkerState.Ready;
                        resolve(processMessage(res, localErrForStack));
                    }
                }
            });
        }
        return this.workerInitPromise;
    }

    private pingWorker(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            if (this.workerState === WorkerState.Killed) {
                throw new Error(`Can't ping dead worker. Use 'VThread.start' to start one from scratch.`);
            }
            if (this.workerState === WorkerState.Listening
                || this.workerState === WorkerState.Ready) {
                resolve(true);
            }

            const channel = new MessageChannel();
            channel.port1.onmessage = (e) => {
                if (this.workerState !== WorkerState.Killed
                    && this.workerState < WorkerState.Listening) {
                    this.workerState = WorkerState.Listening;
                }
                resolve(true);
            };

            this.worker.postMessage({
                type: '__vthread_ping',
            }, [channel.port2]);
            setTimeout(() => {
                // still not quite there yet
                if (this.workerState < WorkerState.Listening) {
                    channel.port1.onmessage = null;
                    resolve(this.pingWorker());
                }
            }, 100);
        });
    }

    private handleWorkerMessage = async (event: MessageEvent) => {
        const { type } = event.data;
        if (typeof type === 'string') {
            if (type === '__vthread_child_exec_parent') {
                const { fnChain, args } = event.data;
                const responsePort: MessagePort = event.ports[0];
                let ret;
                let err: Error;

                try {
                    let maybeFn;
                    try {
                        maybeFn = fnChain.reduce((accu, prop) => typeof accu[prop] !== 'undefined' ?
                            accu[prop] :
                            this.host[prop], {});
                    } catch (error) {
                        // Original error will include ugly reduce fn in stack
                        throw new Error(error.message);
                    }
                    if (typeof maybeFn !== 'function') {
                        throw new TypeError(`Host.${maybeFn} is not a function`);
                    }
                    ret = await maybeFn.apply(this.host, args);
                } catch (error) {
                    error['stackFrames'] = extractStackFrames(error);
                    err = serializeError(error);
                }

                responsePort.postMessage({
                    err,
                    ret,
                }, wiredTransferables.get(ret));
            }
        }
    }
}
// export { VThread };
