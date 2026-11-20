# Pollen TypeScript SDK

This is one Pollen package for applications in different domains.
It contains no application identity rules, source adapters, or domain policy.

The package uses the official `@modelcontextprotocol/client` package.
That client handles MCP negotiation, JSON-RPC, HTTP transport, and server events.
Pollen code handles the Pollen record contract and registered application API.

## Package status

Version 0.2.1 is a release candidate. It is not published to npm.
The package name and registry scope remain provisional. The `private` flag
prevents an accidental npm publication. Build the candidate archive from a
reviewed commit:

```sh
npm ci
npm pack
```

Install that archive in the consuming application:

```sh
npm install /path/to/pollen-sdk-0.2.1.tgz
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

## Account setup

Account setup has two separate steps. An owner first saves the integration
policy in Pollen. The application then starts setup for an eligible user.
The user cannot select an organization or a role in a setup request.

Pollen has five policy templates. These are access profiles, not domain rules.

| Template | Destination and access |
| --- | --- |
| `personal` | The existing personal workspace of its owner. No other user can join. |
| `isolated_customers` | One platform organization. Each new customer has private records. The owner selects the published shared inputs that customers can read. |
| `workplace` | One existing organization. New users get the member role. Its staff access and data ownership rules apply. |
| `customer_organizations` | One existing customer organization per registered integration. Its saved `customer_ref` must match the application backend selection. |
| `shared_project` | One existing project in an owner organization. New guests get project contribution access. They cannot read other projects or staff sources. |

A person can have memberships in several organizations. Each registered
integration keeps one destination. For customer organizations, the application
backend selects a registered client from its trusted customer map. This version
does not create organizations or accept a user-supplied destination.
Customer references use Pollen's text rules: at most 128 UTF-16 code units,
some non-whitespace text, and no ASCII control characters. The SDK preserves
the exact value. A reference can contain slashes, spaces, or Unicode text.

An existing staff membership keeps its role and access. Customer setup does
not promote a member. A new protected membership can use only its registered
application. It cannot issue a general Pollen MCP grant.

Use the same setup check for new users and existing users on their first
assistant use. Keep business eligibility checks in the application server.

```ts
const user = { subject: session.user.id, proof: session.accessToken, signal };
const status = await application.onboarding.status(user);

if (status.state === "setup_required") {
    const started = await application.onboarding.start(user, {
        returnTo: "https://application.example/pollen/return",
    });
    // Keep this value in an authenticated server session or a signed HttpOnly cookie.
    await protectedSession.save(started.transaction);
    return redirect(started.url);
}
```

Pollen asks the user to sign in and confirm the Pollen account. It returns a
short-lived `pollen_code` and `pollen_state` in the registered callback fragment.
The transaction's `expiresAt` includes the two-minute code lifetime after the
start link expires. Keep the server session or cookie until that deadline.
Pollen checks each code's actual expiry from its confirmation time.
The callback page must remove that fragment from browser history at once. It
must send the values to its own authenticated server route. Do not log them.

```ts
const transaction = await protectedSession.read();
const completed = await application.onboarding.complete(user, transaction, {
    code: callback.code,
    state: callback.state,
});
await protectedSession.clear();
return redirect(completed.url);
```

The SDK checks the saved owner, state, expiry, and returned origin. Pollen checks
the current application proof, PKCE S256, saved policy revision, and return
address. Pollen grants membership only after the same Pollen browser account
returns. A forwarded start link alone cannot grant membership. The next screen
uses the existing source OAuth consent flow. Membership alone does not authorize
a data connection. Check status again after that flow. Run model work only when
status is `ready`.

Status can also be `policy_required` or `unavailable`. Show a clear next step or
retry action. Do not route a new user into the staff sign-up path as a fallback.

```ts
await application.onboarding.revoke(user);
```

Revocation removes this application's delegated connection. It ends sessions
for a membership created by setup. It keeps other memberships and source data.
New setup requires fresh application proof and user confirmation. It cannot
change the saved external account owner.

This is a Pollen enrolment API. It uses PKCE and the existing identity checks.
It is not a SCIM server or a new identity provider. The application still owns
its login, eligibility rules, private transaction storage, and optional alert
consent. Pollen owns policy, membership, and data access checks.

Protected customer ownership blocks organization-wide export, deletion, and
retention jobs. This candidate does not add a private user export or deletion
API. Do not use a staff bulk data operation for customer records.

## Checks

Run `npm ci`, `npm run build`, and `npm test` from this directory.
Tests use local fixtures. They make no live service or model calls.

## License

This SDK uses the MIT license. See `LICENSE`.
