export interface SessionRef {
  sourceKind: string;
  absolutePath: string;
  byteSizeOnDisk: number;
  mtimeMs: number;
}

export interface SessionIdentity {
  // Always a canonical UUID — reused from the source's native id when that is
  // itself a UUID, otherwise derived (UUIDv5) from the session file path.
  sessionId: string;
  // The source's own session id, when present and read from content/path. May be
  // a non-UUID; preserved so several physical files (e.g. worktree copies) can be
  // grouped back to one logical session. Absent when no native id was found.
  nativeSessionId?: string;
  // "native" = sessionId is the source's own (UUID) id; "path-hash" = derived.
  derivation: "native" | "path-hash";
}

export interface ParsedSession<TRecord = unknown> {
  sourceKind: string;
  ref: SessionRef;
  identity: SessionIdentity;
  records: TRecord[];
  // Additive (005): the session's recorded working dir + work-time branch, used
  // only by the opt-in git-context resolver. Never enter `records`, so they never
  // reach the anonymizer/payload/contentHash.
  cwd?: string;
  recordedBranch?: string;
}

export interface DiscoverOptions {
  homeDir?: string;
}

export interface Source<TRecord = unknown> {
  kind: string;
  formatVersion: string;
  discover(opts?: DiscoverOptions): Promise<SessionRef[]>;
  parse(ref: SessionRef): Promise<ParsedSession<TRecord>>;
  deriveIdentity(ref: SessionRef, parsed: ParsedSession<TRecord>): SessionIdentity;
}
