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
