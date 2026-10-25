"""Transcribe a Telegram voice note with faster-whisper; print the text to stdout.

Usage: python stt-faster-whisper.py <audio-file> [model] [language]
  model     tiny | base | small | medium | large-v3 (default: small)
  language  ISO code such as en or he; omit for auto-detect

Runs locally on the CPU (int8). The model downloads once to the Hugging Face
cache on first use. Telegram's .ogg/Opus is decoded by PyAV, so no ffmpeg is needed.
"""
import sys

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "small"
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio, language=language, vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    print(f"[{info.language}] {text}" if language is None else text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
