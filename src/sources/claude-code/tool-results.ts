// Claude Code offloads large tool outputs to per-session sidecar files at
// `<session-dir>/<session-id>/tool-results/<id>.txt`, unreferenced from the
// transcript JSONL. The cloud estimates their token footprint from SIZE alone
// (spec 039, frugl contracts/cli-upload.md): this module emits one metadata
// record per file — the content is read only to count characters and discarded
// immediately. It MUST NOT enter the record, the anonymizer input beyond these
// counters, or any log (fail-closed by construction: the record shape is a
// closed five-key allowlist).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const TOOL_RESULT_RECORD_TYPE = "frugl.tool_result_file";

export interface ToolResultFileRecord {
  type: typeof TOOL_RESULT_RECORD_TYPE;
  schema: 1;
  file_id: string;
  bytes: number;
  chars: number;
}

export interface ToolResultCollection {
  records: ToolResultFileRecord[];
  // One entry per skipped (unreadable / non-regular) file — surfaced by the
  // caller, never thrown: a bad sidecar file must not sink the upload.
  warnings: string[];
}

export async function collectToolResultRecords(
  jsonlAbsolutePath: string,
): Promise<ToolResultCollection> {
  const dir = path.join(
    path.dirname(jsonlAbsolutePath),
    path.basename(jsonlAbsolutePath, ".jsonl"),
    "tool-results",
  );

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // No sidecar directory is the normal case — no records, no warning.
    return { records: [], warnings: [] };
  }

  const warnings: string[] = [];
  // Deterministic record order: the upload content hash covers these records,
  // so readdir order must not produce spurious "updated" classifications.
  const candidates = entries
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .filter((e) => e.isFile() && e.name.endsWith(".txt"));
  const settled = await Promise.all(
    candidates.map(async (entry) => {
      try {
        const buf = await readFile(path.join(dir, entry.name));
        return {
          type: TOOL_RESULT_RECORD_TYPE,
          schema: 1,
          file_id: entry.name.slice(0, -".txt".length),
          bytes: buf.byteLength,
          // UTF-8 aware character count; the decoded text is discarded here.
          chars: buf.toString("utf8").length,
        } as ToolResultFileRecord;
      } catch {
        warnings.push(`skipped unreadable tool-result file: ${entry.name}`);
        return null;
      }
    }),
  );
  const records = settled.filter((r): r is ToolResultFileRecord => r !== null);
  return { records, warnings };
}
