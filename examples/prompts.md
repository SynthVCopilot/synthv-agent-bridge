# Example prompts

Before a write operation, ask the agent to read the current state and describe the intended change.

## Guided demo

- `Run the Twinkle Star demo.`
- `运行《小星星》Demo。`

The Agent creates only its isolated Demo Group, prints a short heading for each
of the five stages, pauses once for Vocal and exact Vocal Mode onboarding, then
automatically tunes, verifies, and loops the example.

## Inspect

- Read the current SynthV project and summarize every track, group, voice, and note range.
- Read the current piano-roll selection and list the note indices, lyrics, pitches, and durations.
- Show the loudness and pitch-deviation automation points for the current group.
- Read the complete tempo and time-signature map, then convert quarter 32 to seconds.
- Read the current group's computed phonemes and sample its rendered pitch every eighth note.
- Read the current Group voice and list its base parameters, Vocal Modes, and any host-returned experimental Unison fields.
- Read the selected note's computed phonemes and phoneme attributes, then increase only its first consonant's strength after showing the planned edit.
- Read the current Group voice, then set the `Soft` Vocal Mode to 25 pitch, 40 timbre, and 15 pronunciation using the latest reference fingerprint.
- Confirm that the target is the current piano-roll Group before changing its `Twangy` Vocal Mode; reject the edit if the editor moved to another Group.
- Read the selected notes and change phoneme strength only if every target note remains selected.
- Hot-reload the installed SynthV Bridge, then ping the new session and confirm that its session token changed.

## Edit notes

- Read the selected notes. Extend the final note by half a quarter note, preserving every other field. Show the planned edit before applying it.
- Read track 1, group 1. Add a C-major arpeggio starting at quarter 8, with one eighth note per syllable: "la la la la".
- Read the current selection, then transpose it down three semitones. Use the returned fingerprints and make one reviewable edit call.
- Clone track 1 as `Harmony -3st` and transpose the clone down three semitones.
  Reject any pitch outside MIDI 0–127. If the source has non-main vocal Groups,
  stop unless I explicitly approve detaching their content and manually
  reviewing their Vocals.
- Create an empty Vocal template track from track 1 with `clone_track_shell`.
  Keep the host-cloned main Vocal context, remove all score content and non-main
  Groups, reset the mixer, and report that the API cannot name the Vocal.
- Read track 2, then rename it and enable it in the Render Panel using its latest track fingerprint.
- Read the selected notes and fit the supplied syllables one-to-one. Show a
  structured preview of the lyric count and do not store the complete lyrics
  in side-panel history.
- Humanize the selected phrase with deterministic onset and duration variation,
  preserving shared chord onsets and using the latest note fingerprints.

## Expression

- Read the selected phrase and its loudness automation. Add a gentle 3 dB crescendo across the phrase without replacing points outside the selected range.
- Reduce breathiness to -0.2 over the selected phrase, keeping the surrounding automation intact.
- Set the selected notes to English and manual pitch mode without changing their lyrics or timing.
- Read the current Smart Pitch controls, then add a short upward scoop before the first selected note using a curve control.
- Sample the tension curve every eighth note and simplify the selected range without changing its audible shape beyond a 0.002 threshold.
- Apply the vibrato expression preset to the selected notes after listing their
  fresh fingerprints.
- Preview a short falloff over the selected phrase, warning that existing pitch
  deviation points inside that range will be replaced.

## Harmony and transactions

- Read the lead track, then create a harmony a minor third below. Keep notes
  between MIDI 55 and 79 by octave displacement, set gain to -4 dB, pan to
  0.25, and preview the range policy before applying.
- Read tracks 1 and 2, then publish one side-panel transaction that renames
  track 1 and changes track 2 gain. Include structured before/after rows,
  preflight both fingerprints, and store guarded reverse steps.
- In one transaction, create a track and rename it using the earlier
  `add_track` result through `$result`. Explain that the independent work is
  preflighted first, the result-dependent step is checked just in time, and
  `atomicity: "singleUndoRecord"` is a one-Undo recovery boundary rather than
  automatic rollback.
- Inspect the latest transaction result and preview its rollback only if the
  stored transaction ID and current fingerprints still match.

## Groups and Retakes

- Create a reusable `Chorus` library group from these notes and place linked references at quarters 16 and 32.
- Deep-copy the selected Group reference to track 2 so later note edits do not affect the source.
- Read the selected Group's reference count. If it is shared, reject the note
  edit by default. Only after I explicitly confirm that every linked occurrence
  should change, use `allowAllReferences` with the fresh expected reference
  count.
- Generate a pitch-and-timbre Retake for the selected note, activate it, and return the generated Take ID.

## Local score import

- Inspect `D:\scores\melody.musicxml` locally without editing SynthV. List its
  1-based parts, voices, staffs, overlap status, SHA-256 guard, source tempo,
  and bounded note preview. Do not import until I confirm I have the right to
  use it.
- Inspect `D:\scores\lead.mid`, then import only the explicitly selected
  monophonic track/channel after rights confirmation. Reject a changed hash,
  polyphony, ambiguity, or more than 512 notes, and do not apply the MIDI tempo
  map to the SynthV project.

## Editor navigation

- Select notes 4–8 in the current piano-roll Group and return the selection
  SynthV actually reports, then focus the editor on their time range and return
  the resulting viewport.
- Read the arrangement viewport and snap quarter 12.3 using the editor's current grid settings.

## Playback

- Seek to the first selected note and play, then return SynthV's observed
  playback status and playhead rather than only echoing the request.
- Loop the selected phrase after converting its blick range to seconds from the project time axis.
