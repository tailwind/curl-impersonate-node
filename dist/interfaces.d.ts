type validBrowsers = ["chrome-110", "chrome-116", "firefox-109", "firefox-117"];
interface CurlImpersonateOptions {
    method: string;
    headers: Record<string, string>;
    flags?: Array<string>;
    body?: Record<string, string>;
    timeout?: number | 10000;
    followRedirects?: boolean | true;
    verbose?: boolean | false;
    impersonate?: validBrowsers[number];
    binaryOverridePath?: string;
    fetchBinaryWhenMissing?: boolean;
    binaryCdnUrl?: string;
    /** Max bytes allowed on the child's stdout/stderr. Default 10 MiB. */
    maxBuffer?: number;
    /** Extra environment variables for the curl-impersonate child process, merged over the built-in allowlist. */
    env?: Record<string, string>;
}
interface CurlResponse {
    ipAddress: string | undefined;
    port: number | undefined;
    statusCode: number | undefined;
    response: string;
    responseHeaders: Record<string, string>;
    requestHeaders: Record<string, string>;
    verboseStatus: boolean | undefined;
}
export type { CurlImpersonateOptions, CurlResponse };
