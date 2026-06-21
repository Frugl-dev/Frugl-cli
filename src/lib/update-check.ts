import Conf from "conf";
import semver from "semver";

const REGISTRY_URL = "https://registry.npmjs.org/frugl/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 2_000;

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
}

function cache(): Conf<{ data: UpdateCache | null }> {
  return new Conf<{ data: UpdateCache | null }>({
    projectName: "frugl-update-check",
    defaults: { data: null },
  });
}

// Returns the latest npm version if it is newer than currentVersion, otherwise null.
// Caches the registry result for 24 hours. Any network/parse error returns null silently.
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  const store = cache();
  const cached = store.get("data");

  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    const latest = cached.latestVersion;
    return semver.gt(latest, currentVersion) ? latest : null;
  }

  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = await fetch(REGISTRY_URL, { signal });
    if (!res.ok) return null;

    const json = (await res.json()) as { version?: string };
    const latest = json.version;
    if (!latest || !semver.valid(latest)) return null;

    store.set("data", { checkedAt: Date.now(), latestVersion: latest });
    return semver.gt(latest, currentVersion) ? latest : null;
  } catch {
    return null;
  }
}
