/** The profile used when none was asked for. Existing saves live under this name. */
export const DEFAULT_LOCAL_PROFILE = "Guest";

/** Where the chosen profile is remembered in the browser. */
const PROFILE_STORAGE_KEY = "pokerogue_local_profile";

/** Profile names are letters, digits, `_` and `-`, up to 20 long (they become part of save keys). */
function cleanProfileName(name: string | null | undefined): string | null {
  const cleaned = (name ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 20) : null;
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
