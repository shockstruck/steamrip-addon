import { readdir, stat } from "fs/promises";
import { basename, dirname, extname, join } from "path";

const ALLOWED_EXTENSIONS = [".rar", ".zip", ".7z"] as const;

export type SetupSource = "local-archive" | "already-downloaded" | "download";

// An `empty` result is either the "latest version" notice from an update
// check or the local-archive option; only the latter carries source "local".
export function classifySetupSource(
  type: string,
  manifest?: { source?: string } | null,
): SetupSource {
  if (type !== "empty") return "download";
  return manifest?.source === "local" ? "local-archive" : "already-downloaded";
}

export function hasAllowedArchiveExtension(filePath: string): boolean {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(
    extname(filePath).toLowerCase(),
  );
}

const PART_RAR = /^(.*)\.part(\d+)\.rar$/i;
const OLD_STYLE_VOLUME = /^(.*)\.r\d{2,}$/i;

/**
 * Validates a user-picked archive and returns the path the extractor should
 * be given: the first volume when the pick is any part of a multi-part RAR
 * set. Only reads the directory; never touches the files.
 */
export async function resolveLocalArchive(selected: string): Promise<string> {
  const info = await stat(selected).catch(() => undefined);
  if (!info) throw new Error(`Archive not found: ${selected}`);
  if (!info.isFile()) throw new Error(`Not a file: ${selected}`);

  const name = basename(selected);
  const dir = dirname(selected);
  const part = PART_RAR.exec(name);
  const oldStyle = OLD_STYLE_VOLUME.exec(name);
  if (!hasAllowedArchiveExtension(selected) && !oldStyle) {
    throw new Error(
      `Unsupported archive type "${extname(name)}". Choose a ${ALLOWED_EXTENSIONS.join(", ")} file.`,
    );
  }

  if (part) {
    const [, stem, number] = part;
    const siblings = await readdir(dir);
    const first = siblings.find((sibling) => {
      const match = PART_RAR.exec(sibling);
      return (
        match !== null &&
        match[1] === stem &&
        match[2].length === number.length &&
        Number(match[2]) === 1
      );
    });
    if (!first) {
      throw new Error(`Could not find the first volume for ${name}`);
    }
    return join(dir, first);
  }

  if (oldStyle) {
    const first = `${oldStyle[1]}.rar`;
    if (!(await stat(join(dir, first)).catch(() => undefined))) {
      throw new Error(`Could not find the first volume ${first}`);
    }
    return join(dir, first);
  }

  return selected;
}
