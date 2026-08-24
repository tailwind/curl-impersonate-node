/*
    Guards log aggregatability: the non-zero-exit error message must stay
    fixed-format (no stderr appended), because downstream Elastic grouping
    keys on error.message.keyword and the verbose stderr tail (progress
    meters, resolved IPs) both overflows the keyword field and fragments
    every event into its own bucket. The stderr tail must instead be
    available on the error's `stderr` property.
*/
import { expect, it } from "vitest";
import { CurlExitError, CurlImpersonate } from "../src/index";
import { binDir } from "./helpers/start-test-server";

it("keeps the exit error message fixed and exposes stderr as a property", async () => {
  // Nothing listens on port 1, so curl fails fast with exit code 7.
  const curl = new CurlImpersonate("http://127.0.0.1:1/", {
    method: "GET",
    headers: {},
    binaryOverridePath: binDir,
  });

  const err: unknown = await curl.makeRequest().then(
    () => null,
    (e) => e
  );

  expect(err).toBeInstanceOf(CurlExitError);
  const exitError = err as CurlExitError;
  expect(exitError.message).toMatch(
    /^curl-impersonate exited with code 7 \(signal: null\) using \S+$/
  );
  expect(exitError.message).not.toContain("stderr");
  expect(exitError.status).toBe(7);
  expect(exitError.signal).toBeNull();
  expect(exitError.stderr.length).toBeGreaterThan(0);
});
