/// <reference types="vite/client" />
import type { TerrainLayoutMeta, TerrainLibrary } from "./types";

/**
 * Fetching and inflating the terrain assets.
 *
 * Everything ships gzipped, including the JSON sidecars, so it all flows through
 * one path. The shared half is 6.4 MB -- the mesh library plus the detail
 * textures -- and identical for every layout; a layout adds about 0.78 MB. That
 * split is the whole point: a Coriolis reset changes the layout, and the browser
 * re-fetches under a megabyte.
 */

export type SharedAssets = {
  library: TerrainLibrary;
  /** positions | oct normals | indices, concatenated. */
  geometry: Uint8Array;
  detail1: Uint8Array;
  detail2: Uint8Array;
  breakup: Uint8Array;
};

export type LayoutAssets = {
  meta: TerrainLayoutMeta;
  /** 14 float32 per instance: mat3, translation, iMat, lift. */
  instances: Uint8Array;
  /** hfN x hfN u16. */
  heightField: Uint8Array;
};

/**
 * Vite fingerprints these into `dist/assets/<name>-<hash>.gz`, which earns the
 * long-lived immutable cache-control rule in the API's static handler and, being
 * genuinely content-addressed, can never go stale. It also means the URLs are
 * not predictable, so they have to be resolved from the bundle rather than
 * built from a base path.
 *
 * A layout-only rebuild leaves `meshes.bin-<hash>.gz` at the same URL, so a
 * Coriolis reset re-downloads under a megabyte rather than the whole 6 MB.
 */
const assetUrls = import.meta.glob("./assets/**/*.gz", {
  query: "?url",
  import: "default",
  eager: true
}) as Record<string, string>;

export type AssetResolver = (name: string) => string;

export const bundledAsset: AssetResolver = (name) => {
  const url = assetUrls[`./assets/${name}`];
  if (!url) throw new Error(`terrain asset is not bundled: ${name}`);
  return url;
};
/**
 * The parsed shared library is held for the life of the page and both recently
 * used layouts are kept, so switching maps away and back, or a reset moving the
 * layout, does not re-download or re-inflate. Deliberately not all twelve: the
 * decompressed height fields alone would be hundreds of megabytes.
 */
const LAYOUT_CACHE_LIMIT = 2;
let sharedPromise: Promise<SharedAssets> | null = null;
const layoutCache = new Map<string, Promise<LayoutAssets>>();

/**
 * Hand a shared, cached load to one caller, honouring only that caller's abort.
 *
 * The work itself deliberately runs without an AbortSignal. It is cached and
 * shared, so letting the first caller's signal reach the fetch leaves every
 * later caller inheriting an abort it never asked for. Under StrictMode, where
 * React mounts each effect, tears it down and mounts it again, that is not an
 * edge case but the only path: the remount would always find the first mount's
 * aborted promise and report the terrain unavailable.
 *
 * Abandoning a load is also no reason to throw the bytes away -- whoever comes
 * next wants the same 6 MB -- so the fetch is left to finish and fill the cache.
 */
function forCaller<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  const aborted = () => signal.reason ?? new DOMException("The terrain load was aborted.", "AbortError");
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (finish: () => void) => {
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    work.then((value) => settle(() => resolve(value)), (error) => settle(() => reject(error)));
  });
}

/**
 * Fetch and inflate.
 *
 * A `.gz` name is a strong hint to a static server that the file is
 * content-encoded rather than merely compressed, and Vite's dev and preview
 * servers act on it: they answer with `Content-Encoding: gzip`, so the browser
 * inflates the body before it reaches us and piping it through
 * DecompressionStream throws. The API's own static handler sets no such header,
 * which is why this only ever broke outside production. So trust the response,
 * not the file name: the header is present exactly when the browser has already
 * done the work.
 */
const CONTENT_ENCODED = /\b(?:gzip|x-gzip|deflate|br|zstd)\b/i;

async function gunzip(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  if (!response.body) throw new Error(`${url}: no response body`);
  const encoding = response.headers.get("content-encoding");
  const stream = encoding !== null && CONTENT_ENCODED.test(encoding)
    ? response.body
    : response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipJson<T>(url: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await gunzip(url))) as T;
}

export async function loadSharedAssets(resolve: AssetResolver = bundledAsset, signal?: AbortSignal): Promise<SharedAssets> {
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const [library, geometry, detail1, detail2, breakup] = await Promise.all([
        gunzipJson<TerrainLibrary>(resolve("meshes.json.gz")),
        gunzip(resolve("meshes.bin.gz")),
        gunzip(resolve("tex/det1.bin.gz")),
        gunzip(resolve("tex/det2.bin.gz")),
        gunzip(resolve("tex/brk.bin.gz"))
      ]);
      const expected = library.posBytes + library.nrmBytes + library.idxBytes;
      if (geometry.byteLength !== expected) {
        throw new Error(`mesh library is ${geometry.byteLength} bytes, its table describes ${expected}`);
      }
      return { library, geometry, detail1, detail2, breakup };
    })();
    // A failed load must not poison the page: drop the rejected promise so a
    // later attempt (a retry, or simply switching back to the map) can try again.
    sharedPromise.catch(() => {
      sharedPromise = null;
    });
  }
  return forCaller(sharedPromise, signal);
}

export async function loadLayoutAssets(layout: number, resolve: AssetResolver = bundledAsset, signal?: AbortSignal): Promise<LayoutAssets> {
  const key = `${resolve(`layout-${layout}.bin.gz`)}`;
  const cached = layoutCache.get(key);
  if (cached) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves it last.
    layoutCache.delete(key);
    layoutCache.set(key, cached);
    return forCaller(cached, signal);
  }

  const pending = (async () => {
    const [meta, instances, heightField] = await Promise.all([
      gunzipJson<TerrainLayoutMeta>(resolve(`layout-${layout}.json.gz`)),
      gunzip(resolve(`layout-${layout}.bin.gz`)),
      gunzip(resolve(`layout-${layout}.hf.gz`))
    ]);
    if (heightField.byteLength !== meta.hfN * meta.hfN * 2) {
      throw new Error(`layout ${layout} height field is ${heightField.byteLength} bytes, expected ${meta.hfN}x${meta.hfN} u16`);
    }
    return { meta, instances, heightField };
  })();

  layoutCache.set(key, pending);
  pending.catch(() => layoutCache.delete(key));
  while (layoutCache.size > LAYOUT_CACHE_LIMIT) {
    const oldest = layoutCache.keys().next().value;
    if (oldest === undefined) break;
    layoutCache.delete(oldest);
  }
  return forCaller(pending, signal);
}

/** Test seam: drop everything held between cases. */
export function clearTerrainAssetCache(): void {
  sharedPromise = null;
  layoutCache.clear();
}
