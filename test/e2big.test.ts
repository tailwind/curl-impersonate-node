/*
    Reproduces the warm-Lambda failure mode: a parent process whose env has
    grown past execve's argv+env limit (~2MB with default stack rlimit). With
    full env inheritance this spawn fails with E2BIG; the allowlisted child
    env makes it succeed. Isolated in its own file so the bloated env can't
    leak into other tests.
*/
import { afterAll, beforeAll, expect, it } from "vitest";
import { CurlImpersonate } from "../src/index";
import { binDir, startTestServer } from "./helpers/start-test-server";

let port: number;
let stopServer: () => void;
const junkKeys: string[] = [];

beforeAll(async () => {
  // Start the server before bloating the env — the server child would
  // otherwise inherit the bloat and itself fail to spawn with E2BIG.
  const server = await startTestServer();
  port = server.port;
  stopServer = server.stop;

  for (let i = 0; i < 500; i++) {
    const key = `E2BIG_JUNK_${i}`;
    process.env[key] = "x".repeat(8 * 1024);
    junkKeys.push(key);
  }
});

afterAll(() => {
  for (const key of junkKeys) {
    delete process.env[key];
  }
  stopServer();
});

it("spawns successfully even when the parent env exceeds the execve limit", async () => {
  const curl = new CurlImpersonate(`http://127.0.0.1:${port}/`, {
    method: "GET",
    headers: {},
    binaryOverridePath: binDir,
  });
  const result = await curl.makeRequest();
  expect(JSON.parse(result.response).url).toBe("/");
});
