import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IlinkClient } from "../../src/acp/acp-client.js";

describe("IlinkClient request signal lifecycle", () => {
  const client = new IlinkClient({
    baseUrl: "http://127.0.0.1",
    cdnBaseUrl: "http://127.0.0.1",
  });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function expectReleased(parent: AbortController) {
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  }

  it("releases listeners across repeated polls using the same parent", async () => {
    const parent = new AbortController();
    fetchMock.mockImplementation(async () => new Response('{"ret":0,"msgs":[]}'));

    for (let i = 0; i < 100; i++) {
      await client.getUpdates("cursor", parent.signal);
      expectReleased(parent);
    }

    expect(parent.signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("forwards an already aborted parent and preserves its reason", async () => {
    const parent = new AbortController();
    const reason = new DOMException("stopped", "AbortError");
    parent.abort(reason);
    fetchMock.mockImplementation(async (_url, options) => {
      expect(options.signal.aborted).toBe(true);
      expect(options.signal.reason).toBe(reason);
      throw options.signal.reason;
    });

    await expect(client.getUpdates("cursor", parent.signal)).resolves.toEqual({
      ret: 0, msgs: [], get_updates_buf: "cursor",
    });
    expectReleased(parent);
  });

  it("forwards cancellation while fetch is pending", async () => {
    const parent = new AbortController();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
      });
    });

    const result = client.getUpdates("cursor", parent.signal);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
    parent.abort();
    expect(requestSignal!.aborted).toBe(true);
    expect(requestSignal!.reason).toBe(parent.signal.reason);
    await expect(result).resolves.toEqual({ ret: 0, msgs: [], get_updates_buf: "cursor" });
    expectReleased(parent);
  });

  it("keeps cancellation connected until the response body finishes", async () => {
    const parent = new AbortController();
    let readingBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { readingBody = resolve; });
    fetchMock.mockImplementation(async (_url, options) => ({
      text: () => {
        readingBody();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    }));

    const result = client.getUpdates("cursor", parent.signal);
    await bodyStarted;
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
    parent.abort();
    await expect(result).resolves.toEqual({ ret: 0, msgs: [], get_updates_buf: "cursor" });
    expectReleased(parent);
  });

  it.each(["network", "http", "json", "body"])("cleans up after a %s failure", async (failure) => {
    const parent = new AbortController();
    fetchMock.mockImplementation(async () => {
      if (failure === "network") throw new Error("network failure");
      if (failure === "body") return { text: async () => { throw new Error("body failure"); } };
      if (failure === "http") return new Response("unavailable", { status: 503 });
      return new Response("invalid JSON");
    });

    await expect(client.getUpdates("cursor", parent.signal)).rejects.toThrow();
    expectReleased(parent);
  });

  it("preserves the long-poll timeout and releases the parent listener", async () => {
    const parent = new AbortController();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
      });
    });

    const result = client.getUpdates("cursor", parent.signal);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(requestSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ ret: 0, msgs: [], get_updates_buf: "cursor" });
    expect(parent.signal.aborted).toBe(false);
    expectReleased(parent);
  });
});
