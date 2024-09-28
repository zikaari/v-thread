import { parse as extractStackFrames, StackFrame } from 'error-stack-parser';
import * as serializeError from 'serialize-error';
import EventManager, { IDisposable } from './Event';
import { processMessage } from './utils';
import { wiredTransferables } from './VTransferable';

/**
 * Passed as second argument to the callback set using `VThreadable#onStart`
 *
 * For reference, first argument is any data passed by master in main/window context when `VThread#start` is called there
 */
export interface IVThreadWorkerRuntime {
    /**
     * Master may optionally pass an object as third argument to VThread#start when spawning a Worker
     *
     * Any functions defined in that object can be called here (inside the Worker), except that they'll return a `Promise`
     * which will resolve (or reject) to whatever that respective function returns (or throws) on other side.
     *
     * A Worker can get a handle to that object's virtual proxy using this method
     */
    getMasterProxy(): any;

    /**
     * When master decides to kill the Worker, latter can get notified about that event using `onWillTerminate` callback.
     * The callback will be passed two arguments, any last words sent by master, and second whether termination is graceful
     * or not.
     *
     * When termination is graceful, all parties will wait for `onWillTerminate`'s callback to finish its work before killing the
     * worker, in that case callback can return a `Promise` which will be awaited upon.
     *
     * When not graceful, callback will still be called, along with last words if any, but no async work will be awaited.
     * Termination will occur upon synchronous return of callback.
     *
     * In any case, callbacks's returned value (or resolved, in case of `Promise`) wont be sent back to master
     */
    onWillTerminate(callback: (lastWords: any, graceful: boolean) => void | Promise<void>): IDisposable;
}

/**
 * @param options Any value master may pass upon creation of this Threadable
 * @param host For advanced usage, IVThreadWorkerRuntime has bunch of stuff Threadble may find useful
 */
export type VThreadWorkerProvider = (options: any, host: IVThreadWorkerRuntime) => IVThreadableContainer;

/**
 * Any methods that need to be accessible in main thread (Master/Window context) go here
 *
 * A virtual proxy to this object is returned when `VThread.prototype.getWorkerProxy` is called.
 *
 * Methods defined here can return any serializeable value, but when respective methods are called in main thread,
 * they return `Promise` which resolve (or reject) to what's actually returned (or thrown) here.
 *
 * Once again methods must return something that can be serialized i.e something that can be run through `JSON.stringify()`
 */
export interface IVThreadableContainer {
    // Not enforced as a type (because type == 'any'), but still here for dev reference
    [key: string]: any | ((...args: any[]) => any | Promise<any>) | IVThreadableContainer;
}

export class VThreadable {
    /**
     * Registers a callback to be called when `VThread#start` is called in main window context.
     *
     * Object returned by this callback is what's what accessible in main window context. Virtual
     * proxy to which can be obtained using `VThread.prototype.getWorkerHandle`
     *
     * Only one callback can be registered per Worker, second attempt throws an Error.
     *
     * @param callback Callback to be called when `VThread#start` is called
     */
    public static onStart(callback: VThreadWorkerProvider) {
        if (typeof window !== 'undefined'
            || typeof document !== 'undefined'
            || typeof importScripts === 'undefined'
        ) {
            throw new Error(`VThreadables run in worker context and spawned in main thread using VThread.start(scriptUrl: string)`);
        }
        if (typeof this.providerCallback === 'function') {
            throw new TypeError(`Looks like a callback has already been registered before, on one callback per Worker thread is allowed`);
        }
        if (typeof callback !== 'function') {
            throw new TypeError(`callback must be a function that when called should return an object to be exposed to main/window context`);
        }
        this.providerCallback = callback;
        this.tryBootup();
    }

    /**
     * Initializes and sets up Worker host
     *
     * Consumers need not call this method as this is called internally anyway
     */
    public static init() {
        if (this.isInit) {
            return;
        }
        this.isInit = true;
        addEventListener('message', this.handleMessageFromParent);
    }

    private static isInit: boolean = false;
    private static providerCallback: VThreadWorkerProvider;
    private static initOptions;
    private static initStatusResponsePort: MessagePort;
    private static connectedProvider;
    private static eventManager = new EventManager();
    // Will be Proxy object if isParentAvailable passed in init phase
    private static parentProxy: any = null;
    private static VThreadHost: IVThreadWorkerRuntime = {
        getMasterProxy: () => VThreadable.parentProxy,
        onWillTerminate: (cb) => VThreadable.eventManager.add('will-terminate', cb),
    };

    private static async tryBootup() {
        if (this.connectedProvider) {
            throw new Error(`A Provider has already been registered in this worker`);
        }
        if (typeof this.providerCallback === 'function'
            && this.initStatusResponsePort) {
            let err;
            try {
                this.connectedProvider = await this.providerCallback(this.initOptions, this.VThreadHost);
            } catch (error) {
                error['stackFrames'] = extractStackFrames(error);
                err = serializeError(error);
            }

            this.initStatusResponsePort.postMessage({
                err,
            });
        }
    }

    private static handleMessageFromParent = async (event: MessageEvent) => {
        const { type } = event.data;
        if (typeof type === 'string') {
            const responsePort = event.ports[0] as MessagePort;
            if (type === '__vthread_ping') {
                responsePort.postMessage({ ret: true });
            }

            /**
             * Called after successful ping handshake with parent
             *
             * tryBootup() will work only if connect has been called
             * otherwise connect() will call tryBootup() later
             */
            if (type === '__vthread_worker_init') {
                if (VThreadable.connectedProvider) {
                    responsePort.postMessage({ ret: true });
                }
                const { options, isParentAvailable } = event.data;
                VThreadable.initOptions = options;
                VThreadable.initStatusResponsePort = responsePort;
                if (isParentAvailable) {
                    let errForStackGen: Error = null;
                    let parentQueuedFnChain = [];
                    VThreadable.parentProxy = new Proxy(() => { /** noop */ }, {
                        apply: (subtarget, thisArg, args: any[]) => {
                            if (!(errForStackGen instanceof Error)) {
                                errForStackGen = new Error();
                            }
                            return new Promise((resolve) => {
                                const localErrForStack = errForStackGen;
                                // prep for next immediate use
                                errForStackGen = null;
                                const transferables = [];
                                args.forEach((arg) => {
                                    if (wiredTransferables.has(arg)) {
                                        transferables.push(wiredTransferables.get(arg));
                                        wiredTransferables.delete(arg);
                                    }
                                });
                                const channel = new MessageChannel();
                                channel.port1.onmessage = (e) => {
                                    channel.port1.close();
                                    channel.port2.close();
                                    resolve(processMessage(e, localErrForStack));
                                };

                                (postMessage as any)({
                                    args,
                                    fnChain: parentQueuedFnChain,
                                    type: '__vthread_child_exec_parent',
                                }, [channel.port2, ...transferables]);
                                parentQueuedFnChain = [];
                            });
                        },
                        get: (subtarget, subtprop) => {
                            // We allow unlimited chaining up until a function call is made
                            parentQueuedFnChain.push(subtprop);
                            return VThreadable.parentProxy;
                        },
                    });
                }
                VThreadable.tryBootup();
            }

            if (type === '__vthread_parent_exec_child') {
                const { fnChain, args } = event.data;
                let ret;
                let err;
                try {
                    let maybeFn;
                    try {
                        maybeFn = fnChain.reduce((accu, prop) => typeof accu[prop] !== 'undefined' ?
                            accu[prop] :
                            VThreadable.connectedProvider[prop],
                            {});
                    } catch (error) {
                        // Original error will include ugly reduce fn in stack
                        throw new Error(error.message);
                    }
                    if (typeof maybeFn !== 'function') {
                        throw new TypeError(`worker.${maybeFn} is not a function`);
                    }
                    ret = await maybeFn.apply(VThreadable.connectedProvider, args);
                } catch (error) {
                    error['stackFrames'] = extractStackFrames(error);
                    err = serializeError(error);
                }

                responsePort.postMessage({
                    err,
                    ret,
                }, wiredTransferables.get(ret));
            }

            if (type === '__vthread_worker_terminate_begin') {
                const { options } = event.data;
                let err;
                try {
                    if (options.graceful) {
                        await VThreadable.eventManager.pDispatch('will-terminate', options.lastWords, options.graceful);
                    } else {
                        VThreadable.eventManager.dispatch('will-terminate', options.lastWords, options.graceful);
                    }
                } catch (error) {
                    error['stackFrames'] = extractStackFrames(error);
                    err = serializeError(error);
                }

                try {
                    responsePort.postMessage({
                        err,
                    });
                    close();
                } catch (error) { /** noop */ }
            }
        }
    }

}

VThreadable.init();
