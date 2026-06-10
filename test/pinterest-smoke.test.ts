/*
    Opt-in real-network smoke test: PINTEREST_SMOKE=1 npx vitest run test/pinterest-smoke.test.ts

    Verifies the end-to-end path aero uses in production (chrome-116 preset,
    HTTPS, HTTP/2): TLS handshake with the impersonation flags, statusCode
    extraction (the regex only matches HTTP/2 responses), and response-header
    parsing from curl's -v output.
*/
import { describe, expect, it } from "vitest";
import { CurlImpersonate } from "../src/index";
import { binDir } from "./helpers/start-test-server";

describe.runIf(process.env.PINTEREST_SMOKE === "1")("pinterest smoke", () => {
  it("GETs pinterest.com with the chrome-116 preset and parses status + headers", async () => {
    const curl = new CurlImpersonate("https://www.pinterest.com/", {
      method: "GET",
      impersonate: "chrome-116",
      headers: {},
      binaryOverridePath: binDir,
    });
    const result = await curl.makeRequest();

    expect(result.statusCode).toBeDefined();
    expect(result.statusCode).toBeGreaterThanOrEqual(200);
    expect(result.statusCode).toBeLessThan(500);
    expect(Object.keys(result.responseHeaders).length).toBeGreaterThan(0);
    expect(result.response.length).toBeGreaterThan(0);
  }, 30_000);
});
