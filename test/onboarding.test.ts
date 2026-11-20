import { afterEach, describe, expect, it, vi } from "vitest";
import { PollenApplication, onboardingTemplates } from "../src/server.js";

const user = { subject: "person-1", proof: "fixture-user-proof", signal: new AbortController().signal };
const policy = (template: (typeof onboardingTemplates)[number]) => ({
    id: "policy-1",
    revision: 2,
    template,
    name: "Account setup",
    organization: { id: "organization-1", name: "Example" },
});
const receipt = (template: (typeof onboardingTemplates)[number] = "isolated_customers") => ({
    contract: "pollen-onboarding/v1",
    url: "https://pollen.example/onboarding?ticket=fixture-ticket",
    expires_at: new Date(Date.now() + 300000).toISOString(),
    policy: policy(template),
});
function fixture(response: unknown | ((input: any) => unknown)) {
    const request = vi.fn(async (_url: unknown, init: RequestInit) => {
        expect(init.redirect).toBe("error");
        expect(init.cache).toBe("no-store");
        expect(new Headers(init.headers).get("pollen-user-authorization")).toBe("Bearer fixture-user-proof");
        const input = JSON.parse(String(init.body));
        return Response.json({
            source_id: "application-1",
            identity: { issuer: "https://app.example/auth", subject: user.subject },
            result: { isError: false, structuredContent: typeof response === "function" ? response(input) : response },
        });
    }) as typeof fetch;
    const app = new PollenApplication({
        endpoint: "https://pollen.example/",
        sourceId: "application-1",
        applicationKey: "fixture-application-key-long-enough",
        identityIssuer: "https://app.example/auth",
        fetch: request,
    });
    return { app, request };
}

afterEach(() => vi.restoreAllMocks());

describe("server-owned onboarding policies", () => {
    it.each(onboardingTemplates)("reads the %s policy without selecting user permissions", async (template) => {
        const test = fixture({ contract: "pollen-onboarding/v1", state: "setup_required", policy: policy(template) });
        expect((await test.app.onboarding.status(user)).policy?.template).toBe(template);
        expect(String(test.request.mock.calls[0][0])).toBe(
            "https://pollen.example/app-sources/application-1/onboarding/status",
        );
        expect(JSON.parse(String(test.request.mock.calls[0][1]?.body))).toEqual({});
    });
    it("revokes only the current verified application account", async () => {
        const test = fixture({ contract: "pollen-onboarding/v1", revoked: true });
        expect(await test.app.onboarding.revoke(user)).toMatchObject({ revoked: true });
        expect(String(test.request.mock.calls[0][0])).toBe(
            "https://pollen.example/app-sources/application-1/onboarding/revoke",
        );
        expect(JSON.parse(String(test.request.mock.calls[0][1]?.body))).toEqual({});
    });
    it("retains PKCE state on the server and sends no verifier in the start request", async () => {
        const test = fixture((input) => {
            expect(input.code_challenge_method).toBe("S256");
            expect(input.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(input.state).toHaveLength(64);
            expect(input.code_verifier).toBeUndefined();
            expect(input.role).toBeUndefined();
            expect(input.organization_id).toBeUndefined();
            expect(input.customer_ref).toBe("customer-1");
            return receipt();
        });
        const result = await test.app.onboarding.start(user, {
            returnTo: "https://app.example/pollen/return",
            customerRef: "customer-1",
        });
        expect(result.transaction.subject).toBe(user.subject);
        expect(result.transaction.verifier).toHaveLength(64);
        expect(result.url).not.toContain(result.transaction.verifier);
        expect(result.url).not.toContain(user.proof);
    });
    it("completes only the same user's saved transaction", async () => {
        const test = fixture(receipt());
        const started = await test.app.onboarding.start(user, { returnTo: "https://app.example/pollen/return" });
        await test.app.onboarding.complete(user, started.transaction, {
            code: "fixture-code",
            state: started.transaction.state,
        });
        const input = JSON.parse(String(test.request.mock.calls[1][1]?.body));
        expect(input.code_verifier).toBe(started.transaction.verifier);
        expect(input.return_to).toBe(started.transaction.returnTo);
        expect(String(test.request.mock.calls[1][0])).toBe(
            "https://pollen.example/app-sources/application-1/onboarding/complete",
        );
        await expect(
            test.app.onboarding.complete({ ...user, subject: "other-person" }, started.transaction, {
                code: "fixture-code",
                state: started.transaction.state,
            }),
        ).rejects.toThrow("another session");
        await expect(
            test.app.onboarding.complete(user, started.transaction, { code: "fixture-code", state: "other-state" }),
        ).rejects.toThrow("another session");
        expect(test.request).toHaveBeenCalledTimes(2);
    });
    it("completes a code confirmed just before the start link expires", async () => {
        const startedAt = Date.parse("2026-11-19T12:00:00Z");
        let now = startedAt;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const linkExpiresAt = startedAt + 600000;
        const confirmedAt = startedAt + 599000;
        const codeExpiresAt = confirmedAt + 120000;
        const test = fixture((input) => {
            if (input.code) {
                expect(codeExpiresAt - now).toBe(118000);
                return { ...receipt(), url: "https://pollen.example/auth/onboarding/finish?ticket=fixture" };
            }
            return { ...receipt(), expires_at: new Date(linkExpiresAt).toISOString() };
        });
        const started = await test.app.onboarding.start(user, { returnTo: "https://app.example/return" });
        now = startedAt + 601000;
        await test.app.onboarding.complete(user, started.transaction, {
            code: "confirmed-code",
            state: started.transaction.state,
        });
        expect(test.request).toHaveBeenCalledTimes(2);
        expect(started.transaction.expiresAt).toBe(new Date(linkExpiresAt + 120000).toISOString());
    });
    it("rejects completion at the latest possible code expiry", async () => {
        let now = Date.parse("2026-11-19T12:00:00Z");
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const linkExpiresAt = now + 600000;
        const test = fixture({ ...receipt(), expires_at: new Date(linkExpiresAt).toISOString() });
        const started = await test.app.onboarding.start(user, { returnTo: "https://app.example/return" });
        now = linkExpiresAt + 120000;
        await expect(
            test.app.onboarding.complete(user, started.transaction, {
                code: "expired-code",
                state: started.transaction.state,
            }),
        ).rejects.toThrow("expired");
        expect(test.request).toHaveBeenCalledTimes(1);
    });
    it("leaves the actual callback code expiry check to Pollen", async () => {
        let now = Date.parse("2026-11-19T12:00:00Z");
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const test = fixture({ ...receipt(), expires_at: new Date(now + 600000).toISOString() });
        const started = await test.app.onboarding.start(user, { returnTo: "https://app.example/return" });
        now += 601000;
        vi.mocked(test.request).mockResolvedValueOnce(Response.json({ error: "onboarding_expired" }, { status: 410 }));
        await expect(
            test.app.onboarding.complete(user, started.transaction, {
                code: "expired-code",
                state: started.transaction.state,
            }),
        ).rejects.toMatchObject({ code: "onboarding_expired" });
        expect(test.request).toHaveBeenCalledTimes(2);
    });
    it.each(["customer/acme", "customer acme", "équipe/acmé", " customer/acme ", "c".repeat(128), "🦊".repeat(64)])(
        "preserves the owner-saved customer reference %s",
        async (customerRef) => {
            const test = fixture(receipt("customer_organizations"));
            await test.app.onboarding.start(user, { returnTo: "https://app.example/return", customerRef });
            expect(JSON.parse(String(test.request.mock.calls[0][1]?.body)).customer_ref).toBe(customerRef);
        },
    );
    it.each(["", "   ", "c".repeat(129), "customer\nacme", "customer\u0000acme", "customer\u007facme"])(
        "rejects an invalid customer reference before a request: %j",
        async (customerRef) => {
            const test = fixture(receipt("customer_organizations"));
            await expect(
                test.app.onboarding.start(user, { returnTo: "https://app.example/return", customerRef }),
            ).rejects.toThrow("customer reference");
            expect(test.request).not.toHaveBeenCalled();
        },
    );
    it.each(["https://other.example/onboarding", "https://user:password@pollen.example/onboarding"])(
        "rejects the returned destination %s",
        async (url) => {
            const test = fixture({ ...receipt(), url });
            await expect(test.app.onboarding.start(user, { returnTo: "https://app.example/return" })).rejects.toThrow(
                "invalid onboarding destination",
            );
        },
    );
    it("rejects expired links and unknown templates", async () => {
        const expired = fixture({ ...receipt(), expires_at: new Date(Date.now() - 1000).toISOString() });
        await expect(expired.app.onboarding.start(user, { returnTo: "https://app.example/return" })).rejects.toThrow(
            "expiry",
        );
        const unknown = fixture({
            contract: "pollen-onboarding/v1",
            state: "setup_required",
            policy: { ...policy("workplace"), template: "unreviewed" },
        });
        await expect(unknown.app.onboarding.status(user)).rejects.toThrow("invalid onboarding status");
    });
    it.each([
        "http://app.example/return",
        "https://app.example/return?code=value",
        "https://app.example/return#fragment",
    ])("rejects unsafe return address %s before a request", async (returnTo) => {
        const test = fixture(receipt());
        await expect(test.app.onboarding.start(user, { returnTo })).rejects.toThrow("registered HTTPS return");
        expect(test.request).not.toHaveBeenCalled();
    });
});
