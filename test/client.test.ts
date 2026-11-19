import { describe, expect, it, vi } from "vitest";
import { PollenClient, type InputPage } from "../src/index.js";

const endpoint = "https://pollen.example/mcp";
const token = "fixture-private-access";
const registration = {
    contract: "pollen-inputs/v1",
    connection_id: "source",
    stream_id: "changes",
    transport: "push",
    space_id: "organization",
    mode: "published",
    epoch: null,
    checkpoint: null,
};
const page = (kind = "shipment"): InputPage => ({
    contract: "pollen-inputs/v1",
    stream_id: "changes",
    epoch: "epoch",
    checkpoint: "next",
    has_more: false,
    complete_through: "2026-11-19T10:00:00Z",
    coverage: "observed",
    changes: [
        {
            record_id: "item-1",
            revision: 1,
            operation: "upsert",
            record_kind: kind,
            occurred_at: "2026-11-19T10:00:00Z",
            reported_at: "2026-11-19T10:00:00Z",
            valid_until: null,
            title: "Source update",
            text: "The source state changed.",
            subjects: [{ namespace: kind, id: "item-1" }],
            data: { state: "confirmed" },
            source_url: "https://source.example/items/1",
        },
    ],
});
const receipt = (value: InputPage) => ({
    contract: "pollen-inputs/v1",
    connection_id: "source",
    epoch: value.epoch,
    checkpoint: value.checkpoint,
    complete_through: value.complete_through,
    accepted: value.changes.length,
    receipt: "a".repeat(64),
    replayed: false,
    stage: "accepted",
});

function fixture(tool: (rpc: any) => unknown | Promise<unknown>, sse = false) {
    const messages: any[] = [];
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + token);
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const rpc = JSON.parse(String(init.body));
        messages.push(rpc);
        if (rpc.method === "initialize")
            return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {} },
                    serverInfo: { name: "pollen", version: "fixture" },
                },
            });
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (rpc.method !== "tools/call") throw new Error("Unexpected fixture method: " + rpc.method);
        expect(new Headers(init.headers).get("mcp-protocol-version")).toBe("2025-11-25");
        const result = {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { content: [], structuredContent: await tool(rpc) },
        };
        return sse
            ? new Response("event: message\ndata: " + JSON.stringify(result) + "\n\n", {
                  headers: { "content-type": "text/event-stream" },
              })
            : Response.json(result);
    }) as typeof fetch;
    return {
        client: new PollenClient({
            endpoint,
            authProvider: { token: async () => token },
            fetch: request,
            timeoutMs: 250,
        }),
        request,
        messages,
    };
}

describe("Pollen SDK transport", () => {
    it("uses the official handshake and can call any permitted Pollen tool", async () => {
        const test = fixture((rpc) => {
            expect(rpc.params).toEqual({ name: "list_spaces", arguments: {} });
            return { spaces: [] };
        });
        try {
            expect(await test.client.callTool("list_spaces", {})).toEqual({
                spaces: [],
            });
            expect(test.messages.map((x) => x.method)).toEqual([
                "initialize",
                "notifications/initialized",
                "tools/call",
            ]);
        } finally {
            await test.client.close();
        }
    });
    it("accepts server events through the official transport", async () => {
        const test = fixture(() => registration, true);
        try {
            expect(await test.client.sharedInputs.register("source", "changes", "Source")).toEqual(registration);
        } finally {
            await test.client.close();
        }
    });
    it.each(["shipment", "appointment"])("pushes %s records without a domain rule", async (kind) => {
        const input = page(kind),
            test = fixture((rpc) => {
                expect(rpc.params.name).toBe("push_input_records");
                expect(rpc.params.arguments).toEqual({
                    connection_id: "source",
                    previous_checkpoint: null,
                    page: input,
                });
                return receipt(input);
            });
        try {
            expect(await test.client.sharedInputs.push("source", null, input)).toEqual(receipt(input));
        } finally {
            await test.client.close();
        }
    });
    it("leaves retry decisions to the durable caller after a lost write reply", async () => {
        const requests: unknown[] = [],
            input = page();
        let lost = true;
        const test = fixture((rpc) => {
            requests.push(rpc.params.arguments);
            if (lost) {
                lost = false;
                throw new Error("Lost reply");
            }
            return { ...receipt(input), replayed: true };
        });
        try {
            await expect(test.client.sharedInputs.push("source", null, input)).rejects.toThrow("did not complete");
            expect(requests).toHaveLength(1);
            expect((await test.client.sharedInputs.push("source", null, input)).replayed).toBe(true);
            expect(requests[0]).toEqual(requests[1]);
        } finally {
            await test.client.close();
        }
    });
    it("rejects a registration for another source", async () => {
        const test = fixture(() => ({ ...registration, connection_id: "other" }));
        try {
            await expect(test.client.sharedInputs.register("source", "changes", "Source")).rejects.toThrow(
                "invalid stream registration",
            );
        } finally {
            await test.client.close();
        }
    });
    it("rejects a receipt for another checkpoint", async () => {
        const test = fixture(() => ({ ...receipt(page()), checkpoint: "other" }));
        try {
            await expect(test.client.sharedInputs.push("source", null, page())).rejects.toThrow("different input page");
        } finally {
            await test.client.close();
        }
    });
    it("keeps limits on page count, record text, and encoded page bytes", async () => {
        const test = fixture(() => ({}));
        const many = page();
        many.changes = Array.from({ length: 21 }, () => many.changes[0]);
        const text = page();
        text.changes[0].text = "x".repeat(8001);
        const bytes = page();
        bytes.changes[0].data = { body: "x".repeat(46000) };
        for (const input of [many, text, bytes])
            await expect(test.client.sharedInputs.push("source", null, input)).rejects.toThrow("contract limits");
        expect(test.request).not.toHaveBeenCalled();
        await test.client.close();
    });
    it("bounds received bytes before protocol parsing", async () => {
        const test = fixture(() => ({ body: "x".repeat(64000) }));
        try {
            await expect(test.client.callTool("list_spaces", {})).rejects.toThrow("did not complete");
        } finally {
            await test.client.close();
        }
    });
    it("does not expose remote error text or credentials through its errors", async () => {
        const test = fixture(() => {
            throw new Error(token + " upstream details");
        });
        try {
            const error = await test.client.callTool("list_spaces", {}).catch((error) => error);
            expect(String(error)).toContain("did not complete");
            expect(String(error)).not.toContain(token);
            expect(String(error)).not.toContain("upstream details");
        } finally {
            await test.client.close();
        }
    });
    it("rejects unsafe endpoints before a request", () => {
        for (const endpoint of [
            "http://pollen.example/mcp",
            "https://user:secret@pollen.example/mcp",
            "https://pollen.example/mcp?token=value",
        ]) {
            expect(
                () =>
                    new PollenClient({
                        endpoint,
                        authProvider: { token: async () => token },
                    }),
            ).toThrow("HTTPS endpoint");
        }
    });
});
