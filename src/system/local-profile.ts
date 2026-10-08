/** The profile used when none was asked for. Existing saves live under this name. */
export const DEFAULT_LOCAL_PROFILE = "Guest";

/** Where the chosen profile is remembered in the browser. */
const PROFILE_STORAGE_KEY = "pokerogue_local_profile";

/** Profile names are letters, digits, `_` and `-`, up to 20 long (they become part of save keys). */
function cleanProfileName(name: string | null | undefined): string | null {
  const cleaned = (name ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 20) : null;
}

/** Whether a name can be used as a profile name as typed (no characters would be dropped). */
export function isValidProfileName(name: string): boolean {
  return cleanProfileName(name) === name.trim() && name.trim().length > 0;
}

/**
 * Remember a profile name as the one to play as from now on.
 * @returns The name as stored (cleaned up), or `null` if it holds nothing usable
 */
export function setLocalProfileName(name: string, storage: Pick<Storage, "setItem">): string | null {
  const cleaned = cleanProfileName(name);
  if (cleaned) {
    storage.setItem(PROFILE_STORAGE_KEY, cleaned);
  }
  return cleaned;
}

/**
 * The name of the local profile to play as when the game runs without an account.
 *
 * `?profile=Nickname` in the page address picks one and is remembered by the browser, so later visits (with or
 * without the parameter) keep using it. Each name has its own saves, Pokedex and unlocks in this browser.
 * @param search - The query string, e.g. `location.search`
 * @param storage - Where the choice is remembered (the browser's `localStorage`)
 */
export function getLocalProfileName(search: string, storage: Pick<Storage, "getItem" | "setItem">): string {
  const asked = cleanProfileName(new URLSearchParams(search).get("profile"));
  try {
    if (asked) {
      storage.setItem(PROFILE_STORAGE_KEY, asked);
      return asked;
    }
    return cleanProfileName(storage.getItem(PROFILE_STORAGE_KEY)) ?? DEFAULT_LOCAL_PROFILE;
  } catch {
    return asked ?? DEFAULT_LOCAL_PROFILE;
  }
}

/**
 * The profiles that already have saves in this browser, plus the one in use (even if it is still empty).
 * A profile's saves live under `data_<name>`.
 * @param storage - The browser's `localStorage`
 * @param current - The profile in use
 */
export function listLocalProfiles(storage: Pick<Storage, "length" | "key">, current: string): string[] {
  const names = new Set<string>([current]);
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith("data_")) {
        const name = cleanProfileName(key.slice("data_".length));
        if (name) {
          names.add(name);
        }
      }
    }
  } catch {
    // storage not readable: just the current one
  }
  return [...names].sort((a, b) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)));
}
