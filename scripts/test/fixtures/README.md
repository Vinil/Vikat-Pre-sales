# Test fixtures

Real `.pptx` and `.docx` files, generated with `python-pptx` and `python-docx`
rather than hand-written OOXML. Hand-written fixtures tend to test the fixture
rather than the parser: they omit the namespace noise, style attributes and
relationship parts that real Office output carries, which is exactly where
extraction breaks.

Regenerate with `python3 scripts/test/fixtures/make.py`
(needs `pip install python-pptx python-docx`).

- `battlecard.pptx` — three slides, two with speaker notes, one without.
- `deployment.docx` — three heading-delimited sections, one containing XML
  entities (`<`, `&`) to prove they are decoded rather than passed through.
