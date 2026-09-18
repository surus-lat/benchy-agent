import { describe, expect, it } from "vitest";
import {
  slugify,
  generateInviteToken,
  generateId,
  escapeSqlString,
} from "./invite-lib";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Stanford University")).toBe("stanford-university");
  });

  it("strips punctuation", () => {
    expect(slugify("St. Mary's College")).toBe("st-marys-college");
  });

  it("collapses repeated separators", () => {
    expect(slugify("MIT   (Cambridge)")).toBe("mit-cambridge");
  });
});

describe("generateInviteToken", () => {
  it("returns a 64-character hex string", () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value each call", () => {
    expect(generateInviteToken()).not.toBe(generateInviteToken());
  });
});

describe("generateId", () => {
  it("prefixes the id", () => {
    expect(generateId("org")).toMatch(/^org_[0-9a-f]{16}$/);
  });
});

describe("escapeSqlString", () => {
  it("doubles single quotes", () => {
    expect(escapeSqlString("St. Mary's College")).toBe(
      "St. Mary''s College",
    );
  });

  it("leaves strings without quotes unchanged", () => {
    expect(escapeSqlString("Stanford")).toBe("Stanford");
  });
});
