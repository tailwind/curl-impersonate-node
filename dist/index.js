/*

    curl-impersonate by wearr.
*/
import presets from "./presets.js";
import { buildCurlArgs, buildSpawnEnv } from "./args.js";
import * as proc from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
// Module-level: callers (e.g. aero's pinterest-scraper) create a fresh
// CurlImpersonate per request, so a per-instance semaphore never dedupes
// concurrent downloads of the same binary.
const downloadsInFlight = new Map();
let downloadCounter = 0;
/**
 * CurlExitError is thrown when the curl-impersonate binary runs but exits
 * non-zero. The message carries only low-cardinality fields (exit code,
 * signal, binary path) so log pipelines can aggregate on it; the variable
 * stderr tail lives on the `stderr` property instead of the message.
 */
export class CurlExitError extends Error {
    status;
    signal;
    binaryPath;
    stderr;
    constructor(status, signal, binaryPath, 
    /** Last 500 characters of curl's verbose stderr. */
    stderr) {
        super(`curl-impersonate exited with code ${status} (signal: ${signal}) using ${binaryPath}`);
        this.status = status;
        this.signal = signal;
        this.binaryPath = binaryPath;
        this.stderr = stderr;
        this.name = "CurlExitError";
    }
}
export class CurlImpersonate {
    url;
    options;
    validMethods;
    binary;
    impersonatePresets;
    binaryOverridePath;
    fetchBinaryWhenMissing = false;
    binaryCdnUrl = "https://assets.tailwindapp.com/bin";
    constructor(url, options) {
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
    tempDirectory = "/tmp/curl-impersonate";
    fetchBinary() {
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
        const download = new Promise((resolve, reject) => {
            const file = fs.createWriteStream(partialPath, { mode: 0o755 });
            const discardPartial = (err) => {
                file.close();
                fs.unlink(partialPath, () => { });
                reject(err);
            };
            https
                .get(url, (response) => {
                if (response.statusCode !== 200) {
                    discardPartial(new Error(`Failed to download binary. Status code: ${response.statusCode}`));
                    return;
                }
                response.pipe(file);
                file.on("finish", () => {
                    file.close((closeErr) => {
                        if (closeErr) {
                            fs.unlink(partialPath, () => { });
                            reject(closeErr);
                            return;
                        }
                        try {
                            fs.renameSync(partialPath, tempBinaryPath);
                        }
                        catch (renameErr) {
                            fs.unlink(partialPath, () => { });
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
    checkIfPresetAndMerge() {
        if (this.options.impersonate === undefined)
            return;
        if (this.impersonatePresets.includes(this.options.impersonate)) {
            const preset = presets[this.options.impersonate];
            // Copy instead of mutating: assigning preset.flags by reference let later
            // flag pushes grow the shared module-level preset array on every request
            // in a warm container, eventually exceeding execve's argv limit (E2BIG).
            this.options.headers = { ...this.options.headers, ...preset.headers };
            this.options.flags = [...(this.options.flags ?? []), ...preset.flags];
        }
    }
    getBinaryPath(binary) {
        if (this.binaryOverridePath) {
            return path.resolve(this.binaryOverridePath, binary);
        }
        return path.resolve(__dirname, "..", "bin", binary);
    }
    async getBinaryPathWithDownload(binary) {
        const defaultPath = path.resolve(__dirname, "..", "bin", binary);
        if (this.binaryOverridePath &&
            fs.existsSync(path.join(this.binaryOverridePath, binary))) {
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
    assertSpawnOutputs(result, binaryPath) {
        if (result.error) {
            const code = result.error.code;
            if (code === "ENOBUFS") {
                throw new Error(`curl-impersonate response exceeded maxBuffer of ${this.maxBuffer()} bytes (binary: ${binaryPath}). Raise the maxBuffer option if larger responses are expected.`);
            }
            if (code === "ETIMEDOUT") {
                throw new Error(`curl-impersonate timed out after ${this.options.timeout}ms (binary: ${binaryPath})`);
            }
            if (code === "E2BIG") {
                throw new Error(`curl-impersonate argv+env exceeded the execve limit (E2BIG, binary: ${binaryPath})`);
            }
            throw new Error(`curl-impersonate failed to start (${binaryPath}): ${result.error.message}`);
        }
        if (result.stdout == null || result.stderr == null) {
            throw new Error(`curl-impersonate produced no output (binary: ${binaryPath}, status: ${result.status}, signal: ${result.signal})`);
        }
        return {
            stdout: result.stdout,
            stderr: result.stderr,
        };
    }
    maxBuffer() {
        return this.options.maxBuffer ?? 10 * 1024 * 1024;
    }
    execCurl(binaryPath, args) {
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
            throw new CurlExitError(result.status, result.signal, binaryPath, verbose.slice(-500));
        }
        return { response, verbose };
    }
    async makeRequest(url) {
        if (url !== undefined)
            this.url = url;
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
    setNewURL(url) {
        this.url = url;
    }
    validateOptions(options) {
        if (this.validMethods.includes(options.method.toUpperCase())) {
            if (options.body !== undefined && options.method === "GET") {
                throw new Error("Method is GET with an HTTP payload!");
            }
            try {
                new URL(this.url);
                return true;
            }
            catch {
                throw new Error("URL is invalid! Must have http:// or https:// !");
            }
        }
        else {
            throw new Error(`Invalid Method! Valid HTTP methods are ${this.validMethods}`);
        }
    }
    setupBodyArgument(body) {
        if (body === undefined) {
            throw new Error(`Body is undefined in a post request! Current body is ${this.options.body}`);
        }
        try {
            return JSON.stringify(body);
        }
        catch (error) {
            throw new Error(`POST body is not JSON-serializable: ${error instanceof Error ? error.message : error}`);
        }
    }
    setProperBinary() {
        const isFF = this.options.impersonate === "firefox-109" ||
            this.options.impersonate === "firefox-117";
        switch (process.platform) {
            case "linux":
                if (process.arch === "x64") {
                    if (isFF) {
                        this.binary = "curl-impersonate-firefox-linux-x86";
                    }
                    else {
                        this.binary = "curl-impersonate-chrome-linux-x86";
                    }
                    break;
                }
                if (process.arch === "arm64") {
                    if (isFF) {
                        this.binary = "curl-impersonate-firefox-linux-aarch64";
                    }
                    else {
                        this.binary = "curl-impersonate-chrome-linux-aarch64";
                    }
                    break;
                }
                throw new Error(`Unsupported architecture: ${process.arch}`);
            case "darwin":
                if (isFF) {
                    this.binary = "curl-impersonate-firefox-darwin-x86";
                }
                else {
                    this.binary = "curl-impersonate-chrome-darwin-x86";
                }
                break;
            default:
                throw new Error(`Unsupported Platform! ${process.platform}`);
        }
    }
    async getRequest(flags, binaryPath) {
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
        const returnObject = {
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
    async postRequest(flags, body, binaryPath) {
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
        const returnObject = {
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
    extractRequestData(verbose) {
        const ipAddressRegex = /Trying (\S+):(\d+)/;
        const httpStatusRegex = /< HTTP\/2 (\d+) ([^\n]+)/;
        // Extract IP address and port
        const ipAddressMatch = verbose.match(ipAddressRegex);
        let port;
        let ipAddress;
        if (ipAddressMatch) {
            ipAddress = ipAddressMatch[1];
            port = Number.parseInt(ipAddressMatch[2]);
        }
        // Extract HTTP status code and headers
        const httpStatusMatch = verbose.match(httpStatusRegex);
        let statusCode;
        if (httpStatusMatch) {
            statusCode = Number.parseInt(httpStatusMatch[1]);
        }
        return {
            ipAddress: ipAddress,
            port: port,
            statusCode: statusCode,
        };
    }
    extractResponseHeaders(verbose) {
        const httpResponseRegex = /< ([^\n]+)/g;
        const responseHeaders = {};
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
export default CurlImpersonate;
//# sourceMappingURL=index.js.map