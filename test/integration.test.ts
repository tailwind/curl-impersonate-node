import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurlImpersonate } from "../src/index";
import presets from "../src/presets";
import { binDir, startTestServer } from "./helpers/start-test-server";

let port: number;
let stopServer: () => void;

beforeAll(async () => {
  const server = await startTestServer();
  port = server.port;
  stopServer = server.stop;
});

afterAll(() => {
  stopServer();
});

function makeCurl(url: string, overrides: Record<string, unknown> = {}) {
  return new CurlImpersonate(url, {
    method: "GET",
    headers: {},
    binaryOverridePath: binDir,
    ...overrides,
  });
}

interface EchoedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

describe("spawn without a shell", () => {
  it("performs a GET and returns the response body", async () => {
    const result = await makeCurl(`http://127.0.0.1:${port}/basic`).makeRequest();
    const echoed: EchoedRequest = JSON.parse(result.response);
    expect(echoed.url).toBe("/basic");
    expect(echoed.method).toBe("GET");
  });

  it("delivers header values with shell metacharacters verbatim", async () => {
    const value = `it's a "test" $(whoami) \`id\` ; rm -rf /tmp/x`;
    const result = await makeCurl(`http://127.0.0.1:${port}/headers`, {
      headers: { "x-meta": value },
    }).makeRequest();
    const echoed: EchoedRequest = JSON.parse(result.response);
    expect(echoed.headers["x-meta"]).toBe(value);
  });

  it("delivers URLs with shell metacharacters intact", async () => {
    const urlPath = `/meta'quote?q=$(whoami)&cmd=\`id\``;
    const result = await makeCurl(
      `http://127.0.0.1:${port}${urlPath}`
    ).makeRequest();
    const echoed: EchoedRequest = JSON.parse(result.response);
    expect(echoed.url).toBe(urlPath);
  });

  it("handles responses above the old 1MB default with the 10MB default maxBuffer", async () => {
    const result = await makeCurl(`http://127.0.0.1:${port}/large`).makeRequest();
    expect(result.response.length).toBe(2 * 1024 * 1024);
  });

  it("reports a clear error when maxBuffer is exceeded", async () => {
    await expect(
      makeCurl(`http://127.0.0.1:${port}/large`, {
        maxBuffer: 1024,
      }).makeRequest()
    ).rejects.toThrow(/maxBuffer of 1024 bytes/);
  });

  it("sends a JSON-stringified POST body", async () => {
    const payload = { a: 1, nested: { quote: `it's $(whoami)` } };
    const result = await makeCurl(`http://127.0.0.1:${port}/post`, {
      method: "POST",
      body: payload,
    }).makeRequest();
    const echoed: EchoedRequest = JSON.parse(result.response);
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe(JSON.stringify(payload));
  });
});

describe("preset module purity", () => {
  it("does not accumulate flags on the shared preset across requests", async () => {
    const before = [...presets["chrome-116"].flags];
    const sharedHeaders = { accept: "text/html" };

    await makeCurl(`http://127.0.0.1:${port}/preset1`, {
      impersonate: "chrome-116",
      headers: sharedHeaders,
    }).makeRequest();
    await makeCurl(`http://127.0.0.1:${port}/preset2`, {
      impersonate: "chrome-116",
      headers: sharedHeaders,
    }).makeRequest();

    expect(presets["chrome-116"].flags).toEqual(before);
    expect(presets["chrome-116"].flags).not.toContain("-v");
    // The caller's shared headers object must not be polluted with preset headers
    expect(sharedHeaders).toEqual({ accept: "text/html" });
  });
});
