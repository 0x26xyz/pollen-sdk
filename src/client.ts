import {
    Client,
    StreamableHTTPClientTransport,
    type AuthProvider,
    type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { PollenSharedInputs } from "./inputs.js";
import { boundedResponse } from "./response.js";

export interface PollenClientOptions {
    endpoint: string;
    authProvider: AuthProvider | OAuthClientProvider;
    fetch?: typeof fetch;
    timeoutMs?: number;
    maximumResponseBytes?: number;
}

/** Use one instance for one credential context. Pollen enforces permissions on each request. */
export class PollenClient {
    readonly sharedInputs: PollenSharedInputs;
    private readonly client = new Client({
        name: "pollen-sdk",
        version: "0.1.0",
    });
    private readonly transport: StreamableHTTPClientTransport;
    private readonly timeoutMs: number;
    private connection: Promise<void> | undefined;

    constructor(options: PollenClientOptions) {
        const endpoint = new URL(options.endpoint);
        if (
            endpoint.protocol !== "https:" ||
            endpoint.username ||
            endpoint.password ||
            endpoint.search ||
            endpoint.hash
        ) {
            throw new Error("Use a Pollen HTTPS endpoint without credentials, a query, or a fragment.");
        }
        this.timeoutMs = options.timeoutMs ?? 120000;
        const maximum = options.maximumResponseBytes ?? 64000;
        if (
            !Number.isSafeInteger(this.timeoutMs) ||
            this.timeoutMs < 1 ||
            !Number.isSafeInteger(maximum) ||
            maximum < 1
        ) {
            throw new Error("Use positive response and request limits.");
        }
        const request = options.fetch ?? globalThis.fetch;
        this.transport = new StreamableHTTPClientTransport(endpoint, {
            authProvider: options.authProvider,
            requestInit: { redirect: "error" },
            fetch: async (url, init) =>
                boundedResponse(
                    await request(url, {
                        ...init,
                        redirect: "error",
                        signal: AbortSignal.any([
                            ...(init?.signal ? [init.signal] : []),
                            AbortSignal.timeout(this.timeoutMs),
                        ]),
                    }),
                    maximum,
                ),
        });
        this.sharedInputs = new PollenSharedInputs((name, args) => this.callTool(name, args));
    }

    async connect(): Promise<void> {
        this.connection ??= this.client.connect(this.transport, {
            timeout: this.timeoutMs,
        });
        try {
            await this.connection;
        } catch {
            throw new Error("The Pollen connection did not complete.");
        }
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
        await this.connect();
        let result;
        try {
            result = await this.client.callTool({ name, arguments: args }, { timeout: this.timeoutMs });
        } catch {
            throw new Error("The Pollen tool request did not complete.");
        }
        const content = result.structuredContent;
        if (result.isError || !content || typeof content !== "object" || Array.isArray(content)) {
            throw new Error("Pollen did not accept the tool request.");
        }
        return content as Record<string, unknown>;
    }

    async close(): Promise<void> {
        try {
            await this.transport.terminateSession();
        } finally {
            await this.client.close();
        }
    }
}
