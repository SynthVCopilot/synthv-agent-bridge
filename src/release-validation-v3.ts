export const STAGE3_QUERY_ACTIONS = [
  "convert_pitch",
  "get_project_info",
  "inspect_score_file",
  "get_time_axis",
  "convert_time",
  "list_tracks",
  "list_note_groups",
  "get_track_notes",
  "get_group_voice",
  "get_note_phoneme_data",
  "get_phrase_context",
  "get_computed_group_data",
  "get_note_retakes",
  "get_pitch_controls",
  "get_automation",
  "sample_automation",
  "get_track_mixer",
] as const;

export const STAGE3_VERIFIED_WRITE_ACTIONS = [
  "set_time_axis",
  "create_note_group",
  "delete_note_group",
  "add_group_reference",
  "add_track",
  "update_track",
  "delete_track",
  "update_group",
  "set_group_voice",
  "apply_group_tuning",
  "delete_group_reference",
  "import_monophonic_score",
  "add_notes",
  "edit_notes",
  "transform_notes",
  "set_note_phoneme_properties",
  "generate_note_retake",
  "activate_note_retake",
  "add_pitch_controls",
  "edit_pitch_controls",
  "simplify_automation",
  "set_automation_points",
  "script_data",
  "set_track_mixer",
  "humanize_notes",
  "apply_expression_preset",
  "fit_lyrics",
  "delete_notes",
  "delete_note_retake",
  "delete_pitch_controls",
  "clear_automation",
] as const;

export type Stage3QueryAction = (typeof STAGE3_QUERY_ACTIONS)[number];
export type Stage3VerifiedWriteAction =
  (typeof STAGE3_VERIFIED_WRITE_ACTIONS)[number];

export const STAGE3_ORDINARY_QUERY_BUDGET = 20_000;

export interface Stage3ReadPlanEntry {
  readonly action: Stage3QueryAction;
  readonly actionIteration: number;
  readonly iteration: number;
}

export interface Stage3WritePlanEntry {
  readonly action: Stage3VerifiedWriteAction;
  readonly actionIteration: number;
  readonly iteration: number;
}

export interface Stage3ReadBaseline {
  readonly executorBuildId: string;
  readonly projectFile: string;
  readonly sessionToken: string;
}

export interface Stage3ReadQueryResult {
  readonly durationMs?: number;
  readonly responseBytes: number;
  readonly responseCharacters: number;
}

export interface Stage3ReadValidationSummary {
  readonly actionCounts: Readonly<Record<Stage3QueryAction, number>>;
  readonly completedQueries: number;
  readonly maximumResponseBytes: number;
  readonly maximumResponseCharacters: number;
}

export interface Stage3ReadValidationOptions {
  readonly baseline: Stage3ReadBaseline;
  readonly plan: readonly Stage3ReadPlanEntry[];
  readonly probeBaseline: () => Promise<Stage3ReadBaseline>;
  readonly runQuery: (
    entry: Stage3ReadPlanEntry,
  ) => Promise<Stage3ReadQueryResult>;
}

export function createStage3ReadPlan(
  iterations = 1_000,
): readonly Stage3ReadPlanEntry[] {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new TypeError("Stage 3 read iterations must be a positive safe integer.");
  }
  return Array.from({ length: iterations }, (_, offset) => {
    const actionOffset = offset % STAGE3_QUERY_ACTIONS.length;
    const action = STAGE3_QUERY_ACTIONS[actionOffset];
    if (action === undefined) {
      throw new Error("Stage 3 Query action registry is incomplete.");
    }
    return {
      action,
      actionIteration: Math.floor(offset / STAGE3_QUERY_ACTIONS.length) + 1,
      iteration: offset + 1,
    };
  });
}

export function createStage3WritePlan(
  iterations = 200,
  minimumPerAction = 3,
): readonly Stage3WritePlanEntry[] {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new TypeError("Stage 3 write iterations must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(minimumPerAction) || minimumPerAction < 1) {
    throw new TypeError("Stage 3 minimum writes per action must be a positive safe integer.");
  }
  const required = STAGE3_VERIFIED_WRITE_ACTIONS.length * minimumPerAction;
  if (iterations < required) {
    throw new TypeError(
      `Stage 3 write iterations must be at least ${required} to cover every verified write ${minimumPerAction} times.`,
    );
  }
  return Array.from({ length: iterations }, (_, offset) => {
    const actionOffset = offset % STAGE3_VERIFIED_WRITE_ACTIONS.length;
    const action = STAGE3_VERIFIED_WRITE_ACTIONS[actionOffset];
    if (action === undefined) {
      throw new Error("Stage 3 verified write registry is incomplete.");
    }
    return {
      action,
      actionIteration:
        Math.floor(offset / STAGE3_VERIFIED_WRITE_ACTIONS.length) + 1,
      iteration: offset + 1,
    };
  });
}

function assertStage3Baseline(
  expected: Stage3ReadBaseline,
  actual: Stage3ReadBaseline,
): void {
  for (const field of [
    "projectFile",
    "sessionToken",
    "executorBuildId",
  ] as const) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Stage 3 baseline changed: ${field}`);
    }
  }
}

export async function runStage3ReadValidation(
  options: Stage3ReadValidationOptions,
): Promise<Stage3ReadValidationSummary> {
  const actionCounts = Object.fromEntries(
    STAGE3_QUERY_ACTIONS.map((action) => [action, 0]),
  ) as Record<Stage3QueryAction, number>;
  let maximumResponseBytes = 0;
  let maximumResponseCharacters = 0;
  let completedQueries = 0;

  for (const entry of options.plan) {
    assertStage3Baseline(options.baseline, await options.probeBaseline());
    const result = await options.runQuery(entry);
    if (
      !Number.isSafeInteger(result.responseBytes) ||
      result.responseBytes < 0 ||
      !Number.isSafeInteger(result.responseCharacters) ||
      result.responseCharacters < 0 ||
      result.responseBytes > STAGE3_ORDINARY_QUERY_BUDGET ||
      result.responseCharacters > STAGE3_ORDINARY_QUERY_BUDGET
    ) {
      throw new Error(`Stage 3 response budget exceeded: ${entry.action}`);
    }
    maximumResponseBytes = Math.max(maximumResponseBytes, result.responseBytes);
    maximumResponseCharacters = Math.max(
      maximumResponseCharacters,
      result.responseCharacters,
    );
    actionCounts[entry.action] += 1;
    completedQueries += 1;
  }
  if (options.plan.length > 0) {
    assertStage3Baseline(options.baseline, await options.probeBaseline());
  }

  return {
    actionCounts,
    completedQueries,
    maximumResponseBytes,
    maximumResponseCharacters,
  };
}
