# Pollen TypeScript SDK

This is one Pollen package for applications in different domains.
It contains no application identity rules, source adapters, or domain policy.

The package uses the official `@modelcontextprotocol/client` package.
That client handles MCP negotiation, JSON-RPC, HTTP transport, and server events.
Pollen code handles the Pollen record contract and registered application API.

## Package status

Version 0.1.0 is a release candidate. It is not published to npm.
The package name and registry scope remain provisional. The `private` flag
prevents an accidental npm publication. Build the candidate archive from a
reviewed commit:

```sh
npm ci
npm pack
```

Install that archive in the consuming application:

```sh
npm install /path/to/pollen-sdk-0.1.0.tgz
```

The two import paths belong to the same package:

| Import | Purpose |
| --- | --- |
| `@pollen/sdk` | MCP calls and the `pollen-inputs/v1` contract |
| `@pollen/sdk/server` | Registered application calls with a current user proof |

## MCP client

Supply an HTTPS endpoint and a credential provider. Keep credential storage in
the runtime that owns the credential. The SDK accepts the official MCP
`AuthProvider` and `OAuthClientProvider` interfaces.

```ts
import { PollenClient } from "@pollen/sdk";

const pollen = new PollenClient({
    endpoint: "https://pollen.example/mcp",
    authProvider: {
        token: () => secureTokenStore.currentAccessToken(),
    },
});

try {
    const spaces = await pollen.callTool("list_spaces", {});
} finally {
    await pollen.close();
}
```

Each client belongs to one credential context. Pollen checks permission on
each request. The SDK cannot grant membership or source access.

The client uses the official SDK's default 2025 MCP handshake. It works with
the current Pollen endpoint. It does not add a separate protocol parser.

## Input streams

`pollen.sharedInputs.register(connectionId, streamId, name)` registers an authorized
shared input. Pollen requires an Admin grant for this operation.
`pollen.sharedInputs.push(connectionId, previousCheckpoint, page)` submits one page.

Use these methods only for content approved for the organization audience.
Personal and project memory use separately authorized memory tools.

Records contain text, time, source URLs, subjects, and source values in `data`.
The application chooses its record kinds and subject namespaces. A shipment
source and an appointment source use the same API.

The SDK checks page count, text size, encoded page size, and receipt binding.
An accepted receipt confirms intake. It does not confirm graph extraction,
assessment, or inbox delivery.

Keep pending pages and checkpoints in a durable application store. After a
lost reply, retry the same page and prior checkpoint. The SDK does not repeat
a write after a network error. The application owns that recovery decision.

## Registered application client

Import `PollenApplication` from `@pollen/sdk/server` only in server code.
Supply the registered source ID, application credential, and identity issuer.
Pass the current user's proof to each call. Do not store the proof in chat or
send it as a tool argument.

```ts
import { PollenApplication } from "@pollen/sdk/server";

const application = new PollenApplication({
    endpoint: "https://pollen.example/",
    sourceId: registeredSourceId,
    applicationKey: serverCredential,
    identityIssuer: registeredIdentityIssuer,
});

const result = await application.callTool(
    { subject: signedInUser.id, proof: signedInUser.proof, signal },
    "list_inputs",
    {},
);
```

The SDK checks the returned source, issuer, and user identity. It rejects a
result that echoes either credential. It keeps connection, missing-record,
invalid-response, and unavailable states distinct. Errors omit remote bodies.

HTTP is available only for loopback development when `allowLocalHttp` is true.
Production applications must leave this option off.

## Boundaries

The SDK provides transport and Pollen contract checks. Pollen enforces access.
The application supplies eligibility rules, source mappings, policy text,
consent, and its inbox integration. Business rules do not belong in this SDK.

Automatic customer enrolment remains an open server contract. This candidate
does not implement it. Account ownership, administrator access, and membership
removal must be agreed before that contract becomes a public SDK operation.

## Checks

Run `npm ci`, `npm run build`, and `npm test` from this directory.
Tests use local fixtures. They make no live service or model calls.

## License

This SDK uses the MIT license. See `LICENSE`.
