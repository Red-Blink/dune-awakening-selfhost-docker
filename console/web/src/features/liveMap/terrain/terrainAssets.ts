/// <reference types="vite/client" />
import { sealRockLibrary } from "./terrainSeal";
import { sandRingCount, withCommonRock, withSandRing } from "./terrainGeometry";
import type { TerrainCommonRock, TerrainLayoutMeta, TerrainLibrary, TerrainOutside, TerrainSandRing } from "./types";

/**
 * Fetching and inflating the terrain assets.
 *
 * Everything ships gzipped, including the JSON sidecars, so it all flows through
 * one path. The shared half is 8.2 MB and identical for every layout; a layout
 * adds about 0.65 MB, so a Coriolis reset re-fetches well under a megabyte.
 */

export type SharedAssets = {
  library: TerrainLibrary;
  /** positions | oct normals | indices, concatenated. */
  geometry: Uint8Array;
  detail1: Uint8Array;
  detail2: Uint8Array;
  breakup: Uint8Array;
  /** Normalized u16 UVs for the textured rock meshes (see `TerrainMesh.uvo`). */
  rockUV: Uint8Array;
  /** The game's baked rock diffuse: `texLayers` BC1 layers, back to back. */
  rockTex: Uint8Array;
  /** Rock outside the mapped square, and its instances (14 float32 each). */
  outside: TerrainOutside;
  outsideInstances: Uint8Array;
  /** Sand past a layout's height field: u16 heights, high bytes then low bytes. */
  sandRing: TerrainSandRing;
  sandRingField: Uint8Array;
  /** Placements every layout shares (14 float32 each). */
  commonRock: TerrainCommonRock;
  commonRockInstances: Uint8Array;
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
 * Coriolis reset re-downloads under a megabyte rather than the whole 8.2 MB.
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
 * next wants the same 8.2 MB -- so the fetch is left to finish and fill the cache.
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
      const [library, geometry, detail1, detail2, breakup, rockUV, rockTex, outside, outsideInstances, sandRing, sandRingField, commonRock, commonRockInstances] = await Promise.all([
        gunzipJson<TerrainLibrary>(resolve("meshes.json.gz")),
        gunzip(resolve("meshes.bin.gz")),
        gunzip(resolve("tex/det1.bin.gz")),
        gunzip(resolve("tex/det2.bin.gz")),
        gunzip(resolve("tex/brk.bin.gz")),
        gunzip(resolve("rock-uv.bin.gz")),
        gunzip(resolve("tex/rock.bin.gz")),
        gunzipJson<TerrainOutside>(resolve("outside.json.gz")),
        gunzip(resolve("outside.bin.gz")),
        gunzipJson<TerrainSandRing>(resolve("sand-ring.json.gz")),
        gunzip(resolve("sand-ring.bin.gz")),
        gunzipJson<TerrainCommonRock>(resolve("rock-common.json.gz")),
        gunzip(resolve("rock-common.bin.gz"))
      ]);
      const expected = library.posBytes + library.nrmBytes + library.idxBytes;
      if (geometry.byteLength !== expected) {
        throw new Error(`mesh library is ${geometry.byteLength} bytes, its table describes ${expected}`);
      }
      if (rockUV.byteLength !== (library.uvBytes ?? 0)) {
        throw new Error(`rock UVs are ${rockUV.byteLength} bytes, the library describes ${library.uvBytes ?? 0}`);
      }
      const size = library.texSize ?? 0;
      const layerBytes = (size / 4) * (size / 4) * 8;
      if (rockTex.byteLength !== (library.texLayers ?? 0) * layerBytes) {
        throw new Error(`rock texture is ${rockTex.byteLength} bytes, expected ${library.texLayers ?? 0} BC1 layers of ${size}^2`);
      }
      if (outsideInstances.byteLength !== outside.nInst * 56) {
        throw new Error(`outside rock is ${outsideInstances.byteLength} bytes, its table describes ${outside.nInst} instances`);
      }
      if (sandRingField.byteLength !== sandRingCount(sandRing) * 2) {
        throw new Error(`sand ring is ${sandRingField.byteLength} bytes, its table describes ${sandRingCount(sandRing)} heights`);
      }
      if (commonRockInstances.byteLength !== commonRock.nInst * 56) {
        throw new Error(`shared placements are ${commonRockInstances.byteLength} bytes, their table describes ${commonRock.nInst}`);
      }
      const plain = decodeIndices(library, geometry);
      // Close the slits in the rock meshes once, off the frame path: see terrainSeal.ts.
      const sealed = sealRockLibrary(plain, geometry, rockUV);
      return {
        library: sealed.library, geometry: sealed.geometry, detail1, detail2, breakup, rockUV: sealed.rockUV, rockTex,
        outside, outsideInstances, sandRing, sandRingField, commonRock, commonRockInstances
      };
    })();
    // A failed load must not poison the page: drop the rejected promise so a
    // later attempt (a retry, or simply switching back to the map) can try again.
    sharedPromise.catch(() => {
      sharedPromise = null;
    });
  }
  return forCaller(sharedPromise, signal);
}

/**
 * Undo the library's index coding, in place. With `idxCoding` "zigzag-delta"
 * each mesh's indices are stored as the step from the one before (from 0),
 * wrapped to 16 bits and zigzagged so small steps either way stay small: the
 * library gzips 10% smaller. Returns the library without the coding mark.
 */
export function decodeIndices(library: TerrainLibrary, geometry: Uint8Array): TerrainLibrary {
  if (!library.idxCoding) return library;
  if (library.idxCoding !== "zigzag-delta") throw new Error(`mesh indices are stored as ${library.idxCoding}, which this console cannot read`);
  const idx = new Uint16Array(geometry.buffer, geometry.byteOffset + library.posBytes + library.nrmBytes, library.idxBytes / 2);
  for (const mesh of library.meshes) {
    let v = 0;
    for (let i = mesh.io; i < mesh.io + mesh.ic; i++) {
      const z = idx[i];
      v = (v + ((z >>> 1) ^ -(z & 1))) & 0xffff;
      idx[i] = v;
    }
  }
  const { idxCoding: _coding, ...plain } = library;
  return plain;
}

const joined = new WeakMap<LayoutAssets, LayoutAssets>();

/**
 * A layout with the shared parts joined in: the placements every layout has,
 * and the ring of outside sand round its height field. Built once per layout:
 * the renderer tells layouts apart by identity.
 */
export function joinShared(shared: SharedAssets, layout: LayoutAssets): LayoutAssets {
  let out = joined.get(layout);
  if (!out) {
    const hf = layout.heightField;
    const rock = withCommonRock(layout.meta, layout.instances, shared.commonRock, shared.commonRockInstances);
    const { field, meta } = withSandRing(new Uint16Array(hf.buffer, hf.byteOffset, hf.byteLength / 2), rock.meta, shared.sandRing, shared.sandRingField);
    out = { meta, instances: rock.instances, heightField: new Uint8Array(field.buffer) };
    joined.set(layout, out);
  }
  return out;
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
