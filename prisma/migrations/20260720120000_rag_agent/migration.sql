-- pgvector. Requires an image that ships the extension — the stock
-- postgres:16-alpine does NOT, which is why compose uses pgvector/pgvector:pg16.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "tags" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- The vector column, added outside the Prisma model because Prisma has no
-- native vector type. 384 dimensions = all-MiniLM-L6-v2, the local embedding
-- model. Changing embedding model means a new migration AND re-embedding every
-- existing chunk — the dimension is fixed here, not configurable at runtime.
ALTER TABLE "document_chunks" ADD COLUMN "embedding" vector(384);

-- CreateIndex
CREATE INDEX "documents_user_id_idx" ON "documents"("user_id");
CREATE INDEX "document_chunks_user_id_idx" ON "document_chunks"("user_id");
CREATE UNIQUE INDEX "document_chunks_document_id_chunk_index_key" ON "document_chunks"("document_id", "chunk_index");

-- HNSW rather than IVFFlat.
--
-- IVFFlat has to be built on populated data — it clusters existing rows, so
-- building it on an empty table gives poor recall until it is rebuilt. This
-- table starts empty and grows continuously, which is the case IVFFlat handles
-- worst. HNSW builds fine on an empty table and needs no `lists` tuning.
--
-- Cosine distance (`<=>`): the embedding model returns L2-normalized vectors,
-- so cosine and inner product rank identically; cosine is the clearer default.
--
-- CAVEAT — filtered search: an HNSW scan with `WHERE user_id = ?` post-filters,
-- so it can return fewer than K rows, or miss relevant ones, when one tenant's
-- chunks are sparse among many. VectorStoreService enables
-- `hnsw.iterative_scan` to compensate. At this project's scale exact search is
-- also correct and fast, so correctness never depends on the index being used.
CREATE INDEX "document_chunks_embedding_hnsw_idx"
    ON "document_chunks"
    USING hnsw ("embedding" vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
