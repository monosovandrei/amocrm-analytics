"""Local whisper.cpp smoke test with generated silence; never uses customer audio."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import transcribe as asr


class TranscriptionEndToEnd(unittest.TestCase):
    def setUp(self):
        required = ("CRM_CONTROL_WHISPER_CLI", "CRM_CONTROL_WHISPER_MODEL_PATH", "CRM_CONTROL_WHISPER_MODEL_SHA256")
        missing = [key for key in required if not os.environ.get(key)]
        missing += [name for name in ("ffmpeg", "ffprobe") if not shutil.which(name)]
        if missing:
            self.skipTest("Local ASR is not configured: " + ", ".join(missing))
        self.temporary = tempfile.TemporaryDirectory(prefix="crm-asr-synthetic-")
        self.root = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)

    def request(self, channels):
        source = self.root / "silence.wav"
        with wave.open(str(source), "wb") as audio:
            audio.setparams((channels, 2, 16000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\x00\x00" * 16000 * 2 * channels)
        return {"filePath": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "mimeType": "audio/wav"}

    def invoke(self, request):
        environment = {**os.environ, "CRM_CONTROL_RECORDING_DIR": str(self.root), "PYTHONDONTWRITEBYTECODE": "1"}
        process = subprocess.run([sys.executable, "-B", str(Path(asr.__file__))],
            input=json.dumps(request).encode(), env=environment, capture_output=True, timeout=930)
        self.assertEqual(process.returncode, 0, process.stdout.decode("utf-8", "replace"))
        self.assertEqual(process.stderr, b"")
        summary = json.loads(process.stdout)
        self.assertEqual(summary["status"], "UNVERIFIED")
        self.assertTrue(summary["processingComplete"], summary)
        output = Path(summary["outputPath"])
        self.assertTrue(output.is_relative_to(self.root))
        if os.name == "posix":
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        return summary, json.loads(output.read_text(encoding="utf-8"))

    def test_mono_pipeline_cache_and_unknown_speakers(self):
        request = self.request(1)
        first, value = self.invoke(request)
        self.assertEqual(value["channelCount"], 1)
        self.assertEqual(value["durationMs"], 2000)
        self.assertFalse(first["rolesVerified"])
        self.assertTrue(all(item["actor"]["role"] == "unknown" for item in value["segments"]))
        second, _ = self.invoke(request)
        self.assertTrue(second["cacheHit"])
        self.assertEqual(first["outputPath"], second["outputPath"])

    def test_stereo_channels_remain_unattributed_without_server_metadata(self):
        summary, value = self.invoke(self.request(2))
        self.assertEqual(value["channelCount"], 2)
        self.assertFalse(summary["rolesVerified"])
        self.assertIsNone(value["channelBinding"])
        self.assertTrue(all(item["actor"]["role"] == "unknown" for item in value["segments"]))


if __name__ == "__main__":
    unittest.main()
