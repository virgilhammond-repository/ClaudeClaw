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


# Reranking: pull a wider candidate set from the vector store, then re-score
# with a cross-encoder that reads query+passage together (far more precise than
# cosine similarity alone). Retrieval stays fast; only the shortlist is reranked.
RERANK_CANDIDATES = 24
_ranker = None


def _get_ranker():
    global _ranker
    if _ranker is None:
        from flashrank import Ranker
        # Compact cross-encoder (~4MB), cached under the project after first download.
        # Upgrade to "ms-marco-MiniLM-L-12-v2" for higher precision when bandwidth allows.
        _ranker = Ranker(model_name="ms-marco-TinyBERT-L-2-v2",
                         cache_dir=str(ROOT / "store" / "reranker"))
    return _ranker


def query(text, n=5, source_type=None, rerank=True):
    collection = get_collection()
    embedding = embed_query(text)

    # When reranking, over-fetch candidates so the cross-encoder has room to reorder.
    fetch_n = max(n, RERANK_CANDIDATES) if rerank else n
    kwargs = {
        "query_embeddings": [embedding],
        "n_results": min(fetch_n, collection.count()),
        "include": ["documents", "metadatas", "distances"],
    }
    if source_type:
        kwargs["where"] = {"source_type": source_type}

    results = collection.query(**kwargs)

    if not rerank or not results["documents"][0]:
        # Trim to n if we over-fetched but aren't reranking.
        for key in ("documents", "metadatas", "distances"):
            results[key][0] = results[key][0][:n]
        return results

    return _rerank(text, results, n)


def _rerank(text, results, n):
    from flashrank import RerankRequest
    docs = results["documents"][0]
    metas = results["metadatas"][0]
    dists = results["distances"][0]

    passages = [{"id": i, "text": doc} for i, doc in enumerate(docs)]
    ranked = _get_ranker().rerank(RerankRequest(query=text, passages=passages))

    top = ranked[:n]
    order = [item["id"] for item in top]
    # rerank score in [0,1]; expose it via distance so relevance% = (1-dist)*100 reflects it.
    return {
        "documents": [[docs[i] for i in order]],
        "metadatas": [[metas[i] for i in order]],
        "distances": [[1.0 - float(top[k]["score"]) for k in range(len(order))]],
        "embedding_distances": [[dists[i] for i in order]],
    }


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
    parser.add_argument("--no-rerank", action="store_true", help="Skip cross-encoder reranking (faster, less precise)")
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
        results = query(args.query_text, n=args.n, source_type=source_type, rerank=not args.no_rerank)
        print(format_results(results))
    except Exception as e:
        if "does not exist" in str(e):
            print("Knowledge base is empty. Run: python3 rag/ingest.py")
        else:
            print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
