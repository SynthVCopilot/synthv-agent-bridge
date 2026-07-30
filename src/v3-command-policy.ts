import type { V3ContextTargetKind } from "./v3-context-store.js";

export type V3CommandCategory = "edit" | "delete" | "transaction" | "ui";
export type V3TargetAggregate =
  | "GroupContent"
  | "GroupReference"
  | "TrackShell"
  | "ProjectTimeline"
  | "UIState"
  | "Metadata"
  | "Transaction";
export type V3OwnershipPolicy =
  | "sharedGroupContent"
  | "referenceLocal"
  | "trackShell"
  | "projectTimeline"
  | "uiState"
  | "objectMetadata"
  | "transactionBoundary";
export type V3ExpectedEffectPolicy =
  | "allowAlreadySatisfied"
  | "notApplicable";
export type V3PostconditionStrategy =
  | "hostReadback"
  | "observedUiState"
  | "transactionSummary";
export type V3TransactionEligibility =
  | "eligible"
  | "notEligible"
  | "controller";

interface ContextExpansionPolicy {
  readonly groupLocator?: boolean;
  readonly trackGuard?: boolean;
  readonly trackLocator?: boolean;
  readonly referenceGuard?: boolean;
  readonly automationGuard?: boolean;
  readonly retakeGuard?: boolean;
  readonly noteArrayField?: string;
  readonly pitchArrayField?: string;
  readonly sharedGroupContent?: boolean;
}

export interface V3CommandPolicy {
  readonly category: V3CommandCategory;
  readonly targetAggregate: V3TargetAggregate;
  readonly contextKinds: readonly V3ContextTargetKind[];
  readonly ownershipPolicy: V3OwnershipPolicy;
  readonly expectedEffectPolicy: V3ExpectedEffectPolicy;
  readonly postconditionStrategy: V3PostconditionStrategy;
  readonly transactionEligibility: V3TransactionEligibility;
  readonly contextExpansion?: ContextExpansionPolicy;
}

type PolicyOverrides = Partial<
  Pick<
    V3CommandPolicy,
    | "expectedEffectPolicy"
    | "postconditionStrategy"
    | "transactionEligibility"
    | "contextExpansion"
  >
>;

function projectCommand(
  targetAggregate: V3TargetAggregate,
  contextKinds: readonly V3ContextTargetKind[],
  ownershipPolicy: V3OwnershipPolicy,
  overrides: PolicyOverrides = {},
): V3CommandPolicy {
  return {
    category: "edit",
    targetAggregate,
    contextKinds,
    ownershipPolicy,
    expectedEffectPolicy: "allowAlreadySatisfied",
    postconditionStrategy: "hostReadback",
    transactionEligibility: "notEligible",
    ...overrides,
  };
}

function deleteCommand(
  targetAggregate: V3TargetAggregate,
  contextKinds: readonly V3ContextTargetKind[],
  ownershipPolicy: V3OwnershipPolicy,
  overrides: PolicyOverrides = {},
): V3CommandPolicy {
  return { ...projectCommand(targetAggregate, contextKinds, ownershipPolicy, overrides), category: "delete" };
}

function uiCommand(
  contextKinds: readonly V3ContextTargetKind[] = [],
): V3CommandPolicy {
  return {
    category: "ui",
    targetAggregate: "UIState",
    contextKinds,
    ownershipPolicy: "uiState",
    expectedEffectPolicy: "notApplicable",
    postconditionStrategy: "observedUiState",
    transactionEligibility: "notEligible",
  };
}

const GROUP_CONTEXT = ["group", "automation"] as const;
const TRACK_CONTEXT = ["track"] as const;
const TIME_AXIS_CONTEXT = ["timeAxis"] as const;
const LIBRARY_GROUP_CONTEXT = ["libraryGroup"] as const;

const GROUP_CONTENT: PolicyOverrides = {
  transactionEligibility: "eligible",
  contextExpansion: { groupLocator: true, sharedGroupContent: true },
};
const GROUP_CONTENT_NOT_TRANSACTIONAL: PolicyOverrides = {
  contextExpansion: { groupLocator: true, sharedGroupContent: true },
};
const TRACK_SHELL: PolicyOverrides = {
  transactionEligibility: "eligible",
  contextExpansion: { trackGuard: true },
};
const GROUP_REFERENCE: PolicyOverrides = {
  transactionEligibility: "eligible",
  contextExpansion: { groupLocator: true, referenceGuard: true },
};

const COMMAND_POLICIES: Readonly<Record<string, V3CommandPolicy>> = {
  set_time_axis: projectCommand(
    "ProjectTimeline",
    TIME_AXIS_CONTEXT,
    "projectTimeline",
    { transactionEligibility: "eligible" },
  ),
  create_note_group: projectCommand("GroupContent", [], "sharedGroupContent", {
    transactionEligibility: "eligible",
  }),
  clone_note_group: projectCommand(
    "GroupContent",
    ["group", "automation", "libraryGroup"],
    "sharedGroupContent",
    { transactionEligibility: "eligible" },
  ),
  delete_note_group: deleteCommand(
    "GroupContent",
    LIBRARY_GROUP_CONTEXT,
    "sharedGroupContent",
    { transactionEligibility: "eligible" },
  ),
  add_group_reference: projectCommand(
    "GroupReference",
    ["track", "libraryGroup"],
    "referenceLocal",
    { transactionEligibility: "eligible", contextExpansion: { trackGuard: true } },
  ),
  clone_group_reference: projectCommand(
    "GroupReference",
    ["track", "group", "automation"],
    "referenceLocal",
    { transactionEligibility: "eligible" },
  ),
  add_track: projectCommand("TrackShell", [], "trackShell", { transactionEligibility: "eligible" }),
  update_track: projectCommand("TrackShell", TRACK_CONTEXT, "trackShell", TRACK_SHELL),
  clone_track: projectCommand("TrackShell", TRACK_CONTEXT, "trackShell", TRACK_SHELL),
  clone_track_shell: projectCommand("TrackShell", TRACK_CONTEXT, "trackShell", TRACK_SHELL),
  delete_track: deleteCommand("TrackShell", TRACK_CONTEXT, "trackShell", TRACK_SHELL),
  update_group: projectCommand("GroupReference", GROUP_CONTEXT, "referenceLocal", {
    ...GROUP_REFERENCE,
    contextExpansion: { groupLocator: true, referenceGuard: true, sharedGroupContent: true },
  }),
  set_group_voice: projectCommand("GroupReference", GROUP_CONTEXT, "referenceLocal", GROUP_REFERENCE),
  apply_group_tuning: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: {
      groupLocator: true,
      referenceGuard: true,
      noteArrayField: "noteEdits",
      sharedGroupContent: true,
    },
  }),
  delete_group_reference: deleteCommand("GroupReference", GROUP_CONTEXT, "referenceLocal", GROUP_REFERENCE),
  import_monophonic_score: projectCommand(
    "GroupContent",
    GROUP_CONTEXT,
    "sharedGroupContent",
    GROUP_CONTENT_NOT_TRANSACTIONAL,
  ),
  add_notes: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", GROUP_CONTENT),
  edit_notes: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, noteArrayField: "edits", sharedGroupContent: true },
  }),
  transform_notes: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, noteArrayField: "notes", sharedGroupContent: true },
  }),
  set_note_phoneme_properties: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, noteArrayField: "edits", sharedGroupContent: true },
  }),
  delete_notes: deleteCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, noteArrayField: "notes", sharedGroupContent: true },
  }),
  generate_note_retake: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, retakeGuard: true, sharedGroupContent: true },
  }),
  activate_note_retake: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, retakeGuard: true, sharedGroupContent: true },
  }),
  delete_note_retake: deleteCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, retakeGuard: true, sharedGroupContent: true },
  }),
  add_pitch_controls: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", GROUP_CONTENT),
  edit_pitch_controls: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, pitchArrayField: "edits", sharedGroupContent: true },
  }),
  delete_pitch_controls: deleteCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, pitchArrayField: "pitchControls", sharedGroupContent: true },
  }),
  simplify_automation: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, automationGuard: true, sharedGroupContent: true },
  }),
  set_automation_points: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, automationGuard: true, sharedGroupContent: true },
  }),
  clear_automation: deleteCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, automationGuard: true, sharedGroupContent: true },
  }),
  script_data: projectCommand(
    "Metadata",
    ["track", "group", "automation", "timeAxis"],
    "objectMetadata",
    { contextExpansion: { sharedGroupContent: true } },
  ),
  set_track_mixer: projectCommand("TrackShell", TRACK_CONTEXT, "trackShell", TRACK_SHELL),
  create_harmony_track: projectCommand("TrackShell", TRACK_CONTEXT, "trackShell", {
    transactionEligibility: "eligible",
  }),
  humanize_notes: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, noteArrayField: "notes", sharedGroupContent: true },
  }),
  apply_expression_preset: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, noteArrayField: "notes", sharedGroupContent: true },
  }),
  fit_lyrics: projectCommand("GroupContent", GROUP_CONTEXT, "sharedGroupContent", {
    ...GROUP_CONTENT,
    contextExpansion: { groupLocator: true, noteArrayField: "notes", sharedGroupContent: true },
  }),
  apply_transaction: {
    category: "transaction",
    targetAggregate: "Transaction",
    contextKinds: [],
    ownershipPolicy: "transactionBoundary",
    expectedEffectPolicy: "allowAlreadySatisfied",
    postconditionStrategy: "transactionSummary",
    transactionEligibility: "controller",
  },
  rollback_transaction: {
    category: "transaction",
    targetAggregate: "Transaction",
    contextKinds: [],
    ownershipPolicy: "transactionBoundary",
    expectedEffectPolicy: "allowAlreadySatisfied",
    postconditionStrategy: "transactionSummary",
    transactionEligibility: "controller",
  },
  host_clipboard: uiCommand(),
  show_dialog: uiCommand(),
  get_selection: uiCommand(),
  set_selection: uiCommand(GROUP_CONTEXT),
  get_editor_view: uiCommand(),
  set_editor_view: uiCommand(),
  snap_position: uiCommand(),
  convert_editor_coordinates: uiCommand(),
  playback: uiCommand(),
};

const QUERY_CONTEXT_KINDS: Readonly<Record<string, readonly V3ContextTargetKind[]>> = {
  get_track_mixer: TRACK_CONTEXT,
  get_track_notes: TRACK_CONTEXT,
  get_group_voice: GROUP_CONTEXT,
  get_note_phoneme_data: GROUP_CONTEXT,
  get_phrase_context: GROUP_CONTEXT,
  get_computed_group_data: GROUP_CONTEXT,
  get_note_retakes: GROUP_CONTEXT,
  get_pitch_controls: GROUP_CONTEXT,
  get_automation: GROUP_CONTEXT,
  sample_automation: GROUP_CONTEXT,
};

const QUERY_CONTEXT_EXPANSIONS: Readonly<Record<string, ContextExpansionPolicy>> = {
  get_track_mixer: { trackLocator: true },
  get_track_notes: { trackLocator: true },
  get_group_voice: { groupLocator: true },
  get_note_phoneme_data: { groupLocator: true },
  get_phrase_context: { groupLocator: true },
  get_computed_group_data: { groupLocator: true },
  get_note_retakes: { groupLocator: true },
  get_pitch_controls: { groupLocator: true },
  get_automation: { groupLocator: true },
  sample_automation: { groupLocator: true },
};

const INFRASTRUCTURE_ACTIONS = new Set([
  "bridge_status",
  "get_host_info",
  "ping",
  "reload_bridge",
  "sidebar_get_request",
  "sidebar_publish_preview",
  "sidebar_status",
]);

export function commandPolicyActionNames(): readonly string[] {
  return Object.keys(COMMAND_POLICIES);
}

export function commandPolicyFor(action: string): V3CommandPolicy {
  const policy = COMMAND_POLICIES[action];
  if (policy === undefined) {
    throw new Error(`No v3 command policy for ${action}`);
  }
  return policy;
}

export function optionalCommandPolicy(action: string): V3CommandPolicy | undefined {
  return COMMAND_POLICIES[action];
}

export function contextKindsForAction(action: string): readonly V3ContextTargetKind[] {
  return COMMAND_POLICIES[action]?.contextKinds ?? QUERY_CONTEXT_KINDS[action] ?? [];
}

export function contextExpansionForAction(action: string): ContextExpansionPolicy | undefined {
  return COMMAND_POLICIES[action]?.contextExpansion ?? QUERY_CONTEXT_EXPANSIONS[action];
}

export function isV3InfrastructureAction(action: string): boolean {
  return INFRASTRUCTURE_ACTIONS.has(action);
}

export function assertV3CommandPolicyCatalog(
  definitions: Iterable<
    readonly [
      string,
      {
        readonly annotations?: {
          readonly readOnlyHint?: boolean | undefined;
        } | undefined;
      },
    ]
  >,
): void {
  const actionNames = new Set<string>();
  for (const [action, tool] of definitions) {
    actionNames.add(action);
    if (
      !isV3InfrastructureAction(action) &&
      COMMAND_POLICIES[action] === undefined &&
      tool.annotations?.readOnlyHint !== true
    ) {
      throw new Error(`No v3 command policy for ${action}`);
    }
  }
  for (const action of commandPolicyActionNames()) {
    if (!actionNames.has(action)) {
      throw new Error(`V3 command policy has no live action: ${action}`);
    }
  }
}
