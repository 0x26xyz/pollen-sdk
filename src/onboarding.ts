import pkceChallenge from "pkce-challenge";
import { z } from "zod";

/** Pollen stores these profiles. A user request cannot select a role or a destination. */
export const onboardingTemplates = [
    "personal",
    "isolated_customers",
    "workplace",
    "customer_organizations",
    "shared_project",
] as const;

export const onboardingPolicySchema = z.object({
    id: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    template: z.enum(onboardingTemplates),
    organization: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    name: z.string().min(1).max(100),
});

const statusSchema = z.object({
    contract: z.literal("pollen-onboarding/v1"),
    state: z.enum(["ready", "setup_required", "policy_required", "unavailable"]),
    policy: onboardingPolicySchema.nullable(),
});

const receiptSchema = z.object({
    contract: z.literal("pollen-onboarding/v1"),
    url: z.string().url(),
    expires_at: z.string().datetime(),
    policy: onboardingPolicySchema,
});

const callbackCodeLifetimeMs = 2 * 60 * 1000;

export type OnboardingPolicy = z.infer<typeof onboardingPolicySchema>;
export type OnboardingStatus = z.infer<typeof statusSchema>;
export interface OnboardingUser {
    subject: string;
    proof: string;
    signal: AbortSignal;
}
export interface OnboardingTransaction {
    state: string;
    verifier: string;
    subject: string;
    returnTo: string;
    /** Latest completion deadline. Pollen checks the actual callback code expiry. */
    expiresAt: string;
}
export interface StartOnboarding {
    returnTo: string;
    customerRef?: string;
}
type Request = (
    user: OnboardingUser,
    action: string,
    body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Keep each transaction in the application's protected server session. */
export class PollenOnboarding {
    constructor(
        private readonly request: Request,
        private readonly origin: string,
        private readonly allowLocalHttp = false,
    ) {}

    async status(user: OnboardingUser): Promise<OnboardingStatus> {
        const result = statusSchema.safeParse(await this.request(user, "status", {}));
        if (!result.success) throw new Error("Pollen returned an invalid onboarding status.");
        return result.data;
    }

    async start(user: OnboardingUser, options: StartOnboarding) {
        const target = new URL(options.returnTo);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
        if (
            (target.protocol !== "https:" && !(this.allowLocalHttp && local && target.protocol === "http:")) ||
            target.username ||
            target.password ||
            target.hash ||
            target.search
        )
            throw new Error("Use a registered HTTPS return address without a query or fragment.");
        if (
            options.customerRef !== undefined &&
            (typeof options.customerRef !== "string" ||
                !options.customerRef.trim() ||
                options.customerRef.length > 128 ||
                /[\x00-\x1f\x7f]/.test(options.customerRef))
        ) {
            throw new Error("Use a valid customer reference.");
        }
        const proof = await pkceChallenge(64);
        const state = (await pkceChallenge(64)).code_verifier;
        const result = this.receipt(
            await this.request(user, "start", {
                return_to: target.href,
                state,
                code_challenge: proof.code_challenge,
                code_challenge_method: "S256",
                ...(options.customerRef === undefined ? {} : { customer_ref: options.customerRef }),
            }),
        );
        return {
            url: result.url,
            policy: result.policy,
            transaction: {
                state,
                verifier: proof.code_verifier,
                subject: user.subject,
                returnTo: target.href,
                // Confirmation can occur just before the link expires. Keep PKCE for the full code lifetime.
                expiresAt: new Date(Date.parse(result.expires_at) + callbackCodeLifetimeMs).toISOString(),
            } satisfies OnboardingTransaction,
        };
    }

    async complete(
        user: OnboardingUser,
        transaction: OnboardingTransaction,
        response: { code: string; state: string },
    ) {
        if (
            transaction.subject !== user.subject ||
            transaction.state !== response.state ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(transaction.verifier) ||
            !/^[A-Za-z0-9._~-]{1,256}$/.test(response.code) ||
            !Number.isFinite(Date.parse(transaction.expiresAt)) ||
            Date.parse(transaction.expiresAt) <= Date.now()
        )
            throw new Error("The onboarding transaction is expired or belongs to another session.");
        return this.receipt(
            await this.request(user, "complete", {
                code: response.code,
                state: response.state,
                code_verifier: transaction.verifier,
                return_to: transaction.returnTo,
            }),
        );
    }

    /** Revoke this application's link. Keep the person's other memberships and records. */
    async revoke(user: OnboardingUser) {
        const checked = z
            .object({ contract: z.literal("pollen-onboarding/v1"), revoked: z.literal(true) })
            .safeParse(await this.request(user, "revoke", {}));
        if (!checked.success) throw new Error("Pollen returned an invalid revocation receipt.");
        return checked.data;
    }

    private receipt(value: Record<string, unknown>) {
        const checked = receiptSchema.safeParse(value);
        if (!checked.success) throw new Error("Pollen returned an invalid onboarding receipt.");
        const result = checked.data;
        const url = new URL(result.url);
        const expires = Date.parse(result.expires_at);
        if (
            url.origin !== this.origin ||
            url.username ||
            url.password ||
            url.hash ||
            expires <= Date.now() ||
            expires > Date.now() + 10 * 60 * 1000 + 5000
        )
            throw new Error("Pollen returned an invalid onboarding destination or expiry.");
        return result;
    }
}
