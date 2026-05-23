import envPaths from "env-paths";

const RESUME_NAMESPACE = "poppi-resume-state";
const LEDGER_NAMESPACE = "poppi-ledger";

const resumePaths = envPaths(RESUME_NAMESPACE, { suffix: "" });
const ledgerPaths = envPaths(LEDGER_NAMESPACE, { suffix: "" });

export const PATHS = {
  resumeStateDir: resumePaths.data,
  ledgerStateDir: ledgerPaths.data,
} as const;

export const NAMESPACES = {
  resume: RESUME_NAMESPACE,
  ledger: LEDGER_NAMESPACE,
} as const;
