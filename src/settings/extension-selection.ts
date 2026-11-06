import { isRecord } from "../team/connection.ts";
import type { ExtensionSelection } from "./worker-extensions.ts";

/** Validates saved selection metadata without loading Pi's extension runtime. */
export function validExtensionSelection(value: unknown): value is ExtensionSelection {
  const ids = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 512 && list.every(id => typeof id === "string" && id.length > 0 && id.length <= 4096) && new Set(list).size === list.length;
  if (!isRecord(value) || !ids(value.ids) || !ids(value.required) || !ids(value.excluded)) return false;
  const selected = value.ids;
  return typeof value.preset === "string" && value.required.every(id => selected.includes(id))
    && typeof value.inventory === "string" && /^[a-f0-9]{64}$/.test(value.inventory) && isRecord(value.fingerprints) && Object.entries(value.fingerprints).every(([id, hash]) => selected.includes(id) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === "string") && (value.heapMb === undefined || Number.isSafeInteger(value.heapMb) && Number(value.heapMb) >= 128 && Number(value.heapMb) <= 6144);
}
