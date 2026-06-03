// Parses newline-delimited JSON: one record per non-blank line. A line that is
// not valid JSON is preserved as `{ _raw: <text> }` rather than dropped, so a
// single malformed line never loses the surrounding session. Shared by every
// provider whose on-disk format is NDJSON (Claude Code, Codex, Cursor) so the
// trim/parse/recover behaviour stays identical across them.
export function parseNdjson(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      records.push({ _raw: trimmed });
    }
  }
  return records;
}
