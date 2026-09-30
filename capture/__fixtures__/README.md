# Attachment transcript fixtures

These are native Claude Code transcript shapes. File mentions and compaction restoration came from verified local sessions. The SDK document, full PDF Read, page-range Read and resumed session were recorded with Claude Code 2.1.284 against a deterministic local Messages endpoint; the real Read tool opened and rendered the PDF. This exercises harness behavior, not a hosted model or Augenta processing.

Content, paths, identifiers and timestamps are replaced with disposable values. The PDF is a generated, valid one-page fixture. Page images are replaced with placeholder bytes. No credentials or private document content are retained.

A genuine mention is a file attachment in the initiating user's parent chain whose filePath matches an explicit @ reference. Compaction restoration includes compact_boundary / isCompactSummary followed by reference and file attachments; those are not fresh user supplies. Display paths are never identity inputs. Context must survive incremental tails.
