"""Document parsing + chunking for RAG ingest (apis/documents.py).

Pure functions, no DB/network access — easy to reason about independently
of the ingest endpoint's orchestration (storage, embedding, error
handling all live in apis/documents.py).
"""

import io

from docx import Document as DocxDocument
from pypdf import PdfReader


def parse_document(content: bytes, content_type: str, filename: str) -> str:
    """Extracts plain text from a PDF, DOCX, or plain-text/Markdown file.
    Raises ValueError for anything else — the caller should catch this and
    mark the Document row as an error rather than let it crash the
    request."""
    lower_name = filename.lower()

    if content_type == "application/pdf" or lower_name.endswith(".pdf"):
        reader = PdfReader(io.BytesIO(content))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)

    if (
        content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        or lower_name.endswith(".docx")
    ):
        doc = DocxDocument(io.BytesIO(content))
        return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())

    if content_type.startswith("text/") or lower_name.endswith((".md", ".txt")):
        return content.decode("utf-8", errors="replace")

    raise ValueError(f"Unsupported document type: {content_type} ({filename})")


def chunk_text(text: str, *, chunk_size: int = 800, overlap: int = 100) -> list[str]:
    """Splits text into overlapping chunks, breaking on paragraph
    boundaries where possible so a chunk doesn't cut a sentence in half
    more than it has to. `chunk_size`/`overlap` are character counts, not
    tokens — good enough for an MVP; a token-aware splitter would be more
    precise but isn't worth the extra dependency here.
    """
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return []

    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        if current and len(current) + len(para) + 2 > chunk_size:
            chunks.append(current)
            current = (current[-overlap:] + "\n\n" + para) if overlap else para
        else:
            current = f"{current}\n\n{para}" if current else para
    if current:
        chunks.append(current)

    # A single paragraph longer than chunk_size doesn't get split by the
    # loop above — hard-wrap anything still oversized so nothing blows
    # past the size embedding models are tuned for.
    final: list[str] = []
    for chunk in chunks:
        if len(chunk) <= chunk_size * 1.5:
            final.append(chunk)
            continue
        step = max(chunk_size - overlap, 1)
        for i in range(0, len(chunk), step):
            final.append(chunk[i : i + chunk_size])
    return final
