import { randomBytes } from "node:crypto";
import { chmod, lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// A cheap identity for "has this file changed since I read it": mtime (ns on
// APFS and ext4), size and inode. Used to narrow the window between the
// compare-and-swap read and the rename; it cannot close it (no flock in Node).
export async function fileSignature(path) {
  try {
    const s = await stat(path, { bigint: true });
    return `${s.mtimeNs}:${s.size}:${s.ino}`;
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

// rename() over a symlink replaces the link with a plain file, which would
// silently detach a user's linked auth.json (dotfiles repos, shared CODEX_HOME).
// Resolve the link and write to its target instead; refuse a dangling link.
async function resolveTarget(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return path;
    throw error;
  }
  if (!info.isSymbolicLink()) return path;
  try {
    return await realpath(path);
  } catch {
    throw new Error("refusing to write through a dangling symlink");
  }
}

// Write-to-temp, fsync, rename, chmod 0600, then fsync the directory. Readers
// (including a running Codex CLI) see either the old or the new document,
// never a truncated one. The temp name is random and opened with O_EXCL ("wx"),
// so a pre-planted file or symlink at that name makes the write fail instead of
// being followed. The temp file is created 0600 (umask can only remove bits), so
// the secret is never readable by others, even before the final chmod.
//
// beforeRename(tempPath) runs after the data is durable and immediately before
// the rename; throwing from it aborts the write and removes the temp file. The
// auth code uses it for its last-moment "did the file change?" check.
export async function atomicWriteJson(path, value, { beforeRename } = {}) {
  const target = await resolveTarget(path);
  const directory = dirname(target);
  const tempPath = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (beforeRename) await beforeRename(tempPath);
    await rename(tempPath, target);
    await chmod(target, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  try {
    const dir = await open(directory, "r");
    await dir.sync().catch(() => {});
    await dir.close();
  } catch {
    // Directory fsync is best effort (not supported everywhere).
  }
}
