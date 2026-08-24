import type { CurlImpersonateOptions, CurlResponse } from "./interfaces";
/**
 * CurlExitError is thrown when the curl-impersonate binary runs but exits
 * non-zero. The message carries only low-cardinality fields (exit code,
 * signal, binary path) so log pipelines can aggregate on it; the variable
 * stderr tail lives on the `stderr` property instead of the message.
 */
export declare class CurlExitError extends Error {
    readonly status: number;
    readonly signal: NodeJS.Signals | null;
    readonly binaryPath: string;
    /** Last 500 characters of curl's verbose stderr. */
    readonly stderr: string;
    constructor(status: number, signal: NodeJS.Signals | null, binaryPath: string, 
    /** Last 500 characters of curl's verbose stderr. */
    stderr: string);
}
export declare class CurlImpersonate {
    url: string;
    options: CurlImpersonateOptions;
    validMethods: Array<string>;
    binary: string;
    impersonatePresets: string[];
    binaryOverridePath: string | undefined;
    fetchBinaryWhenMissing: boolean;
    binaryCdnUrl: string;
    constructor(url: string, options: CurlImpersonateOptions);
    private tempDirectory;
    private fetchBinary;
    private checkIfPresetAndMerge;
    private getBinaryPath;
    private getBinaryPathWithDownload;
    private assertSpawnOutputs;
    private maxBuffer;
    private execCurl;
    makeRequest(url?: string): Promise<CurlResponse>;
    setNewURL(url: string): void;
    validateOptions(options: CurlImpersonateOptions): boolean;
    private setupBodyArgument;
    private setProperBinary;
    private getRequest;
    private postRequest;
    private extractRequestData;
    private extractResponseHeaders;
}
export type { CurlImpersonateOptions };
export default CurlImpersonate;
