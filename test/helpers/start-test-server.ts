import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const serverScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "test-server.mjs"
);

export const binDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../bin"
);

export async function startTestServer(): Promise<{
  port: number;
  stop: () => void;
}> {
  const child: ChildProcess = spawn(process.execPath, [serverScript], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", (data: Buffer) => {
      resolve(JSON.parse(data.toString()).port as number);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`test server exited early with code ${code}`))
    );
  });
  return { port, stop: () => void child.kill() };
}
