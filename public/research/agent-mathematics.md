# Agent mathematics playground

This module turns a finite, user-configured world into a computed plan, a separate simulated execution, and inspectable evidence. The three included worlds concern hosting repair, research comparison, and document preparation. The user can change facts, costs, permissions, budgets, and execution outcomes. Every result is recalculated locally. Nothing here contacts a model, modifies a server, sends a document, or proves a real-world claim.

The components are established mathematical techniques assembled for this project. The contribution of this playground is an explicit, testable combination with the root-and-sense architecture. It does not demonstrate a new general learning algorithm or AGI.

## 1. Finite planning with an explicit world model

Let \(F\) be a finite set of declared Boolean facts. A state is a function \(s:F\to\{0,1\}\). A literal \(\ell=(f,v)\) is satisfied when \(s(f)=v\). An action \(a\) contains prerequisite literals \(P_a\), success effects \(E_a\), optional failure effects, a positive cost \(c_a\), and an optional permission label. Its applicability is:

\[
\operatorname{applicable}(a,s,A)\iff
\left(\bigwedge_{\ell\in P_a}s\models\ell\right)
\land(\operatorname{permission}(a)\in A\ \text{or absent}).
\]

Success transition \(T_a(s)\) overwrites only facts named by \(E_a\). A plan \(\pi=(a_1,\ldots,a_k)\) must reach all goal literals while satisfying \(\sum_i c_{a_i}\le B\).

`plan` performs uniform-cost search. It expands the cheapest frontier state, remembers the cheapest known arrival cost for each canonical state, and ignores more expensive revisits. This prevents action cycles from causing endless search. The canonical key sorts fact names, so object insertion order does not create different states.

When a goal state is removed from the priority frontier, the returned plan has the least cost in the configured deterministic success model. This statement requires that future applicability and cost depend only on the represented state, permissions, and declared actions. A hidden real-world dependency invalidates the model, not the search algorithm. Reliability is not part of the optimization objective.

At most \(2^{|F|}\) distinct states exist. An expansion cap limits work; reaching it returns `search_limit`, which does not prove the goal unreachable. Exhausting the reachable, permitted, within-budget search returns `blocked`. Returned blockers summarize encountered branches and need not form a minimal explanation. An unsuccessful search can return a partial path with fewer unsatisfied goals; that path is not a completed solution.

The current implementation sorts an array frontier, which is simple and appropriate for the small scenarios. Larger worlds should use a heap, cancellation, and a worker. The finite model still grows exponentially; boundedness does not make arbitrary planning cheap.

## 2. Planning assumptions versus simulated outcomes

`executePlan` rechecks each action's prerequisites, permission, and remaining budget against the current simulated state. Outcomes are explicitly configured as success or failure. Failure consumes the action cost, applies its failure effects, and stops the run. The user can then replan from that resulting state and remaining budget.

The goal is checked against final state values. In hosting, a planned restart is insufficient: the health-verification step must also succeed. A configured failed health check sets health back to false. A permission flag in this simulator grants no real application permission, and “delivery” changes a Boolean without sending anything.

Step references identify input assumptions, action models, and simulated derivations. They are useful audit structure, but are not external evidence receipts. A production implementation would replace these transitions with tool adapters, scoped authorization, durable operation IDs, and read-back verification.

## 3. Bayesian transition estimates

Suppose a specific transition has an unknown stationary success probability \(\theta\). Use a Beta prior \(\theta\sim\operatorname{Beta}(\alpha_0,\beta_0)\). With configured success and failure counts \(S,F\), the posterior parameters are:

\[
\alpha=\alpha_0+S,\quad\beta=\beta_0+F,\quad n=\alpha+\beta,
\]
\[
\mu=\frac{\alpha}{n},\qquad
V=\frac{\alpha\beta}{n^2(n+1)}.
\]

The expected reduction of posterior parameter variance after one additional Bernoulli observation is:

\[
\Delta V=\frac{\alpha\beta}{n^2(n+1)^2}=\frac{V}{n+1}.
\]

One derivation uses the law of total variance. The two possible updated means are \((\alpha+1)/(n+1)\) and \(\alpha/(n+1)\), weighted by \(\mu\) and \(1-\mu\). Their variance equals \(\Delta V\); the expected remaining parameter variance is \(V-\Delta V\). A test compares this formula with the two explicitly updated posteriors.

`rankActionsByInformation` orders \(\Delta V/c_a\). This is an exploration heuristic measured in variance reduction per simulation cost, not information gain in bits. It assumes an action yields one relevant outcome observation. It does not establish task utility or authorize execution. The module separately reports predictive Bernoulli entropy in bits; high predictive uncertainty and high parameter uncertainty are different quantities.

The displayed path value \(\prod_i\mu_i\) is a plug-in approximation. Correlated failures, repeated actions sharing an uncertain parameter, changing environments, and selected observation samples can invalidate its interpretation. It is not a calibrated probability that a deployed workflow will succeed. The counts in presets are synthetic assumptions, not measured production outcomes.

## 4. Evidence that retains contradiction

A proposition identity contains its ID, tenant, project, context, and optional exact event-time string. Positive and negative assertions are tracked separately. Their presence yields four states:

| Positive source | Negative source | State |
|---|---|---|
| Absent | Absent | Unknown |
| Present | Absent | Supported |
| Absent | Present | Refuted |
| Present | Present | Both |

This representation does not turn a majority into truth. Source references remain inspectable, and repeated references do not increase the count of distinct source labels. The function does not determine whether different URLs share an original source; that requires provenance analysis. Different scopes and event-time strings never merge automatically. Time normalization, entity resolution, and source reliability belong in explicit upstream components.

## 5. Context closure under a budget

For selected items \(Q\), define authored dependency edges \(x\to y\) when using item \(x\) requires item \(y\). Compute the least closure:

\[
C_0=Q,\qquad C_{t+1}=C_t\cup\bigcup_{x\in C_t}\operatorname{requires}(x).
\]

The traversal includes every reachable dependency once. A cycle is reported and retained as a group; it is not repeatedly traversed. Missing dependencies block delivery. If the complete rendered payload exceeds the budget, the result contains `budget_overflow` and no partial payload. This prevents this selector from trimming away a declared negation, scope, or source dependency to fit the budget.

Cost is the number of whitespace-separated words in the exact payload. It is not provider-token usage, and it is unsuitable as a language-neutral compression metric. Closure preserves only dependencies that were authored; it cannot discover an omitted qualification.

## 6. Connection to the larger model

The semantic layer can ground reviewed root-linked senses, roles, modality, and scope into stable proposition and fact identifiers. The planner consumes those grounded facts; it does not infer them from raw speech or text. Candidate procedures learned by a future co-model must pass scenario and counterexample evaluation before becoming action definitions.

These boundaries make measurable comparisons possible: changed plan cost, successful recovery, evidence conflicts retained, avoided incomplete context, and outcome-estimate calibration. The current tests establish local mechanics on controlled scenarios. They do not establish multilingual understanding, autonomous learning, deployment safety, or an improvement over a general model.
