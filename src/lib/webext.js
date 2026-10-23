// Firefox's browser namespace and Chrome 110+ both provide promise-based APIs.
export const api = globalThis.browser ?? globalThis.chrome;

export const backgroundHelp = globalThis.browser
  ? 'Open about:debugging#/runtime/this-firefox → GLASS → Inspect.'
  : 'Open chrome://extensions → GLASS → Errors / service worker.';

// Call directly from a click handler: awaiting contains() first loses Firefox's
// user gesture. Already-granted origins resolve without another prompt.
export function requestRpcPermission(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return Promise.resolve(false);
    return api.permissions.request({ origins: [`${parsed.origin}/*`] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}
