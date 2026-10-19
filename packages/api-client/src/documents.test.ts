import { afterEach, expect, it, vi } from "vitest";
import { api, configureAPI } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
  configureAPI("");
});

it.each([
  ["plain text", "Forbidden"],
  ["HTML", "<html><body>Forbidden</body></html>"],
  ["empty body", ""],
  ["empty JSON error", '{"error":""}'],
])(
  "reports the HTTP status for a forbidden library response with %s",
  async (_label, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 403 })),
    );

    await expect(api.documents()).rejects.toThrow("请求失败 (403)");
  },
);

it("preserves the server's JSON library error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "无法读取书库" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );

  await expect(api.documents()).rejects.toThrow("无法读取书库");
});

it.each([
  ["saved papers", [{ id: "saved-paper", title: "Saved", library: "papers" }]],
  ["an empty library", []],
])(
  "returns %s from an authenticated library request",
  async (_label, documents) => {
    configureAPI("library-test-session");
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(documents), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(api.documents()).resolves.toEqual(documents);
    expect(fetch).toHaveBeenCalledWith(
      "/api/documents",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer library-test-session",
        }),
      }),
    );
  },
);
