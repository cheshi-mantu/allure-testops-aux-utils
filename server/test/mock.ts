import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll } from "vitest";
import { TestOpsClient } from "../src/testops.js";

/**
 * Starts dev/mock-testops.mjs for the tests of a file and gives a client for it.
 * Some reads fail with 500 or an HTML page: the client is expected to repeat them.
 */
export function useMock(failureRate = 0.05): () => TestOpsClient {
  const port = 19_090 + Math.floor(Math.random() * 2000);
  let mock: ChildProcess | undefined;
  beforeAll(async () => {
    mock = spawn(process.execPath, ["dev/mock-testops.mjs"], {
      env: { ...process.env, MOCK_PORT: String(port), MOCK_FAILURE_RATE: String(failureRate) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      mock!.stdout!.once("data", () => resolve());
      mock!.once("exit", (code) => reject(new Error(`mock exited with ${code}`)));
    });
  });
  afterAll(() => {
    mock?.kill();
  });
  return () => new TestOpsClient(`http://127.0.0.1:${port}`, "mock-token");
}
