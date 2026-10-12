import { expect, it } from "vitest";
import { enabledProviders, microsoftVerifiedEmail, socialProviders } from "../src/social-providers";

it("trusts Microsoft's email claim only when its domain is verified", () => {
  expect(microsoftVerifiedEmail({ email: "Ana@Uni.edu", xms_edov: true, preferred_username: "x@y.z" })).toBe("ana@uni.edu");
  // Unverified email claim (the nOAuth vector) falls back to the UPN.
  expect(microsoftVerifiedEmail({ email: "victim@uni.edu", preferred_username: "attacker@evil.onmicrosoft.com" })).toBe(
    "attacker@evil.onmicrosoft.com",
  );
  expect(microsoftVerifiedEmail({ email: "victim@uni.edu" })).toBeNull();
  expect(microsoftVerifiedEmail({ preferred_username: "not-an-email" })).toBeNull();
});

it("enables a provider only with real credentials", () => {
  expect(enabledProviders({})).toEqual({ google: false, microsoft: false });
  expect(enabledProviders({ GOOGLE_CLIENT_ID: "placeholder", GOOGLE_CLIENT_SECRET: "placeholder" })).toEqual({
    google: false,
    microsoft: false,
  });
  expect(
    enabledProviders({ GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", MICROSOFT_CLIENT_ID: "m", MICROSOFT_CLIENT_SECRET: "t" }),
  ).toEqual({ google: true, microsoft: true });
});

it("maps a Microsoft profile to a verified email or none", () => {
  const ms = socialProviders({ MICROSOFT_CLIENT_ID: "m", MICROSOFT_CLIENT_SECRET: "t" }).microsoft as {
    tenantId: string;
    mapProfileToUser: (p: Record<string, unknown>) => Record<string, unknown>;
  };
  expect(ms.tenantId).toBe("common");
  expect(ms.mapProfileToUser({ preferred_username: "Ana@Uni.edu" })).toEqual({ email: "ana@uni.edu", emailVerified: true });
  // An unverified claim is replaced, so it can never redeem an invite or link.
  expect(ms.mapProfileToUser({ email: "victim@uni.edu", oid: "abc" })).toEqual({
    email: "unverified-abc@invalid.invalid",
    emailVerified: false,
  });
});
