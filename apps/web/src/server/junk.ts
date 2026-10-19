// Editor temp/backup files and OS clutter: never compiled, listed, snapshotted or synced. Pure, so the
// rules that use it can be unit tested.
export function isJunk(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name.endsWith("~") ||
    name.endsWith(".swp") ||
    name.endsWith(".swx") ||
    name.endsWith(".tmp") ||
    name.startsWith(".#") ||
    name.startsWith("#")
  );
}
