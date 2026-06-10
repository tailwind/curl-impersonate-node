/**
 * Convert a headers object into curl arg pairs: ["-H", "key: value", ...].
 * Values are passed verbatim — no quoting needed since there is no shell.
 */
export declare function buildHeaderArgs(headers: Record<string, string>): string[];
/**
 * Split flag strings on whitespace. Preset flag lists contain entries with
 * embedded spaces (e.g. "--cert-compression brotli") that previously relied on
 * shell word-splitting; this preserves those semantics for array-args spawning.
 */
export declare function splitFlags(flags: string[]): string[];
/**
 * Build the full curl argv (excluding the binary itself). Does not mutate its
 * inputs. The URL is passed via --url so a value starting with "-" can never
 * be interpreted as an option.
 */
export declare function buildCurlArgs(params: {
    flags: string[];
    headers: Record<string, string>;
    url: string;
    body?: string;
}): string[];
/**
 * Build a minimal child environment from an allowlist instead of inheriting
 * everything — a growing parent env in a warm Lambda container is one way to
 * hit execve's E2BIG limit. `overrideEnv` is merged on top as an escape hatch
 * for callers that need an extra variable.
 */
export declare function buildSpawnEnv(processEnv: NodeJS.ProcessEnv, overrideEnv?: Record<string, string>): Record<string, string>;
