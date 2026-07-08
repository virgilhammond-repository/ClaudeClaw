#!/usr/bin/env python3
"""
RAG ingestion pipeline for ClaudeClaw knowledge base.

Usage:
  python3 rag/ingest.py                     # index everything (skips already-indexed files)
  python3 rag/ingest.py --books-only        # books only
  python3 rag/ingest.py --transcripts-only  # transcripts only
  python3 rag/ingest.py --add /path/to/file # add a single PDF or markdown file
  python3 rag/ingest.py --reset             # clear DB and re-index everything
  python3 rag/ingest.py --stats             # show current DB stats
"""

import os
import sys
import time
import hashlib
import argparse
from pathlib import Path

from dotenv import load_dotenv
import fitz  # pymupdf
import chromadb
from google import genai
from google.genai import types

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

_client = genai.Client(api_key=os.environ["GOOGLE_API_KEY_PAID"])

BOOKS_DIR = Path("/Volumes/Seagate/Business Books - PDF")
TRANSCRIPTS_DIR = Path("/Users/virgilhammond/Documents/Obsidian/ClaudeClaw/Research")
CHROMA_DIR = ROOT / "store" / "rag"
COLLECTION_NAME = "knowledge_base"

CHUNK_SIZE = 1200    # ~300 tokens
CHUNK_OVERLAP = 150
BATCH_SIZE = 50
EMBED_MODEL = "gemini-embedding-001"


def get_collection(reset=False):
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    if reset:
        try:
            client.delete_collection(COLLECTION_NAME)
            print("Collection cleared.")
        except Exception:
            pass
    return client.get_or_create_collection(
        COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"}
    )


def chunk_text(text):
    chunks = []
    start = 0
    text = text.strip()
    while start < len(text):
        end = start + CHUNK_SIZE
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end - CHUNK_OVERLAP
    return chunks


def file_chunk_id(file_path, chunk_idx):
    h = hashlib.md5(str(file_path).encode()).hexdigest()[:10]
    return f"{h}_{chunk_idx}"


def is_indexed(collection, file_path):
    try:
        result = collection.get(ids=[file_chunk_id(file_path, 0)])
        return len(result["ids"]) > 0
    except Exception:
        return False


def embed_texts(texts, retries=3):
    for attempt in range(retries):
        try:
            result = _client.models.embed_content(
                model=EMBED_MODEL,
                contents=texts,
                config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
            )
            return [e.values for e in result.embeddings]
        except Exception as e:
            if attempt < retries - 1:
                wait = 2 ** attempt * 2
                print(f"    Embed error ({e}), retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise


def upsert_chunks(collection, chunks, file_path, base_metadata):
    total = len(chunks)
    for b_start in range(0, total, BATCH_SIZE):
        batch = chunks[b_start:b_start + BATCH_SIZE]
        ids = [file_chunk_id(file_path, b_start + j) for j in range(len(batch))]
        embeddings = embed_texts(batch)
        metadatas = [
            {**base_metadata, "chunk_index": b_start + j, "total_chunks": total}
            for j in range(len(batch))
        ]
        collection.upsert(ids=ids, embeddings=embeddings, documents=batch, metadatas=metadatas)
        time.sleep(0.05)


def clean_book_title(filename):
    name = Path(filename).stem
    for suffix in ["-z-lib.org_", "z-lib.org_", "-z-lib.org", "z-lib.org"]:
        name = name.replace(suffix, "")
    name = name.replace("-", " ").replace("_", " ")
    # Collapse multiple spaces
    return " ".join(name.split())


def ingest_books(collection, force=False):
    if not BOOKS_DIR.exists():
        print(f"Books directory not found: {BOOKS_DIR}")
        return

    pdfs = sorted(BOOKS_DIR.rglob("*.pdf"))  # recursive: books are also filed in subfolders (e.g. Alex Hormozi/)
    print(f"\n-- Books: {len(pdfs)} PDFs --")
    indexed, skipped, errors = 0, 0, 0

    for i, pdf_path in enumerate(pdfs):
        if not force and is_indexed(collection, pdf_path):
            skipped += 1
            continue

        prefix = f"[{i+1}/{len(pdfs)}]"
        title = clean_book_title(pdf_path.name)
        print(f"  {prefix} {title[:65]}...")

        try:
            doc = fitz.open(str(pdf_path))
            text = "".join(page.get_text() for page in doc)
            doc.close()
        except Exception as e:
            print(f"    ERROR extracting PDF: {e}")
            errors += 1
            continue

        if len(text.strip()) < 200:
            print(f"    SKIP: no extractable text (scanned/image PDF)")
            skipped += 1
            continue

        chunks = chunk_text(text)
        try:
            upsert_chunks(collection, chunks, pdf_path, {
                "source_type": "book",
                "title": title[:200],
                "filename": pdf_path.name[:200],
            })
            indexed += len(chunks)
            print(f"    OK ({len(chunks)} chunks)")
        except Exception as e:
            print(f"    ERROR indexing: {e}")
            errors += 1

    print(f"\nBooks: {indexed} chunks indexed | {skipped} skipped | {errors} errors")


def strip_frontmatter(text):
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            return text[end + 3:].strip()
    return text


def ingest_transcripts(collection, force=False):
    if not TRANSCRIPTS_DIR.exists():
        print(f"Transcripts directory not found: {TRANSCRIPTS_DIR}")
        return

    mds = sorted(TRANSCRIPTS_DIR.rglob("*.md"))
    print(f"\n-- Transcripts: {len(mds)} markdown files --")
    indexed, skipped, errors = 0, 0, 0

    for i, md_path in enumerate(mds):
        if not force and is_indexed(collection, md_path):
            skipped += 1
            continue

        if i % 50 == 0 and i > 0:
            print(f"  Progress: {i}/{len(mds)} files | {indexed} chunks so far")

        try:
            text = strip_frontmatter(md_path.read_text(encoding="utf-8", errors="ignore"))
        except Exception as e:
            errors += 1
            continue

        if len(text.strip()) < 200:
            skipped += 1
            continue

        channel = md_path.parent.name
        title = md_path.stem[:200]
        chunks = chunk_text(text)

        try:
            upsert_chunks(collection, chunks, md_path, {
                "source_type": "transcript",
                "title": title,
                "channel": channel,
                "filename": md_path.name[:200],
            })
            indexed += len(chunks)
        except Exception as e:
            print(f"    ERROR {md_path.name}: {e}")
            errors += 1

    print(f"\nTranscripts: {indexed} chunks indexed | {skipped} skipped | {errors} errors")


def ingest_single(collection, file_path):
    path = Path(file_path).expanduser().resolve()
    if not path.exists():
        print(f"File not found: {path}")
        sys.exit(1)

    suffix = path.suffix.lower()

    if suffix == ".pdf":
        doc = fitz.open(str(path))
        text = "".join(page.get_text() for page in doc)
        doc.close()
        title = clean_book_title(path.name)
        metadata = {"source_type": "book", "title": title[:200], "filename": path.name[:200]}
    elif suffix == ".md":
        text = strip_frontmatter(path.read_text(encoding="utf-8", errors="ignore"))
        metadata = {
            "source_type": "transcript",
            "title": path.stem[:200],
            "channel": path.parent.name,
            "filename": path.name[:200],
        }
    else:
        print(f"Unsupported file type: {suffix} (use .pdf or .md)")
        sys.exit(1)

    chunks = chunk_text(text)
    print(f"Indexing {path.name} ({len(chunks)} chunks)...")
    upsert_chunks(collection, chunks, path, metadata)
    print(f"Done: {path.name} added to knowledge base.")


def show_stats(collection):
    total = collection.count()
    books = len(collection.get(where={"source_type": "book"}, include=[])["ids"])
    transcripts = len(collection.get(where={"source_type": "transcript"}, include=[])["ids"])
    print(f"Knowledge base stats:")
    print(f"  Total chunks : {total:,}")
    print(f"  Book chunks  : {books:,}")
    print(f"  Transcript   : {transcripts:,}")


def main():
    parser = argparse.ArgumentParser(description="Ingest knowledge into RAG database")
    parser.add_argument("--books-only", action="store_true")
    parser.add_argument("--transcripts-only", action="store_true")
    parser.add_argument("--add", metavar="FILE", help="Add a single PDF or markdown file")
    parser.add_argument("--reset", action="store_true", help="Clear DB and re-index everything")
    parser.add_argument("--stats", action="store_true", help="Show stats without indexing")
    args = parser.parse_args()

    collection = get_collection(reset=args.reset)

    if args.stats:
        show_stats(collection)
        return

    if args.add:
        ingest_single(collection, args.add)
        return

    if args.reset or not (args.books_only or args.transcripts_only):
        ingest_books(collection, force=args.reset)
        ingest_transcripts(collection, force=args.reset)
    elif args.books_only:
        ingest_books(collection, force=False)
    elif args.transcripts_only:
        ingest_transcripts(collection, force=False)

    show_stats(collection)


if __name__ == "__main__":
    main()
