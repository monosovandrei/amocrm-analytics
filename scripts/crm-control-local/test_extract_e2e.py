"""Run on the Linux host with Poppler, Tesseract rus+eng and openpyxl installed.

    python3 -B -m unittest discover -s scripts/crm-control-local -p test_extract_e2e.py -v

All files are generated synthetic fixtures inside a fresh temporary archive.
No production archive, CRM data, downloads or network requests are used.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

from test_extract import docx, xlsx, extractor


def pdf(objects):
    body = b"%PDF-1.4\n"
    offsets = []
    for index, value in enumerate(objects, 1):
        offsets.append(len(body))
        body += str(index).encode() + b" 0 obj\n" + value + b"\nendobj\n"
    position = len(body)
    body += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n0000000000 65535 f \n"
    body += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    return body + (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
                   f"startxref\n{position}\n%%EOF\n").encode()


def native_pdf():
    content = b"BT /F1 32 Tf 30 100 Td (TOTAL 125000 RUB) Tj ET"
    return pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
    ])


def image_pdf(ppm, mixed=False):
    match = re.match(rb"P6\s+(\d+)\s+(\d+)\s+255\s", ppm)
    if not match:
        raise AssertionError("Unexpected synthetic raster format")
    width, height = map(int, match.groups())
    pixels = ppm[match.end():]
    if len(pixels) != width * height * 3:
        raise AssertionError("Unexpected raster dimensions")
    content = b"q 600 0 0 200 0 0 cm /Im1 Do Q"
    if mixed:
        content += b" BT /F1 12 Tf 30 180 Td (HEADER) Tj ET"
    compressed = zlib.compress(pixels)
    return pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /XObject << /Im1 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>",
        (f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB "
         f"/BitsPerComponent 8 /Filter /FlateDecode /Length {len(compressed)} >>\nstream\n").encode()
        + compressed + b"\nendstream",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ])


class ExtractorEndToEnd(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="crm-extract-synthetic-")
        self.root = Path(self.temporary.name).resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def invoke(self, data, kind):
        digest = hashlib.sha256(data).hexdigest()
        source = self.root / (digest + ".bin")
        source.write_bytes(data)
        request = {"filePath": str(source), "sha256": digest, "mimeType": extractor.MIMES[kind]}
        environment = {**os.environ, "CRM_CONTROL_DOCUMENT_DIR": str(self.root), "PYTHONDONTWRITEBYTECODE": "1"}
        process = subprocess.run([sys.executable, str(Path(extractor.__file__))],
                                 input=json.dumps(request).encode(), capture_output=True,
                                 env=environment, timeout=135)
        self.assertEqual(process.returncode, 0, process.stdout.decode("utf-8", "replace"))
        self.assertEqual(process.stderr, b"")
        summary = json.loads(process.stdout)
        output = Path(summary["outputPath"])
        self.assertTrue(output.is_relative_to(self.root))
        if os.name == "posix":
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        return summary, json.loads(output.read_text(encoding="utf-8"))

    def require_pdf(self, ocr=False):
        names = ["pdfinfo", "pdfimages", "pdftotext"]
        if ocr:
            names += ["pdftoppm", "tesseract"]
        missing = [name for name in names if not shutil.which(name)]
        if missing:
            self.skipTest("Missing local tools: " + ", ".join(missing))

    def raster(self):
        source = self.root / "synthetic-render.pdf"
        source.write_bytes(native_pdf())
        target = self.root / "synthetic-render"
        subprocess.run(["pdftoppm", "-singlefile", "-r", "150", str(source), str(target)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        return target.with_suffix(".ppm").read_bytes()

    def test_native_pdf_real_poppler_and_cache(self):
        self.require_pdf()
        first, value = self.invoke(native_pdf(), "pdf")
        self.assertEqual(first["status"], "COMPLETE", first)
        self.assertIn("125000", " ".join(unit["text"] for unit in value["units"]))
        self.assertTrue(all(unit["locator"]["page"] == 1 and unit["locator"]["bbox"] for unit in value["units"]))
        second, _ = self.invoke(native_pdf(), "pdf")
        self.assertTrue(second["cacheHit"])
        self.assertEqual(first["outputPath"], second["outputPath"])

    def test_scanned_pdf_real_tesseract_retains_unverified_ocr(self):
        self.require_pdf(ocr=True)
        summary, value = self.invoke(image_pdf(self.raster()), "pdf")
        self.assertEqual(summary["status"], "UNVERIFIED")
        self.assertIn("OCR_UNVERIFIED", summary["problems"])
        self.assertIn("125000", " ".join(unit["text"] for unit in value["units"]))
        self.assertTrue(all(unit["method"] == "ocr" for unit in value["units"]))

    def test_mixed_pdf_does_not_silently_lose_image_text(self):
        self.require_pdf(ocr=True)
        summary, value = self.invoke(image_pdf(self.raster(), mixed=True), "pdf")
        self.assertIn("PDF_IMAGES_NOT_OCR", summary["problems"])
        self.assertEqual(summary["status"], "UNVERIFIED")
        self.assertTrue(all(unit["method"] == "native" for unit in value["units"]))
        self.assertIn("HEADER", " ".join(unit["text"] for unit in value["units"]))

    def test_docx_and_xlsx_use_native_parsers(self):
        summary, value = self.invoke(docx('<w:p><w:r><w:t>Итого 125000 RUB</w:t></w:r></w:p>'), "docx")
        self.assertEqual(summary["status"], "COMPLETE")
        self.assertEqual(value["units"][0]["text"], "Итого 125000 RUB")
        summary, value = self.invoke(xlsx('<row r="1"><c r="A1"><v>125000</v></c></row>'), "xlsx")
        self.assertEqual(summary["status"], "COMPLETE", summary)
        self.assertEqual(value["units"][0]["value"], 125000)

    def test_xlsx_formula_is_not_recalculated_or_presented_as_complete(self):
        summary, value = self.invoke(xlsx('<row r="1"><c r="A1"><f>100000+25000</f><v>125000</v></c></row>'), "xlsx")
        self.assertEqual(summary["status"], "UNVERIFIED")
        self.assertIn("XLSX_FORMULAS_NOT_RECALCULATED", summary["problems"])
        self.assertEqual(value["units"][0]["formula"], "=100000+25000")
        self.assertEqual(value["units"][0]["value"], 125000)


if __name__ == "__main__":
    unittest.main()
