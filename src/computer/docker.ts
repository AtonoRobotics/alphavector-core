import { spawn } from "node:child_process";

export class DockerError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "DockerError";
  }
}

export interface DockerRunner {
  run(
    args: string[],
    options?: { input?: string; timeoutMs?: number; cwd?: string },
  ): Promise<{ stdout: string; stderr: string }>;
}

export class ProcessDockerRunner implements DockerRunner {
  constructor(private readonly dockerBin = process.env.AV_DOCKER_BIN ?? "docker") {}

  async run(
    args: string[],
    options?: { input?: string; timeoutMs?: number; cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.dockerBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: options?.cwd,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new DockerError(`docker ${args.join(" ")} timed out`, "", 124));
      }, options?.timeoutMs ?? 120_000);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) {
          reject(new DockerError(`docker ${args.join(" ")} failed`, err, code ?? 1));
          return;
        }
        resolve({ stdout: out, stderr: err });
      });
      if (options?.input !== undefined) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    });
  }
}

export async function dockerAvailable(runner: DockerRunner): Promise<boolean> {
  try {
    await runner.run(["info"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}
