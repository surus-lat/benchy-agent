import { describe, expect, it } from "vitest";
import {
  slugify,
  generateInviteToken,
  generateId,
  escapeSqlString,
  buildUserExistsSql,
  assertNoExistingUser,
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

describe("buildUserExistsSql", () => {
  it("looks the address up on the quoted user table", () => {
    expect(buildUserExistsSql("researcher@stanford.edu")).toBe(
      `SELECT id FROM "user" WHERE email = 'researcher@stanford.edu'`,
    );
  });

  it("lowercases the address, matching how the gate stores it", () => {
    expect(buildUserExistsSql("Researcher@Stanford.EDU")).toContain(
      "'researcher@stanford.edu'",
    );
  });

  it("escapes quotes rather than letting them close the literal", () => {
    expect(buildUserExistsSql("o'hara@stanford.edu")).toBe(
      `SELECT id FROM "user" WHERE email = 'o''hara@stanford.edu'`,
    );
  });
});

describe("assertNoExistingUser", () => {
  it("allows the invite when no account matched", () => {
    expect(() => assertNoExistingUser("new@stanford.edu", [])).not.toThrow();
  });

  it("refuses, naming the email, when an account already exists", () => {
    expect(() =>
      assertNoExistingUser("member@stanford.edu", [{ id: "user_1" }]),
    ).toThrow(/member@stanford\.edu already has a Benchy account/);
  });

  it("says no invite was created, so the admin knows nothing was written", () => {
    expect(() =>
      assertNoExistingUser("member@stanford.edu", [{ id: "user_1" }]),
    ).toThrow(/no invite was created/i);
  });
});
