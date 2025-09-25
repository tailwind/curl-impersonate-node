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
import * as proc from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export class CurlImpersonate {
  url: string;
  options: CurlImpersonateOptions;
  validMethods: Array<string>;
  binary: string;
  impersonatePresets: string[];
  binaryOverridePath: string | undefined;

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
  }

  private checkIfPresetAndMerge() {
    if (this.options.impersonate === undefined) return;
    if (this.impersonatePresets.includes(this.options.impersonate)) {
      const preset = presets[this.options.impersonate];
      this.options.headers = Object.assign(
        this.options.headers,
        preset.headers
      );
      this.options.flags = this.options.flags
        ? this.options.flags.concat(preset.flags)
        : preset.flags;
    }
  }

  private getBinaryPath(binary: string) {
    if (this.binaryOverridePath) {
      return path.join(this.binaryOverridePath, binary);
    }
    return path.join(__dirname, "..", "bin", binary);
  }

  makeRequest(url?: string): Promise<CurlResponse> {
    if (url !== undefined) this.url = url;
    return new Promise((resolve, reject) => {
      if (this.validateOptions(this.options)) {
        this.setProperBinary();
        const binaryPath = this.getBinaryPath(this.binary);
        if (this.binary && fs.existsSync(binaryPath)) {
          fs.chmodSync(binaryPath, 0o755);
        }
        this.checkIfPresetAndMerge();
        const headers = this.convertHeaderObjectToCURL();
        const flags = this.options.flags || [];
        if (this.options.method === "GET") {
          this.getRequest(flags, headers)
            .then((response) => resolve(response))
            .catch((error) => reject(error));
        } else if (this.options.method === "POST") {
          this.postRequest(flags, headers, this.options.body)
            .then((response) => resolve(response))
            .catch((error) => reject(error));
        } else {
          // Handle other HTTP methods if needed
          reject(new Error("Unsupported HTTP method"));
        }
      } else {
        reject(new Error("Invalid options"));
      }
    });
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

  private setupBodyArgument(body: Record<string, unknown> | undefined) {
    if (body !== undefined) {
      try {
        JSON.stringify(body);
      } catch {
        return body; // Assume that content type is anything except www-form-urlencoded or form-data, not quite sure if graphql is supported.
      }
    } else {
      throw new Error(
        `Body is undefined in a post request! Current body is ${this.options.body}`
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
  private async getRequest(flags: Array<string>, headers: string) {
    // GET REQUEST
    flags.push("-v");
    const binpath = this.getBinaryPath(this.binary);
    const args = `${flags.join(" ")} ${headers} '${this.url}'`;
    if (this.options.verbose) {
      console.log({
        binpath: binpath,
        args: args,
        url: this.url,
      });
    }
    const result = proc.spawnSync(`${binpath} ${args}`, { shell: true });
    const response = result.stdout.toString();
    const verbose = result.stderr.toString();

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
    headers: string,
    body: Record<string, unknown> | undefined
  ) {
    // POST REQUEST
    flags.push("-v");
    const curlBody = this.setupBodyArgument(body);
    const binpath = this.getBinaryPath(this.binary);
    const args = `${flags.join(" ")} ${headers} ${this.url}`;

    const result = proc.spawnSync(`${binpath} ${args} -d ${curlBody}`, {
      shell: true,
    });
    const response = result.stdout.toString();
    const cleanedPayload = response.replace(/\s+\+\s+/g, "");
    const verbose = result.stderr.toString();

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

  private convertHeaderObjectToCURL() {
    return Object.entries(this.options.headers)
      .map(([key, value]) => `-H '${key}: ${value}'`)
      .join(" ");
  }
}

export default CurlImpersonate;
