#!/usr/bin/env python3
"""
Query the RAG knowledge base. Called by Otto.

Usage:
  python3 rag/query.py "how do I get my first 100 customers?"
  python3 rag/query.py --top 8 "pricing strategies"
  python3 rag/query.py --books "what does the lean startup say about MVPs?"
  python3 rag/query.py --transcripts "Hormozi advice on offers"
  python3 rag/query.py --stats
"""

import os
import sys
import argparse
from pathlib import Path

from dotenv import load_dotenv
import chromadb
from google import genai
from google.genai import types

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

_client = genai.Client(api_key=os.environ["GOOGLE_API_KEY_PAID"])

CHROMA_DIR = ROOT / "store" / "rag"
COLLECTION_NAME = "knowledge_base"
EMBED_MODEL = "gemini-embedding-001"


def get_collection():
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    return client.get_collection(COLLECTION_NAME)


def embed_query(text):
    result = _client.models.embed_content(
        model=EMBED_MODEL,
        contents=[text],
        config=types.EmbedContentConfig(task_type="RETRIEVAL_QUERY"),
    )
    return result.embeddings[0].values


def query(text, n=5, source_type=None):
    collection = get_collection()
    embedding = embed_query(text)

    kwargs = {
        "query_embeddings": [embedding],
        "n_results": min(n, collection.count()),
        "include": ["documents", "metadatas", "distances"],
    }
    if source_type:
        kwargs["where"] = {"source_type": source_type}

    return collection.query(**kwargs)


def format_results(results, snippet_len=600):
    docs = results["documents"][0]
    metas = results["metadatas"][0]
    distances = results["distances"][0]

    lines = []
    for i, (doc, meta, dist) in enumerate(zip(docs, metas, distances)):
        relevance = round((1 - dist) * 100, 1)
        stype = meta.get("source_type", "unknown")

        if stype == "book":
            source = f"[Book] {meta.get('title', 'Unknown')}"
        else:
            channel = meta.get("channel", "")
            title = meta.get("title", "")
            source = f"[Transcript] {channel} — {title[:70]}"

        snippet = doc[:snippet_len].replace("\n", " ").strip()
        if len(doc) > snippet_len:
            snippet += "..."

        lines.append(f"--- Result {i+1} | {source} | {relevance}% match ---\n{snippet}")

    return "\n\n".join(lines)


def show_stats():
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    try:
        collection = client.get_collection(COLLECTION_NAME)
    except Exception:
        print("Knowledge base not found. Run rag/ingest.py first.")
        return

    total = collection.count()
    books = len(collection.get(where={"source_type": "book"}, include=[])["ids"])
    transcripts = len(collection.get(where={"source_type": "transcript"}, include=[])["ids"])
    print(f"Knowledge base: {total:,} total chunks ({books:,} book | {transcripts:,} transcript)")


def main():
    parser = argparse.ArgumentParser(description="Query the RAG knowledge base")
    parser.add_argument("query_text", nargs="?", help="Your question")
    parser.add_argument("--top", type=int, default=5, dest="n", help="Number of results (default: 5)")
    parser.add_argument("--books", action="store_true", help="Search books only")
    parser.add_argument("--transcripts", action="store_true", help="Search transcripts only")
    parser.add_argument("--stats", action="store_true", help="Show knowledge base stats")
    args = parser.parse_args()

    if args.stats:
        show_stats()
        return

    if not args.query_text:
        parser.print_help()
        sys.exit(1)

    source_type = None
    if args.books:
        source_type = "book"
    elif args.transcripts:
        source_type = "transcript"

    try:
        results = query(args.query_text, n=args.n, source_type=source_type)
        print(format_results(results))
    except Exception as e:
        if "does not exist" in str(e):
            print("Knowledge base is empty. Run: python3 rag/ingest.py")
        else:
            print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
