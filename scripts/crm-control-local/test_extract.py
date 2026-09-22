"""Synthetic-only tests: no CRM files, network, or server access."""
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("local_extract", Path(__file__).with_name("extract.py"))
extractor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extractor)

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
CANARY = "Синтетический клиент: КП 125000 рублей"


def package(parts):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in parts.items():
            archive.writestr(name, value.encode() if isinstance(value, str) else value)
    return stream.getvalue()


def docx(body, extra=None):
    parts = {"word/document.xml": '<w:document xmlns:w="' + W + '" xmlns:r="' + R
             + '"><w:body>' + body + '</w:body></w:document>'}
    parts.update(extra or {})
    return package(parts)


def xlsx(cells, dimension="A1:D2", extra=None):
    parts = {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="' + extractor.MIMES["xlsx"] + '.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '</Types>',
        "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="' + R + '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<workbook xmlns="' + S + '" xmlns:r="' + R + '">'
            '<sheets><sheet name="Предложение" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="' + R + '/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": '<worksheet xmlns="' + S + '"><dimension ref="' + dimension + '"/>'
            '<sheetData>' + cells + '</sheetData></worksheet>',
    }
    # Correct the workbook package content type (not the outer document MIME).
    parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(
        extractor.MIMES["xlsx"] + ".main+xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")
    parts.update(extra or {})
    return package(parts)


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.environment = patch.dict(os.environ, {"CRM_CONTROL_DOCUMENT_DIR": str(self.root)})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def request(self, data, kind="docx", name="source.bin"):
        source = self.root / name
        source.write_bytes(data)
        return {"filePath": str(source), "sha256": hashlib.sha256(data).hexdigest(),
                "mimeType": extractor.MIMES.get(kind)}

    def read(self, summary):
        self.assertTrue(summary["ok"])
        self.assertNotIn("units", summary)
        output = Path(summary["outputPath"])
        self.assertTrue(output.is_relative_to(self.root / ".extracted"))
        if os.name == "posix":
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.parent.stat().st_mode & 0o777, 0o700)
        return json.loads(output.read_text(encoding="utf-8"))

    def test_docx_nested_tables_order_and_exact_locations(self):
        body = ('<w:p><w:r><w:t>' + CANARY + '</w:t></w:r></w:p>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Стоимость</w:t></w:r></w:p>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>125000</w:t></w:r></w:p>'
                '</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>')
        summary = extractor.extract(self.request(docx(body)))
        value = self.read(summary)
        self.assertEqual(summary["status"], "COMPLETE")
        self.assertEqual([unit["text"] for unit in value["units"]], [CANARY, "Стоимость", "125000"])
        self.assertIn("/tbl[1]/tr[1]/tc[1]/tbl[1]/tr[1]/tc[1]/p[1]",
                      value["units"][-1]["locator"]["path"])

    def test_docx_resolves_used_header_does_not_read_orphan_header(self):
        body = '<w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr><w:headerReference r:id="h1"/></w:sectPr>'
        relationships = '<Relationships><Relationship Id="h1" Type="' + R + '/header" Target="header1.xml"/></Relationships>'
        extra = {"word/_rels/document.xml.rels": relationships,
                 "word/header1.xml": '<w:hdr xmlns:w="' + W + '"><w:p><w:r><w:t>Used</w:t></w:r></w:p></w:hdr>',
                 "word/header2.xml": '<w:hdr xmlns:w="' + W + '"><w:p><w:r><w:t>Orphan</w:t></w:r></w:p></w:hdr>'}
        value = self.read(extractor.extract(self.request(docx(body, extra))))
        self.assertEqual([unit["text"] for unit in value["units"]], ["Body", "Used"])

    def test_tracked_changes_and_images_are_not_complete(self):
        body = '<w:p><w:r><w:t>Current</w:t><w:drawing/></w:r><w:del><w:r><w:t>Deleted</w:t></w:r></w:del></w:p>'
        value = self.read(extractor.extract(self.request(docx(body))))
        self.assertEqual(value["status"], "UNVERIFIED")
        self.assertIn("DOCX_UNSUPPORTED_CONTENT", value["problems"])
        self.assertIn("DOCX_TRACKED_CHANGES", value["problems"])
        self.assertEqual(value["units"][0]["text"], "Current")

    def test_docx_xml_entities_rejected_without_expanding_or_reading_paths(self):
        xml = '<!DOCTYPE a [<!ENTITY leak SYSTEM "file:///secrets">]><w:document xmlns:w="' + W + '">&leak;</w:document>'
        value = self.read(extractor.extract(self.request(package({"word/document.xml": xml}))))
        self.assertEqual(value["status"], "UNVERIFIED")
        self.assertIn("UNSAFE_XML", value["problems"])
        self.assertEqual(value["units"], [])

    def test_text_bound_marks_partial_and_does_not_silently_cache(self):
        request = self.request(docx('<w:p><w:r><w:t>' + CANARY + '</w:t></w:r></w:p>'))
        with patch.object(extractor, "MAX_TEXT", 8):
            summary = extractor.extract(request)
        value = self.read(summary)
        self.assertEqual(value["textChars"], 8)
        self.assertFalse(value["units"][0]["complete"])
        self.assertIn("TEXT_LIMIT", value["problems"])
        self.assertFalse(Path(summary["outputPath"]).with_name(request["sha256"] + ".cache.json").exists())

    def test_path_escape_hash_mismatch_and_invalid_request(self):
        request = self.request(docx("<w:p/>"))
        request["filePath"] = str(self.root.parent / "outside.bin")
        with self.assertRaisesRegex(extractor.ExtractionError, "OUTSIDE_ARCHIVE"):
            extractor.extract(request)
        request = self.request(docx("<w:p/>"))
        request["sha256"] = "0" * 64
        with self.assertRaisesRegex(extractor.ExtractionError, "HASH_MISMATCH"):
            extractor.extract(request)
        with self.assertRaisesRegex(extractor.ExtractionError, "INVALID_REQUEST"):
            extractor.extract({**request, "url": "https://example.test"})

    def test_symlink_is_rejected(self):
        request = self.request(docx("<w:p/>"))
        link = self.root / "link.bin"
        try:
            link.symlink_to(request["filePath"])
        except OSError:
            self.skipTest("OS does not grant symbolic-link creation")
        request["filePath"] = str(link)
        with self.assertRaisesRegex(extractor.ExtractionError, "UNSAFE_PATH"):
            extractor.extract(request)

    def test_zip_expansion_and_duplicate_entries_are_rejected(self):
        data = package({"word/document.xml": b"x" * (2 * 1024 * 1024)})
        with self.assertRaisesRegex(extractor.ExtractionError, "ZIP_LIMIT"):
            extractor.extract(self.request(data))
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("word/document.xml", "<x/>")
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                archive.writestr("word/document.xml", "<y/>")
        with self.assertRaisesRegex(extractor.ExtractionError, "ZIP_LIMIT"):
            extractor.extract(self.request(stream.getvalue()))

    def test_complete_cache_rechecks_source_hash_and_cached_result_hash(self):
        request = self.request(docx('<w:p><w:r><w:t>Original</w:t></w:r></w:p>'))
        first = extractor.extract(request)
        second = extractor.extract(request)
        self.assertTrue(second["cacheHit"])
        self.assertEqual(first["outputPath"], second["outputPath"])
        Path(first["outputPath"]).write_text("corrupt", encoding="utf-8")
        third = extractor.extract(request)
        self.assertFalse(third["cacheHit"])
        self.assertEqual(self.read(third)["units"][0]["text"], "Original")
        Path(request["filePath"]).write_bytes(b"changed")
        with self.assertRaisesRegex(extractor.ExtractionError, "HASH_MISMATCH"):
            extractor.extract(request)

    def test_mime_disagreement_cannot_reuse_complete_cache(self):
        request = self.request(docx('<w:p><w:r><w:t>Text</w:t></w:r></w:p>'))
        extractor.extract(request)
        request["mimeType"] = "application/pdf"
        summary = extractor.extract(request)
        self.assertFalse(summary["cacheHit"])
        self.assertIn("MIME_MISMATCH", summary["problems"])

    def test_unsupported_is_unverified_with_private_output(self):
        summary = extractor.extract(self.request(b"unsupported bytes", "unknown"))
        value = self.read(summary)
        self.assertEqual(summary["status"], "UNVERIFIED")
        self.assertIn("UNSUPPORTED_FORMAT", value["problems"])

    def test_pdf_pages_native_bbox_and_ocr_only_empty_page(self):
        calls = []

        def tool(name, args, work, budget):
            calls.append((name, args))
            if name == "pdfinfo":
                return b"Pages: 2\n"
            if name == "pdfimages":
                return b"page num type\n2 0 image\n"
            if name == "pdftotext":
                page = int(args[args.index("-f") + 1])
                if page == 1:
                    return b'<html><page><flow><block><line xMin="1" yMin="2" xMax="30" yMax="12"><word>125000</word></line></block></flow></page></html>'
                return b"<html><page/></html>"
            if name == "pdftoppm":
                Path(args[-1] + ".png").write_bytes(b"synthetic")
                return b""
            if name == "tesseract":
                return b"level\tblock_num\tpar_num\tline_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t10\t20\t30\t10\t91\t250000\n"
            raise AssertionError(name)

        with patch.object(extractor, "run_tool", side_effect=tool):
            value = self.read(extractor.extract(self.request(b"%PDF-synthetic", "pdf")))
        self.assertEqual([unit["locator"]["page"] for unit in value["units"]], [1, 2])
        self.assertEqual(value["units"][0]["locator"]["bbox"], [1, 2, 30, 12])
        self.assertEqual([unit["method"] for unit in value["units"]], ["native", "ocr"])
        self.assertIn("OCR_UNVERIFIED", value["problems"])
        renders = [args for name, args in calls if name == "pdftoppm"]
        self.assertEqual(len(renders), 1)
        self.assertEqual(renders[0][renders[0].index("-f") + 1], "2")

    def test_pdf_page_limit_and_missing_binary_never_complete(self):
        def tool(name, args, work, budget):
            if name == "pdfimages":
                return b"page num type\n"
            return b"Pages: 200\n" if name == "pdfinfo" else b'<html><page><line xMin="1" yMin="2" xMax="3" yMax="4"><word>Text</word></line></page></html>'
        with patch.object(extractor, "run_tool", side_effect=tool), patch.object(extractor, "MAX_PAGES", 1):
            value = self.read(extractor.extract(self.request(b"%PDF-synthetic", "pdf")))
        self.assertIn("PAGE_LIMIT", value["problems"])
        self.assertEqual(len(value["units"]), 1)
        with patch.object(extractor.shutil, "which", return_value=None):
            value = self.read(extractor.extract(self.request(b"%PDF-synthetic", "pdf")))
        self.assertIn("DEPENDENCY_PDFINFO_MISSING", value["problems"])

    def test_mixed_pdf_retains_native_text_but_does_not_claim_image_coverage(self):
        def tool(name, args, work, budget):
            if name == "pdfinfo":
                return b"Pages: 1\n"
            if name == "pdfimages":
                return b"page num type\n1 0 image\n"
            if name == "pdftotext":
                return b'<html><page><line xMin="1" yMin="2" xMax="3" yMax="4"><word>Label</word></line></page></html>'
            self.fail("OCR must not run on a non-empty native text layer")
        with patch.object(extractor, "run_tool", side_effect=tool):
            value = self.read(extractor.extract(self.request(b"%PDF-synthetic", "pdf")))
        self.assertEqual(value["units"][0]["text"], "Label")
        self.assertIn("PDF_IMAGES_NOT_OCR", value["problems"])
        self.assertEqual(value["status"], "UNVERIFIED")

    def test_xlsx_two_passes_cached_formula_and_missing_cache(self):
        try:
            import openpyxl  # noqa: F401
        except ImportError:
            self.skipTest("openpyxl is not installed in this test runtime")
        data = xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>Итого</t></is></c>'
                    '<c r="B1"><v>125000</v></c><c r="C1"><f>B1*2</f><v>250000</v></c>'
                    '<c r="D1"><f>B1*3</f></c></row>')
        value = self.read(extractor.extract(self.request(data, "xlsx")))
        self.assertEqual([unit["locator"]["cell"] for unit in value["units"]], ["A1", "B1", "C1", "D1"])
        self.assertEqual(value["units"][2]["value"], 250000)
        self.assertEqual(value["units"][2]["formula"], "=B1*2")
        self.assertIsNone(value["units"][3]["value"])
        self.assertIn("XLSX_FORMULA_CACHE_MISSING", value["problems"])
        self.assertIn("XLSX_FORMULAS_NOT_RECALCULATED", value["problems"])

    def test_xlsx_untrusted_dimensions_and_cell_limit(self):
        try:
            import openpyxl  # noqa: F401
        except ImportError:
            self.skipTest("openpyxl is not installed in this test runtime")
        data = xlsx('<row r="1"><c r="B1"><v>125000</v></c></row>', dimension="A1:A1")
        request = self.request(data, "xlsx")
        value = self.read(extractor.extract(request))
        self.assertEqual(value["units"][0]["locator"]["cell"], "B1")
        # Separate input avoids deliberately reusing a complete cached result.
        request = self.request(data + b" ", "xlsx")
        with patch.object(extractor, "MAX_CELLS", 1):
            value = self.read(extractor.extract(request))
        self.assertIn("CELL_LIMIT", value["problems"])

    def test_deadline_and_tool_timeout_are_bounded(self):
        with self.assertRaisesRegex(extractor.ExtractionError, "TIME_LIMIT"):
            extractor.Budget(-1).remaining()
        with patch.object(extractor.shutil, "which", return_value=sys.executable):
            with self.assertRaisesRegex(extractor.ExtractionError, "TIME_LIMIT"):
                extractor.run_tool("python", ["-c", "import time; time.sleep(10)"],
                                   self.root, extractor.Budget(0.2))

    def test_cli_never_prints_customer_text_or_sensitive_exception(self):
        request = self.request(docx('<w:p><w:r><w:t>' + CANARY + '</w:t></w:r></w:p>'))
        process = subprocess.run([sys.executable, str(Path(extractor.__file__))],
                                 input=json.dumps(request).encode(), capture_output=True,
                                 env=os.environ.copy(), timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        response = json.loads(process.stdout)
        self.assertEqual(response["status"], "COMPLETE")
        self.assertNotIn(CANARY, process.stdout.decode())
        self.assertEqual(process.stderr, b"")
        process = subprocess.run([sys.executable, str(Path(extractor.__file__))],
                                 input=(b"secret-" * 4000), capture_output=True,
                                 env=os.environ.copy(), timeout=10)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(process.stdout)["errorCode"], "SIZE_LIMIT")
        self.assertNotIn(b"secret", process.stdout + process.stderr)

    def test_cli_suppresses_customer_controlled_parser_warnings(self):
        import warnings
        incoming = io.TextIOWrapper(io.BytesIO(b"{}"), encoding="utf-8")
        outgoing, errors = io.StringIO(), io.StringIO()

        def noisy_parser(_request):
            warnings.warn(CANARY)
            print(CANARY)
            raise extractor.ExtractionError("DOCUMENT_PARSE_FAILED")

        with patch.object(extractor, "apply_limits"), patch.object(extractor, "extract", side_effect=noisy_parser):
            with patch.object(sys, "stdin", incoming), patch.object(sys, "stdout", outgoing), patch.object(sys, "stderr", errors):
                self.assertEqual(extractor.main(), 1)
        self.assertEqual(json.loads(outgoing.getvalue())["errorCode"], "DOCUMENT_PARSE_FAILED")
        self.assertNotIn(CANARY, outgoing.getvalue() + errors.getvalue())


if __name__ == "__main__":
    unittest.main()
