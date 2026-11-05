import type { DefaultResourceLoader, Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

let observation: { loader: typeof DefaultResourceLoader; original: DefaultResourceLoader["getExtensions"]; wrapped: DefaultResourceLoader["getExtensions"]; result?: LoadExtensionsResult } | undefined;

/** Observe native loading without importing factories again or changing its result. */
export function observeLoadedExtensions(loader: typeof DefaultResourceLoader): (matches: (extension: Extension) => boolean) => string[] | undefined {
  if (!observation) {
    const original = loader.prototype.getExtensions;
    const state = { loader, original, wrapped: original, result: undefined as LoadExtensionsResult | undefined };
    state.wrapped = function (this: DefaultResourceLoader) {
      const result = original.call(this);
      state.result = result;
      return result;
    };
    observation = state;
    loader.prototype.getExtensions = state.wrapped;
  }
  return matches => {
    const state = observation;
    if (state && state.loader.prototype.getExtensions === state.wrapped) state.loader.prototype.getExtensions = state.original;
    observation = undefined;
    if (!state?.result?.extensions.some(matches) || state.result.errors.length) return undefined;
    return state.result.extensions.filter(extension => !matches(extension)).map(extension => extension.path);
  };
}
