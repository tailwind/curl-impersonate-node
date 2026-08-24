/* 

    curl-impersonate by wearr.
*/

/*

CurlImpersonateOptions:

    method: A string that should read HTTP methods, GET or POST.
    headers: HTTP Headers in the form of a key:value pair object.
    body: Only required if using a method such as POST or any other option that requires a payload.
    timeout: an integer in milliseconds for a connection time-out
    followRedirects: A boolean that indicates whether or not redirects should be followed 
    flags: A string array where options such as crypto certs are accepted or other curl-impersonate flags.

*/

import type { CurlImpersonateOptions, CurlResponse } from "./interfaces";
import presets from "./presets.js";
import { buildCurlArgs, buildSpawnEnv } from "./args.js";
import * as proc from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";

// Module-level: callers (e.g. aero's pinterest-scraper) create a fresh
// CurlImpersonate per request, so a per-instance semaphore never dedupes
// concurrent downloads of the same binary.
const downloadsInFlight = new Map<string, Promise<string>>();
let downloadCounter = 0;

/**
 * CurlExitError is thrown when the curl-impersonate binary runs but exits
 * non-zero. The message carries only low-cardinality fields (exit code,
 * signal, binary path) so log pipelines can aggregate on it; the variable
 * stderr tail lives on the `stderr` property instead of the message.
 */
export class CurlExitError extends Error {
  constructor(
    readonly status: number,
    readonly signal: NodeJS.Signals | null,
    readonly binaryPath: string,
    /** Last 500 characters of curl's verbose stderr. */
    readonly stderr: string
  ) {
    super(
      `curl-impersonate exited with code ${status} (signal: ${signal}) using ${binaryPath}`
    );
    this.name = "CurlExitError";
  }
}

export class CurlImpersonate {
  url: string;
  options: CurlImpersonateOptions;
  validMethods: Array<string>;
  binary: string;
  impersonatePresets: string[];
  binaryOverridePath: string | undefined;
  fetchBinaryWhenMissing = false;
  binaryCdnUrl = "https://assets.tailwindapp.com/bin";

  constructor(url: string, options: CurlImpersonateOptions) {
    this.url = url;
    this.options = options;
    this.validMethods = ["GET", "POST"];
    this.binary = "";
    this.impersonatePresets = [
      "chrome-110",
      "chrome-116",
      "firefox-109",
      "firefox-117",
    ];
    this.binaryOverridePath =
      options.binaryOverridePath || process.env.CURL_IMPERSONATE_BINARY_PATH;
    this.fetchBinaryWhenMissing = options.fetchBinaryWhenMissing || false;
    this.binaryCdnUrl = options.binaryCdnUrl || this.binaryCdnUrl;
  }

  private tempDirectory = "/tmp/curl-impersonate";

  private fetchBinary(): Promise<string> {
    const binaryPath = this.getBinaryPath(this.binary);
    if (fs.existsSync(binaryPath)) {
      return Promise.resolve(binaryPath);
    }

    // Check if binary exists in temp directory
    const tempBinaryPath = path.join(this.tempDirectory, this.binary);
    if (fs.existsSync(tempBinaryPath)) {
      return Promise.resolve(tempBinaryPath);
    }

    // Check if download is already in progress
    const inFlight = downloadsInFlight.get(this.binary);
    if (inFlight) {
      return inFlight;
    }

    console.warn("Curl-impersonate binary not found, fetching from CDN");

    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDirectory)) {
      fs.mkdirSync(this.tempDirectory, { recursive: true });
    }

    const url = `${this.binaryCdnUrl}/${this.binary}`;
    console.log(`Downloading binary from ${url}`);

    // Download to a unique partial path and rename into place once the fd is
    // closed. Writing straight to the final path let a concurrent existsSync
    // see a half-written file and spawn it (ETXTBSY / truncated binary).
    // rename is atomic because the partial file is on the same mount.
    const partialPath = `${tempBinaryPath}.${process.pid}.${++downloadCounter}.download`;

    const download = new Promise<string>((resolve, reject) => {
      const file = fs.createWriteStream(partialPath, { mode: 0o755 });
      const discardPartial = (err: unknown) => {
        file.close();
        fs.unlink(partialPath, () => {});
        reject(err);
      };

      https
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            discardPartial(
              new Error(
                `Failed to download binary. Status code: ${response.statusCode}`
              )
            );
            return;
          }
          response.pipe(file);
          file.on("finish", () => {
            file.close((closeErr) => {
              if (closeErr) {
                fs.unlink(partialPath, () => {});
                reject(closeErr);
                return;
              }
              try {
                fs.renameSync(partialPath, tempBinaryPath);
              } catch (renameErr) {
                fs.unlink(partialPath, () => {});
                reject(renameErr);
                return;
              }
              resolve(tempBinaryPath);
            });
          });
        })
        .on("error", discardPartial);
    }).finally(() => {
      downloadsInFlight.delete(this.binary);
    });

    downloadsInFlight.set(this.binary, download);
    return download;
  }

  private checkIfPresetAndMerge() {
    if (this.options.impersonate === undefined) return;
    if (this.impersonatePresets.includes(this.options.impersonate)) {
      const preset = presets[this.options.impersonate];
      // Copy instead of mutating: assigning preset.flags by reference let later
      // flag pushes grow the shared module-level preset array on every request
      // in a warm container, eventually exceeding execve's argv limit (E2BIG).
      this.options.headers = { ...this.options.headers, ...preset.headers };
      this.options.flags = [...(this.options.flags ?? []), ...preset.flags];
    }
  }

  private getBinaryPath(binary: string) {
    if (this.binaryOverridePath) {
      return path.resolve(this.binaryOverridePath, binary);
    }
    return path.resolve(__dirname, "..", "bin", binary);
  }

  private async getBinaryPathWithDownload(binary: string): Promise<string> {
    const defaultPath = path.resolve(__dirname, "..", "bin", binary);
    if (
      this.binaryOverridePath &&
      fs.existsSync(path.join(this.binaryOverridePath, binary))
    ) {
      return path.resolve(this.binaryOverridePath, binary);
    }
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }

    // If fetchBinaryWhenMissing is enabled, try to download it
    if (this.fetchBinaryWhenMissing) {
      return await this.fetchBinary();
    }

    return defaultPath;
  }

  private assertSpawnOutputs(
    result: proc.SpawnSyncReturns<Buffer | string>,
    binaryPath: string
  ) {
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOBUFS") {
        throw new Error(
          `curl-impersonate response exceeded maxBuffer of ${this.maxBuffer()} bytes (binary: ${binaryPath}). Raise the maxBuffer option if larger responses are expected.`
        );
      }
      if (code === "ETIMEDOUT") {
        throw new Error(
          `curl-impersonate timed out after ${this.options.timeout}ms (binary: ${binaryPath})`
        );
      }
      if (code === "E2BIG") {
        throw new Error(
          `curl-impersonate argv+env exceeded the execve limit (E2BIG, binary: ${binaryPath})`
        );
      }
      throw new Error(
        `curl-impersonate failed to start (${binaryPath}): ${result.error.message}`
      );
    }

    if (result.stdout == null || result.stderr == null) {
      throw new Error(
        `curl-impersonate produced no output (binary: ${binaryPath}, status: ${result.status}, signal: ${result.signal})`
      );
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private maxBuffer() {
    return this.options.maxBuffer ?? 10 * 1024 * 1024;
  }

  private execCurl(binaryPath: string, args: string[]) {
    // No shell: array args go straight to execve, so scraped content in
    // URLs/headers can never be interpreted by /bin/sh, and the child gets a
    // minimal allowlisted env instead of the full (growing) parent env.
    const result = proc.spawnSync(binaryPath, args, {
      env: buildSpawnEnv(process.env, this.options.env),
      maxBuffer: this.maxBuffer(),
      timeout: this.options.timeout,
    });
    const { stdout, stderr } = this.assertSpawnOutputs(result, binaryPath);
    const response = stdout.toString();
    const verbose = stderr.toString();

    if (result.status && result.status !== 0) {
      throw new CurlExitError(
        result.status,
        result.signal,
        binaryPath,
        verbose.slice(-500)
      );
    }

    return { response, verbose };
  }

  async makeRequest(url?: string): Promise<CurlResponse> {
    if (url !== undefined) this.url = url;

    if (!this.validateOptions(this.options)) {
      throw new Error("Invalid options");
    }

    this.setProperBinary();

    // Ensure binary is available (download if necessary)
    const binaryPath = await this.getBinaryPathWithDownload(this.binary);

    this.checkIfPresetAndMerge();
    const flags = this.options.flags || [];

    if (this.options.method === "GET") {
      return await this.getRequest(flags, binaryPath);
    }
    if (this.options.method === "POST") {
      return await this.postRequest(flags, this.options.body, binaryPath);
    }
    throw new Error("Unsupported HTTP method");
  }

  setNewURL(url: string) {
    this.url = url;
  }

  validateOptions(options: CurlImpersonateOptions) {
    if (this.validMethods.includes(options.method.toUpperCase())) {
      if (options.body !== undefined && options.method === "GET") {
        throw new Error("Method is GET with an HTTP payload!");
      }
      try {
        new URL(this.url);
        return true;
      } catch {
        throw new Error("URL is invalid! Must have http:// or https:// !");
      }
    } else {
      throw new Error(
        `Invalid Method! Valid HTTP methods are ${this.validMethods}`
      );
    }
  }

  private setupBodyArgument(body: Record<string, unknown> | undefined): string {
    if (body === undefined) {
      throw new Error(
        `Body is undefined in a post request! Current body is ${this.options.body}`
      );
    }
    try {
      return JSON.stringify(body);
    } catch (error) {
      throw new Error(
        `POST body is not JSON-serializable: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  private setProperBinary() {
    const isFF =
      this.options.impersonate === "firefox-109" ||
      this.options.impersonate === "firefox-117";
    switch (process.platform) {
      case "linux":
        if (process.arch === "x64") {
          if (isFF) {
            this.binary = "curl-impersonate-firefox-linux-x86";
          } else {
            this.binary = "curl-impersonate-chrome-linux-x86";
          }

          break;
        }
        if (process.arch === "arm64") {
          if (isFF) {
            this.binary = "curl-impersonate-firefox-linux-aarch64";
          } else {
            this.binary = "curl-impersonate-chrome-linux-aarch64";
          }
          break;
        }
        throw new Error(`Unsupported architecture: ${process.arch}`);
      case "darwin":
        if (isFF) {
          this.binary = "curl-impersonate-firefox-darwin-x86";
        } else {
          this.binary = "curl-impersonate-chrome-darwin-x86";
        }
        break;
      default:
        throw new Error(`Unsupported Platform! ${process.platform}`);
    }
  }
  private async getRequest(flags: Array<string>, binaryPath: string) {
    // GET REQUEST
    const args = buildCurlArgs({
      flags,
      headers: this.options.headers,
      url: this.url,
    });
    if (this.options.verbose) {
      console.log({
        binpath: binaryPath,
        args: args,
        url: this.url,
      });
    }
    const { response, verbose } = this.execCurl(binaryPath, args);

    const requestData = this.extractRequestData(verbose);
    const respHeaders = this.extractResponseHeaders(verbose);

    const returnObject: CurlResponse = {
      ipAddress: requestData.ipAddress,
      port: requestData.port,
      statusCode: requestData.statusCode,
      response: response,
      responseHeaders: respHeaders,
      requestHeaders: this.options.headers,
      verboseStatus: this.options.verbose ?? false,
    };

    return returnObject;
  }

  private async postRequest(
    flags: Array<string>,
    body: Record<string, unknown> | undefined,
    binaryPath: string
  ) {
    // POST REQUEST
    const curlBody = this.setupBodyArgument(body);
    const args = buildCurlArgs({
      flags,
      headers: this.options.headers,
      url: this.url,
      body: curlBody,
    });

    const { response, verbose } = this.execCurl(binaryPath, args);
    const cleanedPayload = response.replace(/\s+\+\s+/g, "");

    const requestData = this.extractRequestData(verbose);
    const respHeaders = this.extractResponseHeaders(verbose);

    const returnObject: CurlResponse = {
      ipAddress: requestData.ipAddress,
      port: requestData.port,
      statusCode: requestData.statusCode,
      response: cleanedPayload,
      responseHeaders: respHeaders,
      requestHeaders: this.options.headers,
      verboseStatus: this.options.verbose,
    };
    return returnObject;
  }

  private extractRequestData(verbose: string) {
    const ipAddressRegex = /Trying (\S+):(\d+)/;
    const httpStatusRegex = /< HTTP\/2 (\d+) ([^\n]+)/;

    // Extract IP address and port
    const ipAddressMatch = verbose.match(ipAddressRegex);
    let port: number | undefined;
    let ipAddress: string | undefined;
    if (ipAddressMatch) {
      ipAddress = ipAddressMatch[1];
      port = Number.parseInt(ipAddressMatch[2]);
    }

    // Extract HTTP status code and headers
    const httpStatusMatch = verbose.match(httpStatusRegex);
    let statusCode: number | undefined;
    if (httpStatusMatch) {
      statusCode = Number.parseInt(httpStatusMatch[1]);
    }
    return {
      ipAddress: ipAddress,
      port: port,
      statusCode: statusCode,
    };
  }

  private extractResponseHeaders(verbose: string) {
    const httpResponseRegex = /< ([^\n]+)/g;
    const responseHeaders: { [key: string]: string } = {};
    const match = verbose.match(httpResponseRegex);
    if (match) {
      for (const header of match) {
        const headerWithoutPrefix = header.substring(2);
        const headerParts = headerWithoutPrefix.split(": ");
        if (headerParts.length > 1) {
          const headerName = headerParts[0].trim();
          const headerValue = headerParts[1].trim();
          responseHeaders[headerName] = headerValue;
        }
      }
    }
    return responseHeaders;
  }

}
export type { CurlImpersonateOptions };
export default CurlImpersonate;
