/*
    Reproduces the group-board-finder ETXTBSY failure mode: many fresh
    CurlImpersonate instances (callers create one per request) racing to
    download the same missing binary. Before the fix, each instance had its
    own semaphore and wrote directly to the final path, so a concurrent
    existsSync could see a half-written file — and resolve() fired before the
    write fd was closed. The CDN is stubbed with a local HTTP server that
    streams the payload slowly to widen the race window.
*/
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { CurlImpersonate } from "../src/index";

// fetchBinary uses https.get; delegate to plain http so the stub CDN does
// not need a self-signed certificate.
vi.mock("node:https", async () => {
  const httpActual =
    await vi.importActual<typeof import("node:http")>("node:http");
  return { get: httpActual.get };
});

const PAYLOAD = Buffer.alloc(64 * 1024, "curl-impersonate-test-payload ");
const CHUNK_SIZE = 8 * 1024;

let server: http.Server;
let cdnUrl: string;
let requestCount = 0;
let failNextRequest = false;
let testDir: string;
let emptyBinDir: string;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-binary-test-"));
  emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-binary-empty-"));

  server = http.createServer((req, res) => {
    requestCount++;
    if (failNextRequest) {
      failNextRequest = false;
      res.statusCode = 500;
      res.end("stub CDN failure");
      return;
    }
    res.statusCode = 200;
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= PAYLOAD.length) {
        clearInterval(interval);
        res.end();
        return;
      }
      res.write(PAYLOAD.subarray(offset, offset + CHUNK_SIZE));
      offset += CHUNK_SIZE;
    }, 5);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub CDN did not bind to a port");
  }
  cdnUrl = `http://127.0.0.1:${address.port}/bin`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(emptyBinDir, { recursive: true, force: true });
});

// fetchBinary is private and normally reached through makeRequest; invoke it
// directly so the test does not depend on a spawnable binary.
function makeFetcher(binaryName: string): () => Promise<string> {
  const curl = new CurlImpersonate("https://example.com", {
    method: "GET",
    headers: {},
    fetchBinaryWhenMissing: true,
    binaryCdnUrl: cdnUrl,
    binaryOverridePath: emptyBinDir,
  }) as unknown as {
    binary: string;
    tempDirectory: string;
    fetchBinary: () => Promise<string>;
  };
  curl.binary = binaryName;
  curl.tempDirectory = testDir;
  return () => curl.fetchBinary();
}

it("dedupes concurrent fetches across instances and resolves only with a complete file", async () => {
  const binaryName = "fake-curl-binary-concurrent";
  const fetches = Array.from({ length: 8 }, () => makeFetcher(binaryName)());
  const paths = await Promise.all(fetches);

  const finalPath = path.join(testDir, binaryName);
  for (const resolved of paths) {
    expect(resolved).toBe(finalPath);
  }

  // One shared download despite 8 instances — the semaphore must be
  // module-level, not per-instance.
  expect(requestCount).toBe(1);

  // File is complete and executable the moment any fetch resolves.
  const written = fs.readFileSync(finalPath);
  expect(written.equals(PAYLOAD)).toBe(true);
  expect(fs.statSync(finalPath).mode & 0o755).toBe(0o755);

  // No partial download files left behind.
  const leftovers = fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith(".download"));
  expect(leftovers).toEqual([]);
});

it("clears the in-flight slot on failure so a retry can succeed", async () => {
  const binaryName = "fake-curl-binary-retry";
  requestCount = 0;
  failNextRequest = true;

  await expect(makeFetcher(binaryName)()).rejects.toThrow(
    "Failed to download binary. Status code: 500"
  );
  // The failed attempt must not leave a partial file that short-circuits the
  // retry's existsSync check.
  expect(fs.existsSync(path.join(testDir, binaryName))).toBe(false);

  const resolved = await makeFetcher(binaryName)();
  expect(requestCount).toBe(2);
  expect(fs.readFileSync(resolved).equals(PAYLOAD)).toBe(true);
});
