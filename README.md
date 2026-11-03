# @arik0108/retryly

Tiny, zero-dependency retry helper for async functions, with **exponential backoff**, **jitter**, **per-attempt timeouts** and **`AbortSignal`** support. Fully typed, ships ESM and CommonJS.

```sh
npm install @arik0108/retryly
```

## Why

Network calls fail for short-lived reasons: overloaded servers, rate limits, dropped connections. Retrying fixes most of them, but retrying *badly* (instantly, forever, all clients in sync) makes outages worse. `retryly` retries the right way:

- **Exponential backoff:** waits 100ms → 200ms → 400ms → … between attempts, capped by `maxDelay`.
- **Jitter:** randomizes delays so many clients don't retry in lockstep (the "thundering herd").
- **Timeouts:** a hanging attempt is aborted and retried instead of blocking forever.
- **Cancellation:** pass an `AbortSignal` to stop everything, including a pending wait.
- **Control:** decide which errors are worth retrying with `shouldRetry` or `StopRetryError`.

## Usage

```ts
import { retry } from "@arik0108/retryly";

const user = await retry(
  async ({ signal }) => {
    const res = await fetch("https://api.example.com/user", { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  { retries: 4, timeout: 5_000 },
);
```

CommonJS works too:

```js
const { retry } = require("@arik0108/retryly");
```

### Only retry errors that can succeed later

```ts
class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

await retry(
  async ({ signal }) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  {
    // retry rate limits and server errors, give up on 4xx client errors
    shouldRetry: (error) =>
      !(error instanceof HttpError) || error.status === 429 || error.status >= 500,
  },
);
```

### Stop from inside the function

```ts
import { retry, StopRetryError } from "@arik0108/retryly";

await retry(async () => {
  const res = await fetch(url);
  if (res.status === 401) throw new StopRetryError(new Error("Not logged in"));
  // ...
});
// rejects with the "Not logged in" error after a single attempt
```

### Cancel everything

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000); // give up after 10s total

await retry(({ signal }) => fetch(url, { signal }), { signal: controller.signal });
```

### Log retries

```ts
await retry(task, {
  onRetry: (error, attempt, delay) =>
    console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, error),
});
```

## API

### `retry(fn, options?)`

Calls `fn` until it resolves. Returns its result, or rejects with the **last error** once all retries are used up.

`fn` receives `{ attempt, signal }`:

| Field     | Description                                                                        |
| --------- | ---------------------------------------------------------------------------------- |
| `attempt` | Current attempt number, starting at `1`.                                           |
| `signal`  | `AbortSignal` that aborts on timeout or outer cancellation. Pass it to `fetch` etc. |

#### Options

| Option        | Default    | Description                                                                 |
| ------------- | ---------- | --------------------------------------------------------------------------- |
| `retries`     | `3`        | Retries after the first attempt (`3` means up to 4 attempts total).         |
| `minDelay`    | `100`      | Delay before the first retry, in ms.                                        |
| `maxDelay`    | `30000`    | Maximum delay between attempts, in ms.                                      |
| `factor`      | `2`        | Multiplier applied to the delay after each failure.                         |
| `jitter`      | `"full"`   | `"full"` (0 to delay), `"equal"` (half to full delay) or `"none"`.          |
| `timeout`     | none       | Per-attempt timeout in ms. Rejects that attempt with `TimeoutError`.        |
| `signal`      | none       | `AbortSignal` that cancels the whole operation.                             |
| `shouldRetry` | always     | `(error, attempt) => boolean \| Promise<boolean>`. Return `false` to stop. |
| `onRetry`     | none       | `(error, attempt, delay) => void`, called before each wait.                 |

### `StopRetryError`

Throw `new StopRetryError(cause)` from `fn` to stop immediately. `retry` rejects with `cause`.

### `TimeoutError`

The error used when an attempt exceeds `timeout`.

### `computeDelay(retry, options?)`

Returns the delay (ms) used before retry number `retry` (1-based), following the same backoff and jitter rules. Handy for building your own retry loops.

## Requirements

Node.js 20.3+ or any modern browser (uses `AbortSignal.any`).

## License

MIT
