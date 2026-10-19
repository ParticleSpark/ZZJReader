import { expect, it } from "vitest";
import { resolveLibraryDirectory } from "./library-directory";

it.each([undefined, "", "   "])(
  "uses the existing userData library when the override is %j",
  (value) => {
    expect(
      resolveLibraryDirectory({
        userData: "C:\\Users\\z'z'j\\AppData\\Roaming\\Reader Dev",
        env: { READER_LIBRARY_DIR: value },
        platform: "win32",
      }),
    ).toBe("C:\\Users\\z'z'j\\AppData\\Roaming\\Reader Dev\\library");
    expect(
      resolveLibraryDirectory({
        userData: "/Users/reader/Library/Application Support/Reader",
        env: { READER_LIBRARY_DIR: value },
        platform: "darwin",
      }),
    ).toBe("/Users/reader/Library/Application Support/Reader/library");
  },
);

it.each([
  ["D:\\Reader Files\\z'z'j\\..\\library", "D:\\Reader Files\\library"],
  ["D:/Reader Files/z'z'j/library", "D:\\Reader Files\\z'z'j\\library"],
  [
    "\\\\server\\Reader Files\\z'z'j\\library",
    "\\\\server\\Reader Files\\z'z'j\\library",
  ],
  [
    "//server/Reader Files/z'z'j/library",
    "\\\\server\\Reader Files\\z'z'j\\library",
  ],
])("normalizes the absolute Windows override %s", (configured, expected) => {
  expect(
    resolveLibraryDirectory({
      userData: "C:\\default",
      env: { READER_LIBRARY_DIR: configured },
      platform: "win32",
    }),
  ).toBe(expected);
});

it("normalizes a POSIX override without changing spaces or apostrophes", () => {
  expect(
    resolveLibraryDirectory({
      userData: "/default",
      env: { READER_LIBRARY_DIR: "/Volumes/Reader Files/z'z'j/../library" },
      platform: "darwin",
    }),
  ).toBe("/Volumes/Reader Files/library");
});

it.each([
  "library",
  "..\\library",
  "D:library",
  "\\library",
  "/library",
  "\\\\server",
])(
  "rejects ambiguous Windows overrides instead of opening another library: %s",
  (configured) => {
    expect(() =>
      resolveLibraryDirectory({
        userData: "C:\\default",
        env: { READER_LIBRARY_DIR: configured },
        platform: "win32",
      }),
    ).toThrow("READER_LIBRARY_DIR 必须是绝对路径");
  },
);

it.each(["library", "../library", "D:\\Reader\\library"])(
  "rejects relative POSIX overrides: %s",
  (configured) => {
    expect(() =>
      resolveLibraryDirectory({
        userData: "/default",
        env: { READER_LIBRARY_DIR: configured },
        platform: "linux",
      }),
    ).toThrow("READER_LIBRARY_DIR 必须是绝对路径");
  },
);
