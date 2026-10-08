/** What the page address asks for: `?coop=host` or `?coop=join`, plus `&room=CODE` and `&server=ws://...` */
export interface CoopUrlConfig {
  role: "host" | "join";
  /** Room code. Optional: the relay makes one up for hosts, and a guest without one joins whoever is hosting. */
  room: string | undefined;
  /** WebSocket address of the relay server */
  server: string;
}

/** The port the relay server listens on unless told otherwise. */
export const DEFAULT_RELAY_PORT = 8787;

/**
 * Read the co-op settings from a page address.
 * @param search - The query string, e.g. `location.search`
 * @param page - Where the page is served from, used to guess the relay address when `server` is not given
 * @returns The settings, or `null` when the address does not ask for co-op
 */
export function parseCoopUrl(search: string, page: { protocol: string; hostname: string }): CoopUrlConfig | null {
  const params = new URLSearchParams(search);
  const role = params.get("coop");
  if (role !== "host" && role !== "join") {
    return null;
  }
  const room = params.get("room")?.trim().toUpperCase() || undefined;
  // A page served over https can only talk to wss:// servers
  const scheme = page.protocol === "https:" ? "wss" : "ws";
  const server = params.get("server")?.trim() || `${scheme}://${page.hostname}:${DEFAULT_RELAY_PORT}`;
  return { role, room, server };
}

/**
 * The co-op choices to offer on the title screen.
 * An address that asks for one role offers just that; otherwise both are offered, so players need no special address.
 */
export function getCoopTitleConfigs(search: string, page: { protocol: string; hostname: string }): CoopUrlConfig[] {
  const asked = parseCoopUrl(search, page);
  if (asked) {
    return [asked];
  }
  const server = parseCoopUrl("?coop=host", page)?.server;
  const params = new URLSearchParams(search);
  const chosenServer = params.get("server")?.trim() || server;
  return (["host", "join"] as const).map(role => ({ role, room: undefined, server: chosenServer! }));
}

/**
 * Turn what a player typed as the relay's address into a WebSocket address.
 * `26.1.2.3` and `26.1.2.3:8787` both work, as does a full `ws://...` or `http://...` address.
 * @param input - What was typed (may be empty, which means "the machine the page came from")
 * @param page - Where the page is served from
 */
export function normalizeRelayAddress(input: string, page: { protocol: string; hostname: string }): string {
  const fallback = parseCoopUrl("?coop=host", page)!.server;
  let text = input.trim();
  if (!text) {
    return fallback;
  }
  const secure = page.protocol === "https:";
  const scheme = /^(wss?|https?):\/\//i.exec(text)?.[1]?.toLowerCase();
  text = text.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  if (!text) {
    return fallback;
  }
  if (!/:\d+$/.test(text)) {
    text += `:${DEFAULT_RELAY_PORT}`;
  }
  const wsScheme =
    scheme === "wss" || scheme === "https"
      ? "wss"
      : scheme === "ws" || scheme === "http"
        ? "ws"
        : secure
          ? "wss"
          : "ws";
  return `${wsScheme}://${text}`;
}

/** The part of a relay address a player recognises: `26.1.2.3:8787` instead of `ws://26.1.2.3:8787`. */
export function describeRelayAddress(server: string): string {
  return server.replace(/^wss?:\/\//, "");
}
