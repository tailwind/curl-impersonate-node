import { describe, expect, it } from "vitest";
import {
  buildCurlArgs,
  buildHeaderArgs,
  buildSpawnEnv,
  splitFlags,
} from "../src/args";

describe("buildHeaderArgs", () => {
  it("produces -H pairs with values passed verbatim", () => {
    expect(
      buildHeaderArgs({ Accept: "text/html", "User-Agent": "Mozilla/5.0" })
    ).toEqual(["-H", "Accept: text/html", "-H", "User-Agent: Mozilla/5.0"]);
  });

  it("does not mangle shell metacharacters in header values", () => {
    const args = buildHeaderArgs({
      "X-Test": `it's a "test" with $(whoami) and \`id\` and ; rm -rf /`,
    });
    expect(args).toEqual([
      "-H",
      `X-Test: it's a "test" with $(whoami) and \`id\` and ; rm -rf /`,
    ]);
  });
});

describe("splitFlags", () => {
  it("splits embedded-space preset entries into separate argv elements", () => {
    expect(splitFlags(["--cert-compression brotli", "--http2"])).toEqual([
      "--cert-compression",
      "brotli",
      "--http2",
    ]);
  });

  it("splits the ciphers flag into flag and value", () => {
    expect(
      splitFlags(["--ciphers TLS_AES_128_GCM_SHA256,TLS_AES_256_GCM_SHA384"])
    ).toEqual(["--ciphers", "TLS_AES_128_GCM_SHA256,TLS_AES_256_GCM_SHA384"]);
  });

  it("drops empty fragments from repeated whitespace", () => {
    expect(splitFlags(["--compressed  ", " --tlsv1.2"])).toEqual([
      "--compressed",
      "--tlsv1.2",
    ]);
  });
});

describe("buildCurlArgs", () => {
  it("orders args as flags, -v, headers, --url", () => {
    expect(
      buildCurlArgs({
        flags: ["--http2", "--cert-compression brotli"],
        headers: { Accept: "text/html" },
        url: "https://example.com/a?b=c",
      })
    ).toEqual([
      "--http2",
      "--cert-compression",
      "brotli",
      "-v",
      "-H",
      "Accept: text/html",
      "--url",
      "https://example.com/a?b=c",
    ]);
  });

  it("adds -d before --url only when a body is given", () => {
    const args = buildCurlArgs({
      flags: [],
      headers: {},
      url: "https://example.com",
      body: '{"a":1}',
    });
    expect(args).toEqual(["-v", "-d", '{"a":1}', "--url", "https://example.com"]);
    expect(
      buildCurlArgs({ flags: [], headers: {}, url: "https://example.com" })
    ).not.toContain("-d");
  });

  it("does not mutate its inputs", () => {
    const flags = ["--http2"];
    const headers = { Accept: "text/html" };
    buildCurlArgs({ flags, headers, url: "https://example.com" });
    buildCurlArgs({ flags, headers, url: "https://example.com" });
    expect(flags).toEqual(["--http2"]);
    expect(headers).toEqual({ Accept: "text/html" });
  });
});

describe("buildSpawnEnv", () => {
  it("keeps only allowlisted vars from a bloated environment", () => {
    const bloated: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      LD_LIBRARY_PATH: "/var/lang/lib",
    };
    for (let i = 0; i < 500; i++) {
      bloated[`JUNK_${i}`] = "x".repeat(1000);
    }
    const env = buildSpawnEnv(bloated);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      LD_LIBRARY_PATH: "/var/lang/lib",
    });
  });

  it("omits allowlisted keys that are absent", () => {
    expect(buildSpawnEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  it("passes through proxy and CA vars", () => {
    const env = buildSpawnEnv({
      https_proxy: "http://proxy:3128",
      NO_PROXY: "localhost",
      CURL_CA_BUNDLE: "/etc/ca.pem",
    });
    expect(env).toEqual({
      https_proxy: "http://proxy:3128",
      NO_PROXY: "localhost",
      CURL_CA_BUNDLE: "/etc/ca.pem",
    });
  });

  it("merges overrideEnv on top of the allowlist", () => {
    const env = buildSpawnEnv({ PATH: "/usr/bin" }, { EXTRA: "1", PATH: "/override" });
    expect(env).toEqual({ PATH: "/override", EXTRA: "1" });
  });
});
