import { getLocalProfileName } from "#system/local-profile";
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
