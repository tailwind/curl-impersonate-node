import type { CurlImpersonateOptions, CurlResponse } from "./interfaces";
export declare class CurlImpersonate {
    url: string;
    options: CurlImpersonateOptions;
    validMethods: Array<string>;
    binary: string;
    impersonatePresets: string[];
    binaryOverridePath: string | undefined;
    constructor(url: string, options: CurlImpersonateOptions);
    private checkIfPresetAndMerge;
    private getBinaryPath;
    makeRequest(url?: string): Promise<CurlResponse>;
    setNewURL(url: string): void;
    validateOptions(options: CurlImpersonateOptions): boolean;
    private setupBodyArgument;
    private setProperBinary;
    private getRequest;
    private postRequest;
    private extractRequestData;
    private extractResponseHeaders;
    private convertHeaderObjectToCURL;
}
export default CurlImpersonate;
