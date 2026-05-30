export interface SessionRef {
  sourceKind: string;
  absolutePath: string;
  byteSizeOnDisk: number;
  mtimeMs: number;
}

export interface SessionIdentity {
  sessionId: string;
  derivation: "native" | "path-hash";
}

export interface SessionMeta {
  // Actual session start time extracted from the source format's records.
  // Absent when the format carries no timestamp (e.g. Cursor).
  startedAt?: Date;
}

export interface ParsedSession<TRecord = unknown> {
  sourceKind: string;
  ref: SessionRef;
  identity: SessionIdentity;
  records: TRecord[];
  meta: SessionMeta;
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
