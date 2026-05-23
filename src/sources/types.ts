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

export interface ParsedSession<TRecord = unknown> {
  sourceKind: string;
  ref: SessionRef;
  identity: SessionIdentity;
  records: TRecord[];
}

export interface DiscoverOptions {
  homeDir?: string;
}

export interface Source<TRecord = unknown> {
  kind: string;
  discover(opts?: DiscoverOptions): Promise<SessionRef[]>;
  parse(ref: SessionRef): Promise<ParsedSession<TRecord>>;
  deriveIdentity(ref: SessionRef, parsed: ParsedSession<TRecord>): SessionIdentity;
}
