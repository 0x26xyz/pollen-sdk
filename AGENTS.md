# Writing

Use ASD-STE100 Simplified Technical English for prose. Use short sentences,
active voice, and consistent terms. This rule does not change code,
identifiers, protocol text, logs, quotations, or supplied source text.

# SDK boundary

This repository contains one Pollen SDK for applications in different domains.
Keep source adapters, application identities, and domain policies in applications.
Use maintained packages for standard protocols. Keep Pollen contract checks here.
Pollen enforces membership and data access. The SDK cannot grant permission.

# Changes

Keep transport, credential storage, and application rules separate.
Use clear steps. Explain complicated recovery rules in comments.
Run the build, format check, and fixture tests before a commit.
Tests must not use live credentials, live feeds, or paid model calls.
Never print or commit a secret.
