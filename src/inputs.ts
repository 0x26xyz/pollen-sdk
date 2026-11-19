import { z } from "zod";

export interface Subject {
    namespace: string;
    id: string;
}

export interface SourceRecord {
    record_id: string;
    operation: "upsert" | "withdraw";
    record_kind: string;
    occurred_at: string;
    reported_at: string;
    valid_until: string | null;
    title: string;
    text: string;
    subjects: Subject[];
    data: Record<string, unknown>;
    source_url: string;
}

export interface InputRecord extends SourceRecord {
    revision: number;
}

export interface InputPage {
    contract: "pollen-inputs/v1";
    stream_id: string;
    epoch: string;
    changes: InputRecord[];
    checkpoint: string;
    has_more: boolean;
    complete_through: string;
    coverage: "observed";
}

const registrationSchema = z.object({
    contract: z.literal("pollen-inputs/v1"),
    connection_id: z.string(),
    stream_id: z.string(),
    transport: z.literal("push"),
    space_id: z.literal("organization"),
    mode: z.literal("published"),
    epoch: z.string().nullable(),
    checkpoint: z.string().nullable(),
});

const receiptSchema = z.object({
    contract: z.literal("pollen-inputs/v1"),
    connection_id: z.string(),
    epoch: z.string(),
    checkpoint: z.string(),
    complete_through: z.string(),
    accepted: z.number().int().min(0).max(20),
    receipt: z.string().regex(/^[a-f0-9]{64}$/),
    replayed: z.boolean(),
    stage: z.literal("accepted"),
});

export type Registration = z.infer<typeof registrationSchema>;
export type Receipt = z.infer<typeof receiptSchema>;

export interface SharedInputClient {
    register(connection: string, stream: string, name: string): Promise<Registration>;
    push(connection: string, previous: string | null, page: InputPage): Promise<Receipt>;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** These are Pollen record rules. An application supplies its own record kinds and subjects. */
export class PollenSharedInputs implements SharedInputClient {
    constructor(private readonly callTool: CallTool) {}

    async register(connection: string, stream: string, name: string): Promise<Registration> {
        const result = registrationSchema.safeParse(
            await this.callTool("register_input_stream", {
                connection_id: connection,
                stream_id: stream,
                name,
            }),
        );
        if (!result.success || result.data.connection_id !== connection || result.data.stream_id !== stream) {
            throw new Error("Pollen returned an invalid stream registration.");
        }
        return result.data;
    }

    async push(connection: string, previous: string | null, page: InputPage): Promise<Receipt> {
        const withinRecordLimits =
            page.changes.length <= 20 && page.changes.every((record) => Array.from(record.text).length <= 8000);
        if (!withinRecordLimits || new TextEncoder().encode(JSON.stringify(page)).byteLength > 46000) {
            throw new Error("The input page exceeds the Pollen contract limits.");
        }
        const result = receiptSchema.safeParse(
            await this.callTool("push_input_records", {
                connection_id: connection,
                previous_checkpoint: previous,
                page,
            }),
        );
        if (
            !result.success ||
            result.data.connection_id !== connection ||
            result.data.epoch !== page.epoch ||
            result.data.checkpoint !== page.checkpoint ||
            result.data.complete_through !== page.complete_through ||
            result.data.accepted !== page.changes.length
        ) {
            throw new Error("Pollen returned a receipt for a different input page.");
        }
        return result.data;
    }
}
