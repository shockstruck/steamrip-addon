import { spawn } from "child_process";
import { basename, resolve } from "path";

const MAX_OUTPUT_LENGTH = 64 * 1024;

export type ExtractionProgressCallback = (progress: number) => void;

export type RarExtractionResult = {
  error?: Error;
  status: number;
  output: string;
};

export type RarExtractorCommand = "unrar" | "unar";

// Prefer unrar, but fall back to unar (The Unarchiver), which also extracts RAR.
export function resolveRarExtractor(): RarExtractorCommand | null {
  return (
    (["unrar", "unar"] as const).find((command) => Bun.which(command)) ?? null
  );
}

export function extractRar(
  archivePath: string,
  destinationPath: string,
  command = "unrar",
  onProgress?: ExtractionProgressCallback,
): Promise<RarExtractionResult> {
  // unar has its own CLI: -f overwrites and -D skips the wrapper directory,
  // matching unrar's "x -y" behavior. unar prints no percentages, so progress
  // only reports 100 on completion.
  const args: string[] =
    basename(command) === "unar"
      ? ["-f", "-D", resolve(archivePath)]
      : ["x", "-y", resolve(archivePath)];
  return runExtractor(command, args, destinationPath, onProgress);
}

export function extractWith7Zip(
  archivePath: string,
  destinationPath: string,
  command: string,
  onProgress?: ExtractionProgressCallback,
): Promise<RarExtractionResult> {
  return runExtractor(
    command,
    ["x", resolve(archivePath), `-o${resolve(destinationPath)}`, "-y", "-bsp1"],
    destinationPath,
    onProgress,
  );
}

function runExtractor(
  command: string,
  args: string[],
  destinationPath: string,
  onProgress?: ExtractionProgressCallback,
): Promise<RarExtractionResult> {
  return new Promise((resolveResult) => {
    let output = "";
    let lastProgress = -1;
    let settled = false;
    const createOutputHandler = () => {
      let progressBuffer = "";

      return (chunk: Buffer): void => {
        const text = chunk.toString();
        output = (output + text).slice(-MAX_OUTPUT_LENGTH);
        const combinedOutput = progressBuffer + text;

        for (const match of combinedOutput.matchAll(
          /(?:^|[\s\x08])(\d{1,3})%/g,
        )) {
          const progress = Math.min(Number(match[1]), 99);
          if (progress > lastProgress) {
            lastProgress = progress;
            onProgress?.(progress);
          }
        }
        progressBuffer = combinedOutput.slice(-8);
      };
    };
    const finish = (result: Omit<RarExtractionResult, "output">) => {
      if (settled) return;
      settled = true;
      if (!result.error && result.status === 0 && lastProgress < 100) {
        onProgress?.(100);
      }
      resolveResult({ ...result, output: output.trim() });
    };
    const child = spawn(command, args, {
      cwd: resolve(destinationPath),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", createOutputHandler());
    child.stderr.on("data", createOutputHandler());
    child.on("error", (error) => {
      finish({ error, status: 1 });
    });
    child.on("close", (code) => {
      finish({ status: code ?? 1 });
    });
  });
}
