import { getLocalProfileName, isValidProfileName, listLocalProfiles, setLocalProfileName } from "#system/local-profile";
import { describe, expect, it } from "vitest";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

describe("getLocalProfileName", () => {
  it("defaults to Guest, so existing saves keep working", () => {
    expect(getLocalProfileName("", memoryStorage())).toBe("Guest");
  });

  it("uses the profile from the address and remembers it for later visits", () => {
    const storage = memoryStorage();
    expect(getLocalProfileName("?profile=Matheus", storage)).toBe("Matheus");
    expect(getLocalProfileName("", storage)).toBe("Matheus");
    expect(getLocalProfileName("?profile=Friend", storage)).toBe("Friend");
    expect(getLocalProfileName("", storage)).toBe("Friend");
  });

  it("keeps names safe to use in save keys", () => {
    expect(getLocalProfileName("?profile=a b/c%3F!", memoryStorage())).toBe("abc");
    expect(getLocalProfileName(`?profile=${"x".repeat(50)}`, memoryStorage())).toBe("x".repeat(20));
    expect(getLocalProfileName("?profile=%20%20", memoryStorage())).toBe("Guest");
  });

  it("still works when the browser refuses storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(getLocalProfileName("?profile=Matheus", broken)).toBe("Matheus");
    expect(getLocalProfileName("", broken)).toBe("Guest");
  });
});

describe("setLocalProfileName", () => {
  it("stores a cleaned-up name that getLocalProfileName then returns", () => {
    const storage = memoryStorage();
    expect(setLocalProfileName("  Ma theus!  ", storage)).toBe("Matheus");
    expect(getLocalProfileName("", storage)).toBe("Matheus");
  });

  it("refuses names with nothing usable in them and keeps the old profile", () => {
    const storage = memoryStorage();
    setLocalProfileName("Matheus", storage);
    expect(setLocalProfileName("!!!", storage)).toBeNull();
    expect(getLocalProfileName("", storage)).toBe("Matheus");
  });

  it("tells whether a name can be used exactly as typed", () => {
    expect(isValidProfileName("Matheus_2")).toBe(true);
    expect(isValidProfileName("Ma theus")).toBe(false);
    expect(isValidProfileName("   ")).toBe(false);
  });
});

describe("listLocalProfiles", () => {
  const storageWith = (keys: string[]) => ({ length: keys.length, key: (i: number) => keys[i] ?? null });

  it("lists the profile in use first, then the others that have saves, and ignores other keys", () => {
    const storage = storageWith(["data_Zed", "data_Ana", "settings", "sessionData_Ana", "data_Guest"]);
    expect(listLocalProfiles(storage, "Guest")).toEqual(["Guest", "Ana", "Zed"]);
  });

  it("includes the profile in use even when it has no saves yet", () => {
    expect(listLocalProfiles(storageWith([]), "New")).toEqual(["New"]);
  });
});
