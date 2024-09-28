import { parse as extractStackFrames, StackFrame } from 'error-stack-parser';

function processMessage(event: MessageEvent, localErrForStack: Error) {
    const { transactionId, err, ret } = event.data;
    if (err) {
        const localStack = extractStackFrames(localErrForStack);
        if (localStack[0] && localStack[0].functionName.indexOf('Object.apply') > -1) {
            localStack.shift();
        }
        let hydratedErr;
        if (localErrForStack && err.stackFrames) {
            const ctr = typeof self !== 'undefined' && self[err.name] ? self[err.name] : Error;
            // @ts-ignore
            hydratedErr = new ctr(err.message);
            Object.defineProperties(hydratedErr, (Object as any).getOwnPropertyDescriptors(err));
            hydratedErr.stack = [...err.stackFrames, ...localStack].map((frame) => frame.source).join('\n');
        } else {
            hydratedErr = new Error('Unknown error occured in v-thread');
        }

        throw hydratedErr;
    }
    return ret;
}

export { processMessage };
