// Runtime configuration derived from Vite build-time environment variables.
//
// VITE_REMOTEDECK_MODE:
//   'direct'                – explicit dev mode; requires API base URL + token
//                             inputs.  Only activated when the variable is set
//                             to exactly 'direct'.
//   'same-origin'           – (default) deployed behind a same-origin reverse
//                             proxy (e.g. Workbench); no token input; auth
//                             handled by proxy cookies.
//
//   Missing or invalid values resolve to 'same-origin' so that a production
//   build never accidentally exposes credential input fields.
//
// VITE_REMOTEDECK_BASE:
//   The base path the app is served under, e.g. '/remotedeck'.
//   In 'same-origin' mode this is also used as the API baseUrl.
//   Default: '' (served from root).

import type { ClientMode } from '@remotedeck/client-sdk';

export interface AppConfig {
  mode: ClientMode;
  /** API baseUrl for RemoteDeckClient. */
  baseUrl: string;
}

/**
 * Resolve runtime config from Vite environment variables.
 *
 * @param env - Override for `import.meta.env` (used in tests). Defaults to
 *              the live Vite environment at build time.
 *
 * Fail-safe: when `VITE_REMOTEDECK_MODE` is missing or set to an unrecognised
 * value the result is `same-origin`, the safe production default.  `direct`
 * mode is activated *only* by the explicit value `'direct'`.
 */
export function resolveConfig(
  env: Record<string, string | undefined> = import.meta.env,
): AppConfig {
  const raw = env.VITE_REMOTEDECK_MODE;

  if (raw === 'direct') {
    return { mode: 'direct', baseUrl: '' };
  }

  // 'same-origin' or fallback (missing / invalid): derive API path prefix.
  const base = env.VITE_REMOTEDECK_BASE ?? env.BASE_URL ?? '/';
  const baseUrl = base.replace(/\/+$/, '');
  return { mode: 'same-origin', baseUrl };
}
