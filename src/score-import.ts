import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { inflateRaw } from "node:zlib";

/**
 * Synthesizer V's current public scripting API uses this many blicks per
 * quarter note. Callers may override it so the parser is not coupled to a
 * hidden host lookup.
 */
export const SYNTHV_QUARTER_BLICKS = 705_600_000;

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const ABSOLUTE_MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_XML_ELEMENTS = 500_000;
const MAX_XML_DEPTH = 256;
const MAX_MIDI_TRACKS = 1_024;
const MAX_SCORE_NOTES = 100_000;
const MAX_IMPORTED_SCORE_NOTES = 512;
const MAX_MIDI_EVENTS = 2_000_000;
const MAX_MIDI_STORED_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_TEMPO_POINTS = 100_000;
const ALLOWED_SCORE_EXTENSIONS = new Set([
  ".xml",
  ".musicxml",
  ".mxl",
  ".mid",
  ".midi",
]);
const EPSILON = 1e-9;

export type ScoreImportErrorCode =
  | "LOCAL_FILE_REQUIRED"
  | "SCORE_FILE_NOT_FOUND"
  | "SCORE_FILE_CHANGED"
  | "INVALID_SCORE_SNAPSHOT"
  | "SCORE_FILE_TOO_LARGE"
  | "SVP_NOT_SUPPORTED"
  | "UNSUPPORTED_SCORE_FORMAT"
  | "UNSUPPORTED_COMPRESSED_MUSICXML"
  | "UNSAFE_XML"
  | "MALFORMED_MUSICXML"
  | "UNSUPPORTED_MUSICXML"
  | "MALFORMED_MIDI"
  | "UNSUPPORTED_MIDI"
  | "INVALID_SCORE_SELECTION"
  | "NO_NOTES"
  | "POLYPHONIC_SOURCE"
  | "SCORE_NOTE_LIMIT_EXCEEDED"
  | "TIMING_OUT_OF_RANGE"
  | "PITCH_OUT_OF_RANGE";

export class ScoreImportError extends Error {
  public constructor(
    public readonly code: ScoreImportErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ScoreImportError";
  }
}

export interface ScoreReadOptions {
  readonly maxFileBytes?: number;
}

export interface ScoreImportReadOptions extends ScoreReadOptions {
  readonly expectedFileFingerprint: string;
}

export interface ScoreConversionOptions {
  readonly quarterBlicks?: number;
  readonly onsetBlickOffset?: number;
  /** Explicit import transposition applied after source-score transposition. */
  readonly transposeSemitones?: number;
  readonly defaultLyric?: string;
}

export interface SynthVAddNote {
  readonly onset: number;
  readonly duration: number;
  readonly pitch: number;
  readonly lyrics?: string;
}

export interface ScoreTempoPoint {
  readonly position: number;
  readonly quarterPosition: number;
  readonly bpm: number;
  readonly inferred: boolean;
}

export interface ScorePreviewNote extends SynthVAddNote {
  /** 1-based index in this preview, never a SynthV storage index. */
  readonly noteIndex: number;
}

export interface ScorePreview {
  readonly timingBasis: "group-local-blick";
  readonly quarterBlicks: number;
  readonly onsetBlickOffset: number;
  readonly transposeSemitones: number;
  readonly noteCount: number;
  readonly beginPosition: number;
  readonly endPosition: number;
  readonly pitchMinimum: number;
  readonly pitchMaximum: number;
  readonly monophonic: boolean;
  readonly notes: readonly ScorePreviewNote[];
}

export interface MusicXmlSelection {
  /** 1-based part storage index. Defaults to 1 when partId is omitted. */
  readonly partIndex?: number;
  readonly partId?: string;
  readonly voice?: string;
  readonly staff?: number;
}

export interface MidiSelection {
  /** 1-based SMF track storage index. */
  readonly trackIndex: number;
  /** 1-based MIDI channel (1..16). Omit to combine all channels. */
  readonly channel?: number;
}

export interface MusicXmlVoiceInspection {
  readonly voice: string;
  readonly staffs: readonly number[];
  readonly noteCount: number;
  readonly hasOverlap: boolean;
}

export interface MusicXmlPartInspection {
  readonly partIndex: number;
  readonly partId: string;
  readonly name?: string;
  readonly noteCount: number;
  readonly durationQuarters: number;
  readonly pitchMinimum?: number;
  readonly pitchMaximum?: number;
  readonly hasOverlap: boolean;
  readonly voices: readonly MusicXmlVoiceInspection[];
  readonly tempoMap: readonly ScoreTempoPoint[];
  readonly warnings: readonly string[];
}

export interface MusicXmlInspection {
  readonly format: "musicxml";
  readonly scoreType: "score-partwise";
  readonly title?: string;
  readonly parts: readonly MusicXmlPartInspection[];
  readonly tempoMap: readonly ScoreTempoPoint[];
  readonly warnings: readonly string[];
}

export interface MidiChannelInspection {
  /** 1-based MIDI channel. */
  readonly channel: number;
  readonly noteCount: number;
  readonly pitchMinimum?: number;
  readonly pitchMaximum?: number;
  readonly hasOverlap: boolean;
}

export interface MidiTrackInspection {
  /** 1-based SMF track storage index. */
  readonly trackIndex: number;
  readonly name?: string;
  readonly noteCount: number;
  readonly channels: readonly MidiChannelInspection[];
  readonly danglingNoteOnCount: number;
  readonly orphanNoteOffCount: number;
  readonly warnings: readonly string[];
}

export interface MidiInspection {
  readonly format: "midi";
  readonly smfFormat: 0 | 1;
  readonly ticksPerQuarter: number;
  readonly tracks: readonly MidiTrackInspection[];
  readonly tempoMap: readonly ScoreTempoPoint[];
}

export type ScoreInspection = MusicXmlInspection | MidiInspection;

export interface MusicXmlImportResult {
  readonly format: "musicxml";
  readonly selection: Required<Pick<MusicXmlSelection, "partIndex">> &
    Omit<MusicXmlSelection, "partIndex">;
  /** This array can be passed directly as the notes field of add_notes. */
  readonly notes: readonly SynthVAddNote[];
  readonly preview: ScorePreview;
  readonly tempoMap: readonly ScoreTempoPoint[];
  readonly warnings: readonly string[];
}

export interface MidiImportResult {
  readonly format: "midi";
  readonly selection: MidiSelection;
  /** This array can be passed directly as the notes field of add_notes. */
  readonly notes: readonly SynthVAddNote[];
  readonly preview: ScorePreview;
  readonly tempoMap: readonly ScoreTempoPoint[];
  readonly warnings: readonly string[];
}

export type ScoreImportResult = MusicXmlImportResult | MidiImportResult;

const LOCAL_SCORE_SNAPSHOT_BRAND: unique symbol = Symbol("LocalScoreSnapshot");

export interface LocalScoreSnapshot {
  readonly [LOCAL_SCORE_SNAPSHOT_BRAND]: true;
  /** Absolute, normalized local path used for the bounded read. */
  readonly sourcePath: string;
  /** SHA-256 of the exact local file bytes, including the ZIP container for .mxl. */
  readonly fileFingerprint: string;
  /** Exact local file size before any safe .mxl extraction. */
  readonly sourceSize: number;
  readonly format: "musicxml" | "midi";
  readonly container: "plain" | "mxl";
  /** Parsed-source bytes; for .mxl this is the CRC-checked root MusicXML entry. */
  readonly bytes: Uint8Array;
}

export type LocalScoreInspection = ScoreInspection & {
  readonly sourcePath: string;
  readonly fileFingerprint: string;
  readonly sourceSize: number;
  readonly container: "plain" | "mxl";
};

export type LocalScoreImportResult = ScoreImportResult & {
  readonly sourcePath: string;
  readonly fileFingerprint: string;
  readonly sourceSize: number;
  readonly container: "plain" | "mxl";
};

interface LocalScoreSnapshotState {
  readonly bytes: Uint8Array;
  readonly fileFingerprint: string;
}

const LOCAL_SCORE_SNAPSHOTS = new WeakMap<object, LocalScoreSnapshotState>();

interface RawNote {
  onsetQuarter: number;
  durationQuarter: number;
  pitch: number;
  lyric?: string;
  voice?: string;
  staff?: number;
  sourceMeasure?: string;
  sourceTick?: number;
  sourceTrackIndex?: number;
  sourceChannel?: number;
}

interface RawTempo {
  quarterPosition: number;
  bpm: number;
}

interface ParsedMusicXmlPart {
  partIndex: number;
  partId: string;
  name?: string;
  notes: RawNote[];
  tempos: RawTempo[];
  durationQuarters: number;
  warnings: string[];
}

interface ParsedMusicXml {
  title?: string;
  parts: ParsedMusicXmlPart[];
  tempos: RawTempo[];
  warnings: string[];
}

interface ParsedMidiTrack {
  trackIndex: number;
  name?: string;
  notes: RawNote[];
  lyrics: MidiLyric[];
  danglingNoteOnCount: number;
  orphanNoteOffCount: number;
  warnings: string[];
}

interface ParsedMidi {
  format: 0 | 1;
  ticksPerQuarter: number;
  tracks: ParsedMidiTrack[];
  tempos: RawTempo[];
}

interface XmlElement {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: Array<XmlElement | string>;
}

function fail(
  code: ScoreImportErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new ScoreImportError(code, message, details);
}

function requireFiniteInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    return fail("TIMING_OUT_OF_RANGE", `${field} must be an integer in ${minimum}..${maximum}.`, {
      field,
      value,
      minimum,
      maximum,
    });
  }
  return value;
}

function conversionSettings(options: ScoreConversionOptions): {
  quarterBlicks: number;
  onsetBlickOffset: number;
  transposeSemitones: number;
  defaultLyric?: string;
} {
  const quarterBlicks = requireFiniteInteger(
    options.quarterBlicks ?? SYNTHV_QUARTER_BLICKS,
    "quarterBlicks",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const onsetBlickOffset = requireFiniteInteger(
    options.onsetBlickOffset ?? 0,
    "onsetBlickOffset",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const transposeSemitones = requireFiniteInteger(
    options.transposeSemitones ?? 0,
    "transposeSemitones",
    -127,
    127,
  );
  if (options.defaultLyric !== undefined && options.defaultLyric.length > 4_000) {
    return fail("TIMING_OUT_OF_RANGE", "defaultLyric is longer than the bridge note schema permits.", {
      length: options.defaultLyric.length,
      maximum: 4_000,
    });
  }
  const base = {
    quarterBlicks,
    onsetBlickOffset,
    transposeSemitones,
  };
  return options.defaultLyric === undefined
    ? base
    : { ...base, defaultLyric: options.defaultLyric };
}

function sortedNotes(notes: readonly RawNote[]): RawNote[] {
  return [...notes].sort(
    (left, right) =>
      left.onsetQuarter - right.onsetQuarter ||
      left.pitch - right.pitch ||
      left.durationQuarter - right.durationQuarter,
  );
}

function findOverlap(notes: readonly RawNote[]): {
  firstIndex: number;
  secondIndex: number;
  first: RawNote;
  second: RawNote;
} | undefined {
  const sorted = sortedNotes(notes);
  let furthestEnd = -Infinity;
  let furthestIndex = -1;
  for (let index = 0; index < sorted.length; index += 1) {
    const note = sorted[index];
    if (note === undefined) {
      continue;
    }
    if (note.onsetQuarter < furthestEnd - EPSILON) {
      const first = sorted[furthestIndex];
      if (first !== undefined) {
        return {
          firstIndex: furthestIndex + 1,
          secondIndex: index + 1,
          first,
          second: note,
        };
      }
    }
    const end = note.onsetQuarter + note.durationQuarter;
    if (end > furthestEnd) {
      furthestEnd = end;
      furthestIndex = index;
    }
  }
  return undefined;
}

function pitchRange(notes: readonly RawNote[]): {
  minimum?: number;
  maximum?: number;
} {
  if (notes.length === 0) {
    return {};
  }
  let minimum = 127;
  let maximum = 0;
  for (const note of notes) {
    minimum = Math.min(minimum, note.pitch);
    maximum = Math.max(maximum, note.pitch);
  }
  return { minimum, maximum };
}

function convertTempoMap(
  tempos: readonly RawTempo[],
  quarterBlicks: number,
  onsetBlickOffset: number,
): ScoreTempoPoint[] {
  const ordered = [...tempos]
    .filter((tempo) => Number.isFinite(tempo.quarterPosition) && Number.isFinite(tempo.bpm))
    .sort((left, right) => left.quarterPosition - right.quarterPosition);
  const normalized: Array<RawTempo & { inferred: boolean }> = [];
  if (ordered.length === 0 || ordered[0]?.quarterPosition !== 0) {
    normalized.push({ quarterPosition: 0, bpm: 120, inferred: true });
  }
  for (const tempo of ordered) {
    if (tempo.bpm <= 0) {
      continue;
    }
    const previous = normalized.at(-1);
    if (
      previous !== undefined &&
      Math.abs(previous.quarterPosition - tempo.quarterPosition) < EPSILON
    ) {
      normalized[normalized.length - 1] = { ...tempo, inferred: false };
    } else {
      normalized.push({ ...tempo, inferred: false });
    }
  }
  return normalized.map((tempo) => {
    const position = Math.round(tempo.quarterPosition * quarterBlicks) + onsetBlickOffset;
    if (!Number.isSafeInteger(position) || position < 0) {
      return fail("TIMING_OUT_OF_RANGE", "A tempo position cannot be represented as a safe blick.", {
        quarterPosition: tempo.quarterPosition,
        quarterBlicks,
        onsetBlickOffset,
      });
    }
    return {
      position,
      quarterPosition: tempo.quarterPosition,
      bpm: tempo.bpm,
      inferred: tempo.inferred,
    };
  });
}

function buildImport(
  rawNotes: readonly RawNote[],
  rawTempos: readonly RawTempo[],
  options: ScoreConversionOptions,
): {
  notes: SynthVAddNote[];
  preview: ScorePreview;
  tempoMap: ScoreTempoPoint[];
} {
  if (rawNotes.length === 0) {
    return fail("NO_NOTES", "The selected score part, track, voice, or channel has no notes.");
  }
  if (rawNotes.length > MAX_IMPORTED_SCORE_NOTES) {
    return fail(
      "SCORE_NOTE_LIMIT_EXCEEDED",
      "The selected score lane exceeds the per-import note limit.",
      {
        noteCount: rawNotes.length,
        maximum: MAX_IMPORTED_SCORE_NOTES,
      },
    );
  }
  const settings = conversionSettings(options);
  const ordered = sortedNotes(rawNotes);
  const overlap = findOverlap(ordered);
  if (overlap !== undefined) {
    return fail(
      "POLYPHONIC_SOURCE",
      "The selected source contains overlapping notes. Select a single voice/channel or explicitly allow polyphony.",
      {
        firstNoteIndex: overlap.firstIndex,
        firstPitch: overlap.first.pitch,
        firstOnsetQuarter: overlap.first.onsetQuarter,
        firstEndQuarter: overlap.first.onsetQuarter + overlap.first.durationQuarter,
        secondNoteIndex: overlap.secondIndex,
        secondPitch: overlap.second.pitch,
        secondOnsetQuarter: overlap.second.onsetQuarter,
      },
    );
  }

  const notes = ordered.map((raw, sourceIndex): SynthVAddNote => {
    const pitch = raw.pitch + settings.transposeSemitones;
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
      return fail("PITCH_OUT_OF_RANGE", "A score pitch is outside SynthV's MIDI pitch range.", {
        sourceNoteIndex: sourceIndex + 1,
        sourcePitch: raw.pitch,
        transposeSemitones: settings.transposeSemitones,
        pitch,
      });
    }
    if (!Number.isFinite(raw.onsetQuarter) || raw.onsetQuarter < 0) {
      return fail("TIMING_OUT_OF_RANGE", "A score note has an invalid onset.", {
        sourceNoteIndex: sourceIndex + 1,
        onsetQuarter: raw.onsetQuarter,
      });
    }
    if (!Number.isFinite(raw.durationQuarter) || raw.durationQuarter <= 0) {
      return fail("TIMING_OUT_OF_RANGE", "A score note has a non-positive duration.", {
        sourceNoteIndex: sourceIndex + 1,
        durationQuarter: raw.durationQuarter,
      });
    }
    const sourceOnset = Math.round(raw.onsetQuarter * settings.quarterBlicks);
    const sourceEnd = Math.round(
      (raw.onsetQuarter + raw.durationQuarter) * settings.quarterBlicks,
    );
    const onset = sourceOnset + settings.onsetBlickOffset;
    // Rounding both score boundaries keeps connected source notes exactly
    // connected in SynthV even when divisions do not divide SV.QUARTER.
    const duration = sourceEnd - sourceOnset;
    if (!Number.isSafeInteger(onset) || onset < 0 || !Number.isSafeInteger(duration) || duration < 1) {
      return fail("TIMING_OUT_OF_RANGE", "A score note cannot be represented as safe integer blicks.", {
        sourceNoteIndex: sourceIndex + 1,
        onsetQuarter: raw.onsetQuarter,
        durationQuarter: raw.durationQuarter,
        quarterBlicks: settings.quarterBlicks,
        onsetBlickOffset: settings.onsetBlickOffset,
      });
    }
    const end = onset + duration;
    if (!Number.isSafeInteger(end)) {
      return fail("TIMING_OUT_OF_RANGE", "A score note end exceeds JavaScript's safe integer range.", {
        sourceNoteIndex: sourceIndex + 1,
        onset,
        duration,
      });
    }
    const lyric = raw.lyric === undefined || raw.lyric.length === 0 ? settings.defaultLyric : raw.lyric;
    return lyric === undefined
      ? { onset, duration, pitch }
      : { onset, duration, pitch, lyrics: lyric };
  });

  const previewNotes = notes.map(
    (note, index): ScorePreviewNote => ({ noteIndex: index + 1, ...note }),
  );
  let beginPosition = Number.MAX_SAFE_INTEGER;
  let endPosition = 0;
  let pitchMinimum = 127;
  let pitchMaximum = 0;
  for (const note of notes) {
    beginPosition = Math.min(beginPosition, note.onset);
    endPosition = Math.max(endPosition, note.onset + note.duration);
    pitchMinimum = Math.min(pitchMinimum, note.pitch);
    pitchMaximum = Math.max(pitchMaximum, note.pitch);
  }
  return {
    notes,
    preview: {
      timingBasis: "group-local-blick",
      quarterBlicks: settings.quarterBlicks,
      onsetBlickOffset: settings.onsetBlickOffset,
      transposeSemitones: settings.transposeSemitones,
      noteCount: notes.length,
      beginPosition,
      endPosition,
      pitchMinimum,
      pitchMaximum,
      monophonic: overlap === undefined,
      notes: previewNotes,
    },
    tempoMap: convertTempoMap(rawTempos, settings.quarterBlicks, settings.onsetBlickOffset),
  };
}

function localName(name: string): string {
  const separator = name.indexOf(":");
  return (separator < 0 ? name : name.slice(separator + 1)).toLowerCase();
}

function decodeXmlBytes(bytes: Uint8Array, context: string): string {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
  } else {
    const declarationProbe = String.fromCharCode(
      ...bytes.subarray(0, Math.min(bytes.length, 256)),
    );
    const declared = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/iu.exec(
      declarationProbe,
    )?.[1];
    if (declared !== undefined) {
      encoding = declared;
    }
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    return fail("MALFORMED_MUSICXML", `${context} uses an invalid or unsupported text encoding.`, {
      encoding,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function decodeXmlEntities(value: string): string {
  return value.replaceAll(/&([^;]+);/gu, (_match, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const numeric = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : entity.startsWith("#")
            ? Number.parseInt(entity.slice(1), 10)
            : Number.NaN;
        if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff) {
          return fail("UNSAFE_XML", "MusicXML contains an unknown or external entity.", { entity });
        }
        return String.fromCodePoint(numeric);
      }
    }
  });
}

function findTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return fail("MALFORMED_MUSICXML", "MusicXML contains an unterminated tag.");
}

function parseXmlTag(tag: string): {
  name: string;
  attributes: Readonly<Record<string, string>>;
  selfClosing: boolean;
} {
  const selfClosing = /\/\s*$/u.test(tag);
  const body = (selfClosing ? tag.replace(/\/\s*$/u, "") : tag).trim();
  const nameMatch = /^([^\s/>]+)/u.exec(body);
  const name = nameMatch?.[1];
  if (name === undefined) {
    return fail("MALFORMED_MUSICXML", "MusicXML contains a tag without a name.");
  }
  const attributes: Record<string, string> = {};
  let offset = name.length;
  while (offset < body.length) {
    while (offset < body.length && /\s/u.test(body[offset] ?? "")) {
      offset += 1;
    }
    if (offset >= body.length) {
      break;
    }
    const attributeMatch = /^([^\s=/>]+)/u.exec(body.slice(offset));
    const attributeName = attributeMatch?.[1];
    if (attributeName === undefined) {
      return fail("MALFORMED_MUSICXML", "MusicXML contains an invalid attribute name.", {
        tag: name,
      });
    }
    offset += attributeName.length;
    while (offset < body.length && /\s/u.test(body[offset] ?? "")) {
      offset += 1;
    }
    if (body[offset] !== "=") {
      return fail("MALFORMED_MUSICXML", "MusicXML attributes must use quoted values.", {
        tag: name,
        attribute: attributeName,
      });
    }
    offset += 1;
    while (offset < body.length && /\s/u.test(body[offset] ?? "")) {
      offset += 1;
    }
    const quote = body[offset];
    if (quote !== '"' && quote !== "'") {
      return fail("MALFORMED_MUSICXML", "MusicXML attributes must use quoted values.", {
        tag: name,
        attribute: attributeName,
      });
    }
    offset += 1;
    const end = body.indexOf(quote, offset);
    if (end < 0) {
      return fail("MALFORMED_MUSICXML", "MusicXML contains an unterminated attribute value.", {
        tag: name,
        attribute: attributeName,
      });
    }
    attributes[attributeName] = decodeXmlEntities(body.slice(offset, end));
    offset = end + 1;
  }
  return { name, attributes, selfClosing };
}

function parseXml(xml: string): XmlElement {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) {
    return fail(
      "UNSAFE_XML",
      "DOCTYPE and ENTITY declarations are not accepted; local score import never resolves external entities.",
    );
  }
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let cursor = 0;
  let elementCount = 0;
  const appendText = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    const parent = stack.at(-1);
    if (parent !== undefined) {
      parent.children.push(decodeXmlEntities(text));
    } else if (text.trim().length > 0) {
      fail("MALFORMED_MUSICXML", "MusicXML contains text outside its root element.");
    }
  };

  while (cursor < xml.length) {
    const tagStart = xml.indexOf("<", cursor);
    if (tagStart < 0) {
      appendText(xml.slice(cursor));
      cursor = xml.length;
      break;
    }
    appendText(xml.slice(cursor, tagStart));
    if (xml.startsWith("<!--", tagStart)) {
      const end = xml.indexOf("-->", tagStart + 4);
      if (end < 0) {
        return fail("MALFORMED_MUSICXML", "MusicXML contains an unterminated comment.");
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      const end = xml.indexOf("]]>", tagStart + 9);
      if (end < 0) {
        return fail("MALFORMED_MUSICXML", "MusicXML contains an unterminated CDATA section.");
      }
      const parent = stack.at(-1);
      if (parent !== undefined) {
        parent.children.push(xml.slice(tagStart + 9, end));
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      const end = xml.indexOf("?>", tagStart + 2);
      if (end < 0) {
        return fail("MALFORMED_MUSICXML", "MusicXML contains an unterminated processing instruction.");
      }
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      return fail("UNSAFE_XML", "Unsupported XML declarations are not accepted.");
    }
    const tagEnd = findTagEnd(xml, tagStart + 1);
    const tag = xml.slice(tagStart + 1, tagEnd).trim();
    if (tag.startsWith("/")) {
      const closingName = tag.slice(1).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== closingName) {
        return fail("MALFORMED_MUSICXML", "MusicXML closing tags are not balanced.", {
          closingName,
          openName: open?.name,
        });
      }
    } else {
      const parsed = parseXmlTag(tag);
      const element: XmlElement = {
        name: parsed.name,
        attributes: parsed.attributes,
        children: [],
      };
      elementCount += 1;
      if (elementCount > MAX_XML_ELEMENTS) {
        return fail("SCORE_FILE_TOO_LARGE", "MusicXML contains too many elements.", {
          maximumElements: MAX_XML_ELEMENTS,
        });
      }
      const parent = stack.at(-1);
      if (parent === undefined) {
        roots.push(element);
      } else {
        parent.children.push(element);
      }
      if (!parsed.selfClosing) {
        stack.push(element);
        if (stack.length > MAX_XML_DEPTH) {
          return fail("SCORE_FILE_TOO_LARGE", "MusicXML nesting exceeds the safety limit.", {
            maximumDepth: MAX_XML_DEPTH,
          });
        }
      }
    }
    cursor = tagEnd + 1;
  }
  if (stack.length > 0) {
    return fail("MALFORMED_MUSICXML", "MusicXML contains unclosed tags.", {
      openTag: stack.at(-1)?.name,
    });
  }
  if (roots.length !== 1 || roots[0] === undefined) {
    return fail("MALFORMED_MUSICXML", "MusicXML must contain exactly one root element.", {
      rootCount: roots.length,
    });
  }
  return roots[0];
}

function xmlChildren(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => typeof child !== "string" && localName(child.name) === name,
  );
}

function xmlChild(element: XmlElement, name: string): XmlElement | undefined {
  return xmlChildren(element, name)[0];
}

function xmlText(element: XmlElement | undefined): string | undefined {
  if (element === undefined) {
    return undefined;
  }
  const collect = (node: XmlElement): string =>
    node.children
      .map((child) => (typeof child === "string" ? child : collect(child)))
      .join("");
  const value = collect(element).trim();
  return value.length === 0 ? undefined : value;
}

function xmlNumber(
  element: XmlElement | undefined,
  field: string,
  options: { integer?: boolean; minimum?: number; required?: boolean } = {},
): number | undefined {
  const text = xmlText(element);
  if (text === undefined) {
    if (options.required === true) {
      return fail("MALFORMED_MUSICXML", `MusicXML ${field} is required.`, { field });
    }
    return undefined;
  }
  const value = Number(text);
  if (
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isInteger(value)) ||
    (options.minimum !== undefined && value < options.minimum)
  ) {
    return fail("MALFORMED_MUSICXML", `MusicXML ${field} has an invalid numeric value.`, {
      field,
      value: text,
    });
  }
  return value;
}

function xmlAttribute(element: XmlElement, name: string): string | undefined {
  for (const [attributeName, value] of Object.entries(element.attributes)) {
    if (localName(attributeName) === name) {
      return value;
    }
  }
  return undefined;
}

function musicXmlPitch(note: XmlElement, transpose: number): number | undefined {
  const pitch = xmlChild(note, "pitch");
  if (pitch === undefined) {
    if (xmlChild(note, "unpitched") !== undefined) {
      return undefined;
    }
    return undefined;
  }
  const step = xmlText(xmlChild(pitch, "step"))?.toUpperCase();
  const octave = xmlNumber(xmlChild(pitch, "octave"), "pitch.octave", {
    integer: true,
    required: true,
  });
  const alter = xmlNumber(xmlChild(pitch, "alter"), "pitch.alter") ?? 0;
  if (!Number.isInteger(alter)) {
    return fail(
      "UNSUPPORTED_MUSICXML",
      "Fractional MusicXML pitch alteration cannot be represented by an integer SynthV note pitch.",
      { alter },
    );
  }
  const stepOffsets: Readonly<Record<string, number>> = {
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
    A: 9,
    B: 11,
  };
  const stepOffset = step === undefined ? undefined : stepOffsets[step];
  if (stepOffset === undefined || octave === undefined) {
    return fail("MALFORMED_MUSICXML", "MusicXML pitched notes require step and octave.", {
      step,
      octave,
    });
  }
  const midiPitch = 12 * (octave + 1) + stepOffset + alter + transpose;
  if (!Number.isInteger(midiPitch) || midiPitch < 0 || midiPitch > 127) {
    return fail("PITCH_OUT_OF_RANGE", "A transposed MusicXML pitch is outside MIDI 0..127.", {
      step,
      octave,
      alter,
      transpose,
      midiPitch,
    });
  }
  return midiPitch;
}

function musicXmlLyric(note: XmlElement): string | undefined {
  const lyric = xmlChildren(note, "lyric")[0];
  if (lyric === undefined) {
    return undefined;
  }
  const segments: string[] = [];
  for (const child of lyric.children) {
    if (typeof child !== "string") {
      const name = localName(child.name);
      if (name === "text") {
        const text = xmlText(child);
        if (text !== undefined) {
          segments.push(text);
        }
      } else if (name === "elision") {
        segments.push(xmlText(child) ?? " ");
      }
    }
  }
  const joined = segments.join("");
  return joined.length === 0 ? undefined : joined;
}

function musicXmlTieTypes(note: XmlElement): Set<string> {
  const types = new Set<string>();
  for (const tie of xmlChildren(note, "tie")) {
    const type = xmlAttribute(tie, "type");
    if (type !== undefined) {
      types.add(type.toLowerCase());
    }
  }
  return types;
}

function soundTempo(sound: XmlElement | undefined): number | undefined {
  const valueText = sound === undefined ? undefined : xmlAttribute(sound, "tempo");
  if (valueText === undefined) {
    return undefined;
  }
  const value = Number(valueText);
  if (!Number.isFinite(value) || value <= 0) {
    return fail("MALFORMED_MUSICXML", "MusicXML sound tempo must be positive.", {
      tempo: valueText,
    });
  }
  return value;
}

function directionTempo(direction: XmlElement): number | undefined {
  const sound = xmlChild(direction, "sound");
  const explicitSoundTempo = soundTempo(sound);
  if (explicitSoundTempo !== undefined) {
    return explicitSoundTempo;
  }
  const metronomes = xmlChildren(direction, "direction-type").flatMap((directionType) =>
    xmlChildren(directionType, "metronome"),
  );
  if (metronomes.length > 1) {
    return fail(
      "UNSUPPORTED_MUSICXML",
      "A MusicXML direction with multiple metronome definitions is ambiguous.",
      { metronomeCount: metronomes.length },
    );
  }
  const metronome = metronomes[0];
  const perMinute =
    metronome === undefined
      ? undefined
      : xmlNumber(xmlChild(metronome, "per-minute"), "metronome.per-minute", {
          minimum: Number.MIN_VALUE,
        });
  if (perMinute === undefined || metronome === undefined) {
    return undefined;
  }
  if (
    xmlChild(metronome, "beat-unit-tied") !== undefined ||
    xmlChild(metronome, "metronome-note") !== undefined ||
    xmlChild(metronome, "metronome-relation") !== undefined
  ) {
    return fail(
      "UNSUPPORTED_MUSICXML",
      "Complex MusicXML metronome relations cannot be reduced safely to one quarter-note BPM.",
    );
  }
  const beatUnit = xmlText(xmlChild(metronome, "beat-unit"))?.toLowerCase() ?? "quarter";
  const beatQuarters: Readonly<Record<string, number>> = {
    maxima: 32,
    long: 16,
    breve: 8,
    whole: 4,
    half: 2,
    quarter: 1,
    eighth: 0.5,
    "16th": 0.25,
    "32nd": 0.125,
    "64th": 0.0625,
    "128th": 0.03125,
    "256th": 0.015625,
    "512th": 0.0078125,
    "1024th": 0.00390625,
  };
  let durationQuarters = beatQuarters[beatUnit];
  if (durationQuarters === undefined) {
    return fail("UNSUPPORTED_MUSICXML", "MusicXML metronome beat-unit is unsupported.", {
      beatUnit,
    });
  }
  let added = durationQuarters;
  const dotCount = xmlChildren(metronome, "beat-unit-dot").length;
  for (let dotIndex = 0; dotIndex < dotCount; dotIndex += 1) {
    added /= 2;
    durationQuarters += added;
  }
  return perMinute * durationQuarters;
}

function directionPlaybackOffset(direction: XmlElement, divisions: number): number {
  const sound = xmlChild(direction, "sound");
  const soundOffset = sound === undefined ? undefined : xmlChild(sound, "offset");
  if (soundOffset !== undefined) {
    return (
      xmlNumber(soundOffset, "sound.offset", {
        minimum: -Number.MAX_VALUE,
        required: true,
      }) ?? 0
    ) / divisions;
  }
  const offset = xmlChild(direction, "offset");
  if (offset === undefined || xmlAttribute(offset, "sound")?.toLowerCase() !== "yes") {
    return 0;
  }
  return (
    xmlNumber(offset, "direction.offset", {
      minimum: -Number.MAX_VALUE,
      required: true,
    }) ?? 0
  ) / divisions;
}

function parseMusicXmlSource(source: string): ParsedMusicXml {
  const root = parseXml(source.replace(/^\uFEFF/u, ""));
  if (localName(root.name) !== "score-partwise") {
    return fail(
      "UNSUPPORTED_MUSICXML",
      "Only MusicXML score-partwise documents are supported.",
      { root: root.name },
    );
  }
  const title =
    xmlText(xmlChild(root, "movement-title")) ??
    xmlText(xmlChild(xmlChild(root, "work") ?? root, "work-title"));
  const partNames = new Map<string, string>();
  const partList = xmlChild(root, "part-list");
  if (partList !== undefined) {
    for (const scorePart of xmlChildren(partList, "score-part")) {
      const id = xmlAttribute(scorePart, "id");
      const name = xmlText(xmlChild(scorePart, "part-name"));
      if (id !== undefined && name !== undefined) {
        partNames.set(id, name);
      }
    }
  }

  const parts: ParsedMusicXmlPart[] = [];
  for (const [partOffset, partElement] of xmlChildren(root, "part").entries()) {
    const partIndex = partOffset + 1;
    const partId = xmlAttribute(partElement, "id") ?? `part-${partIndex}`;
    const notes: RawNote[] = [];
    const tempos: RawTempo[] = [];
    const warnings: string[] = [];
    let warnedNotationOnlyTie = false;
    let warnedUnpitched = false;
    let skippedCueCount = 0;
    let skippedGraceCount = 0;
    const activeTies = new Map<string, RawNote>();
    let divisions = 1;
    let transpose = 0;
    const transposeByStaff = new Map<number, number>();
    let partQuarter = 0;

    for (const [measureOffset, measure] of xmlChildren(partElement, "measure").entries()) {
      const measureNumber = xmlAttribute(measure, "number") ?? String(measureOffset + 1);
      const measureStart = partQuarter;
      let cursorQuarter = 0;
      let furthestQuarter = 0;
      let previousNoteOnset: number | undefined;

      for (const child of measure.children) {
        if (typeof child === "string") {
          continue;
        }
        switch (localName(child.name)) {
          case "attributes": {
            const nextDivisions = xmlNumber(xmlChild(child, "divisions"), "divisions", {
              minimum: Number.MIN_VALUE,
            });
            if (nextDivisions !== undefined) {
              divisions = nextDivisions;
            }
            for (const transposeElement of xmlChildren(child, "transpose")) {
              if (xmlChild(transposeElement, "double") !== undefined) {
                return fail(
                  "UNSUPPORTED_MUSICXML",
                  "MusicXML double transposition cannot be represented by one monophonic vocal lane.",
                  { partIndex, measure: measureNumber },
                );
              }
              const chromaticElement = xmlChild(transposeElement, "chromatic");
              if (
                chromaticElement === undefined &&
                xmlChild(transposeElement, "diatonic") !== undefined
              ) {
                return fail(
                  "UNSUPPORTED_MUSICXML",
                  "MusicXML diatonic-only transpose cannot be mapped safely to MIDI semitones.",
                  { partIndex, measure: measureNumber },
                );
              }
              const chromatic =
                xmlNumber(chromaticElement, "transpose.chromatic", {
                }) ?? 0;
              if (!Number.isInteger(chromatic)) {
                return fail(
                  "UNSUPPORTED_MUSICXML",
                  "Fractional MusicXML chromatic transpose cannot be represented by integer SynthV pitch.",
                  { partIndex, measure: measureNumber, chromatic },
                );
              }
              const octaveChange =
                xmlNumber(xmlChild(transposeElement, "octave-change"), "transpose.octave-change", {
                  integer: true,
                }) ?? 0;
              const semitones = chromatic + 12 * octaveChange;
              const staffValue = xmlAttribute(transposeElement, "number");
              if (staffValue === undefined) {
                transpose = semitones;
                transposeByStaff.clear();
              } else {
                const staffNumber = Number(staffValue);
                if (!Number.isInteger(staffNumber) || staffNumber < 1) {
                  return fail(
                    "MALFORMED_MUSICXML",
                    "MusicXML transpose number must identify a 1-based staff.",
                    { partIndex, measure: measureNumber, number: staffValue },
                  );
                }
                transposeByStaff.set(staffNumber, semitones);
              }
            }
            break;
          }
          case "backup": {
            const duration = xmlNumber(xmlChild(child, "duration"), "backup.duration", {
              minimum: 0,
              required: true,
            });
            cursorQuarter -= (duration ?? 0) / divisions;
            if (cursorQuarter < -EPSILON) {
              return fail("MALFORMED_MUSICXML", "MusicXML backup moves before the measure start.", {
                partIndex,
                measure: measureNumber,
                cursorQuarter,
              });
            }
            cursorQuarter = Math.max(0, cursorQuarter);
            previousNoteOnset = undefined;
            break;
          }
          case "forward": {
            const duration = xmlNumber(xmlChild(child, "duration"), "forward.duration", {
              minimum: 0,
              required: true,
            });
            cursorQuarter += (duration ?? 0) / divisions;
            furthestQuarter = Math.max(furthestQuarter, cursorQuarter);
            previousNoteOnset = undefined;
            break;
          }
          case "direction": {
            const tempo = directionTempo(child);
            if (tempo !== undefined) {
              const quarterPosition =
                measureStart + cursorQuarter + directionPlaybackOffset(child, divisions);
              if (quarterPosition < -EPSILON) {
                return fail(
                  "MALFORMED_MUSICXML",
                  "A MusicXML direction offset moves before score time zero.",
                  { partIndex, measure: measureNumber, quarterPosition },
                );
              }
              tempos.push({ quarterPosition: Math.max(0, quarterPosition), bpm: tempo });
            }
            break;
          }
          case "sound": {
            const tempo = soundTempo(child);
            if (tempo !== undefined) {
              const offset =
                xmlNumber(xmlChild(child, "offset"), "sound.offset", {
                  minimum: -Number.MAX_VALUE,
                }) ?? 0;
              const quarterPosition = measureStart + cursorQuarter + offset / divisions;
              if (quarterPosition < -EPSILON) {
                return fail(
                  "MALFORMED_MUSICXML",
                  "A MusicXML sound offset moves before score time zero.",
                  { partIndex, measure: measureNumber, quarterPosition },
                );
              }
              tempos.push({ quarterPosition: Math.max(0, quarterPosition), bpm: tempo });
            }
            break;
          }
          case "note": {
            const isCue = xmlChild(child, "cue") !== undefined;
            const grace = xmlChild(child, "grace") !== undefined;
            const durationUnits = xmlNumber(xmlChild(child, "duration"), "note.duration", {
              minimum: 0,
              required: !grace,
            });
            if (grace) {
              skippedGraceCount += 1;
              break;
            }
            const durationQuarter = (durationUnits ?? 0) / divisions;
            if (durationQuarter <= 0) {
              return fail("MALFORMED_MUSICXML", "MusicXML note duration must be positive.", {
                partIndex,
                measure: measureNumber,
                duration: durationUnits,
              });
            }
            const isChord = xmlChild(child, "chord") !== undefined;
            if (isChord && previousNoteOnset === undefined) {
              return fail(
                "MALFORMED_MUSICXML",
                "MusicXML chord note has no preceding note onset.",
                { partIndex, measure: measureNumber },
              );
            }
            const localOnset = isChord ? (previousNoteOnset ?? cursorQuarter) : cursorQuarter;
            if (!isChord) {
              previousNoteOnset = localOnset;
              cursorQuarter += durationQuarter;
            }
            furthestQuarter = Math.max(furthestQuarter, localOnset + durationQuarter, cursorQuarter);
            if (isCue) {
              skippedCueCount += 1;
              break;
            }
            if (xmlChild(child, "rest") !== undefined) {
              break;
            }
            const voice = xmlText(xmlChild(child, "voice")) ?? "1";
            const staff =
              xmlNumber(xmlChild(child, "staff"), "note.staff", {
                integer: true,
                minimum: 1,
              }) ?? 1;
            const pitch = musicXmlPitch(
              child,
              transposeByStaff.get(staff) ?? transpose,
            );
            if (pitch === undefined) {
              if (xmlChild(child, "unpitched") !== undefined) {
                if (!warnedUnpitched) {
                  warnedUnpitched = true;
                  warnings.push(
                    "Skipped unpitched notes because a vocal lane requires MIDI pitch.",
                  );
                }
                break;
              }
              return fail("MALFORMED_MUSICXML", "MusicXML note is neither pitched nor a rest.", {
                partIndex,
                measure: measureNumber,
              });
            }
            const tieTypes = musicXmlTieTypes(child);
            if (
              tieTypes.size === 0 &&
              xmlChildren(xmlChild(child, "notations") ?? child, "tied").length > 0 &&
              !warnedNotationOnlyTie
            ) {
              warnedNotationOnlyTie = true;
              warnings.push(
                "Ignored notation-only tied marks that had no sound-level tie elements.",
              );
            }
            const tieStops = tieTypes.has("stop") || tieTypes.has("continue");
            const tieStarts = tieTypes.has("start") || tieTypes.has("continue");
            const tieKey = `${voice}\u0000${staff}\u0000${pitch}`;
            const onsetQuarter = measureStart + localOnset;
            const lyric = musicXmlLyric(child);
            if (tieStops) {
              const active = activeTies.get(tieKey);
              if (active === undefined) {
                return fail("MALFORMED_MUSICXML", "MusicXML tie stop has no matching tie start.", {
                  partIndex,
                  measure: measureNumber,
                  voice,
                  staff,
                  pitch,
                });
              }
              const activeEnd = active.onsetQuarter + active.durationQuarter;
              if (Math.abs(activeEnd - onsetQuarter) > EPSILON) {
                return fail("MALFORMED_MUSICXML", "MusicXML tied notes are not contiguous.", {
                  partIndex,
                  measure: measureNumber,
                  pitch,
                  activeEndQuarter: activeEnd,
                  continuationOnsetQuarter: onsetQuarter,
                });
              }
              active.durationQuarter += durationQuarter;
              if (active.lyric === undefined && lyric !== undefined) {
                active.lyric = lyric;
              }
              if (!tieStarts) {
                activeTies.delete(tieKey);
              }
            } else {
              const rawNote: RawNote = {
                onsetQuarter,
                durationQuarter,
                pitch,
                voice,
                staff,
                sourceMeasure: measureNumber,
              };
              if (lyric !== undefined) {
                rawNote.lyric = lyric;
              }
              if (notes.length >= MAX_SCORE_NOTES) {
                return fail(
                  "SCORE_FILE_TOO_LARGE",
                  "MusicXML part exceeds the note safety limit.",
                  { partIndex, maximum: MAX_SCORE_NOTES },
                );
              }
              notes.push(rawNote);
              if (tieStarts) {
                if (activeTies.has(tieKey)) {
                  return fail("MALFORMED_MUSICXML", "MusicXML starts an already-active tie.", {
                    partIndex,
                    measure: measureNumber,
                    voice,
                    staff,
                    pitch,
                  });
                }
                activeTies.set(tieKey, rawNote);
              }
            }
            break;
          }
          default:
            break;
        }
      }
      partQuarter = measureStart + Math.max(furthestQuarter, cursorQuarter);
    }
    if (activeTies.size > 0) {
      warnings.push(`${activeTies.size} tie chain(s) ended without an explicit stop.`);
    }
    if (skippedCueCount > 0) {
      warnings.push(`Skipped ${skippedCueCount} sounding cue note(s).`);
    }
    if (skippedGraceCount > 0) {
      warnings.push(`Skipped ${skippedGraceCount} grace note(s).`);
    }
    const parsedPart: ParsedMusicXmlPart = {
      partIndex,
      partId,
      notes,
      tempos,
      durationQuarters: partQuarter,
      warnings,
    };
    const name = partNames.get(partId);
    if (name !== undefined) {
      parsedPart.name = name;
    }
    parts.push(parsedPart);
  }
  if (parts.length === 0) {
    return fail("MALFORMED_MUSICXML", "MusicXML score contains no parts.");
  }
  const tempoEntries = parts.flatMap((part) =>
    part.tempos.map((tempo) => ({ ...tempo, partIndex: part.partIndex })),
  );
  if (tempoEntries.length > MAX_TEMPO_POINTS) {
    return fail("SCORE_FILE_TOO_LARGE", "MusicXML score exceeds the tempo-event safety limit.", {
      tempoCount: tempoEntries.length,
      maximum: MAX_TEMPO_POINTS,
    });
  }
  tempoEntries.sort(
    (left, right) =>
      left.quarterPosition - right.quarterPosition ||
      left.partIndex - right.partIndex,
  );
  const tempos: RawTempo[] = [];
  const warnings: string[] = [];
  for (const tempo of tempoEntries) {
    const previous = tempos.at(-1);
    if (
      previous !== undefined &&
      Math.abs(previous.quarterPosition - tempo.quarterPosition) < EPSILON
    ) {
      if (
        Math.abs(previous.bpm - tempo.bpm) > EPSILON &&
        warnings.length < 100
      ) {
        warnings.push(
          `Conflicting tempo marks at quarter ${tempo.quarterPosition}; kept the lowest-index part.`,
        );
      }
      continue;
    }
    tempos.push({ quarterPosition: tempo.quarterPosition, bpm: tempo.bpm });
  }
  const result: ParsedMusicXml = { parts, tempos, warnings };
  if (title !== undefined) {
    result.title = title;
  }
  return result;
}

function musicXmlPartInspection(
  part: ParsedMusicXmlPart,
  quarterBlicks: number,
  onsetBlickOffset: number,
): MusicXmlPartInspection {
  const byVoice = new Map<string, RawNote[]>();
  for (const note of part.notes) {
    const voice = note.voice ?? "1";
    const entries = byVoice.get(voice) ?? [];
    entries.push(note);
    byVoice.set(voice, entries);
  }
  const voices = [...byVoice.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([voice, notes]): MusicXmlVoiceInspection => ({
      voice,
      staffs: [
        ...new Set(notes.map((note) => note.staff ?? 1)),
      ].sort((left, right) => left - right),
      noteCount: notes.length,
      hasOverlap: findOverlap(notes) !== undefined,
    }));
  const range = pitchRange(part.notes);
  const base = {
    partIndex: part.partIndex,
    partId: part.partId,
    noteCount: part.notes.length,
    durationQuarters: part.durationQuarters,
    hasOverlap: findOverlap(part.notes) !== undefined,
    voices,
    tempoMap: convertTempoMap(part.tempos, quarterBlicks, onsetBlickOffset),
    warnings: [...part.warnings],
  };
  return {
    ...base,
    ...(part.name === undefined ? {} : { name: part.name }),
    ...(range.minimum === undefined ? {} : { pitchMinimum: range.minimum }),
    ...(range.maximum === undefined ? {} : { pitchMaximum: range.maximum }),
  };
}

export function inspectMusicXml(
  source: string,
  options: Pick<ScoreConversionOptions, "quarterBlicks" | "onsetBlickOffset"> = {},
): MusicXmlInspection {
  const parsed = parseMusicXmlSource(source);
  const settings = conversionSettings(options);
  const base = {
    format: "musicxml" as const,
    scoreType: "score-partwise" as const,
    parts: parsed.parts.map((part) =>
      musicXmlPartInspection(part, settings.quarterBlicks, settings.onsetBlickOffset),
    ),
    tempoMap: convertTempoMap(
      parsed.tempos,
      settings.quarterBlicks,
      settings.onsetBlickOffset,
    ),
    warnings: [...parsed.warnings],
  };
  return parsed.title === undefined ? base : { ...base, title: parsed.title };
}

function selectMusicXmlPart(
  parsed: ParsedMusicXml,
  selection: MusicXmlSelection,
): ParsedMusicXmlPart {
  const requestedIndex =
    selection.partIndex ?? (selection.partId === undefined ? 1 : undefined);
  if (
    requestedIndex !== undefined &&
    (!Number.isInteger(requestedIndex) || requestedIndex < 1)
  ) {
    return fail("INVALID_SCORE_SELECTION", "MusicXML partIndex must be a 1-based integer.", {
      partIndex: selection.partIndex,
    });
  }
  const byIndex =
    requestedIndex === undefined ? undefined : parsed.parts[requestedIndex - 1];
  const byId =
    selection.partId === undefined
      ? undefined
      : parsed.parts.find((part) => part.partId === selection.partId);
  if (selection.partId !== undefined && byId === undefined) {
    return fail("INVALID_SCORE_SELECTION", "MusicXML partId was not found.", {
      partId: selection.partId,
      availablePartIds: parsed.parts.map((part) => part.partId),
    });
  }
  if (requestedIndex !== undefined && byIndex === undefined) {
    return fail("INVALID_SCORE_SELECTION", "MusicXML partIndex is out of range.", {
      partIndex: requestedIndex,
      partCount: parsed.parts.length,
    });
  }
  if (selection.partIndex !== undefined && byId !== undefined && byId !== byIndex) {
    return fail("INVALID_SCORE_SELECTION", "MusicXML partIndex and partId identify different parts.", {
      partIndex: requestedIndex,
      partId: selection.partId,
    });
  }
  const selected = byId ?? byIndex;
  if (selected === undefined) {
    return fail("INVALID_SCORE_SELECTION", "No MusicXML part was selected.");
  }
  return selected;
}

export function importMusicXmlMonophonic(
  source: string,
  selection: MusicXmlSelection = {},
  options: ScoreConversionOptions = {},
): MusicXmlImportResult {
  const parsed = parseMusicXmlSource(source);
  const part = selectMusicXmlPart(parsed, selection);
  if (
    selection.staff !== undefined &&
    (!Number.isInteger(selection.staff) || selection.staff < 1)
  ) {
    return fail("INVALID_SCORE_SELECTION", "MusicXML staff must be a 1-based integer.", {
      staff: selection.staff,
    });
  }
  const notes = part.notes.filter(
    (note) =>
      (selection.voice === undefined || note.voice === selection.voice) &&
      (selection.staff === undefined || note.staff === selection.staff),
  );
  const converted = buildImport(notes, parsed.tempos, options);
  const normalizedSelection = {
    partIndex: part.partIndex,
    ...(selection.partId === undefined ? {} : { partId: selection.partId }),
    ...(selection.voice === undefined ? {} : { voice: selection.voice }),
    ...(selection.staff === undefined ? {} : { staff: selection.staff }),
  };
  return {
    format: "musicxml",
    selection: normalizedSelection,
    notes: converted.notes,
    preview: converted.preview,
    tempoMap: converted.tempoMap,
    warnings: [...parsed.warnings, ...part.warnings],
  };
}

class MidiReader {
  public constructor(
    private readonly bytes: Uint8Array,
    public offset = 0,
    private readonly limit = bytes.length,
  ) {}

  public remaining(): number {
    return this.limit - this.offset;
  }

  public readByte(context: string): number {
    if (this.offset >= this.limit) {
      return fail("MALFORMED_MIDI", `Unexpected end of MIDI data while reading ${context}.`, {
        offset: this.offset,
      });
    }
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value ?? fail("MALFORMED_MIDI", "Unexpected end of MIDI data.");
  }

  public peekByte(context: string): number {
    if (this.offset >= this.limit) {
      return fail("MALFORMED_MIDI", `Unexpected end of MIDI data while reading ${context}.`, {
        offset: this.offset,
      });
    }
    return this.bytes[this.offset] ?? fail("MALFORMED_MIDI", "Unexpected end of MIDI data.");
  }

  public readUint16(context: string): number {
    return this.readByte(context) * 0x100 + this.readByte(context);
  }

  public readUint32(context: string): number {
    const high = this.readUint16(context);
    const low = this.readUint16(context);
    return high * 0x1_0000 + low;
  }

  public readVariable(context: string): number {
    let value = 0;
    for (let count = 0; count < 4; count += 1) {
      const byte = this.readByte(context);
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) {
        return value;
      }
    }
    return fail("MALFORMED_MIDI", "MIDI variable-length quantity exceeds four bytes.", {
      context,
      offset: this.offset,
    });
  }

  public readBytes(length: number, context: string): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining()) {
      return fail("MALFORMED_MIDI", `MIDI ${context} exceeds its chunk boundary.`, {
        offset: this.offset,
        length,
        remaining: this.remaining(),
      });
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  public subReader(length: number, context: string): MidiReader {
    return new MidiReader(this.readBytes(length, context));
  }
}

function midiAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function midiText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0+$/u, "");
}

interface ActiveMidiNote {
  tick: number;
}

interface ActiveMidiQueue {
  notes: ActiveMidiNote[];
  head: number;
}

interface MidiLyric {
  tick: number;
  text: string;
}

interface MidiParseBudget {
  eventCount: number;
  noteCount: number;
  storedTextBytes: number;
  tempoCount: number;
}

function parseMidiTrack(
  reader: MidiReader,
  trackIndex: number,
  ticksPerQuarter: number,
  budget: MidiParseBudget,
): { track: ParsedMidiTrack; tempos: RawTempo[] } {
  const notes: RawNote[] = [];
  const tempos: RawTempo[] = [];
  const lyrics: MidiLyric[] = [];
  const warnings: string[] = [];
  const active = new Map<string, ActiveMidiQueue>();
  let runningStatus: number | undefined;
  let tick = 0;
  let trackName: string | undefined;
  let orphanNoteOffCount = 0;
  let zeroLengthNoteCount = 0;
  let ended = false;
  let activeNoteCount = 0;

  const noteKey = (channel: number, pitch: number): string => `${channel}:${pitch}`;
  const closeNote = (channel: number, pitch: number): void => {
    const key = noteKey(channel, pitch);
    const queue = active.get(key);
    if (queue === undefined) {
      orphanNoteOffCount += 1;
      return;
    }
    const started = queue.notes[queue.head];
    if (started === undefined) {
      orphanNoteOffCount += 1;
      return;
    }
    queue.head += 1;
    activeNoteCount -= 1;
    if (queue.head >= queue.notes.length) {
      active.delete(key);
    }
    if (tick <= started.tick) {
      zeroLengthNoteCount += 1;
      return;
    }
    budget.noteCount += 1;
    if (budget.noteCount > MAX_SCORE_NOTES) {
      fail("SCORE_FILE_TOO_LARGE", "MIDI file exceeds the note safety limit.", {
        trackIndex,
        maximum: MAX_SCORE_NOTES,
      });
    }
    notes.push({
      onsetQuarter: started.tick / ticksPerQuarter,
      durationQuarter: (tick - started.tick) / ticksPerQuarter,
      pitch,
      sourceTick: started.tick,
      sourceTrackIndex: trackIndex,
      sourceChannel: channel + 1,
    });
  };

  while (reader.remaining() > 0 && !ended) {
    budget.eventCount += 1;
    if (budget.eventCount > MAX_MIDI_EVENTS) {
      return fail("SCORE_FILE_TOO_LARGE", "MIDI file exceeds the event safety limit.", {
        trackIndex,
        maximum: MAX_MIDI_EVENTS,
      });
    }
    const delta = reader.readVariable("event delta");
    tick += delta;
    if (!Number.isSafeInteger(tick)) {
      return fail("MALFORMED_MIDI", "MIDI absolute tick exceeds the safe integer range.", {
        trackIndex,
      });
    }
    const first = reader.peekByte("event status");
    let status: number;
    let firstData: number | undefined;
    if (first >= 0x80) {
      status = reader.readByte("event status");
      if (status >= 0x80 && status <= 0xef) {
        runningStatus = status;
      } else {
        runningStatus = undefined;
      }
    } else {
      if (runningStatus === undefined) {
        return fail("MALFORMED_MIDI", "MIDI running status appears before a channel status byte.", {
          trackIndex,
          tick,
        });
      }
      status = runningStatus;
      firstData = reader.readByte("running-status data");
    }

    if (status === 0xff) {
      const metaType = reader.readByte("meta event type");
      const length = reader.readVariable("meta event length");
      const data = reader.readBytes(length, "meta event");
      if (metaType === 0x2f) {
        if (length !== 0) {
          return fail("MALFORMED_MIDI", "MIDI end-of-track event must have zero length.", {
            trackIndex,
          });
        }
        ended = true;
      } else if (metaType === 0x51) {
        if (length !== 3) {
          return fail("MALFORMED_MIDI", "MIDI tempo meta event must contain three bytes.", {
            trackIndex,
            length,
          });
        }
        const microseconds = (data[0] ?? 0) * 0x1_0000 + (data[1] ?? 0) * 0x100 + (data[2] ?? 0);
        if (microseconds <= 0) {
          return fail("MALFORMED_MIDI", "MIDI tempo must be greater than zero.", {
            trackIndex,
            tick,
          });
        }
        budget.tempoCount += 1;
        if (budget.tempoCount > MAX_TEMPO_POINTS) {
          return fail("SCORE_FILE_TOO_LARGE", "MIDI file exceeds the tempo-event safety limit.", {
            maximum: MAX_TEMPO_POINTS,
          });
        }
        tempos.push({
          quarterPosition: tick / ticksPerQuarter,
          bpm: 60_000_000 / microseconds,
        });
      } else if (metaType === 0x03 && trackName === undefined) {
        budget.storedTextBytes += data.length;
        if (budget.storedTextBytes > MAX_MIDI_STORED_TEXT_BYTES) {
          return fail("SCORE_FILE_TOO_LARGE", "MIDI text exceeds the storage safety limit.", {
            maximumBytes: MAX_MIDI_STORED_TEXT_BYTES,
          });
        }
        trackName = midiText(data);
      } else if (metaType === 0x05) {
        budget.storedTextBytes += data.length;
        if (budget.storedTextBytes > MAX_MIDI_STORED_TEXT_BYTES) {
          return fail("SCORE_FILE_TOO_LARGE", "MIDI lyrics exceed the storage safety limit.", {
            maximumBytes: MAX_MIDI_STORED_TEXT_BYTES,
          });
        }
        lyrics.push({ tick, text: midiText(data) });
      }
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const length = reader.readVariable("SysEx length");
      reader.readBytes(length, "SysEx event");
      continue;
    }
    if (status < 0x80 || status > 0xef) {
      return fail("UNSUPPORTED_MIDI", "Unsupported system event in MIDI track.", {
        trackIndex,
        tick,
        status,
      });
    }

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    const dataLength = eventType === 0xc0 || eventType === 0xd0 ? 1 : 2;
    const data1 = firstData ?? reader.readByte("channel event data");
    const data2 = dataLength === 2 ? reader.readByte("channel event data") : undefined;
    if (data1 >= 0x80 || (data2 !== undefined && data2 >= 0x80)) {
      return fail("MALFORMED_MIDI", "MIDI channel event data bytes must be below 128.", {
        trackIndex,
        tick,
        status,
      });
    }
    if (eventType === 0x90 && (data2 ?? 0) > 0) {
      activeNoteCount += 1;
      if (budget.noteCount + activeNoteCount > MAX_SCORE_NOTES) {
        return fail("SCORE_FILE_TOO_LARGE", "MIDI file exceeds the active/completed note safety limit.", {
          trackIndex,
          maximum: MAX_SCORE_NOTES,
        });
      }
      const key = noteKey(channel, data1);
      const queue = active.get(key) ?? { notes: [], head: 0 };
      queue.notes.push({ tick });
      active.set(key, queue);
    } else if (eventType === 0x80 || (eventType === 0x90 && (data2 ?? 0) === 0)) {
      closeNote(channel, data1);
    }
  }

  if (ended && reader.remaining() > 0) {
    return fail(
      "MALFORMED_MIDI",
      "MIDI track contains data after its end-of-track event.",
      { trackIndex, trailingBytes: reader.remaining() },
    );
  }
  let danglingNoteOnCount = 0;
  for (const queue of active.values()) {
    danglingNoteOnCount += queue.notes.length - queue.head;
  }
  if (danglingNoteOnCount > 0) {
    warnings.push(`${danglingNoteOnCount} note-on event(s) have no matching note-off.`);
  }
  if (orphanNoteOffCount > 0) {
    warnings.push(`${orphanNoteOffCount} note-off event(s) have no matching note-on.`);
  }
  if (zeroLengthNoteCount > 0) {
    warnings.push(`Ignored ${zeroLengthNoteCount} zero-length MIDI note pair(s).`);
  }
  if (!ended) {
    warnings.push("Track has no end-of-track meta event.");
  }

  const track: ParsedMidiTrack = {
    trackIndex,
    notes,
    lyrics,
    danglingNoteOnCount,
    orphanNoteOffCount,
    warnings,
  };
  if (trackName !== undefined && trackName.length > 0) {
    track.name = trackName;
  }
  return { track, tempos };
}

function parseMidiSource(source: Uint8Array): ParsedMidi {
  const reader = new MidiReader(source);
  const headerId = midiAscii(reader.readBytes(4, "header chunk identifier"));
  if (headerId !== "MThd") {
    return fail("MALFORMED_MIDI", "MIDI file does not begin with an MThd header chunk.");
  }
  const headerLength = reader.readUint32("header chunk length");
  if (headerLength < 6) {
    return fail("MALFORMED_MIDI", "MIDI header chunk is shorter than six bytes.", {
      headerLength,
    });
  }
  const header = reader.subReader(headerLength, "header chunk");
  const formatValue = header.readUint16("SMF format");
  if (formatValue !== 0 && formatValue !== 1) {
    return fail("UNSUPPORTED_MIDI", "Only SMF format 0 and format 1 are supported.", {
      format: formatValue,
    });
  }
  const format: 0 | 1 = formatValue;
  const trackCount = header.readUint16("track count");
  if (trackCount < 1 || trackCount > MAX_MIDI_TRACKS) {
    return fail("MALFORMED_MIDI", "MIDI track count is invalid or exceeds the safety limit.", {
      trackCount,
      maximum: MAX_MIDI_TRACKS,
    });
  }
  if (format === 0 && trackCount !== 1) {
    return fail("MALFORMED_MIDI", "SMF format 0 must contain exactly one track.", {
      trackCount,
    });
  }
  const division = header.readUint16("time division");
  if ((division & 0x8000) !== 0) {
    return fail("UNSUPPORTED_MIDI", "SMPTE time division is not supported; use PPQ MIDI.", {
      division,
    });
  }
  if (division === 0) {
    return fail("MALFORMED_MIDI", "MIDI ticks-per-quarter division must be greater than zero.");
  }

  const tracks: ParsedMidiTrack[] = [];
  const tempos: RawTempo[] = [];
  const budget: MidiParseBudget = {
    eventCount: 0,
    noteCount: 0,
    storedTextBytes: 0,
    tempoCount: 0,
  };
  for (let index = 0; index < trackCount; index += 1) {
    const chunkId = midiAscii(reader.readBytes(4, "track chunk identifier"));
    if (chunkId !== "MTrk") {
      return fail("MALFORMED_MIDI", "Expected an MTrk chunk.", {
        trackIndex: index + 1,
        chunkId,
      });
    }
    const chunkLength = reader.readUint32("track chunk length");
    const parsed = parseMidiTrack(
      reader.subReader(chunkLength, "track chunk"),
      index + 1,
      division,
      budget,
    );
    tracks.push(parsed.track);
    if (format === 0 || index === 0) {
      tempos.push(...parsed.tempos);
    } else if (parsed.tempos.length > 0) {
      parsed.track.warnings.push(
        `Ignored ${parsed.tempos.length} tempo event(s) outside SMF format-1 tempo track 1.`,
      );
    }
  }
  return {
    format,
    ticksPerQuarter: division,
    tracks,
    tempos,
  };
}

function midiTrackInspection(track: ParsedMidiTrack): MidiTrackInspection {
  const byChannel = new Map<number, RawNote[]>();
  for (const note of track.notes) {
    const channel = note.sourceChannel ?? 1;
    const entries = byChannel.get(channel) ?? [];
    entries.push(note);
    byChannel.set(channel, entries);
  }
  const channels = [...byChannel.entries()]
    .sort(([left], [right]) => left - right)
    .map(([channel, notes]): MidiChannelInspection => {
      const range = pitchRange(notes);
      return {
        channel,
        noteCount: notes.length,
        hasOverlap: findOverlap(notes) !== undefined,
        ...(range.minimum === undefined ? {} : { pitchMinimum: range.minimum }),
        ...(range.maximum === undefined ? {} : { pitchMaximum: range.maximum }),
      };
    });
  const base = {
    trackIndex: track.trackIndex,
    noteCount: track.notes.length,
    channels,
    danglingNoteOnCount: track.danglingNoteOnCount,
    orphanNoteOffCount: track.orphanNoteOffCount,
    warnings: [...track.warnings],
  };
  return track.name === undefined ? base : { ...base, name: track.name };
}

export function inspectMidi(
  source: Uint8Array,
  options: Pick<ScoreConversionOptions, "quarterBlicks" | "onsetBlickOffset"> = {},
): MidiInspection {
  const parsed = parseMidiSource(source);
  const settings = conversionSettings(options);
  return {
    format: "midi",
    smfFormat: parsed.format,
    ticksPerQuarter: parsed.ticksPerQuarter,
    tracks: parsed.tracks.map(midiTrackInspection),
    tempoMap: convertTempoMap(parsed.tempos, settings.quarterBlicks, settings.onsetBlickOffset),
  };
}

function attachMidiLyrics(
  notes: RawNote[],
  lyrics: readonly MidiLyric[],
): string[] {
  const notesByTick = new Map<number, RawNote[]>();
  for (const note of sortedNotes(notes)) {
    const sourceTick = note.sourceTick ?? 0;
    const entries = notesByTick.get(sourceTick) ?? [];
    entries.push(note);
    notesByTick.set(sourceTick, entries);
  }
  const cursors = new Map<number, number>();
  let unmatched = 0;
  for (const lyric of lyrics) {
    if (lyric.text.length === 0) {
      continue;
    }
    const candidates = notesByTick.get(lyric.tick);
    const cursor = cursors.get(lyric.tick) ?? 0;
    const candidate = candidates?.[cursor];
    if (candidate === undefined) {
      unmatched += 1;
    } else {
      candidate.lyric = lyric.text;
      cursors.set(lyric.tick, cursor + 1);
    }
  }
  return unmatched === 0
    ? []
    : [`Ignored ${unmatched} MIDI lyric event(s) without a selected note at the same tick.`];
}

export function importMidiMonophonic(
  source: Uint8Array,
  selection: MidiSelection,
  options: ScoreConversionOptions = {},
): MidiImportResult {
  if (!Number.isInteger(selection.trackIndex) || selection.trackIndex < 1) {
    return fail("INVALID_SCORE_SELECTION", "MIDI trackIndex must be a 1-based integer.", {
      trackIndex: selection.trackIndex,
    });
  }
  if (
    selection.channel !== undefined &&
    (!Number.isInteger(selection.channel) || selection.channel < 1 || selection.channel > 16)
  ) {
    return fail("INVALID_SCORE_SELECTION", "MIDI channel must be a 1-based integer in 1..16.", {
      channel: selection.channel,
    });
  }
  const parsed = parseMidiSource(source);
  const track = parsed.tracks[selection.trackIndex - 1];
  if (track === undefined) {
    return fail("INVALID_SCORE_SELECTION", "MIDI trackIndex is out of range.", {
      trackIndex: selection.trackIndex,
      trackCount: parsed.tracks.length,
    });
  }
  const notes = (
    selection.channel === undefined
      ? track.notes
      : track.notes.filter((note) => note.sourceChannel === selection.channel)
  ).map((note) => ({ ...note }));
  const lyricWarnings = attachMidiLyrics(notes, track.lyrics);
  const converted = buildImport(notes, parsed.tempos, options);
  const normalizedSelection =
    selection.channel === undefined
      ? { trackIndex: selection.trackIndex }
      : { trackIndex: selection.trackIndex, channel: selection.channel };
  return {
    format: "midi",
    selection: normalizedSelection,
    notes: converted.notes,
    preview: converted.preview,
    tempoMap: converted.tempoMap,
    warnings: [...track.warnings, ...lyricWarnings],
  };
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : 0xedb88320 ^ (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function littleEndian16(bytes: Uint8Array, offset: number, context: string): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    return fail("MALFORMED_MUSICXML", `Compressed MusicXML ${context} is truncated.`, {
      offset,
    });
  }
  return (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 0x100;
}

function littleEndian32(bytes: Uint8Array, offset: number, context: string): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    return fail("MALFORMED_MUSICXML", `Compressed MusicXML ${context} is truncated.`, {
      offset,
    });
  }
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x1_0000 +
    (bytes[offset + 3] ?? 0) * 0x1_000000
  );
}

function zipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableIndex = (crc ^ byte) & 0xff;
    crc = (crc >>> 8) ^ (CRC32_TABLE[tableIndex] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeZipPath(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes("\0") ||
    segments.some((segment) => segment === "..")
  ) {
    return fail(
      "UNSUPPORTED_COMPRESSED_MUSICXML",
      "Compressed MusicXML contains an unsafe archive path.",
      { entryName: name },
    );
  }
  return normalized;
}

function parseZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const minimumEocdSize = 22;
  const firstPossible = Math.max(0, bytes.length - (minimumEocdSize + 0xffff));
  let eocdOffset = -1;
  for (let offset = bytes.length - minimumEocdSize; offset >= firstPossible; offset -= 1) {
    if (littleEndian32(bytes, offset, "end-of-central-directory search") === 0x06054b50) {
      const commentLength = littleEndian16(bytes, offset + 20, "archive comment length");
      if (offset + minimumEocdSize + commentLength === bytes.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML has no valid ZIP central directory.",
    );
  }
  const diskNumber = littleEndian16(bytes, eocdOffset + 4, "disk number");
  const directoryDisk = littleEndian16(bytes, eocdOffset + 6, "central-directory disk");
  const entriesOnDisk = littleEndian16(bytes, eocdOffset + 8, "entry count");
  const entryCount = littleEndian16(bytes, eocdOffset + 10, "entry count");
  const directorySize = littleEndian32(bytes, eocdOffset + 12, "central-directory size");
  const directoryOffset = littleEndian32(bytes, eocdOffset + 16, "central-directory offset");
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entryCount
  ) {
    return fail(
      "UNSUPPORTED_COMPRESSED_MUSICXML",
      "Multi-disk compressed MusicXML archives are not supported.",
    );
  }
  if (
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    return fail(
      "UNSUPPORTED_COMPRESSED_MUSICXML",
      "ZIP64 compressed MusicXML archives are not supported.",
    );
  }
  if (entryCount < 1 || entryCount > 4_096) {
    return fail(
      "UNSUPPORTED_COMPRESSED_MUSICXML",
      "Compressed MusicXML archive entry count exceeds the safety limit.",
      { entryCount, maximum: 4_096 },
    );
  }
  if (
    directoryOffset + directorySize > eocdOffset ||
    directoryOffset < 0 ||
    directorySize < 0
  ) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML central-directory bounds are invalid.",
      { directoryOffset, directorySize, eocdOffset },
    );
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (littleEndian32(bytes, cursor, "central-directory entry") !== 0x02014b50) {
      return fail(
        "MALFORMED_MUSICXML",
        "Compressed MusicXML has an invalid central-directory entry.",
        { entryIndex: index + 1, offset: cursor },
      );
    }
    const flags = littleEndian16(bytes, cursor + 8, "entry flags");
    const compressionMethod = littleEndian16(bytes, cursor + 10, "compression method");
    const crc32 = littleEndian32(bytes, cursor + 16, "entry CRC");
    const compressedSize = littleEndian32(bytes, cursor + 20, "compressed size");
    const uncompressedSize = littleEndian32(bytes, cursor + 24, "uncompressed size");
    const nameLength = littleEndian16(bytes, cursor + 28, "entry name length");
    const extraLength = littleEndian16(bytes, cursor + 30, "entry extra length");
    const commentLength = littleEndian16(bytes, cursor + 32, "entry comment length");
    const diskStart = littleEndian16(bytes, cursor + 34, "entry disk");
    const localHeaderOffset = littleEndian32(bytes, cursor + 42, "local-header offset");
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > directoryOffset + directorySize || entryEnd > bytes.length) {
      return fail(
        "MALFORMED_MUSICXML",
        "Compressed MusicXML central-directory entry exceeds its bounds.",
        { entryIndex: index + 1 },
      );
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      return fail(
        "UNSUPPORTED_COMPRESSED_MUSICXML",
        "ZIP64 compressed MusicXML entries are not supported.",
        { entryIndex: index + 1 },
      );
    }
    if (diskStart !== 0) {
      return fail(
        "UNSUPPORTED_COMPRESSED_MUSICXML",
        "Multi-disk compressed MusicXML entries are not supported.",
        { entryIndex: index + 1 },
      );
    }
    if ((flags & 0x0001) !== 0) {
      return fail(
        "UNSUPPORTED_COMPRESSED_MUSICXML",
        "Encrypted compressed MusicXML entries are not supported.",
        { entryIndex: index + 1 },
      );
    }
    if ((flags & 0x0040) !== 0) {
      return fail(
        "UNSUPPORTED_COMPRESSED_MUSICXML",
        "Strongly encrypted compressed MusicXML entries are not supported.",
        { entryIndex: index + 1 },
      );
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      return fail(
        "UNSUPPORTED_COMPRESSED_MUSICXML",
        "Only stored or deflated compressed MusicXML entries are supported.",
        { entryIndex: index + 1, compressionMethod },
      );
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let decodedName: string;
    try {
      decodedName = new TextDecoder((flags & 0x0800) === 0 ? "latin1" : "utf-8", {
        fatal: true,
      }).decode(nameBytes);
    } catch (error) {
      return fail(
        "MALFORMED_MUSICXML",
        "Compressed MusicXML contains an invalid archive-path encoding.",
        {
          entryIndex: index + 1,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    const name = safeZipPath(decodedName);
    if (names.has(name)) {
      return fail(
        "MALFORMED_MUSICXML",
        "Compressed MusicXML contains duplicate archive paths.",
        { entryName: name },
      );
    }
    names.add(name);
    entries.push({
      name,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = entryEnd;
  }
  if (cursor !== directoryOffset + directorySize) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML central-directory size does not match its entries.",
      { expectedEnd: directoryOffset + directorySize, actualEnd: cursor },
    );
  }
  return entries;
}

function inflateRawLimited(data: Uint8Array, maximum: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    inflateRaw(data, { maxOutputLength: maximum }, (error, result) => {
      if (error !== null) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

async function extractZipEntry(
  archive: Uint8Array,
  entry: ZipEntry,
  maximum: number,
): Promise<Uint8Array> {
  if (entry.uncompressedSize > maximum) {
    return fail(
      "SCORE_FILE_TOO_LARGE",
      "Compressed MusicXML entry exceeds the configured uncompressed size limit.",
      { entryName: entry.name, uncompressedSize: entry.uncompressedSize, maximum },
    );
  }
  const offset = entry.localHeaderOffset;
  if (littleEndian32(archive, offset, "local file header") !== 0x04034b50) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML local file header is invalid.",
      { entryName: entry.name, offset },
    );
  }
  const localFlags = littleEndian16(archive, offset + 6, "local entry flags");
  const localMethod = littleEndian16(archive, offset + 8, "local compression method");
  const nameLength = littleEndian16(archive, offset + 26, "local name length");
  const extraLength = littleEndian16(archive, offset + 28, "local extra length");
  if (
    localMethod !== entry.compressionMethod ||
    (localFlags & 0x0001) !== (entry.flags & 0x0001)
  ) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML local and central entry metadata disagree.",
      { entryName: entry.name },
    );
  }
  const localNameBytes = archive.subarray(offset + 30, offset + 30 + nameLength);
  let localEntryName: string;
  try {
    localEntryName = safeZipPath(
      new TextDecoder((localFlags & 0x0800) === 0 ? "latin1" : "utf-8", {
        fatal: true,
      }).decode(localNameBytes),
    );
  } catch (error) {
    if (error instanceof ScoreImportError) {
      throw error;
    }
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML local entry name has an invalid encoding.",
      {
        entryName: entry.name,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (localEntryName !== entry.name) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML local and central entry names disagree.",
      { centralName: entry.name, localName: localEntryName },
    );
  }
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataOffset < 0 || dataEnd > archive.length || dataEnd < dataOffset) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML entry data exceeds archive bounds.",
      { entryName: entry.name },
    );
  }
  const compressed = archive.subarray(dataOffset, dataEnd);
  let uncompressed: Uint8Array;
  if (entry.compressionMethod === 0) {
    uncompressed = compressed.slice();
  } else {
    try {
      uncompressed = await inflateRawLimited(compressed, maximum);
    } catch (error) {
      return fail("MALFORMED_MUSICXML", "Compressed MusicXML deflate stream is invalid.", {
        entryName: entry.name,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (uncompressed.length !== entry.uncompressedSize) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML entry size does not match its central directory.",
      {
        entryName: entry.name,
        expectedSize: entry.uncompressedSize,
        actualSize: uncompressed.length,
      },
    );
  }
  const actualCrc = zipCrc32(uncompressed);
  if (actualCrc !== entry.crc32) {
    return fail("MALFORMED_MUSICXML", "Compressed MusicXML entry CRC check failed.", {
      entryName: entry.name,
      expectedCrc32: entry.crc32,
      actualCrc32: actualCrc,
    });
  }
  return uncompressed;
}

function xmlDescendants(element: XmlElement, name: string): XmlElement[] {
  const matches: XmlElement[] = [];
  for (const child of element.children) {
    if (typeof child !== "string") {
      if (localName(child.name) === name) {
        matches.push(child);
      }
      matches.push(...xmlDescendants(child, name));
    }
  }
  return matches;
}

async function extractCompressedMusicXml(
  archive: Uint8Array,
  maximum: number,
): Promise<Uint8Array> {
  const entries = parseZipDirectory(archive);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const containerEntry =
    byName.get("META-INF/container.xml") ??
    entries.find((entry) => entry.name.toLowerCase() === "meta-inf/container.xml");
  if (containerEntry === undefined) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML archive has no META-INF/container.xml.",
    );
  }
  const containerBytes = await extractZipEntry(
    archive,
    containerEntry,
    Math.min(maximum, 1_048_576),
  );
  const container = parseXml(
    decodeXmlBytes(containerBytes, "Compressed MusicXML container"),
  );
  if (localName(container.name) !== "container") {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML container has an invalid root element.",
      { root: container.name },
    );
  }
  const rootfiles = xmlDescendants(container, "rootfile");
  const rootfile = rootfiles[0];
  if (rootfile === undefined) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML container has no rootfile entries.",
    );
  }
  const rootPathValue = xmlAttribute(rootfile, "full-path");
  if (rootPathValue === undefined) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML container identifies no uncompressed MusicXML rootfile.",
    );
  }
  const mediaType = xmlAttribute(rootfile, "media-type");
  if (
    mediaType !== undefined &&
    mediaType !== "application/vnd.recordare.musicxml+xml"
  ) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML first rootfile has a non-MusicXML media type.",
      { mediaType },
    );
  }
  const rootPath = safeZipPath(rootPathValue);
  const scoreEntry = byName.get(rootPath);
  if (scoreEntry === undefined) {
    return fail(
      "MALFORMED_MUSICXML",
      "Compressed MusicXML rootfile is absent from the archive.",
      { rootPath },
    );
  }
  return extractZipEntry(archive, scoreEntry, maximum);
}

function detectScoreFormat(filePath: string, bytes: Uint8Array): "musicxml" | "midi" {
  const extension = path.extname(filePath).toLowerCase();
  const hasMidiHeader =
    bytes.length >= 4 && midiAscii(bytes.subarray(0, 4)) === "MThd";
  if (extension === ".mid" || extension === ".midi") {
    if (!hasMidiHeader) {
      return fail(
        "MALFORMED_MIDI",
        "File extension indicates MIDI, but the MThd header is missing.",
      );
    }
    return "midi";
  }
  if (extension === ".xml" || extension === ".musicxml") {
    if (hasMidiHeader) {
      return fail(
        "UNSUPPORTED_SCORE_FORMAT",
        "MIDI content must use a .mid or .midi extension.",
        { extension },
      );
    }
    return "musicxml";
  }
  return fail(
    "UNSUPPORTED_SCORE_FORMAT",
    "Uncompressed score content must use .xml, .musicxml, .mid, or .midi.",
    { extension },
  );
}

function snapshotState(snapshot: LocalScoreSnapshot): LocalScoreSnapshotState {
  const state = LOCAL_SCORE_SNAPSHOTS.get(snapshot);
  if (state === undefined) {
    return fail(
      "INVALID_SCORE_SNAPSHOT",
      "Score snapshot was not created by readLocalScoreSnapshot.",
    );
  }
  return state;
}

function createLocalScoreSnapshot(
  metadata: Omit<
    LocalScoreSnapshot,
    "bytes" | typeof LOCAL_SCORE_SNAPSHOT_BRAND
  >,
  bytes: Uint8Array,
): LocalScoreSnapshot {
  const protectedBytes = bytes.slice();
  const snapshot: LocalScoreSnapshot = Object.freeze({
    ...metadata,
    [LOCAL_SCORE_SNAPSHOT_BRAND]: true as const,
    get bytes(): Uint8Array {
      return protectedBytes.slice();
    },
  });
  LOCAL_SCORE_SNAPSHOTS.set(snapshot, {
    bytes: protectedBytes,
    fileFingerprint: metadata.fileFingerprint,
  });
  return snapshot;
}

export async function readLocalScoreSnapshot(
  filePath: string,
  options: ScoreReadOptions = {},
): Promise<LocalScoreSnapshot> {
  if (
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(filePath) ||
    /^(?:\\\\|\/\/|\\[?.]\\)/u.test(filePath)
  ) {
    return fail(
      "LOCAL_FILE_REQUIRED",
      "Score import accepts local disk paths only; URLs, UNC shares, and device paths are rejected.",
      { filePath },
    );
  }
  if (!path.isAbsolute(filePath)) {
    return fail(
      "LOCAL_FILE_REQUIRED",
      "Score import requires an explicitly supplied absolute local file path.",
      { filePath },
    );
  }
  const sourcePath = path.resolve(filePath);
  if (/^(?:\\\\|\/\/|\\[?.]\\)/u.test(sourcePath)) {
    return fail(
      "LOCAL_FILE_REQUIRED",
      "Resolved score path is a UNC share or device path, not a local disk file.",
      { sourcePath },
    );
  }
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".svp") {
    return fail(
      "SVP_NOT_SUPPORTED",
      "Direct .svp parsing is intentionally outside the bridge responsibility boundary.",
    );
  }
  if (!ALLOWED_SCORE_EXTENSIONS.has(extension)) {
    return fail(
      "UNSUPPORTED_SCORE_FORMAT",
      "Score file extension must be .xml, .musicxml, .mxl, .mid, or .midi.",
      { sourcePath, extension },
    );
  }
  const maximum = requireFiniteInteger(
    options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    "maxFileBytes",
    1,
    ABSOLUTE_MAX_FILE_BYTES,
  );
  let bytes: Uint8Array;
  try {
    const handle = await open(sourcePath, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        return fail("SCORE_FILE_NOT_FOUND", "Score path is not a regular file.", { sourcePath });
      }
      if (before.size > maximum) {
        return fail("SCORE_FILE_TOO_LARGE", "Local score file exceeds the configured size limit.", {
          sourcePath,
          fileSize: before.size,
          maximum,
        });
      }
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= maximum) {
        const requestLength = Math.min(64 * 1024, maximum + 1 - total);
        if (requestLength <= 0) {
          break;
        }
        const chunk = Buffer.allocUnsafe(requestLength);
        const result = await handle.read(chunk, 0, requestLength, total);
        if (result.bytesRead === 0) {
          break;
        }
        chunks.push(chunk.subarray(0, result.bytesRead));
        total += result.bytesRead;
      }
      if (total > maximum) {
        return fail("SCORE_FILE_TOO_LARGE", "Local score file exceeds the configured size limit.", {
          sourcePath,
          fileSizeAtLeast: total,
          maximum,
        });
      }
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        total !== after.size
      ) {
        return fail(
          "SCORE_FILE_CHANGED",
          "Local score file changed while the bounded snapshot was being read.",
          {
            sourcePath,
            sizeBefore: before.size,
            sizeAfter: after.size,
            bytesRead: total,
          },
        );
      }
      bytes = Buffer.concat(chunks, total);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ScoreImportError) {
      throw error;
    }
    return fail("SCORE_FILE_NOT_FOUND", "Local score file could not be read.", {
      sourcePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const fileFingerprint = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (extension === ".mxl") {
    const extracted = await extractCompressedMusicXml(bytes, maximum);
    return createLocalScoreSnapshot({
      sourcePath,
      sourceSize: bytes.length,
      fileFingerprint,
      format: "musicxml",
      container: "mxl",
    }, extracted);
  }
  return createLocalScoreSnapshot({
    format: detectScoreFormat(sourcePath, bytes),
    sourcePath,
    sourceSize: bytes.length,
    fileFingerprint,
    container: "plain",
  }, bytes);
}

export function inspectScoreSnapshot(
  snapshot: LocalScoreSnapshot,
  conversionOptions: Pick<
    ScoreConversionOptions,
    "quarterBlicks" | "onsetBlickOffset"
  > = {},
): LocalScoreInspection {
  const state = snapshotState(snapshot);
  const inspection =
    snapshot.format === "midi"
      ? inspectMidi(state.bytes, conversionOptions)
      : inspectMusicXml(
          decodeXmlBytes(state.bytes, "MusicXML score"),
          conversionOptions,
        );
  return {
    ...inspection,
    sourcePath: snapshot.sourcePath,
    fileFingerprint: snapshot.fileFingerprint,
    sourceSize: snapshot.sourceSize,
    container: snapshot.container,
  };
}

export async function inspectLocalScore(
  filePath: string,
  readOptions: ScoreReadOptions = {},
  conversionOptions: Pick<
    ScoreConversionOptions,
    "quarterBlicks" | "onsetBlickOffset"
  > = {},
): Promise<LocalScoreInspection> {
  return inspectScoreSnapshot(
    await readLocalScoreSnapshot(filePath, readOptions),
    conversionOptions,
  );
}

export function importScoreSnapshotMonophonic(
  snapshot: LocalScoreSnapshot,
  selection: MusicXmlSelection | MidiSelection,
  expectedFileFingerprint: string,
  conversionOptions: ScoreConversionOptions = {},
): LocalScoreImportResult {
  const state = snapshotState(snapshot);
  if (expectedFileFingerprint !== state.fileFingerprint) {
    return fail(
      "SCORE_FILE_CHANGED",
      "Local score fingerprint differs from the inspected file snapshot.",
      {
        expectedFileFingerprint,
        actualFileFingerprint: state.fileFingerprint,
        sourcePath: snapshot.sourcePath,
      },
    );
  }
  let imported: ScoreImportResult;
  if (snapshot.format === "midi") {
    if (!("trackIndex" in selection)) {
      return fail("INVALID_SCORE_SELECTION", "MIDI import requires a trackIndex selection.");
    }
    imported = importMidiMonophonic(state.bytes, selection, conversionOptions);
  } else {
    if ("trackIndex" in selection) {
      return fail(
        "INVALID_SCORE_SELECTION",
        "MusicXML import requires a part selection, not trackIndex.",
      );
    }
    imported = importMusicXmlMonophonic(
      decodeXmlBytes(state.bytes, "MusicXML score"),
      selection,
      conversionOptions,
    );
  }
  return {
    ...imported,
    sourcePath: snapshot.sourcePath,
    fileFingerprint: snapshot.fileFingerprint,
    sourceSize: snapshot.sourceSize,
    container: snapshot.container,
  };
}

export async function importLocalScoreMonophonic(
  filePath: string,
  selection: MusicXmlSelection | MidiSelection,
  readOptions: ScoreImportReadOptions,
  conversionOptions: ScoreConversionOptions = {},
): Promise<LocalScoreImportResult> {
  const snapshot = await readLocalScoreSnapshot(filePath, readOptions);
  return importScoreSnapshotMonophonic(
    snapshot,
    selection,
    readOptions.expectedFileFingerprint,
    conversionOptions,
  );
}
