"""Phase 2 — one audio file per narration line, with REAL measured durations.

Durations come from ffprobe reading the written file, not from a word-count
estimate and not from the sample array length. The driver reads durations.json
and holds each beat for exactly that long.
"""
import json, subprocess, sys, pathlib
import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "audio"
OUT.mkdir(exist_ok=True)

script = json.loads((ROOT / "narration.json").read_text())
voice = script.get("voice", "af_heart")

kokoro = Kokoro("/tmp/kokoro-models/kokoro-v1.0.onnx", "/tmp/kokoro-models/voices-v1.0.bin")

def probe_seconds(path: pathlib.Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)

durations, total = {}, 0.0
for ln in script["lines"]:
    wav = OUT / f"{ln['id']}.wav"
    samples, rate = kokoro.create(ln["text"], voice=voice, speed=1.0, lang="en-us")
    sf.write(wav, samples, rate)
    secs = probe_seconds(wav)          # measured, not estimated
    durations[ln["id"]] = round(secs, 3)
    total += secs
    print(f"{ln['id']:<13} {secs:6.3f}s  {wav.name}")

(ROOT / "durations.json").write_text(json.dumps(durations, indent=2) + "\n")
print(f"\n{len(durations)} lines, total narration {total:.2f}s")
print("wrote", (ROOT / 'durations.json'))
