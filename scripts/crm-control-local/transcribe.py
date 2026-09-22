#!/usr/bin/env python3
"""Offline, bounded whisper.cpp wrapper. stdout is metadata only.

Input channelMetadata is exclusively a server-owned telephony attestation.
Never expose this CLI contract directly as an end-user/API request.
Requires sibling extract.py, ffmpeg/ffprobe and a pinned local whisper-cli/model.
The deployed service must disable networking and serialize heavy local jobs.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import wave
from array import array
from decimal import Decimal, InvalidOperation
from pathlib import Path

from extract import Budget, ExtractionError, atomic_private, bounded_read, canonical_json, private_directory, stop_process

WRAPPER_VERSION = "local-asr-v1"
MAX_RECORDING = 100 * 1024 * 1024
MAX_MODEL = 1024 * 1024 * 1024
MAX_BINARY = 64 * 1024 * 1024
MAX_DURATION_MS = 30 * 60 * 1000
MAX_SEGMENTS = 10_000
MAX_TEXT = 200_000
MAX_JSON = 8 * 1024 * 1024
TIMEOUT_SECONDS = 900
MEMORY_BYTES = 2 * 1024 * 1024 * 1024
PCM_FILE_LIMIT = 128 * 1024 * 1024
HASH = re.compile(r"^[a-f0-9]{64}$")


def digest_valid(value):
    return isinstance(value, str) and bool(HASH.fullmatch(value))


def safe_absolute(value):
    if (not isinstance(value, str) or not value or len(value) > 4096
            or "\x00" in value or value.startswith(("//", "\\\\"))):
        raise ExtractionError("UNSAFE_PATH")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise ExtractionError("UNSAFE_PATH")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise ExtractionError("UNSAFE_PATH")
    return path


def request_source(request):
    if (not isinstance(request, dict)
            or not {"filePath", "sha256", "mimeType"}.issubset(request)
            or set(request) - {"filePath", "sha256", "mimeType", "channelMetadata"}
            or not digest_valid(request["sha256"])
            or (request["mimeType"] is not None
                and (not isinstance(request["mimeType"], str) or len(request["mimeType"]) > 256))):
        raise ExtractionError("INVALID_REQUEST")
    root = safe_absolute(os.environ.get("CRM_CONTROL_RECORDING_DIR", ""))
    source = safe_absolute(request["filePath"])
    if not root.is_dir() or not source.is_relative_to(root) or not source.is_file():
        raise ExtractionError("OUTSIDE_RECORDING_ARCHIVE")
    return root, source, request["sha256"]


@contextlib.contextmanager
def verified_file(path, expected, maximum, budget):
    """Keep the verified inode open. Linux whisper reads this inherited descriptor."""
    if not digest_valid(expected):
        raise ExtractionError("INVALID_EXPECTED_HASH")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise ExtractionError("FILE_LIMIT")
        digest, size = hashlib.sha256(), 0
        while True:
            budget.remaining()
            data = stream.read(1024 * 1024)
            if not data:
                break
            size += len(data)
            if size > maximum:
                raise ExtractionError("FILE_LIMIT")
            digest.update(data)
        after = os.fstat(stream.fileno())
        if (digest.hexdigest() != expected or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns):
            raise ExtractionError("HASH_MISMATCH")
        stream.seek(0)
        yield stream


def binary_fingerprint(path, budget):
    path = safe_absolute(str(path))
    if not path.is_file() or path.stat().st_size > MAX_BINARY:
        raise ExtractionError("INVALID_WHISPER_BINARY")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            budget.remaining()
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def run_process(executable, args, work, budget, *, pass_fds=(), watched_files=()):
    """No shell, no inherited credentials, bounded output and process-group cleanup."""
    resolved = str(executable) if Path(executable).is_absolute() else shutil.which(str(executable))
    if not resolved or not Path(resolved).is_file():
        raise ExtractionError("DEPENDENCY_MISSING")
    environment = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR") if key in os.environ}
    environment.update({"HOME": str(work), "TMPDIR": str(work), "TEMP": str(work),
                        "LC_ALL": "C", "LANG": "C", "OMP_NUM_THREADS": "2",
                        "OPENBLAS_NUM_THREADS": "1", "GGML_LOG_LEVEL": "0"})
    with tempfile.TemporaryFile(dir=work) as output:
        kwargs = {"pass_fds": pass_fds} if os.name == "posix" else {}
        process = subprocess.Popen([resolved, *args], cwd=work, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                                   start_new_session=os.name == "posix", **kwargs)
        try:
            while process.poll() is None:
                if os.fstat(output.fileno()).st_size > MAX_JSON:
                    raise ExtractionError("PROCESS_OUTPUT_LIMIT")
                for path, limit in watched_files:
                    if path.exists() and path.stat().st_size > limit:
                        raise ExtractionError("PROCESS_OUTPUT_LIMIT")
                try:
                    process.wait(timeout=min(0.1, budget.remaining()))
                except subprocess.TimeoutExpired:
                    pass
        except BaseException:
            stop_process(process)
            raise
        if process.returncode:
            raise ExtractionError("LOCAL_PROCESS_FAILED")
        output.seek(0)
        return bounded_read(output, MAX_JSON)


def audio_format(path):
    with path.open("rb") as stream:
        header = stream.read(64)
    if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        return "wav"
    if header.startswith(b"fLaC"):
        return "flac"
    if header.startswith(b"OggS"):
        return "ogg"
    if header[4:8] == b"ftyp":
        return "mov"
    if header.startswith((b"#!AMR\n", b"#!AMR-WB\n")):
        return "amr"
    if header.startswith(b"ID3"):
        return "mp3"
    if len(header) >= 2 and header[0] == 0xff and header[1] & 0xe0 == 0xe0:
        return "aac" if header[1] & 0x06 == 0 else "mp3"
    raise ExtractionError("UNSUPPORTED_AUDIO_FORMAT")


def input_arguments(kind):
    # Explicit demuxer disallows playlists/concat; protocol whitelist forbids
    # network even for a malicious file. MOV external data references stay off.
    args = ["-protocol_whitelist", "file,pipe", "-f", kind]
    if kind == "mov":
        args += ["-enable_drefs", "0"]
    return args


def inspect_audio(source, kind, work, budget):
    raw = run_process("ffprobe", ["-v", "error", *input_arguments(kind),
        "-select_streams", "a", "-show_entries", "stream=index,channels,sample_rate:format=duration",
        "-of", "json", str(source)], work, budget)
    info = json.loads(raw)
    streams = info.get("streams")
    if not isinstance(streams, list) or len(streams) != 1 or not isinstance(streams[0], dict):
        raise ExtractionError("UNSUPPORTED_AUDIO_STREAMS")
    stream = streams[0]
    channels, index = stream.get("channels"), stream.get("index")
    if type(channels) is not int or channels not in (1, 2) or type(index) is not int or index < 0:
        raise ExtractionError("UNSUPPORTED_AUDIO_CHANNELS")
    duration = info.get("format", {}).get("duration")
    if duration is not None:
        try:
            seconds = Decimal(duration)
            if not seconds.is_finite() or seconds < 0:
                raise ExtractionError("INVALID_AUDIO_DURATION")
            if seconds * 1000 > MAX_DURATION_MS:
                raise ExtractionError("AUDIO_DURATION_LIMIT")
        except (InvalidOperation, TypeError):
            raise ExtractionError("INVALID_AUDIO_DURATION") from None
    return channels, index


def channel_binding(metadata, channels, recording_hash):
    if metadata is None or metadata == {"status": "UNVERIFIED"}:
        return None
    if (not isinstance(metadata, dict) or set(metadata) != {"status", "recordingSha256", "proofId", "channels"}
            or metadata["status"] != "SERVER_VERIFIED_STEREO" or channels != 2
            or metadata["recordingSha256"] != recording_hash
            or not isinstance(metadata["proofId"], str) or not 1 <= len(metadata["proofId"].strip()) <= 256
            or not isinstance(metadata["channels"], list) or len(metadata["channels"]) != 2):
        raise ExtractionError("CHANNEL_BINDING_MISMATCH")
    roles = {}
    for item in metadata["channels"]:
        if (not isinstance(item, dict) or set(item) != {"channel", "role", "actorId"}
                or type(item["channel"]) is not int or item["channel"] not in (0, 1)
                or item["channel"] in roles or item["role"] not in ("manager", "customer")
                or not isinstance(item["actorId"], str) or not 1 <= len(item["actorId"].strip()) <= 256):
            raise ExtractionError("INVALID_CHANNEL_BINDING")
        roles[item["channel"]] = {"role": item["role"], "actorId": item["actorId"]}
    if {item["role"] for item in roles.values()} != {"manager", "customer"}:
        raise ExtractionError("INVALID_CHANNEL_BINDING")
    return {"recordingSha256": recording_hash, "proofId": metadata["proofId"],
            "channels": [{"channel": index, **roles[index]} for index in (0, 1)]}


def decode_audio(source, kind, channels, index, work, budget):
    target = work / "decoded.wav"
    run_process("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-threads", "1",
        *input_arguments(kind), "-i", str(source), "-map", "0:" + str(index),
        "-vn", "-sn", "-dn", "-ac", str(channels), "-ar", "16000", "-c:a", "pcm_s16le",
        "-threads", "1", "-t", str(Decimal(MAX_DURATION_MS + 100) / 1000), "-y", str(target)],
        work, budget, watched_files=((target, PCM_FILE_LIMIT),))
    with wave.open(str(target), "rb") as audio:
        if audio.getnchannels() != channels or audio.getframerate() != 16000 or audio.getsampwidth() != 2:
            raise ExtractionError("INVALID_DECODED_AUDIO")
        frames = audio.getnframes()
        if frames * 1000 > MAX_DURATION_MS * 16000:
            raise ExtractionError("AUDIO_DURATION_LIMIT")
        if not frames:
            raise ExtractionError("EMPTY_AUDIO")
    return target, (frames * 1000 + 15999) // 16000


def split_channel(source, channel, target, budget):
    with wave.open(str(source), "rb") as incoming, wave.open(str(target), "wb") as outgoing:
        channels = incoming.getnchannels()
        if channel >= channels:
            raise ExtractionError("INVALID_CHANNEL")
        outgoing.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        while True:
            budget.remaining()
            data = incoming.readframes(8192)
            if not data:
                break
            samples = array("h")
            samples.frombytes(data)
            outgoing.writeframesraw(samples[channel::channels].tobytes())


def normalize_segments(raw, channel, duration_ms, binding, budget):
    if (not isinstance(raw, dict) or not isinstance(raw.get("transcription"), list)
            or len(raw["transcription"]) > MAX_SEGMENTS
            or not isinstance(raw.get("params"), dict) or not isinstance(raw.get("model"), dict)
            or raw.get("params", {}).get("translate") is not False
            or raw.get("params", {}).get("language") != "ru"
            or raw.get("model", {}).get("multilingual") is not True):
        raise ExtractionError("INVALID_WHISPER_OUTPUT")
    role = binding["channels"][channel] if binding else {"role": "unknown", "actorId": None}
    segments, text_chars, previous_end = [], 0, 0
    for item in raw["transcription"]:
        budget.remaining()
        if not isinstance(item, dict) or not isinstance(item.get("offsets"), dict):
            raise ExtractionError("INVALID_WHISPER_OUTPUT")
        start, end, text = item["offsets"].get("from"), item["offsets"].get("to"), item.get("text")
        if (type(start) is not int or type(end) is not int or start < 0 or end < start
                or end > duration_ms or start < previous_end or not isinstance(text, str)
                or len(text) > 16_000):
            raise ExtractionError("INVALID_SEGMENT")
        previous_end = end
        text_chars += len(text)
        if text_chars > MAX_TEXT:
            raise ExtractionError("TRANSCRIPT_TEXT_LIMIT")
        if not text.strip():
            continue
        if start == end:
            raise ExtractionError("INVALID_SEGMENT")
        segments.append({"channel": channel, "startMs": start, "endMs": end,
                         "text": text, "textHash": hashlib.sha256(text.encode()).hexdigest(),
                         "actor": {"role": role["role"], "actorId": role["actorId"]},
                         "quality": "ASR_UNVERIFIED"})
    return segments


def cached(folder, key):
    index = folder / (key + ".cache.json")
    if index.is_symlink():
        raise ExtractionError("UNSAFE_PATH")
    try:
        with index.open("rb") as stream:
            fingerprint = json.loads(bounded_read(stream, 1024))["resultSha256"]
        if not digest_valid(fingerprint):
            return None
        path = folder / (key + "." + fingerprint + ".json")
        if path.is_symlink():
            raise ExtractionError("UNSAFE_PATH")
        with path.open("rb") as stream:
            data = bounded_read(stream, MAX_JSON)
        if hashlib.sha256(data).hexdigest() != fingerprint:
            return None
        value = json.loads(data)
        if value.get("cacheKey") == key and value.get("processingComplete") is True:
            return value, path
    except (OSError, KeyError, ValueError, TypeError):
        pass
    return None


def summary(value, path, cache_hit):
    return {"ok": True, "status": "UNVERIFIED", "wrapperVersion": WRAPPER_VERSION,
            "sha256": value["sourceSha256"], "modelSha256": value["modelSha256"],
            "outputPath": str(path), "durationMs": value["durationMs"],
            "segmentCount": len(value["segments"]), "processingComplete": value["processingComplete"],
            "rolesVerified": value["channelBinding"] is not None,
            "problems": value["problems"], "cacheHit": cache_hit}


def transcribe(request, budget=None):
    budget = budget or Budget(TIMEOUT_SECONDS)
    root, source, digest = request_source(request)
    model_path = safe_absolute(os.environ.get("CRM_CONTROL_WHISPER_MODEL_PATH", ""))
    model_hash = os.environ.get("CRM_CONTROL_WHISPER_MODEL_SHA256", "")
    binary = safe_absolute(os.environ.get("CRM_CONTROL_WHISPER_CLI", ""))
    binary_hash = binary_fingerprint(binary, budget)
    private_directory(root / ".transcribed")
    folder = root / ".transcribed" / WRAPPER_VERSION
    private_directory(folder)
    with verified_file(model_path, model_hash, MAX_MODEL, budget) as model, \
            verified_file(binary, binary_hash, MAX_BINARY, budget) as engine:
        model_stamp = os.fstat(model.fileno())
        binary_stamp = os.fstat(engine.fileno())
        with tempfile.TemporaryDirectory(prefix=".asr-", dir=folder) as temporary:
            work = Path(temporary)
            copy = work / "recording.bin"
            with verified_file(source, digest, MAX_RECORDING, budget) as incoming, copy.open("xb") as outgoing:
                while True:
                    budget.remaining()
                    data = incoming.read(1024 * 1024)
                    if not data:
                        break
                    outgoing.write(data)
            # The source could have been modified after its initial hash pass.
            with verified_file(copy, digest, MAX_RECORDING, budget):
                pass
            kind = audio_format(copy)
            channels, index = inspect_audio(copy, kind, work, budget)
            binding = channel_binding(request.get("channelMetadata"), channels, digest)
            key = hashlib.sha256(canonical_json({"recording": digest, "model": model_hash,
                "binary": binary_hash, "version": WRAPPER_VERSION, "channelBinding": binding})).hexdigest()
            existing = cached(folder, key)
            if existing:
                return summary(*existing, True)
            decoded, duration_ms = decode_audio(copy, kind, channels, index, work, budget)
            problems = ["ASR_UNVERIFIED"] + ([] if binding else ["SPEAKER_ROLES_UNKNOWN"])
            value = {"wrapperVersion": WRAPPER_VERSION, "cacheKey": key,
                     "sourceSha256": digest, "modelSha256": model_hash, "binarySha256": binary_hash,
                     "durationMs": duration_ms, "channelCount": channels, "channelBinding": binding,
                     "processingComplete": True, "status": "UNVERIFIED",
                     "problems": problems, "segments": []}
            model_reference = "/proc/self/fd/" + str(model.fileno()) if sys.platform.startswith("linux") else str(model_path)
            binary_reference = "/proc/self/fd/" + str(engine.fileno()) if sys.platform.startswith("linux") else str(binary)
            descriptors = (model.fileno(), engine.fileno()) if sys.platform.startswith("linux") else ()
            for channel in range(channels):
                mono, output = work / ("channel-" + str(channel) + ".wav"), work / "whisper.json"
                try:
                    model.seek(0)
                    split_channel(decoded, channel, mono, budget)
                    output.unlink(missing_ok=True)
                    run_process(binary_reference, ["-m", model_reference, "-f", str(mono),
                        "-l", "ru", "-t", "2", "-p", "1", "-oj", "-of", str(work / "whisper"),
                        "-np", "-ng", "-nf", "-sns"], work, budget,
                        pass_fds=descriptors, watched_files=((output, MAX_JSON),))
                    with output.open("rb") as stream:
                        parsed = json.loads(bounded_read(stream, MAX_JSON))
                    segments = normalize_segments(parsed, channel, duration_ms, binding, budget)
                    if (len(value["segments"]) + len(segments) > MAX_SEGMENTS
                            or sum(len(item["text"]) for item in value["segments"] + segments) > MAX_TEXT):
                        raise ExtractionError("TRANSCRIPT_TEXT_LIMIT")
                    value["segments"].extend(segments)
                except ExtractionError as error:
                    value["processingComplete"] = False
                    problems.append(str(error))
                    break
                except Exception:
                    value["processingComplete"] = False
                    problems.append("TRANSCRIPTION_FAILED")
                    break
                finally:
                    mono.unlink(missing_ok=True)
            if not value["segments"]:
                problems.append("NO_SPEECH_TEXT")
            # Keep channel-specific overlapping turns; do not guess who spoke first.
            value["segments"].sort(key=lambda item: (item["startMs"], item["channel"], item["endMs"]))
            value["problems"] = list(dict.fromkeys(problems))
            model_after = os.fstat(model.fileno())
            if (model_stamp.st_size != model_after.st_size
                    or model_stamp.st_mtime_ns != model_after.st_mtime_ns):
                raise ExtractionError("MODEL_CHANGED_DURING_TRANSCRIPTION")
            binary_after = os.fstat(engine.fileno())
            if (binary_stamp.st_size != binary_after.st_size
                    or binary_stamp.st_mtime_ns != binary_after.st_mtime_ns):
                raise ExtractionError("BINARY_CHANGED_DURING_TRANSCRIPTION")
            if not sys.platform.startswith("linux"):
                # /proc FD execution is unavailable here. Refuse publication if
                # either configured path was replaced while the process ran.
                if binary_fingerprint(binary, budget) != binary_hash:
                    raise ExtractionError("BINARY_CHANGED_DURING_TRANSCRIPTION")
                with verified_file(model_path, model_hash, MAX_MODEL, budget):
                    pass
            data = canonical_json(value)
            if len(data) > MAX_JSON:
                raise ExtractionError("TRANSCRIPT_OUTPUT_LIMIT")
            fingerprint = hashlib.sha256(data).hexdigest()
            output = folder / (key + "." + fingerprint + ".json")
            atomic_private(output, data)
            if value["processingComplete"]:
                atomic_private(folder / (key + ".cache.json"), canonical_json({"resultSha256": fingerprint}))
            return summary(value, output, False)


def apply_limits():
    os.umask(0o077)
    if os.name != "posix":
        return
    import resource
    for key, limit in ((resource.RLIMIT_AS, MEMORY_BYTES), (resource.RLIMIT_CPU, TIMEOUT_SECONDS * 2),
                       (resource.RLIMIT_FSIZE, PCM_FILE_LIMIT), (resource.RLIMIT_NOFILE, 96)):
        _, hard = resource.getrlimit(key)
        resource.setrlimit(key, (min(limit, hard) if hard != resource.RLIM_INFINITY else limit, hard))
    def deadline(_signal, _frame):
        raise ExtractionError("TIME_LIMIT")
    signal.signal(signal.SIGALRM, deadline)
    def cancelled(_signal, _frame):
        raise ExtractionError("PROCESS_CANCELLED")
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    signal.alarm(TIMEOUT_SECONDS)


def main():
    try:
        apply_limits()
        request = json.loads(bounded_read(sys.stdin.buffer, 16 * 1024))
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            response = transcribe(request)
    except ExtractionError as error:
        response = {"ok": False, "status": "ERROR", "errorCode": str(error), "wrapperVersion": WRAPPER_VERSION}
    except MemoryError:
        response = {"ok": False, "status": "ERROR", "errorCode": "MEMORY_LIMIT", "wrapperVersion": WRAPPER_VERSION}
    except Exception:
        response = {"ok": False, "status": "ERROR", "errorCode": "TRANSCRIPTION_UNAVAILABLE", "wrapperVersion": WRAPPER_VERSION}
    if os.name == "posix":
        signal.alarm(0)
    sys.stdout.write(json.dumps(response, ensure_ascii=True, allow_nan=False) + "\n")
    return 0 if response["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
