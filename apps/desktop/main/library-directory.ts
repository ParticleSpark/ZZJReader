import { posix, win32 } from "node:path";

/** Keep saved documents in one explicit location across launch environments. */
export function resolveLibraryDirectory({
  userData,
  env,
  platform = process.platform,
}: {
  userData: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}) {
  const paths = platform === "win32" ? win32 : posix;
  const configured = env.READER_LIBRARY_DIR?.trim();
  if (!configured) return paths.join(userData, "library");
  // Windows root-relative paths still depend on the launching drive.
  const fullyQualified =
    platform !== "win32" ||
    /^[a-z]:[\\/]/i.test(configured) ||
    /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(configured);
  if (!paths.isAbsolute(configured) || !fullyQualified)
    throw new Error("READER_LIBRARY_DIR 必须是绝对路径，无法打开指定书库。");
  return paths.resolve(configured);
}
