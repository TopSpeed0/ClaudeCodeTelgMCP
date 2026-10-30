"""Transcribe a Telegram voice note with faster-whisper; print the text to stdout.

Usage: python stt-faster-whisper.py <audio-file> [model] [language]
  model     tiny | base | small | medium | large-v3 | large-v3-turbo (default: small)
  language  ISO code such as en or he; omit for auto-detect

Runs locally on the CPU (int8). The model downloads once to the Hugging Face
cache on first use. Audio is decoded with ffmpeg when it is on PATH (robust
against PyAV API changes); otherwise faster-whisper's own PyAV decoder is used.

Mixed-language notes: Whisper picks one language per 30-second window, and
speech in another language then comes out translated into the first one.
When auto-detect sees a second language with real probability, every segment
is checked on its own and re-transcribed in its own language. That costs
roughly four times as long, so single-language notes skip it.

Progress goes to stderr as "@stt <stage> [args]" lines, read by the daemon
for its live bubble: model (loading), audio <seconds>, seg <end> <text>
(each segment as it is heard), mixed (re-checking languages).
"""
import os
import shutil
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000
# Hint words (names of your tools and systems) that Whisper should expect,
# passed by the daemon in STT_HOTWORDS; they help it spell jargon right.
HOTWORDS = os.environ.get("STT_HOTWORDS", "").strip() or None
MIXED_THRESHOLD = 0.02  # second-language probability that marks a note as mixed
MIN_SEGMENT_SECONDS = 1.0  # shorter clips are too short to detect a language reliably


def progress(*parts):
    print("@stt", *parts, file=sys.stderr, flush=True)


def load_audio(path):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return path
    pcm = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0


def transcribe_mixed(model, audio, segments, main_language):
    """Re-transcribe segments whose own language differs from the note's."""
    parts, languages = [], [main_language]
    for segment in segments:
        clip = audio[int(segment.start * SAMPLE_RATE):int(segment.end * SAMPLE_RATE)]
        text = segment.text.strip()
        if len(clip) >= MIN_SEGMENT_SECONDS * SAMPLE_RATE:
            language, probability, _ = model.detect_language(clip)
            if language != main_language and probability > 0.5:
                redo, _ = model.transcribe(clip, language=language, vad_filter=False, hotwords=HOTWORDS)
                text = " ".join(r.text.strip() for r in redo).strip() or text
                if language not in languages:
                    languages.append(language)
        parts.append(text)
    return " ".join(parts).strip(), languages


def main() -> int:
    # A piped stdout on Windows defaults to the ANSI code page, which cannot
    # encode Hebrew; the daemon reads UTF-8.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "small"
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    progress("model")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    audio = load_audio(sys.argv[1])
    heard, info = model.transcribe(audio, language=language, vad_filter=True, hotwords=HOTWORDS)
    progress("audio", f"{info.duration:.1f}")
    segments = []
    for segment in heard:  # a generator: each segment is decoded as it is pulled
        segments.append(segment)
        progress("seg", f"{segment.end:.1f}", " ".join(segment.text.split()))
    if language is not None:
        print(" ".join(s.text.strip() for s in segments).strip())
        return 0
    probabilities = info.all_language_probs or []
    mixed = len(probabilities) > 1 and probabilities[1][1] >= MIXED_THRESHOLD
    if mixed and isinstance(audio, np.ndarray):
        progress("mixed")
        text, languages = transcribe_mixed(model, audio, segments, info.language)
    else:
        text, languages = " ".join(s.text.strip() for s in segments).strip(), [info.language]
    print(f"[{'+'.join(languages)}] {text}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
