import { expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { defaultTheme } from "@reader/core";
import { saveReaderSettings } from "./reader-settings";

vi.mock("@reader/api", () => ({ api: { saveSettings: vi.fn() } }));

it("finishes an older autosave before saving the latest glossary at close", async () => {
  let finish!: () => void;
  vi.mocked(api.saveSettings).mockImplementationOnce(
    () =>
      new Promise<typeof defaultTheme>((resolve) => {
        finish = () => resolve(defaultTheme);
      }),
  );
  const older = { ...defaultTheme, translationGlossary: "old" };
  const latest = { ...defaultTheme, translationGlossary: "new" };
  const first = saveReaderSettings(older);
  const closing = saveReaderSettings(latest);
  await Promise.resolve();
  await Promise.resolve();
  expect(api.saveSettings).toHaveBeenCalledTimes(1);
  expect(api.saveSettings).toHaveBeenLastCalledWith(older);
  finish();
  await Promise.all([first, closing]);
  expect(api.saveSettings).toHaveBeenLastCalledWith(latest);
});

it("allows a later save to recover after an autosave fails", async () => {
  vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error("save failed"));
  await expect(saveReaderSettings(defaultTheme)).rejects.toThrow("save failed");
  await expect(saveReaderSettings(defaultTheme)).resolves.toBeUndefined();
});
