"""Synthetic-only ASR tests. Mock the expensive engines, retain file/hash/cache I/O."""
import hashlib
import io
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import transcribe as asr


def wav(channels=1, frames=16000):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((channels, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"".join(struct.pack("<h", 1000 * (channel + 1)) for channel in range(channels)) * frames)
    return output.getvalue()


def engine_result(text="Синтетическая расшифровка", start=0, end=900):
    return {"model": {"multilingual": True}, "params": {"translate": False, "language": "ru"},
            "transcription": [{"offsets": {"from": start, "to": end}, "text": text, "speaker": "customer"}]}


class TranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.model = self.root / "model.bin"
        self.model.write_bytes(b"synthetic-model")
        self.binary = self.root / "whisper-cli"
        self.binary.write_bytes(b"synthetic-engine")
        self.environment = patch.dict(os.environ, {
            "CRM_CONTROL_RECORDING_DIR": str(self.root),
            "CRM_CONTROL_WHISPER_MODEL_PATH": str(self.model),
            "CRM_CONTROL_WHISPER_MODEL_SHA256": hashlib.sha256(self.model.read_bytes()).hexdigest(),
            "CRM_CONTROL_WHISPER_CLI": str(self.binary),
        })
        self.environment.start()
        self.calls = []

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def request(self, channels=1):
        data = wav(channels)
        path = self.root / "recording.bin"
        path.write_bytes(data)
        return {"filePath": str(path), "sha256": hashlib.sha256(data).hexdigest(), "mimeType": "audio/wav"}

    def binding(self, digest):
        return {"status": "SERVER_VERIFIED_STEREO", "recordingSha256": digest, "proofId": "telephony-proof-1",
                "channels": [{"channel": 0, "role": "manager", "actorId": "manager-1"},
                             {"channel": 1, "role": "customer", "actorId": "contact-1"}]}

    def engine(self, executable, args, work, budget, **kwargs):
        self.calls.append((str(executable), list(args), kwargs))
        if executable == "ffprobe":
            with wave.open(args[-1], "rb") as audio:
                channels = audio.getnchannels()
            return json.dumps({"streams": [{"index": 0, "channels": channels, "sample_rate": "16000"}],
                               "format": {"duration": "1.000"}}).encode()
        if executable == "ffmpeg":
            shutil.copyfile(args[args.index("-i") + 1], args[-1])
            return b""
        with wave.open(args[args.index("-f") + 1], "rb") as audio:
            self.assertEqual(audio.getnchannels(), 1)
            first_sample = struct.unpack("<h", audio.readframes(1))[0]
        output = Path(args[args.index("-of") + 1] + ".json")
        output.write_text(json.dumps(engine_result("Синтетический канал " + str(first_sample))),
                          encoding="utf-8")
        return b""

    def execute(self, request):
        with patch.object(asr, "run_process", side_effect=self.engine):
            summary = asr.transcribe(request)
        value = json.loads(Path(summary["outputPath"]).read_text(encoding="utf-8"))
        self.assertEqual(summary["status"], "UNVERIFIED")
        self.assertNotIn("segments", summary)
        if os.name == "posix":
            self.assertEqual(Path(summary["outputPath"]).stat().st_mode & 0o777, 0o600)
        return summary, value

    def test_mono_never_gets_customer_label_from_model_output(self):
        summary, value = self.execute(self.request())
        self.assertTrue(summary["processingComplete"])
        self.assertFalse(summary["rolesVerified"])
        self.assertEqual(value["segments"][0]["actor"], {"role": "unknown", "actorId": None})
        self.assertEqual(value["segments"][0]["startMs"], 0)
        self.assertEqual(value["segments"][0]["endMs"], 900)
        self.assertEqual(value["segments"][0]["quality"], "ASR_UNVERIFIED")
        self.assertIn("SPEAKER_ROLES_UNKNOWN", value["problems"])
        self.assertIn("ASR_UNVERIFIED", value["problems"])

    def test_stereo_is_split_without_mixdown_and_without_guessed_roles(self):
        summary, value = self.execute(self.request(2))
        self.assertEqual([segment["channel"] for segment in value["segments"]], [0, 1])
        self.assertEqual([segment["text"] for segment in value["segments"]],
                         ["Синтетический канал 1000", "Синтетический канал 2000"])
        self.assertTrue(all(segment["actor"]["role"] == "unknown" for segment in value["segments"]))
        self.assertFalse(summary["rolesVerified"])

    def test_verified_metadata_can_attribute_exact_stereo_channels(self):
        request = self.request(2)
        request["channelMetadata"] = self.binding(request["sha256"])
        summary, value = self.execute(request)
        self.assertTrue(summary["rolesVerified"])
        self.assertEqual([segment["actor"]["role"] for segment in value["segments"]], ["manager", "customer"])
        self.assertEqual(value["channelBinding"]["proofId"], "telephony-proof-1")

    def test_metadata_binding_rejects_mono_wrong_hash_and_duplicate_channels(self):
        for variant in ("mono", "hash", "duplicate", "same-role"):
            request = self.request(1 if variant == "mono" else 2)
            request["channelMetadata"] = self.binding(request["sha256"])
            if variant == "hash":
                request["channelMetadata"]["recordingSha256"] = "0" * 64
            if variant == "duplicate":
                request["channelMetadata"]["channels"][1]["channel"] = 0
            if variant == "same-role":
                request["channelMetadata"]["channels"][1]["role"] = "manager"
            with patch.object(asr, "run_process", side_effect=self.engine):
                with self.assertRaises(asr.ExtractionError, msg=variant):
                    asr.transcribe(request)

    def test_cache_bound_to_recording_model_engine_and_channel_metadata(self):
        request = self.request(2)
        first, _ = self.execute(request)
        second, _ = self.execute(request)
        self.assertTrue(second["cacheHit"])
        self.assertEqual(first["outputPath"], second["outputPath"])
        request["channelMetadata"] = self.binding(request["sha256"])
        attributed, _ = self.execute(request)
        self.assertFalse(attributed["cacheHit"])
        self.assertNotEqual(attributed["outputPath"], first["outputPath"])
        self.model.write_bytes(b"another-model")
        os.environ["CRM_CONTROL_WHISPER_MODEL_SHA256"] = hashlib.sha256(self.model.read_bytes()).hexdigest()
        changed_model, _ = self.execute(request)
        self.assertFalse(changed_model["cacheHit"])
        self.binary.write_bytes(b"another-engine")
        changed_binary, _ = self.execute(request)
        self.assertFalse(changed_binary["cacheHit"])
        self.assertNotEqual(changed_model["outputPath"], changed_binary["outputPath"])

    def test_cache_checks_output_hash_and_recording_bytes(self):
        request = self.request()
        first, _ = self.execute(request)
        Path(first["outputPath"]).write_text("broken", encoding="utf-8")
        repaired, _ = self.execute(request)
        self.assertFalse(repaired["cacheHit"])
        Path(request["filePath"]).write_bytes(b"changed")
        with self.assertRaisesRegex(asr.ExtractionError, "HASH_MISMATCH"):
            self.execute(request)

    def test_wrong_model_hash_is_rejected_before_any_engine_call(self):
        request = self.request()
        os.environ["CRM_CONTROL_WHISPER_MODEL_SHA256"] = "0" * 64
        with self.assertRaisesRegex(asr.ExtractionError, "HASH_MISMATCH"):
            self.execute(request)
        self.assertEqual(self.calls, [])

    def test_model_changed_in_place_is_not_published_under_old_hash(self):
        request = self.request()
        def changed(executable, args, work, budget, **kwargs):
            result = self.engine(executable, args, work, budget, **kwargs)
            if "-m" in args:
                self.model.write_bytes(b"changed-model-in-place")
            return result
        with patch.object(asr, "run_process", side_effect=changed):
            with self.assertRaisesRegex(asr.ExtractionError, "MODEL_CHANGED_DURING_TRANSCRIPTION"):
                asr.transcribe(request)

    def test_binary_changed_in_place_is_not_published_under_old_hash(self):
        request = self.request()
        def changed(executable, args, work, budget, **kwargs):
            result = self.engine(executable, args, work, budget, **kwargs)
            if "-m" in args:
                self.binary.write_bytes(b"changed-engine-in-place")
            return result
        with patch.object(asr, "run_process", side_effect=changed):
            with self.assertRaisesRegex(asr.ExtractionError, "BINARY_CHANGED_DURING_TRANSCRIPTION"):
                asr.transcribe(request)
        self.assertEqual(list((self.root / ".transcribed").rglob("*.json")), [])

    def test_linux_executes_pinned_binary_and_model_descriptors(self):
        with patch.object(asr.sys, "platform", "linux"):
            self.execute(self.request())
        engine = next(call for call in self.calls if "-m" in call[1])
        model_reference = engine[1][engine[1].index("-m") + 1]
        self.assertTrue(engine[0].startswith("/proc/self/fd/"))
        self.assertTrue(model_reference.startswith("/proc/self/fd/"))
        self.assertEqual(set(engine[2]["pass_fds"]),
                         {int(engine[0].rsplit("/", 1)[1]), int(model_reference.rsplit("/", 1)[1])})

    def test_forced_safe_demuxer_blocks_network_playlist_input(self):
        request = self.request()
        data = b"#EXTM3U\nhttps://example.invalid/private-recording\n"
        Path(request["filePath"]).write_bytes(data)
        request["sha256"] = hashlib.sha256(data).hexdigest()
        with self.assertRaisesRegex(asr.ExtractionError, "UNSUPPORTED_AUDIO_FORMAT"):
            self.execute(request)
        self.assertEqual(self.calls, [])
        self.assertEqual(asr.input_arguments("mov"), ["-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0"])

    def test_outside_archive_and_url_cannot_be_used(self):
        request = self.request()
        request["filePath"] = str(self.root.parent / "recording.wav")
        with self.assertRaisesRegex(asr.ExtractionError, "OUTSIDE_RECORDING_ARCHIVE"):
            asr.request_source(request)
        request["filePath"] = "https://example.invalid/audio.wav"
        with self.assertRaisesRegex(asr.ExtractionError, "UNSAFE_PATH"):
            asr.request_source(request)

    def test_symlink_recording_is_rejected(self):
        request = self.request()
        link = self.root / "link.wav"
        try:
            link.symlink_to(request["filePath"])
        except OSError:
            self.skipTest("OS does not grant symbolic-link creation")
        request["filePath"] = str(link)
        with self.assertRaisesRegex(asr.ExtractionError, "UNSAFE_PATH"):
            asr.request_source(request)

    def test_oversized_recording_duration_and_stereo_streams_rejected(self):
        request = self.request()
        with patch.object(asr, "MAX_RECORDING", 16):
            with self.assertRaisesRegex(asr.ExtractionError, "FILE_LIMIT"):
                self.execute(request)
        for document, code in [
            ({"streams": [{"index": 0, "channels": 2}], "format": {"duration": "1800.01"}}, "AUDIO_DURATION_LIMIT"),
            ({"streams": [{"index": 0, "channels": 3}]}, "UNSUPPORTED_AUDIO_CHANNELS"),
            ({"streams": [{"index": 0, "channels": 1}, {"index": 1, "channels": 1}]}, "UNSUPPORTED_AUDIO_STREAMS"),
        ]:
            with patch.object(asr, "run_process", return_value=json.dumps(document).encode()):
                with self.assertRaisesRegex(asr.ExtractionError, code):
                    asr.transcribe(request)

    def test_invalid_timestamps_and_non_russian_or_translated_output_rejected(self):
        for start, end in [(-1, 100), (100, 90), (0, 1001), (True, 10), (0, 0)]:
            with self.assertRaisesRegex(asr.ExtractionError, "INVALID_SEGMENT"):
                asr.normalize_segments(engine_result(start=start, end=end), 0, 1000, None, asr.Budget())
        for section, key, value in [("params", "translate", True), ("params", "language", "en"), ("model", "multilingual", False)]:
            document = engine_result()
            document[section][key] = value
            with self.assertRaisesRegex(asr.ExtractionError, "INVALID_WHISPER_OUTPUT"):
                asr.normalize_segments(document, 0, 1000, None, asr.Budget())

    def test_invalid_later_channel_preserves_partial_result_but_never_caches_it(self):
        request = self.request(2)
        def broken(executable, args, work, budget, **kwargs):
            if "-m" in args and "channel-1.wav" in args[args.index("-f") + 1]:
                raise asr.ExtractionError("TIME_LIMIT")
            return self.engine(executable, args, work, budget, **kwargs)
        with patch.object(asr, "run_process", side_effect=broken):
            summary = asr.transcribe(request)
        value = json.loads(Path(summary["outputPath"]).read_text(encoding="utf-8"))
        self.assertFalse(summary["processingComplete"])
        self.assertEqual(len(value["segments"]), 1)
        self.assertIn("TIME_LIMIT", summary["problems"])
        self.assertFalse(Path(summary["outputPath"]).with_name(value["cacheKey"] + ".cache.json").exists())

    def test_empty_transcript_does_not_claim_complete_conversation_or_known_speakers(self):
        document = engine_result()
        document["transcription"] = []
        self.assertEqual(asr.normalize_segments(document, 0, 1000, None, asr.Budget()), [])

    def test_process_deadline_stops_the_child(self):
        with self.assertRaisesRegex(asr.ExtractionError, "TIME_LIMIT"):
            asr.run_process(sys.executable, ["-c", "import time; time.sleep(10)"], self.root, asr.Budget(0.2))

    @unittest.skipUnless(os.name == "posix", "POSIX process-group cleanup")
    def test_term_handler_kills_the_active_child_before_cli_exits(self):
        marker = self.root / "synthetic-child.pid"
        child_code = "import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
        for module in ("transcribe", "extract"):
            marker.unlink(missing_ok=True)
            invocation = ("module.run_process(sys.executable, ['-c', child_code, marker], work, module.Budget(10))"
                          if module == "transcribe" else
                          "module.run_tool(sys.executable, ['-c', child_code, marker], work, module.Budget(10))")
            code = ("import sys\nfrom pathlib import Path\nimport " + module + " as module\n"
                    "module.apply_limits()\nwork=Path(sys.argv[1]); marker=sys.argv[2]; child_code=sys.argv[3]\n"
                    "try:\n " + invocation + "\nexcept module.ExtractionError as error:\n print(str(error))\n")
            process = subprocess.Popen([sys.executable, "-B", "-c", code, str(self.root), str(marker), child_code],
                cwd=Path(asr.__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(marker.exists())
                child_pid = int(marker.read_text())
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(stdout.strip(), b"PROCESS_CANCELLED")
                self.assertEqual(stderr, b"")
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()

    def test_cli_errors_are_sanitized_and_never_include_request_text(self):
        process = subprocess.run([sys.executable, "-B", str(Path(asr.__file__))],
            input=b'{"secret":"private-client"}', capture_output=True, env=os.environ.copy(), timeout=5)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(process.stdout)["errorCode"], "INVALID_REQUEST")
        self.assertNotIn(b"private-client", process.stdout + process.stderr)
        self.assertEqual(process.stderr, b"")


if __name__ == "__main__":
    unittest.main()
