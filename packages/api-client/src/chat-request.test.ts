import { afterEach, expect, it, vi } from "vitest";
import { chat, configureAPI } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
  configureAPI("");
});

it.each([undefined, false, true])(
  "sends full-document mode %s without replacing the selected source",
  async (fullDocument) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'event: delta\ndata: {"text":"answer"}\n\nevent: done\ndata: {"ok":true}\n\n',
        ),
      );
    vi.stubGlobal("fetch", fetch);
    configureAPI("chat-test-session");
    const signal = new AbortController().signal;
    const delta = vi.fn();
    const event = vi.fn();
    const references = [
      { text: "selected passage", location: { type: "pdf" as const, page: 3 } },
    ];
    await chat(
      "paper",
      "codex",
      "explain",
      "selected passage",
      signal,
      delta,
      references,
      ["p3-b1"],
      undefined,
      event,
      fullDocument,
    );

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("/api/documents/paper/chat");
    expect(options.signal).toBe(signal);
    expect(options.headers.Authorization).toBe("Bearer chat-test-session");
    expect(JSON.parse(options.body)).toEqual({
      provider: "codex",
      prompt: "explain",
      context: "selected passage",
      references,
      attachments: ["p3-b1"],
      fullDocument: fullDocument ?? false,
    });
    expect(delta).toHaveBeenCalledExactlyOnceWith("answer");
    expect(event).toHaveBeenLastCalledWith({
      event: "done",
      data: { ok: true },
    });
  },
);

it.each([409, 413])(
  "surfaces full-document rejection %s before streaming",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "全文正文尚不可用" }), {
            status,
          }),
        ),
    );
    const delta = vi.fn();
    await expect(
      chat(
        "paper",
        "codex",
        "explain",
        "excerpt",
        new AbortController().signal,
        delta,
        [],
        [],
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow("全文正文尚不可用");
    expect(delta).not.toHaveBeenCalled();
  },
);
