// xterm addons ship UMD bundles that read `self` at import time; the node test
// environment has none. Tests render App via renderToString without a DOM.
if (typeof (globalThis as { self?: unknown }).self === 'undefined') {
  (globalThis as { self?: unknown }).self = globalThis;
}
