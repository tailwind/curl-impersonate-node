/*
    Pure helpers for building curl-impersonate spawn arguments and environment.

    These exist so the binary can be spawned WITHOUT a shell (array args, no
    /bin/sh): no quote-escaping of scraped content, no E2BIG from an inherited
    parent environment, no shell-injection surface.
*/
/**
 * Convert a headers object into curl arg pairs: ["-H", "key: value", ...].
 * Values are passed verbatim — no quoting needed since there is no shell.
 */
export function buildHeaderArgs(headers) {
    return Object.entries(headers).flatMap(([key, value]) => [
        "-H",
        `${key}: ${value}`,
    ]);
}
/**
 * Split flag strings on whitespace. Preset flag lists contain entries with
 * embedded spaces (e.g. "--cert-compression brotli") that previously relied on
 * shell word-splitting; this preserves those semantics for array-args spawning.
 */
export function splitFlags(flags) {
    return flags.flatMap((flag) => flag.split(/\s+/).filter(Boolean));
}
/**
 * Build the full curl argv (excluding the binary itself). Does not mutate its
 * inputs. The URL is passed via --url so a value starting with "-" can never
 * be interpreted as an option.
 */
export function buildCurlArgs(params) {
    return [
        ...splitFlags(params.flags),
        "-v",
        ...buildHeaderArgs(params.headers),
        ...(params.body !== undefined ? ["-d", params.body] : []),
        "--url",
        params.url,
    ];
}
const ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "LD_LIBRARY_PATH",
    "TMPDIR",
    "CURL_CA_BUNDLE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
];
/**
 * Build a minimal child environment from an allowlist instead of inheriting
 * everything — a growing parent env in a warm Lambda container is one way to
 * hit execve's E2BIG limit. `overrideEnv` is merged on top as an escape hatch
 * for callers that need an extra variable.
 */
export function buildSpawnEnv(processEnv, overrideEnv) {
    const env = {};
    for (const key of ENV_ALLOWLIST) {
        const value = processEnv[key];
        if (value !== undefined) {
            env[key] = value;
        }
    }
    return { ...env, ...overrideEnv };
}
//# sourceMappingURL=args.js.map