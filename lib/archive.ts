import { spawn } from "child_process";
import { resolve } from "path";

const MAX_OUTPUT_LENGTH = 64 * 1024;

export type RarExtractionResult = {
  error?: Error;
  status: number;
  output: string;
};

export function extractRar(
  archivePath: string,
  destinationPath: string,
  command = "unrar",
): Promise<RarExtractionResult> {
  return new Promise((resolveResult) => {
    let output = "";
    let settled = false;
    const appendOutput = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT_LENGTH);
    };
    const finish = (result: Omit<RarExtractionResult, "output">) => {
      if (settled) return;
      settled = true;
      resolveResult({ ...result, output: output.trim() });
    };
    const child = spawn(command, ["x", "-y", resolve(archivePath)], {
      cwd: resolve(destinationPath),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (error) => {
      finish({ error, status: 1 });
    });
    child.on("close", (code) => {
      finish({ status: code ?? 1 });
    });
  });
}
