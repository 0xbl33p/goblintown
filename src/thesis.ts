import {
  profileSolanaAddress,
  summarizeSolanaToken,
  summarizeSolanaTransaction,
  type SolanaAddressProfile,
  type SolanaRpcClient,
  type SolanaRpcClientOptions,
  type SolanaTokenSummary,
  type SolanaTransactionSummary,
} from "./solana.js";

export interface ThesisInput {
  subject: string;
  horizon: string;
  context?: string;
  solanaAddress?: string;
  solanaSignature?: string;
}

export interface ThesisEvidence {
  block: string;
  warnings: string[];
}

export interface ThesisEvidencePayload {
  profile?: SolanaAddressProfile;
  token?: SolanaTokenSummary;
  transaction?: SolanaTransactionSummary;
  errors?: string[];
}

const DEFAULT_HORIZON = "30d";

export function normalizeThesisInput(raw: {
  subject?: unknown;
  horizon?: unknown;
  context?: unknown;
  solanaAddress?: unknown;
  solanaSignature?: unknown;
}): ThesisInput {
  const subject = stringField(raw.subject);
  if (!subject) throw new Error("subject is required");
  const horizon = stringField(raw.horizon) || DEFAULT_HORIZON;
  const context = stringField(raw.context);
  const solanaAddress = stringField(raw.solanaAddress);
  const solanaSignature = stringField(raw.solanaSignature);
  return {
    subject,
    horizon,
    ...(context ? { context } : {}),
    ...(solanaAddress ? { solanaAddress } : {}),
    ...(solanaSignature ? { solanaSignature } : {}),
  };
}

export async function collectThesisEvidence(
  input: ThesisInput,
  clientOrOptions: SolanaRpcClient | SolanaRpcClientOptions = {},
): Promise<ThesisEvidence> {
  const payload: ThesisEvidencePayload = {};
  const errors: string[] = [];
  if (input.solanaAddress) {
    try {
      payload.profile = await profileSolanaAddress(input.solanaAddress, clientOrOptions);
    } catch (err) {
      errors.push(`profile: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      payload.token = await summarizeSolanaToken(input.solanaAddress, clientOrOptions);
    } catch (err) {
      errors.push(`token: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (input.solanaSignature) {
    try {
      payload.transaction = await summarizeSolanaTransaction(input.solanaSignature, clientOrOptions);
    } catch (err) {
      errors.push(`transaction: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  payload.errors = errors;
  return {
    block: renderThesisEvidence(payload),
    warnings: errors,
  };
}

export function renderThesisEvidence(payload: ThesisEvidencePayload): string {
  const lines: string[] = [];
  lines.push("Solana evidence (read-only diligence context):");
  if (payload.profile) {
    lines.push(`- profile address: ${payload.profile.address}`);
    lines.push(`  inferred type: ${payload.profile.inferredType}`);
    if (payload.profile.balance) {
      lines.push(`  SOL balance: ${payload.profile.balance.sol}`);
    }
    lines.push(`  activity: ${payload.profile.activity.signatureCount} recent signatures; failed=${payload.profile.activity.failedCount}`);
    if (payload.profile.tokenHighlights.tokenAccountCount > 0) {
      lines.push(
        `  token accounts: ${payload.profile.tokenHighlights.tokenAccountCount}; non-zero=${payload.profile.tokenHighlights.nonZeroTokenAccounts}`,
      );
    }
    for (const note of payload.profile.notes.slice(0, 6)) lines.push(`  note: ${note}`);
    for (const warning of payload.profile.warnings.slice(0, 6)) lines.push(`  warning: ${warning}`);
  }
  if (payload.token) {
    lines.push(`- token summary: ${payload.token.kind}`);
    if (payload.token.kind === "mint") {
      lines.push(`  supply: ${payload.token.uiSupply ?? payload.token.supply ?? "unknown"}`);
      if (payload.token.decimals !== undefined) lines.push(`  decimals: ${payload.token.decimals}`);
      if (payload.token.mintAuthority !== undefined) lines.push(`  mint authority: ${payload.token.mintAuthority ?? "none"}`);
      if (payload.token.freezeAuthority !== undefined) lines.push(`  freeze authority: ${payload.token.freezeAuthority ?? "none"}`);
    } else if (payload.token.kind === "token-account") {
      if (payload.token.mint) lines.push(`  mint: ${payload.token.mint}`);
      if (payload.token.tokenOwner) lines.push(`  token owner: ${payload.token.tokenOwner}`);
      lines.push(`  amount: ${payload.token.uiAmountString ?? payload.token.amount ?? "unknown"}`);
    }
  }
  if (payload.transaction) {
    lines.push(`- transaction: ${payload.transaction.signature}`);
    lines.push(`  found: ${payload.transaction.found}`);
    if (payload.transaction.found) {
      lines.push(`  status: ${payload.transaction.status ?? "unknown"}`);
      if (payload.transaction.feeLamports !== undefined) lines.push(`  fee lamports: ${payload.transaction.feeLamports}`);
      if (payload.transaction.signers.length) lines.push(`  signers: ${payload.transaction.signers.join(", ")}`);
      for (const ix of payload.transaction.instructions.slice(0, 8)) {
        lines.push(`  instruction: ${[ix.program, ix.type, ix.programId].filter(Boolean).join(" / ")}`);
      }
    }
  }
  if (payload.errors?.length) {
    lines.push("- partial evidence errors:");
    for (const err of payload.errors) lines.push(`  error: ${err}`);
  }
  if (lines.length === 1) lines.push("- no Solana adapter evidence supplied");
  return lines.join("\n");
}

export function buildThesisTask(input: ThesisInput, evidence?: ThesisEvidence): string {
  const lines: string[] = [];
  lines.push("Build a project-quality thesis.");
  lines.push(`Subject: ${input.subject}`);
  lines.push(`Time horizon: ${input.horizon}`);
  if (input.context) {
    lines.push("Additional context:");
    lines.push(input.context);
  }
  if (evidence?.block) {
    lines.push("");
    lines.push(evidence.block);
  }
  lines.push("");
  lines.push("Evaluate the quality and advantages of the project, team, product, technology, ecosystem position, traction, execution, and evidence base.");
  lines.push("This is not a buy/sell recommendation and not financial advice. Do not discuss buyability except to explicitly avoid it.");
  lines.push("");
  lines.push("Evidence discipline:");
  lines.push("- User-provided context is evidence. If the user says they are the developer, do not contradict that without stronger supplied evidence.");
  lines.push("- Absence of evidence is not evidence of absence. Missing repo, team, social, or onchain data must be marked Unknown / Unverified, not scored as Low, None, scam, abandoned, or failed.");
  lines.push("- Do not downgrade team credibility only because a founder is pseudonymous; not being doxxed is not a negative signal by itself.");
  lines.push("- Do not claim name-squatting, impersonation, parasitic branding, unaffiliated status, scams, honeypots, rugs, or malicious intent unless supplied context, scanned files, verifier results, or cited evidence directly supports it.");
  lines.push("- If repository contents are relevant but no scan context is supplied, list repo inspection as an evidence gap instead of guessing what is in the repo.");
  lines.push("");
  lines.push("Return a concise thesis memo with these sections:");
  lines.push("1. One-line thesis");
  lines.push("2. Quality scorecard: team credibility, product/technical quality, ecosystem position, traction, advantage durability, evidence quality");
  lines.push("3. Bull case: strongest project-quality arguments");
  lines.push("4. Bear case: strongest project-quality objections");
  lines.push("5. Invalidation triggers: what would prove this thesis wrong");
  lines.push("6. Evidence gaps: what is missing or weak");
  lines.push("7. Watchlist: concrete next checks");
  lines.push("8. Confidence: evidence-quality confidence only, not price prediction certainty");
  return lines.join("\n");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
