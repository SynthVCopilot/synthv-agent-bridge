# Example prompts

Before a write operation, ask the agent to read the current state and describe the intended change.

## Inspect

- Read the current SynthV project and summarize every track, group, voice, and note range.
- Read the current piano-roll selection and list the note indices, lyrics, pitches, and durations.
- Show the loudness and pitch-deviation automation points for the current group.
- Read the complete tempo and time-signature map, then convert quarter 32 to seconds.
- Read the current group's computed phonemes and sample its rendered pitch every eighth note.

## Edit notes

- Read the selected notes. Extend the final note by half a quarter note, preserving every other field. Show the planned edit before applying it.
- Read track 1, group 1. Add a C-major arpeggio starting at quarter 8, with one eighth note per syllable: "la la la la".
- Read the current selection, then transpose it down three semitones. Use the returned fingerprints and make one reviewable edit call.
- Clone track 1 as `Harmony -3st` and transpose the clone down three semitones. Preserve the source singer and reject the operation if any pitch would leave MIDI 0–127.
- Read track 2, then rename it and enable it in the Render Panel using its latest track fingerprint.

## Expression

- Read the selected phrase and its loudness automation. Add a gentle 3 dB crescendo across the phrase without replacing points outside the selected range.
- Reduce breathiness to -0.2 over the selected phrase, keeping the surrounding automation intact.
- Set the selected notes to English and manual pitch mode without changing their lyrics or timing.

## Playback

- Seek to the first selected note and play.
- Loop the selected phrase after converting its blick range to seconds from the project time axis.
