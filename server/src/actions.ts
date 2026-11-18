// Actions for the pronunciation checker — aggregation only.
//
// The action implementations live in one module per server feature:
//
//   actions/scoring.ts  recordAttempt (word alignment, candidate
//                       selection, model feedback, attempt insert)
//   actions/history.ts  listAttempts / deleteAttempt / clearAttempts
//   actions/notion.ts   searchNotionPages / saveToNotion (Notion export)
//   actions/shared.ts   the attempt shapes and row conversion all
//                       three features use
//
// This file stays at the fixed path the build and the client's typed
// API import from; it only merges the feature modules into the single
// Actions map.

import type { ActionsModule } from "@hatch/space-sdk";
import { HistoryActions } from "./actions/history";
import { NotionActions } from "./actions/notion";
import { ScoringActions } from "./actions/scoring";

export const Actions = {
  ...ScoringActions,
  ...HistoryActions,
  ...NotionActions,
} satisfies ActionsModule;
