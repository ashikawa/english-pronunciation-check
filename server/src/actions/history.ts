// History: read and delete past pronunciation-check attempts.
//
// Attempts are created by scoring (actions/scoring.ts); this module only
// lists them and removes them, individually or all at once.

import { defineAction, z } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "../schema";
import { attemptShape, toAttempt } from "./shared";

const doneResponse = z.object({ ok: z.literal(true) });

export const HistoryActions = {
  listAttempts: defineAction({
    description: "Lists past pronunciation-check attempts, newest first.",
    request: z.object({
      limit: z.number().int().positive().max(200).default(50),
    }),
    response: z.object({ attempts: z.array(attemptShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.attempts)
        .orderBy(desc(schema.attempts.id))
        .limit(args.limit);
      return { attempts: rows.map(toAttempt) };
    },
  }),

  deleteAttempt: defineAction({
    description: "Deletes one pronunciation-check attempt from history.",
    request: z.object({ id: z.number().int().positive() }),
    response: doneResponse,
    async handler(ctx, args): Promise<z.infer<typeof doneResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.attempts).where(eq(schema.attempts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  clearAttempts: defineAction({
    description: "Deletes all pronunciation-check history.",
    request: z.object({}),
    response: doneResponse,
    async handler(ctx): Promise<z.infer<typeof doneResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.attempts);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
};
