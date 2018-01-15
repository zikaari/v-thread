## Web workers on steroids really.

`v-thread` is a library that gives you bunch of amazing features and neat goodies when working with web workers.

Goodies include but not limited to:

- Abstracting away `postMessage` and `onmessage` so you can focus on your code, 
- Being able to kill workers gracefully, giving them time to do clean up and stuff,
- Ability to pass additional data when workers are created,
- Enhancing errors, i.e if an error is thrown in `Worker`, final stack trace will also include calls in main thread
 that led to that error, so you know what's really going on

And the best of all, [brace yourself], being able to call methods defined in worker directly, just like you're used to.

### Example

Let's say you're making `WebGL` app or similar. You might wanna do heavy computation inside a worker to avoid blocking the main (UI) thread.

`v-thread` can really ease the process.

*Install*

```bash
$ npm i v-thread
```

*Light it up*

```javascript
// main.js

import { VThread } from 'v-thread'

(async () => {
    // start thread
    const thread = VThread.start('worker.js');

    // get proxy
    const worker = thread.getWorkerProxy();

    // have fun
    const bitmap = await worker.computeNextScene();
    
})();

// ...

```
___

```javascript
// worker.js

import { VThreadable } from 'v-thread';

class Shader {

    // ...

    async computeNextScene() {
        const frame = await this.getNextFrame();
        const camera = this.getCameraOrientaion(frame);
        const scene = this.bakeScene(frame, camera);
        return scene.rgbBitmap;
    }
}

VThreadable.onStart(() => new Shader());

// ...

```

*That's it!*

Power of multi-threading, without the pain.

|Browser support||
|--------|------|
| Chrome  | 49 |
| Firefox | 18 |
| Edge    | ✅ |
| Opera   | 36 |
| Safari  | 10 |
| IE      | ⛔ |

> Edge on desktops requires version 12 or above

Head over to [documentation](https://chipto.github.io/v-thread) for more info on whats available.

## Related

[co-web-worker](https://www.npmjs.com/package/co-web-worker) - Cross-origin web workers. Works with `v-thread`

[text-store](https://www.npmjs.com/package/text-store) - Super performant text container for working with massive text files
