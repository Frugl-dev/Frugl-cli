import type { OrgSetupPrompts, OrgSetupSuccess } from "./flow.js";
import type { OutputMode } from "../lib/output-mode.js";
import { UsageError } from "../lib/errors.js";

// The command supplies the inquirer prompt; the presenter decides whether to
// reprompt (text-mode retry) versus hard-fail instead (JSON mode).
export type Reprompt = () => Promise<string>;

// Per-branch copy. `warn` is the stderr line shown before a text-mode reprompt
// (no trailing newline — the presenter adds it); `abort` is the UsageError
// message raised in JSON mode (and in either mode for an unreachable branch).
// They differ for some commands — e.g. `org create` warns a colored
// "⚠ That slug is already taken." but aborts with a plainer "Slug is taken…"
// — so the presenter keeps both rather than collapsing them.
export interface BranchCopy {
  warn: string;
  abort: string;
}

export interface OrgSetupPresentation {
  // JSON envelope identity, e.g. "org create" / "login" / "setup".
  command: string;

  // Reprompt sources. Omit a branch the command's intent can never hit
  // (create-only commands omit `code`, join-only commands omit `name`); the
  // presenter installs an "unexpected result" guard for omitted branches that
  // throws the corresponding `abort` copy in either mode.
  reprompt?: { name?: Reprompt; code?: Reprompt };

  // Per-branch copy. For a reachable branch, text mode warns `warn` to stderr
  // then reprompts; JSON mode throws UsageError(`abort`). For an omitted
  // branch, `abort` is the "unexpected result" message thrown in both modes.
  messages: {
    slugTaken: (suggestion: string) => BranchCopy;
    invalidCode: BranchCopy;
    expiredCode: BranchCopy;
  };

  // Success rendering — the ONE place the terminal result shape lives.
  render: {
    text: (r: OrgSetupSuccess) => string;
    json: (r: OrgSetupSuccess) => Record<string, unknown>;
  };
}

function guard(copy: BranchCopy): never {
  throw new UsageError(copy.abort);
}

// Build the OrgSetupPrompts port for runOrgSetupFlow from a declarative spec.
// Each handler maps a non-terminal result branch to either "warn + reprompt"
// (text mode, when the command supplies a reprompt source) or a UsageError
// abort (JSON mode, or any mode for a branch the command's intent can't reach).
export function makeOrgSetupPrompts(spec: OrgSetupPresentation, mode: OutputMode): OrgSetupPrompts {
  // A branch the command can reach: warn to stderr + reprompt in the default
  // (interactive) format, hard-fail with the abort copy in any non-interactive
  // format (json/minimal) since there's no terminal to reprompt at.
  const handle = (reprompt: Reprompt, copy: BranchCopy): Promise<string> => {
    if (mode !== "default") throw new UsageError(copy.abort);
    process.stderr.write(`${copy.warn}\n`);
    return reprompt();
  };

  const name = spec.reprompt?.name;
  const code = spec.reprompt?.code;

  return {
    onSlugTaken: name
      ? (suggestion: string) => handle(name, spec.messages.slugTaken(suggestion))
      : (suggestion: string) => guard(spec.messages.slugTaken(suggestion)),
    onInvalidCode: code
      ? () => handle(code, spec.messages.invalidCode)
      : () => guard(spec.messages.invalidCode),
    onExpiredCode: code
      ? () => handle(code, spec.messages.expiredCode)
      : () => guard(spec.messages.expiredCode),
  };
}

// Render a terminal success to stdout in the requested mode, using the spec's
// per-mode renderers — the single place result shape and mode behaviour live.
export function renderOrgSetupResult(
  result: OrgSetupSuccess,
  spec: OrgSetupPresentation,
  mode: OutputMode,
): void {
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(spec.render.json(result))}\n`);
    return;
  }
  process.stdout.write(spec.render.text(result));
}
