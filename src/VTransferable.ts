export type IVTranserableData = ArrayBuffer | ImageBitmap;

// typescript please stahp!
declare const ImageBitmap;

const wiredTransferables: WeakMap<any, any> = new WeakMap();

/**
 * Marks some or all of data in first argument as transferable.
 *
 * Call this before returning or exchanging large amounts of data between worker and main thread
 *
 * ⚠ WARNING ⚠ : Data once marked as transferable becomes unusable in the context it was marked transferable
 *
 * @param value
 * @param transferables
 */
function markAsVTransferable<T>(value: T, ...transferables: IVTranserableData[]) {
    if (typeof value === 'object') {
        if (transferables.length === 0) {
            transferables.push(value as any);
        }
        if (!transferables.every((t) => (t instanceof ArrayBuffer || t instanceof ImageBitmap))) {
            throw new TypeError('Only ArrayBuffer(s) and ImageBitmap(s) can be transfered');
        }
        wiredTransferables.set(value, transferables);
    }
    return value;
}

export { markAsVTransferable, wiredTransferables };
