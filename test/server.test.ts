import { afterEach, describe, expect, it, vi } from "vitest";
import { PollenApplication } from "../src/server.js";

const applicationKey = "fixture-application-key-with-private-length";
const user = {
    subject: "person-1",
    proof: "fixture-user-proof",
    signal: new AbortController().signal,
};
const options = {
    endpoint: "https://pollen.example/",
    sourceId: "registered-app",
    applicationKey,
    identityIssuer: "https://application.example/auth",
};
const envelope = (value: unknown) => ({
    source_id: options.sourceId,
    identity: { issuer: options.identityIssuer, subject: user.subject },
    result: { isError: false, structuredContent: value },
});
afterEach(() => vi.unstubAllGlobals());

describe("registered application client", () => {
    it("sends credentials as headers and binds the result to the current user", async () => {
        const request = vi.fn(async (_url, init) => {
            expect(new Headers(init.headers).get("authorization")).toBe("Bearer " + applicationKey);
            expect(new Headers(init.headers).get("pollen-user-authorization")).toBe("Bearer " + user.proof);
            expect(JSON.parse(init.body)).toEqual({
                tool_name: "list_inputs",
                arguments: {},
            });
            expect(init.redirect).toBe("error");
            return Response.json(envelope({ connections: [] }));
        });
        const client = new PollenApplication({
            ...options,
            fetch: request as typeof fetch,
        });
        expect(await client.callTool(user, "list_inputs", {})).toEqual({
            connections: [],
        });
    });
    it("rejects a result for a different user", async () => {
        const body = envelope({ memories: [] });
        body.identity.subject = "other-person";
        const client = new PollenApplication({
            ...options,
            fetch: vi.fn(async () => Response.json(body)),
        });
        await expect(client.callTool(user, "list_space_memories", {})).rejects.toMatchObject({
            code: "invalid_response",
        });
    });
    it("keeps connection and missing-record states distinct", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: "connection_required" }, { status: 403 }))
            .mockResolvedValueOnce(Response.json({ error: "missing" }, { status: 404 }));
        const client = new PollenApplication({ ...options, fetch: request });
        await expect(client.callTool(user, "list_inputs", {})).rejects.toMatchObject({ code: "connection_required" });
        await expect(
            client.callTool(user, "read_memory", {
                space_id: "personal",
                memory_id: "context",
            }),
        ).rejects.toMatchObject({ code: "record_not_found" });
    });
    it("rejects an echoed credential before returning the result", async () => {
        const client = new PollenApplication({
            ...options,
            fetch: vi.fn(async () => Response.json(envelope({ text: user.proof }))),
        });
        await expect(client.callTool(user, "read_memory", {})).rejects.toMatchObject({ code: "invalid_response" });
    });
});
