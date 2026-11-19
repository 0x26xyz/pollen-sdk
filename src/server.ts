import { boundedResponse } from "./response.js";

type FailureCode = "connection_required" | "record_not_found" | "invalid_response" | "unavailable";

export class PollenApplicationError extends Error {
    constructor(readonly code: FailureCode) {
        super("The Pollen application request failed: " + code + ".");
        this.name = "PollenApplicationError";
    }
}

export interface PollenApplicationOptions {
    endpoint: string;
    sourceId: string;
    applicationKey: string;
    identityIssuer: string;
    allowLocalHttp?: boolean;
    fetch?: typeof fetch;
}

export interface ApplicationUser {
    subject: string;
    proof: string;
    signal: AbortSignal;
}

const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => new PollenApplicationError("invalid_response");

/** Keep this client on the application server. User proofs exist only for the current request. */
export class PollenApplication {
    private readonly url: URL;
    private readonly request: typeof fetch;

    constructor(private readonly options: PollenApplicationOptions) {
        const endpoint = new URL(options.endpoint);
        const localHttp =
            options.allowLocalHttp &&
            endpoint.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
        if (
            (endpoint.protocol !== "https:" && !localHttp) ||
            endpoint.username ||
            endpoint.password ||
            endpoint.search ||
            endpoint.hash ||
            endpoint.pathname !== "/"
        ) {
            throw new Error("Use the Pollen HTTPS application origin.");
        }
        if (
            !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.sourceId) ||
            !/^[\x21-\x7e]{32,4096}$/.test(options.applicationKey)
        ) {
            throw new Error("Configure the registered application and its server credential.");
        }
        this.url = new URL("app-sources/" + encodeURIComponent(options.sourceId) + "/rpc", endpoint);
        this.request = options.fetch ?? globalThis.fetch;
    }

    async callTool(
        user: ApplicationUser,
        name: string,
        args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        if (!user.proof || user.proof.length > 16384 || /\s/.test(user.proof))
            throw new Error("A current user proof is required.");
        let response: Response;
        try {
            response = await this.request(this.url, {
                method: "POST",
                headers: {
                    authorization: "Bearer " + this.options.applicationKey,
                    "pollen-user-authorization": "Bearer " + user.proof,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ tool_name: name, arguments: args }),
                cache: "no-store",
                redirect: "error",
                signal: AbortSignal.any([user.signal, AbortSignal.timeout(25000)]),
            });
        } catch {
            throw new PollenApplicationError("unavailable");
        }

        let body: unknown;
        try {
            body = await boundedResponse(response, 512 * 1024).json();
        } catch {
            throw invalid();
        }
        if (!object(body)) throw invalid();
        if (!response.ok) {
            if (response.status === 403 && body.error === "connection_required")
                throw new PollenApplicationError("connection_required");
            if (response.status === 404 && name === "read_memory") throw new PollenApplicationError("record_not_found");
            throw new PollenApplicationError("unavailable");
        }
        if (
            body.source_id !== this.options.sourceId ||
            !object(body.identity) ||
            body.identity.issuer !== this.options.identityIssuer ||
            body.identity.subject !== user.subject ||
            !object(body.result) ||
            (body.result.isError !== undefined && body.result.isError !== false) ||
            !object(body.result.structuredContent)
        )
            throw invalid();

        const result = body.result.structuredContent;
        const serialized = JSON.stringify(result);
        if (
            [this.options.applicationKey, user.proof].some((secret) =>
                serialized.includes(JSON.stringify(secret).slice(1, -1)),
            )
        )
            throw invalid();
        return result;
    }
}
