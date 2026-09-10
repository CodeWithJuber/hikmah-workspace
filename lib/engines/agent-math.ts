/**
 * Hikmah agent mathematics playground, v1.
 * Pure local computations: no network, models, credentials, tools, or external effects.
 * A scenario is an explicit finite model. Its simulated facts are not real-world evidence.
 */

export type State = Readonly<Record<string, boolean>>;
export type Literal = Readonly<{ fact: string; value: boolean }>;
export type Scope = Readonly<{ tenant: string; project: string; context: string }>;
export type TransitionObservations = Readonly<{
  successes: number;
  failures: number;
  priorAlpha?: number;
  priorBeta?: number;
}>;
export type Action = Readonly<{
  id: string;
  label: string;
  requires: readonly Literal[];
  effects: readonly Literal[];
  failureEffects?: readonly Literal[];
  permission?: string;
  cost: number;
  observations: TransitionObservations;
  modelRef: string;
}>;
export type PlanningProblem = Readonly<{
  id: string;
  label: string;
  scope: Scope;
  initial: State;
  initialRefs?: Readonly<Record<string, readonly string[]>>;
  goals: readonly Literal[];
  actions: readonly Action[];
  permissions: readonly string[];
  budget: number;
  maxExpansions: number;
}>;
export type LiteralProof = Readonly<{
  literal: Literal;
  satisfied: boolean;
  references: readonly string[];
}>;
export type PlanStep = Readonly<{
  index: number;
  actionId: string;
  label: string;
  cost: number;
  cumulativeCost: number;
  assumedSuccessProbability: number;
  before: State;
  after: State;
  preconditions: readonly LiteralProof[];
  effectReferences: readonly string[];
  modelRef: string;
}>;
export type Blocker = Readonly<{
  actionId: string;
  kind: "permission" | "budget" | "precondition";
  detail: string;
}>;
export type PlanResult = Readonly<{
  mode: "simulated_plan";
  scope: Scope;
  status: "found" | "blocked" | "search_limit";
  actionIds: readonly string[];
  trace: readonly PlanStep[];
  totalCost: number;
  finalState: State;
  unresolvedGoals: readonly Literal[];
  goalProofs: readonly LiteralProof[];
  blockers: readonly Blocker[];
  expansions: number;
  uniqueStates: number;
  assumedPathSuccessProbability: number;
  optimality: "least_cost_in_configured_success_model" | "not_established";
  assumptions: readonly string[];
}>;

const cloneState = (state: State): Record<string, boolean> => ({ ...state });
const satisfied = (state: State, literal: Literal): boolean => state[literal.fact] === literal.value;
const unmet = (state: State, goals: readonly Literal[]): Literal[] => goals.filter((goal) => !satisfied(state, goal));
const stateKey = (state: State): string => JSON.stringify(Object.keys(state).sort().map((key) => [key, state[key]]));
const formatLiteral = (literal: Literal): string => `${literal.fact} = ${literal.value}`;
const applyEffects = (state: State, effects: readonly Literal[]): Record<string, boolean> => {
  const next = cloneState(state);
  for (const effect of effects) next[effect.fact] = effect.value;
  return next;
};

function finiteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and nonnegative.`);
}

function assertScope(scope: Scope): void {
  if (!scope || ![scope.tenant, scope.project, scope.context].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("A nonempty tenant, project, and context are required.");
  }
}

export function transitionEstimate(observations: TransitionObservations) {
  const { successes, failures, priorAlpha = 1, priorBeta = 1 } = observations;
  if (![successes, failures].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Transition observations must be nonnegative integer counts.");
  }
  if (![priorAlpha, priorBeta].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Beta prior parameters must be finite and positive.");
  }
  const alpha = successes + priorAlpha;
  const beta = failures + priorBeta;
  const concentration = alpha + beta;
  // Algebraically equivalent to alpha*beta / (n*n*(n+1)), with less overflow risk.
  const mean = alpha / concentration;
  const variance = (mean * (1 - mean)) / (concentration + 1);
  const expectedVarianceReduction = variance / (concentration + 1);
  const predictiveEntropyBits = -mean * Math.log2(mean) - (1 - mean) * Math.log2(1 - mean);
  if (![alpha, beta, concentration, mean, variance, expectedVarianceReduction, predictiveEntropyBits].every(Number.isFinite)) {
    throw new Error("Transition parameters exceed supported numeric precision.");
  }
  return {
    alpha, beta, observations: successes + failures, mean, variance,
    expectedVarianceReduction,
    expectedVarianceAfterOneObservation: variance - expectedVarianceReduction,
    predictiveEntropyBits,
    status: successes + failures === 0 ? "prior_only" as const : "updated_from_configured_counts" as const,
  };
}

/** Utility is expected reduction of posterior variance, not Shannon information in bits. */
export function rankActionsByInformation(actions: readonly Action[]) {
  return actions.map((action) => {
    if (!Number.isFinite(action.cost) || action.cost <= 0) throw new Error("Action cost must be finite and positive.");
    const estimate = transitionEstimate(action.observations);
    return {
      actionId: action.id, cost: action.cost, ...estimate,
      varianceReductionPerCost: estimate.expectedVarianceReduction / action.cost,
      expectedSuccessPerCost: estimate.mean / action.cost,
    };
  }).sort((left, right) => right.varianceReductionPerCost - left.varianceReductionPerCost || left.actionId.localeCompare(right.actionId));
}

export function validateProblem(problem: PlanningProblem): void {
  assertScope(problem.scope);
  finiteNonnegative(problem.budget, "Budget");
  if (!Number.isSafeInteger(problem.maxExpansions) || problem.maxExpansions < 1) throw new Error("maxExpansions must be a positive integer.");
  if (!problem.id || !problem.label) throw new Error("Problem ID and label are required.");
  const facts = new Set(Object.keys(problem.initial));
  if (!facts.size || Object.values(problem.initial).some((value) => typeof value !== "boolean")) throw new Error("Initial facts must be explicit booleans.");
  const checkLiterals = (literals: readonly Literal[], label: string) => {
    const seen = new Map<string, boolean>();
    for (const literal of literals) {
      if (!facts.has(literal.fact) || typeof literal.value !== "boolean") throw new Error(`${label}: undeclared fact or non-boolean literal.`);
      if (seen.has(literal.fact) && seen.get(literal.fact) !== literal.value) throw new Error(`${label}: contradictory literals for ${literal.fact}.`);
      seen.set(literal.fact, literal.value);
    }
  };
  checkLiterals(problem.goals, "Goals");
  const actionIds = new Set<string>();
  for (const action of problem.actions) {
    if (!action.id || actionIds.has(action.id)) throw new Error("Action IDs must be nonempty and unique.");
    actionIds.add(action.id);
    if (!Number.isFinite(action.cost) || action.cost <= 0) throw new Error("Action costs must be finite and positive.");
    if (!action.modelRef) throw new Error("Every action needs a model reference.");
    checkLiterals(action.requires, `${action.id} prerequisites`);
    checkLiterals(action.effects, `${action.id} effects`);
    checkLiterals(action.failureEffects ?? [], `${action.id} failure effects`);
    transitionEstimate(action.observations);
  }
}

type SearchNode = { state: State; cost: number; path: string[]; sequence: number };

function explainPath(problem: PlanningProblem, actionIds: readonly string[]) {
  let state = cloneState(problem.initial);
  let totalCost = 0;
  let probability = 1;
  const refs: Record<string, string[]> = {};
  for (const fact of Object.keys(state)) refs[fact] = [...(problem.initialRefs?.[fact] ?? [`scenario:${problem.id}:initial:${fact}`])];
  const trace: PlanStep[] = [];
  for (const [index, actionId] of actionIds.entries()) {
    const action = problem.actions.find((candidate) => candidate.id === actionId)!;
    const before = cloneState(state);
    const preconditions = action.requires.map((literal) => ({ literal, satisfied: satisfied(state, literal), references: [...refs[literal.fact]] }));
    state = applyEffects(state, action.effects);
    const effectReferences = action.effects.map((effect) => {
      const ref = `simulated:${problem.id}:step:${index + 1}:${action.id}:${effect.fact}`;
      refs[effect.fact] = [ref, action.modelRef];
      return ref;
    });
    totalCost += action.cost;
    const assumedSuccessProbability = transitionEstimate(action.observations).mean;
    probability *= assumedSuccessProbability;
    trace.push({ index: index + 1, actionId, label: action.label, cost: action.cost, cumulativeCost: totalCost, assumedSuccessProbability, before, after: cloneState(state), preconditions, effectReferences, modelRef: action.modelRef });
  }
  return {
    trace, totalCost, state, probability,
    goalProofs: problem.goals.map((literal) => ({ literal, satisfied: satisfied(state, literal), references: [...refs[literal.fact]] })),
  };
}

/** Uniform-cost search over a declared Boolean world; success effects are planning assumptions. */
export function plan(problem: PlanningProblem): PlanResult {
  validateProblem(problem);
  let sequence = 0;
  const start: SearchNode = { state: cloneState(problem.initial), cost: 0, path: [], sequence: sequence++ };
  const frontier: SearchNode[] = [start];
  const cheapest = new Map<string, number>([[stateKey(start.state), 0]]);
  const permissions = new Set(problem.permissions);
  const blockers = new Map<string, Blocker>();
  let expansions = 0;
  let best = start;
  let found: SearchNode | undefined;
  let limitHit = false;
  const block = (entry: Blocker) => blockers.set(`${entry.actionId}:${entry.kind}:${entry.detail}`, entry);
  while (frontier.length) {
    frontier.sort((left, right) => left.cost - right.cost || left.sequence - right.sequence);
    const node = frontier.shift()!;
    if (node.cost !== cheapest.get(stateKey(node.state))) continue;
    const missing = unmet(node.state, problem.goals).length;
    const bestMissing = unmet(best.state, problem.goals).length;
    if (missing < bestMissing || (missing === bestMissing && node.cost < best.cost)) best = node;
    if (!missing) { found = node; break; }
    if (expansions >= problem.maxExpansions) { limitHit = true; break; }
    expansions++;
    for (const action of problem.actions) {
      const missingPreconditions = unmet(node.state, action.requires);
      if (missingPreconditions.length) {
        block({ actionId: action.id, kind: "precondition", detail: missingPreconditions.map(formatLiteral).join(", ") });
        continue;
      }
      if (action.permission && !permissions.has(action.permission)) {
        block({ actionId: action.id, kind: "permission", detail: action.permission });
        continue;
      }
      const cost = node.cost + action.cost;
      if (cost > problem.budget) {
        block({ actionId: action.id, kind: "budget", detail: `${cost} required; ${problem.budget} available` });
        continue;
      }
      const state = applyEffects(node.state, action.effects);
      const key = stateKey(state);
      if (cost >= (cheapest.get(key) ?? Infinity)) continue;
      cheapest.set(key, cost);
      frontier.push({ state, cost, path: [...node.path, action.id], sequence: sequence++ });
    }
  }
  const selected = found ?? best;
  const explanation = explainPath(problem, selected.path);
  return {
    mode: "simulated_plan",
    scope: { ...problem.scope },
    status: found ? "found" : limitHit ? "search_limit" : "blocked",
    actionIds: selected.path, trace: explanation.trace, totalCost: explanation.totalCost,
    finalState: cloneState(explanation.state), unresolvedGoals: unmet(explanation.state, problem.goals), goalProofs: explanation.goalProofs,
    blockers: [...blockers.values()], expansions, uniqueStates: cheapest.size,
    assumedPathSuccessProbability: explanation.probability,
    optimality: found ? "least_cost_in_configured_success_model" : "not_established",
    assumptions: [
      "All state facts, actions, permissions, costs, and observations are configured simulation inputs.",
      "Planning assumes each selected action applies its declared success effects.",
      "Path probability is a plug-in product of posterior means; it is not a full posterior predictive calculation or calibrated deployment reliability.",
      "Proof references explain a simulated derivation and do not establish real-world truth.",
      "Blockers summarize encountered search branches; they are not necessarily a minimal explanation of failure.",
    ],
  };
}

export type SimulationOptions = Readonly<{
  outcomes?: Readonly<Record<string, "success" | "failure">>;
  /** Zero is allowed: inspect current goal without taking a step. */
  stepLimit?: number;
}>;
export type ExecutionStep = Readonly<{
  index: number; actionId: string; label: string; outcome: "success" | "failure";
  before: State; after: State; cost: number; cumulativeCost: number;
  effectReferences: readonly string[];
}>;

/** Executes only state transitions in this local simulator. No external operation is performed. */
export function executePlan(problem: PlanningProblem, actionIds: readonly string[], options: SimulationOptions = {}) {
  validateProblem(problem);
  const stepLimit = options.stepLimit ?? actionIds.length;
  if (!Number.isSafeInteger(stepLimit) || stepLimit < 0) throw new Error("stepLimit must be a nonnegative integer.");
  for (const [id, outcome] of Object.entries(options.outcomes ?? {})) {
    if (!problem.actions.some((action) => action.id === id)) throw new Error(`Unknown outcome action: ${id}.`);
    if (outcome !== "success" && outcome !== "failure") throw new Error(`Invalid outcome for ${id}.`);
  }
  let state = cloneState(problem.initial);
  let spent = 0;
  const trace: ExecutionStep[] = [];
  const permissions = new Set(problem.permissions);
  const finish = (status: "goal_reached" | "step_limit" | "failed" | "blocked" | "plan_exhausted", reason: string) => ({
    mode: "simulated_execution" as const, scope: { ...problem.scope }, status, reason, trace,
    finalState: cloneState(state), spent, remainingBudget: problem.budget - spent,
    goalVerifiedInSimulation: unmet(state, problem.goals).length === 0,
    unresolvedGoals: unmet(state, problem.goals), externalOperations: 0,
  });
  if (!unmet(state, problem.goals).length) return finish("goal_reached", "Initial simulated facts already satisfy the goal.");
  for (const [index, actionId] of actionIds.entries()) {
    if (index >= stepLimit) return finish("step_limit", "Requested simulation step limit reached.");
    const action = problem.actions.find((candidate) => candidate.id === actionId);
    if (!action) return finish("blocked", `Unknown action: ${actionId}.`);
    if (action.permission && !permissions.has(action.permission)) return finish("blocked", `Permission missing: ${action.permission}.`);
    const missing = unmet(state, action.requires);
    if (missing.length) return finish("blocked", `Prerequisites not satisfied: ${missing.map(formatLiteral).join(", ")}.`);
    if (spent + action.cost > problem.budget) return finish("blocked", "Remaining simulation budget is insufficient.");
    const outcome = options.outcomes?.[actionId] ?? "success";
    const before = cloneState(state);
    const effects = outcome === "success" ? action.effects : action.failureEffects ?? [];
    state = applyEffects(state, effects);
    spent += action.cost;
    trace.push({ index: index + 1, actionId, label: action.label, outcome, before, after: cloneState(state), cost: action.cost, cumulativeCost: spent, effectReferences: effects.map((effect) => `simulated:${problem.id}:execution:${index + 1}:${outcome}:${effect.fact}`) });
    if (outcome === "failure") return finish("failed", "Configured failure applied; inspect the resulting state and replan.");
    if (!unmet(state, problem.goals).length) return finish("goal_reached", "Goal literals verified against the resulting simulated state.");
  }
  return finish("plan_exhausted", "The supplied actions ended before the simulated goal was satisfied.");
}

export type Proposition = Readonly<{ id: string; scope: Scope; eventTime?: string }>;
export type Assertion = Readonly<{
  id: string; proposition: Proposition; polarity: "positive" | "negative"; sourceRef: string;
}>;

const propositionKey = (proposition: Proposition): string => JSON.stringify([proposition.id, proposition.scope.tenant, proposition.scope.project, proposition.scope.context, proposition.eventTime ?? null]);

/** Exact scoped identity only. Assertion presence is not a truth probability. */
export function evaluateEvidence(query: Proposition, assertions: readonly Assertion[]) {
  assertScope(query.scope);
  if (!query.id) throw new Error("Proposition ID is required.");
  const seen = new Set<string>();
  for (const assertion of assertions) {
    assertScope(assertion.proposition.scope);
    if (!assertion.id || seen.has(assertion.id) || !assertion.sourceRef || !assertion.proposition.id) throw new Error("Assertion IDs must be unique and references/propositions nonempty.");
    if (!["positive", "negative"].includes(assertion.polarity)) throw new Error("Assertion polarity must be explicit.");
    seen.add(assertion.id);
  }
  const matching = assertions.filter((assertion) => propositionKey(query) === propositionKey(assertion.proposition));
  const supporting = matching.filter((assertion) => assertion.polarity === "positive");
  const refuting = matching.filter((assertion) => assertion.polarity === "negative");
  const state = supporting.length ? refuting.length ? "both" : "supported" : refuting.length ? "refuted" : "unknown";
  return {
    state: state as "supported" | "refuted" | "both" | "unknown",
    supporting, refuting, ignoredDifferentPropositionsOrScopes: assertions.length - matching.length,
    distinctSupportingSources: [...new Set(supporting.map((assertion) => assertion.sourceRef))],
    distinctRefutingSources: [...new Set(refuting.map((assertion) => assertion.sourceRef))],
  };
}

export type ContextItem = Readonly<{
  id: string;
  text: string;
  requires: readonly string[];
  kind?: "policy" | "claim" | "evidence" | "negation" | "scope" | "context";
}>;

export function wordUnits(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

/** Complete authored dependency closure or explicit non-delivery; never truncate a claim's dependencies. */
export function selectContext(items: readonly ContextItem[], selectedIds: readonly string[], budget: number) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("Context budget must be a nonnegative integer.");
  const byId = new Map<string, ContextItem>();
  for (const item of items) {
    if (!item.id || byId.has(item.id) || typeof item.text !== "string") throw new Error("Context IDs must be nonempty and unique; text must be a string.");
    byId.set(item.id, item);
  }
  const completed = new Set<string>();
  const visiting: string[] = [];
  const ordered: ContextItem[] = [];
  const missing = new Set<string>();
  const cycles: string[][] = [];
  const visit = (id: string) => {
    if (completed.has(id)) return;
    const existingIndex = visiting.indexOf(id);
    if (existingIndex >= 0) { cycles.push([...visiting.slice(existingIndex), id]); return; }
    const item = byId.get(id);
    if (!item) { missing.add(id); return; }
    visiting.push(id);
    for (const dependency of item.requires) visit(dependency);
    visiting.pop();
    completed.add(id);
    ordered.push(item);
  };
  for (const id of selectedIds) visit(id);
  const candidate = ordered.map((item) => item.text).join("\n\n");
  const requiredUnits = wordUnits(candidate);
  const status = missing.size ? "missing_dependency" : requiredUnits > budget ? "budget_overflow" : "ready";
  return {
    status: status as "ready" | "budget_overflow" | "missing_dependency",
    budgetUnit: "whitespace_words" as const, budget, requiredUnits,
    payload: status === "ready" ? candidate : null,
    items: status === "ready" ? ordered : [],
    requiredIds: ordered.map((item) => item.id), missingIds: [...missing], cycles,
    caveat: "Closure preserves declared dependencies only. It does not discover missing semantics or measure provider tokens.",
  };
}

const lit = (fact: string, value = true): Literal => ({ fact, value });
const action = (id: string, label: string, requires: readonly Literal[], effects: readonly Literal[], cost: number, permission: string | undefined, successes: number, failures: number, failureEffects: readonly Literal[] = []): Action => ({
  id, label, requires, effects, cost, permission, observations: { successes, failures }, failureEffects, modelRef: `scenario-model:v1:${id}`,
});
const scope: Scope = { tenant: "playground", project: "agent-math", context: "local-simulation" };

export const PRESETS: Readonly<Record<string, PlanningProblem>> = {
  hosting: {
    id: "hosting", label: "Inspect, repair, and verify a hosting service", scope,
    initial: { issue_reported: true, logs_reviewed: false, fault_identified: false, config_backed_up: false, config_valid: false, service_healthy: false, health_checked: false },
    goals: [lit("service_healthy"), lit("health_checked")],
    actions: [
      action("inspect-logs", "Inspect service logs", [lit("issue_reported")], [lit("logs_reviewed")], 1, "logs.read", 12, 0),
      action("diagnose", "Identify the configured fault", [lit("logs_reviewed")], [lit("fault_identified")], 1, undefined, 8, 2),
      action("backup", "Create a simulated configuration backup", [lit("fault_identified")], [lit("config_backed_up")], 1, "service.write", 10, 0),
      action("repair", "Apply the simulated configuration repair", [lit("fault_identified"), lit("config_backed_up")], [lit("config_valid"), lit("health_checked", false)], 3, "service.write", 8, 2, [lit("config_valid", false), lit("health_checked", false)]),
      action("restart", "Simulate a service restart", [lit("config_valid")], [lit("service_healthy"), lit("health_checked", false)], 2, "service.restart", 9, 1, [lit("service_healthy", false)]),
      action("check-health", "Verify the simulated health result", [lit("config_valid"), lit("service_healthy")], [lit("health_checked")], 1, "health.read", 15, 1, [lit("health_checked", false), lit("service_healthy", false)]),
    ],
    permissions: ["logs.read", "service.write", "service.restart", "health.read"], budget: 10, maxExpansions: 1000,
  },
  research: {
    id: "research", label: "Compare claim evidence and verify a conclusion", scope,
    initial: { question_defined: true, source_a_read: false, source_b_read: false, claim_extracted: false, scope_checked: false, conflict_checked: false, conclusion_drafted: false, conclusion_verified: false },
    goals: [lit("conclusion_verified")],
    actions: [
      action("read-source-a", "Read simulated source A", [lit("question_defined")], [lit("source_a_read")], 1, "research.read", 10, 1),
      action("read-source-b", "Read simulated source B", [lit("question_defined")], [lit("source_b_read")], 1, "research.read", 4, 1),
      action("extract-claim", "Extract a scoped claim", [lit("source_a_read")], [lit("claim_extracted")], 1, undefined, 8, 2),
      action("check-scope", "Compare subject, date, and context", [lit("source_a_read"), lit("source_b_read"), lit("claim_extracted")], [lit("scope_checked")], 1, undefined, 4, 2),
      action("compare-evidence", "Record support and contradiction", [lit("scope_checked")], [lit("conflict_checked")], 2, undefined, 5, 2),
      action("draft-conclusion", "Draft a conclusion with uncertainty", [lit("conflict_checked")], [lit("conclusion_drafted")], 1, "document.write", 8, 1),
      action("verify-conclusion", "Verify source coverage in the simulated model", [lit("conclusion_drafted"), lit("source_a_read"), lit("source_b_read"), lit("scope_checked"), lit("conflict_checked")], [lit("conclusion_verified")], 1, undefined, 5, 1, [lit("conclusion_verified", false)]),
    ],
    permissions: ["research.read", "document.write"], budget: 10, maxExpansions: 1000,
  },
  document: {
    id: "document", label: "Prepare, validate, and simulate delivery of a document", scope,
    initial: { brief_ready: true, outline_ready: false, draft_ready: false, citations_attached: false, validated: false, delivered: false },
    goals: [lit("delivered")],
    actions: [
      action("outline", "Create an outline", [lit("brief_ready")], [lit("outline_ready")], 1, "document.write", 10, 0),
      action("draft", "Prepare a simulated document", [lit("outline_ready")], [lit("draft_ready")], 2, "document.write", 8, 1),
      action("attach-citations", "Attach simulated source references", [lit("draft_ready")], [lit("citations_attached")], 2, "research.read", 7, 2),
      action("validate", "Validate the configured document constraints", [lit("draft_ready"), lit("citations_attached")], [lit("validated")], 1, undefined, 6, 2, [lit("validated", false)]),
      action("deliver", "Simulate delivery; no message is sent", [lit("validated")], [lit("delivered")], 1, "document.deliver", 9, 1, [lit("delivered", false)]),
    ],
    permissions: ["document.write", "research.read", "document.deliver"], budget: 9, maxExpansions: 1000,
  },
};

/** Detached copy lets the UI change a scenario without mutating the preset catalog. */
export function createPreset(id: string): PlanningProblem {
  if (!Object.hasOwn(PRESETS, id)) throw new Error(`Unknown preset: ${id}.`);
  return JSON.parse(JSON.stringify(PRESETS[id])) as PlanningProblem;
}
