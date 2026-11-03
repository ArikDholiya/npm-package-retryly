import { describe, expect, it, vi } from "vitest";
import { computeDelay, retry, StopRetryError, TimeoutError } from "../src/index";

const fast = { minDelay: 1, jitter: "none" } as const;

describe("retry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(retry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success", async () => {
    let calls = 0;
    const result = await retry(() => {
      if (++calls < 3) throw new Error("fail");
      return calls;
    }, fast);
    expect(result).toBe(3);
  });

  it("throws the last error after exhausting retries", async () => {
    let calls = 0;
    await expect(
      retry(() => {
        throw new Error(`fail ${++calls}`);
      }, { ...fast, retries: 2 }),
    ).rejects.toThrow("fail 3");
    expect(calls).toBe(3);
  });

  it("passes the attempt number", async () => {
    const attempts: number[] = [];
    await retry(({ attempt }) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error();
    }, fast);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("stops when shouldRetry returns false", async () => {
    const fn = vi.fn(async () => {
      throw new Error("404");
    });
    await expect(retry(fn, { ...fast, shouldRetry: (e) => (e as Error).message !== "404" })).rejects.toThrow("404");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on StopRetryError and rethrows the cause", async () => {
    const cause = new Error("bad input");
    const fn = vi.fn(async () => {
      throw new StopRetryError(cause);
    });
    await expect(retry(fn, fast)).rejects.toBe(cause);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with error, attempt and delay", async () => {
    const onRetry = vi.fn();
    await retry(({ attempt }) => {
      if (attempt < 3) throw new Error(`e${attempt}`);
    }, { minDelay: 2, jitter: "none", onRetry });
    expect(onRetry.mock.calls.map(([e, a, d]) => [(e as Error).message, a, d])).toEqual([
      ["e1", 1, 2],
      ["e2", 2, 4],
    ]);
  });

  it("times out a hanging attempt and aborts its signal", async () => {
    let seenSignal: AbortSignal | undefined;
    const error = await retry(({ signal }) => {
      seenSignal = signal;
      return new Promise(() => {});
    }, { ...fast, retries: 0, timeout: 20 }).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("retries after a timeout", async () => {
    const result = await retry(({ attempt }) => (attempt === 1 ? new Promise(() => {}) : "second"), {
      ...fast,
      timeout: 20,
    });
    expect(result).toBe("second");
  });

  it("rejects right away if the signal is already aborted", async () => {
    const fn = vi.fn();
    await expect(retry(fn, { signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow("cancelled");
    expect(fn).not.toHaveBeenCalled();
  });

  it("aborting during the backoff delay rejects without further attempts", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      setTimeout(() => controller.abort(new Error("cancelled")), 10);
      throw new Error("fail");
    });
    await expect(retry(fn, { minDelay: 10_000, jitter: "none", signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("computeDelay", () => {
  it("grows exponentially and caps at maxDelay", () => {
    const opts = { minDelay: 100, maxDelay: 1000, jitter: "none" } as const;
    expect([1, 2, 3, 4, 5].map((n) => computeDelay(n, opts))).toEqual([100, 200, 400, 800, 1000]);
  });

  it("applies full jitter between 0 and the backoff", () => {
    expect(computeDelay(3, { minDelay: 100 }, () => 0)).toBe(0);
    expect(computeDelay(3, { minDelay: 100 }, () => 0.5)).toBe(200);
  });

  it("applies equal jitter between half and all of the backoff", () => {
    expect(computeDelay(3, { minDelay: 100, jitter: "equal" }, () => 0)).toBe(200);
    expect(computeDelay(3, { minDelay: 100, jitter: "equal" }, () => 1)).toBe(400);
  });
});
