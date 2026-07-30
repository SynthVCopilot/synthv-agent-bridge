import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  importLocalScoreMonophonic,
  importMidiMonophonic,
  importMusicXmlMonophonic,
  importScoreSnapshotMonophonic,
  inspectLocalScore,
  inspectMidi,
  inspectMusicXml,
  readLocalScoreSnapshot,
  ScoreImportError,
  SYNTHV_QUARTER_BLICKS,
  type LocalScoreSnapshot,
} from "../src/score-import.js";

const quarter = SYNTHV_QUARTER_BLICKS;

const leadMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Parser Test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Lead</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <transpose><chromatic>-2</chromatic></transpose>
      </attributes>
      <direction><sound tempo="100"/></direction>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><tie type="start"/>
        <lyric><text>Hel</text></lyric>
      </note>
    </measure>
    <measure number="2">
      <attributes><divisions>8</divisions></attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>8</duration><voice>1</voice><tie type="stop"/>
      </note>
      <direction><sound tempo="120"/></direction>
      <note><rest/><duration>4</duration><voice>1</voice></note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>8</duration><voice>1</voice>
        <lyric><text>lo</text></lyric>
      </note>
    </measure>
  </part>
</score-partwise>`;

const polyphonicMusicXml = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Two voices</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><staff>1</staff>
      </note>
      <backup><duration>4</duration></backup>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>4</duration><voice>2</voice><staff>1</staff>
      </note>
    </measure>
  </part>
</score-partwise>`;

function variableLength(value: number): number[] {
  const bytes = [value & 0x7f];
  let remaining = Math.floor(value / 128);
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  return bytes;
}

function uint16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function uint32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function littleUint16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function littleUint32(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 0 ? crc >>> 1 : 0xedb88320 ^ (crc >>> 1);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(
  entries: readonly { name: string; content: string; flags?: number }[],
): Uint8Array {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(content);
    const flags = 0x0800 | (entry.flags ?? 0);
    const crc = testCrc32(content);
    const local = Buffer.from([
      ...littleUint32(0x04034b50),
      ...littleUint16(20),
      ...littleUint16(flags),
      ...littleUint16(8),
      ...littleUint16(0),
      ...littleUint16(0),
      ...littleUint32(crc),
      ...littleUint32(compressed.length),
      ...littleUint32(content.length),
      ...littleUint16(name.length),
      ...littleUint16(0),
      ...name,
      ...compressed,
    ]);
    localChunks.push(local);
    centralChunks.push(
      Buffer.from([
        ...littleUint32(0x02014b50),
        ...littleUint16(20),
        ...littleUint16(20),
        ...littleUint16(flags),
        ...littleUint16(8),
        ...littleUint16(0),
        ...littleUint16(0),
        ...littleUint32(crc),
        ...littleUint32(compressed.length),
        ...littleUint32(content.length),
        ...littleUint16(name.length),
        ...littleUint16(0),
        ...littleUint16(0),
        ...littleUint16(0),
        ...littleUint16(0),
        ...littleUint32(0),
        ...littleUint32(localOffset),
        ...name,
      ]),
    );
    localOffset += local.length;
  }
  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.from([
    ...littleUint32(0x06054b50),
    ...littleUint16(0),
    ...littleUint16(0),
    ...littleUint16(entries.length),
    ...littleUint16(entries.length),
    ...littleUint32(centralDirectory.length),
    ...littleUint32(localOffset),
    ...littleUint16(0),
  ]);
  return Buffer.concat([...localChunks, centralDirectory, end]);
}

function midiFile(format: 0 | 1, division: number, tracks: readonly number[][]): Uint8Array {
  const bytes = [
    ...Buffer.from("MThd"),
    ...uint32(6),
    ...uint16(format),
    ...uint16(tracks.length),
    ...uint16(division),
  ];
  for (const track of tracks) {
    bytes.push(...Buffer.from("MTrk"), ...uint32(track.length), ...track);
  }
  return Uint8Array.from(bytes);
}

function meta(delta: number, type: number, data: readonly number[]): number[] {
  return [...variableLength(delta), 0xff, type, ...variableLength(data.length), ...data];
}

test("MusicXML inspection and import preserve rests, merge ties, apply transpose, and expose tempo", () => {
  const inspection = inspectMusicXml(leadMusicXml);
  assert.equal(inspection.title, "Parser Test");
  assert.equal(inspection.parts.length, 1);
  assert.deepEqual(inspection.parts[0], {
    partIndex: 1,
    partId: "P1",
    name: "Lead",
    noteCount: 2,
    durationQuarters: 3.5,
    pitchMinimum: 58,
    pitchMaximum: 62,
    hasOverlap: false,
    voices: [{ voice: "1", staffs: [1], noteCount: 2, hasOverlap: false }],
    tempoMap: [
      {
        position: 0,
        quarterPosition: 0,
        bpm: 100,
        inferred: false,
      },
      {
        position: quarter * 2,
        quarterPosition: 2,
        bpm: 120,
        inferred: false,
      },
    ],
    warnings: [],
  });

  const imported = importMusicXmlMonophonic(
    leadMusicXml,
    { partIndex: 1, partId: "P1", voice: "1" },
    { onsetBlickOffset: quarter },
  );
  assert.deepEqual(imported.notes, [
    { onset: quarter, duration: quarter * 2, pitch: 58, lyrics: "Hel" },
    { onset: quarter * 3.5, duration: quarter, pitch: 62, lyrics: "lo" },
  ]);
  assert.deepEqual(
    imported.preview.notes.map((note) => note.noteIndex),
    [1, 2],
  );
  assert.deepEqual(
    imported.tempoMap.map(({ position, bpm, inferred }) => ({ position, bpm, inferred })),
    [
      { position: quarter, bpm: 100, inferred: false },
      { position: quarter * 3, bpm: 120, inferred: false },
    ],
  );
});

test("MusicXML defaults to rejecting polyphony but supports explicit voice selection", () => {
  const inspection = inspectMusicXml(polyphonicMusicXml);
  assert.equal(inspection.parts[0]?.hasOverlap, true);
  assert.deepEqual(
    inspection.parts[0]?.voices.map((voice) => [voice.voice, voice.hasOverlap]),
    [
      ["1", false],
      ["2", false],
    ],
  );
  assert.throws(
    () => importMusicXmlMonophonic(polyphonicMusicXml, { partIndex: 1 }),
    (error: unknown) =>
      error instanceof ScoreImportError &&
      error.code === "POLYPHONIC_SOURCE" &&
      error.details?.["firstNoteIndex"] === 1 &&
      error.details?.["secondNoteIndex"] === 2,
  );
  assert.deepEqual(
    importMusicXmlMonophonic(polyphonicMusicXml, { partIndex: 1, voice: "2" }).notes,
    [{ onset: 0, duration: quarter, pitch: 64 }],
  );
});

test("MusicXML partId-only selection locates a non-first part and explicit transposition is checked", () => {
  const source = `<score-partwise>
    <part-list>
      <score-part id="P1"><part-name>First</part-name></score-part>
      <score-part id="P2"><part-name>Second</part-name></score-part>
    </part-list>
    <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
      <sound tempo="88"/>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration></note>
    </measure></part>
    <part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
    </measure></part>
  </score-partwise>`;
  const imported = importMusicXmlMonophonic(source, { partId: "P2" }, { transposeSemitones: 2 });
  assert.equal(imported.selection.partIndex, 2);
  assert.equal(imported.preview.transposeSemitones, 2);
  assert.deepEqual(imported.notes, [{ onset: 0, duration: quarter, pitch: 62 }]);
  assert.equal(imported.tempoMap[0]?.bpm, 88);
  assert.throws(
    () => importMusicXmlMonophonic(source, { partIndex: 1, partId: "P2" }),
    (error: unknown) =>
      error instanceof ScoreImportError && error.code === "INVALID_SCORE_SELECTION",
  );
});

test("MusicXML blick conversion rounds shared boundaries once and honors dotted metronome units", () => {
  const source = `<score-partwise>
    <part-list><score-part id="P1"><part-name>Sevenths</part-name></score-part></part-list>
    <part id="P1"><measure number="1">
      <attributes><divisions>7</divisions></attributes>
      <direction><direction-type><metronome>
        <beat-unit>eighth</beat-unit><beat-unit-dot/><per-minute>120</per-minute>
      </metronome></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note>
    </measure></part>
  </score-partwise>`;
  const imported = importMusicXmlMonophonic(source);
  assert.equal(
    (imported.notes[0]?.onset ?? 0) + (imported.notes[0]?.duration ?? 0),
    imported.notes[1]?.onset,
  );
  assert.equal(
    (imported.notes[1]?.onset ?? 0) + (imported.notes[1]?.duration ?? 0),
    imported.notes[2]?.onset,
  );
  assert.equal(imported.tempoMap[0]?.bpm, 90);
});

test("MusicXML cue notes advance time and standalone sound tempo is preserved", () => {
  const source = `<score-partwise>
    <part-list><score-part id="P1"><part-name>Cue</part-name></score-part></part-list>
    <part id="P1"><measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <sound tempo="90"/>
      <note><cue/><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note>
    </measure></part>
  </score-partwise>`;
  const inspection = inspectMusicXml(source);
  assert.equal(inspection.parts[0]?.durationQuarters, 2);
  assert.equal(inspection.parts[0]?.tempoMap[0]?.bpm, 90);
  assert.deepEqual(importMusicXmlMonophonic(source).notes, [
    { onset: quarter, duration: quarter, pitch: 62 },
  ]);
});

test("MusicXML rejects entity declarations instead of resolving local or remote resources", () => {
  assert.throws(
    () =>
      inspectMusicXml(
        `<!DOCTYPE score-partwise [<!ENTITY xxe SYSTEM "file:///secret">]>
         <score-partwise><part-list/><part id="P1">&xxe;</part></score-partwise>`,
      ),
    (error: unknown) => error instanceof ScoreImportError && error.code === "UNSAFE_XML",
  );
});

test("inspection permits large previews but every import rejects more than 512 notes", () => {
  const notes = Array.from(
    { length: 513 },
    () =>
      `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>`,
  ).join("");
  const source = `<score-partwise>
    <part-list><score-part id="P1"><part-name>Too many</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
      ${notes}
    </measure></part>
  </score-partwise>`;
  assert.equal(inspectMusicXml(source).parts[0]?.noteCount, 513);
  assert.throws(
    () => importMusicXmlMonophonic(source),
    (error: unknown) =>
      error instanceof ScoreImportError &&
      error.code === "SCORE_NOTE_LIMIT_EXCEEDED" &&
      error.details?.["maximum"] === 512,
  );
});

test("SMF format 1 parser handles running status, lyric events, and a global tempo map", () => {
  const tempoTrack = [
    ...meta(0, 0x51, [0x07, 0xa1, 0x20]),
    ...meta(480, 0x51, [0x03, 0xd0, 0x90]),
    ...meta(0, 0x2f, []),
  ];
  const leadTrack = [
    ...meta(0, 0x03, [...Buffer.from("Lead")]),
    ...meta(0, 0x51, [0x0f, 0x42, 0x40]),
    ...meta(0, 0x05, [...Buffer.from("la")]),
    0x00,
    0x90,
    60,
    100,
    ...variableLength(240),
    60,
    0,
    ...meta(0, 0x05, [...Buffer.from("di")]),
    0x00,
    0x90,
    62,
    100,
    ...variableLength(240),
    62,
    0,
    ...meta(0, 0x2f, []),
  ];
  const source = midiFile(1, 480, [tempoTrack, leadTrack]);
  const inspection = inspectMidi(source);
  assert.equal(inspection.smfFormat, 1);
  assert.equal(inspection.tracks[1]?.name, "Lead");
  assert.match(
    inspection.tracks[1]?.warnings[0] ?? "",
    /outside SMF format-1 tempo track 1/u,
  );
  assert.deepEqual(inspection.tracks[1]?.channels, [
    {
      channel: 1,
      noteCount: 2,
      pitchMinimum: 60,
      pitchMaximum: 62,
      hasOverlap: false,
    },
  ]);
  assert.deepEqual(
    inspection.tempoMap.map(({ position, bpm }) => [position, Math.round(bpm)]),
    [
      [0, 120],
      [quarter, 240],
    ],
  );

  const imported = importMidiMonophonic(source, { trackIndex: 2, channel: 1 });
  assert.deepEqual(imported.notes, [
    { onset: 0, duration: quarter / 2, pitch: 60, lyrics: "la" },
    { onset: quarter / 2, duration: quarter / 2, pitch: 62, lyrics: "di" },
  ]);
});

test("MIDI track/channel selection is 1-based and rejects overlap in the selected channel", () => {
  const events = [
    0x00,
    0x90,
    60,
    100,
    ...variableLength(240),
    64,
    100,
    ...variableLength(240),
    60,
    0,
    0x00,
    64,
    0,
    0x00,
    0x91,
    67,
    100,
    ...variableLength(480),
    67,
    0,
    ...meta(0, 0x2f, []),
  ];
  const source = midiFile(0, 480, [events]);
  assert.throws(
    () => importMidiMonophonic(source, { trackIndex: 1, channel: 1 }),
    (error: unknown) => error instanceof ScoreImportError && error.code === "POLYPHONIC_SOURCE",
  );
  assert.deepEqual(importMidiMonophonic(source, { trackIndex: 1, channel: 2 }).notes, [
    { onset: quarter, duration: quarter, pitch: 67 },
  ]);
  assert.throws(
    () => importMidiMonophonic(source, { trackIndex: 0 }),
    (error: unknown) =>
      error instanceof ScoreImportError && error.code === "INVALID_SCORE_SELECTION",
  );
});

test("MIDI lyrics are attached after channel selection instead of leaking to another channel", () => {
  const events = [
    ...meta(0, 0x05, [...Buffer.from("word")]),
    0x00,
    0x90,
    60,
    100,
    0x00,
    0x91,
    67,
    100,
    ...variableLength(480),
    0x81,
    67,
    0,
    0x00,
    0x80,
    60,
    0,
    ...meta(0, 0x2f, []),
  ];
  const source = midiFile(0, 480, [events]);
  assert.deepEqual(importMidiMonophonic(source, { trackIndex: 1, channel: 2 }).notes, [
    { onset: 0, duration: quarter, pitch: 67, lyrics: "word" },
  ]);
});

test("MIDI running status without a prior channel status is a structured parse error", () => {
  const source = midiFile(0, 480, [[0, 60, 100, ...meta(0, 0x2f, [])]]);
  assert.throws(
    () => inspectMidi(source),
    (error: unknown) => error instanceof ScoreImportError && error.code === "MALFORMED_MIDI",
  );
});

test("local file API detects score type, enforces limits, and never parses .svp", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synthv-score-import-"));
  try {
    const musicXmlPath = path.join(directory, "lead.musicxml");
    await writeFile(musicXmlPath, leadMusicXml, "utf8");
    const inspection = await inspectLocalScore(musicXmlPath);
    assert.equal(inspection.format, "musicxml");
    assert.match(inspection.fileFingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      (
        await importLocalScoreMonophonic(
          musicXmlPath,
          { partIndex: 1 },
          { expectedFileFingerprint: inspection.fileFingerprint },
          { defaultLyric: "la" },
        )
      ).preview.noteCount,
      2,
    );
    await assert.rejects(
      inspectLocalScore(musicXmlPath, { maxFileBytes: 32 }),
      (error: unknown) =>
        error instanceof ScoreImportError && error.code === "SCORE_FILE_TOO_LARGE",
    );
    await assert.rejects(
      inspectLocalScore(path.join(directory, "project.svp")),
      (error: unknown) => error instanceof ScoreImportError && error.code === "SVP_NOT_SUPPORTED",
    );
    await assert.rejects(
      inspectLocalScore("https://example.invalid/score.mid"),
      (error: unknown) => error instanceof ScoreImportError && error.code === "LOCAL_FILE_REQUIRED",
    );
    await assert.rejects(
      inspectLocalScore("relative.musicxml"),
      (error: unknown) =>
        error instanceof ScoreImportError && error.code === "LOCAL_FILE_REQUIRED",
    );
    const disguisedPath = path.join(directory, "disguised.txt");
    await writeFile(disguisedPath, leadMusicXml, "utf8");
    await assert.rejects(
      inspectLocalScore(disguisedPath),
      (error: unknown) =>
        error instanceof ScoreImportError && error.code === "UNSUPPORTED_SCORE_FORMAT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot imports reject structurally forged snapshot objects", () => {
  const forged = {
    sourcePath: "D:\\forged.musicxml",
    sourceSize: 1,
    fileFingerprint: "sha256:forged",
    format: "musicxml",
    container: "plain",
    bytes: new TextEncoder().encode(leadMusicXml),
  } as unknown as LocalScoreSnapshot;
  assert.throws(
    () =>
      importScoreSnapshotMonophonic(
        forged,
        { partIndex: 1 },
        "sha256:forged",
      ),
    (error: unknown) =>
      error instanceof ScoreImportError && error.code === "INVALID_SCORE_SNAPSHOT",
  );
});

test("local file API safely reads deflated .mxl through its container rootfile", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synthv-score-import-mxl-"));
  try {
    const container = `<?xml version="1.0"?>
      <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
          <rootfile full-path="scores/lead"
            media-type="application/vnd.recordare.musicxml+xml"/>
          <rootfile full-path="scores/not-the-primary-root.pdf"
            media-type="application/pdf"/>
        </rootfiles>
      </container>`;
    const archive = zipArchive([
      { name: "META-INF/container.xml", content: container },
      { name: "scores/lead", content: leadMusicXml },
    ]);
    const filePath = path.join(directory, "lead.mxl");
    await writeFile(filePath, archive);
    const inspection = await inspectLocalScore(filePath);
    assert.equal(inspection.format, "musicxml");
    assert.equal(inspection.parts[0]?.partId, "P1");
    const imported = await importLocalScoreMonophonic(
      filePath,
      { partId: "P1" },
      { expectedFileFingerprint: inspection.fileFingerprint },
      { transposeSemitones: 2 },
    );
    assert.deepEqual(imported.notes.map((note) => note.pitch), [60, 64]);

    const snapshot = await readLocalScoreSnapshot(filePath);
    assert.equal(snapshot.container, "mxl");
    await assert.rejects(
      importLocalScoreMonophonic(
        filePath,
        { partId: "P1" },
        { expectedFileFingerprint: `sha256:${"0".repeat(64)}` },
      ),
      (error: unknown) =>
        error instanceof ScoreImportError && error.code === "SCORE_FILE_CHANGED",
    );

    const encryptedPath = path.join(directory, "encrypted.mxl");
    await writeFile(
      encryptedPath,
      zipArchive([
        { name: "META-INF/container.xml", content: container, flags: 0x0001 },
        { name: "scores/lead", content: leadMusicXml },
      ]),
    );
    await assert.rejects(
      inspectLocalScore(encryptedPath),
      (error: unknown) =>
        error instanceof ScoreImportError &&
        error.code === "UNSUPPORTED_COMPRESSED_MUSICXML",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
