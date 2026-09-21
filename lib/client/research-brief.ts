/** A reviewable brief for the existing research tools, not a second run engine. */
export const RESEARCH_LIMITS = { question: 2_000, context: 6_000 } as const;

export const RESEARCH_OUTPUTS = [
  {
    value: 'evidence',
    label: 'Review evidence',
    detail: 'What is known, disputed, and still missing?',
  },
  {
    value: 'hypothesis',
    label: 'Challenge an idea',
    detail: 'Look for evidence that could change your mind.',
  },
  {
    value: 'experiment',
    label: 'Plan a test',
    detail: 'Design a practical next experiment.',
  },
] as const;

export type ResearchOutput = (typeof RESEARCH_OUTPUTS)[number]['value'];
export type ResearchCapabilities = { webSearch: boolean; parallelResearch: boolean };
export type ResearchBriefInput = {
  question: string;
  context?: string;
  output: ResearchOutput;
  useWeb: boolean;
};
export type PreparedResearchBrief = {
  prompt: string;
  question: string;
  output: ResearchOutput;
  webSearch: boolean;
  deepResearch: boolean;
};

/** Availability must be confirmed by the server. The explicit Search switch
 * enables search/read over the saved conversation switches, as buildRunAgent
 * does. It never re-enables a disabled deep_research tool. */
export function researchCapabilities(
  tools: readonly { name: string; available: boolean }[],
  disabledTools: readonly string[] = [],
): ResearchCapabilities {
  const available = new Set(tools.filter((tool) => tool.available).map((tool) => tool.name));
  const webSearch = available.has('search_web') && available.has('read_webpage');
  return {
    webSearch,
    parallelResearch: webSearch && !disabledTools.includes('deep_research'),
  };
}

export function researchBriefError(input: ResearchBriefInput): string | null {
  if (!input.question.trim()) return 'Add a question or an idea to investigate.';
  if (input.question.length > RESEARCH_LIMITS.question)
    return `Keep the question under ${RESEARCH_LIMITS.question.toLocaleString('en-US')} characters. Put supporting detail in context.`;
  if ((input.context?.length ?? 0) > RESEARCH_LIMITS.context)
    return `Keep context under ${RESEARCH_LIMITS.context.toLocaleString('en-US')} characters. You can attach longer material in chat.`;
  if (!RESEARCH_OUTPUTS.some((output) => output.value === input.output))
    return 'Choose the kind of research you need.';
  return null;
}

const GOALS: Record<ResearchOutput, string> = {
  evidence:
    'Review the strongest relevant evidence. Distinguish established findings, contested claims, and open questions. Identify where evidence is absent or only indirectly relevant.',
  hypothesis:
    'Turn the idea into a testable hypothesis. Compare it with at least one plausible alternative explanation and actively seek disconfirming evidence. State what observation would change the conclusion.',
  experiment:
    'Design the smallest feasible test of the question. Define a hypothesis, comparison or control, measurable outcome, confounders, resources, and a decision rule chosen before results are known. Explain what the proposed test could and could not establish.',
};

/** Build only from the choices the person can review. A lost capability must
 * downgrade the brief instead of asking the model to pretend it searched. */
export function prepareResearchBrief(
  input: ResearchBriefInput,
  capabilities: ResearchCapabilities,
): PreparedResearchBrief {
  const error = researchBriefError(input);
  if (error) throw new Error(error);

  const question = input.question.trim();
  const context = input.context?.trim();
  const webSearch = input.useWeb && capabilities.webSearch;
  const deepResearch = webSearch && capabilities.parallelResearch;
  const sources = webSearch
    ? [
        'Use search_web to discover sources and read_webpage to inspect them. Prefer relevant primary research, original data, and official documentation. Search snippets are leads, not verified evidence.',
        deepResearch
          ? 'Use deep_research when distinct lines of inquiry would help, with at most three research lanes: supporting evidence, counter-evidence or alternatives, and limits or a feasible test. Respect the available tools, model-call limits, and cancellation. If it is unavailable, continue with the available source tools.'
          : 'Work with the available source tools in this conversation. Research agents are not requested.',
        'Cite the exact source URL beside the claim it supports; include dates and study limitations when relevant. Only describe a source as inspected when a tool actually returned its content. If access or a tool fails, report the gap and reduce confidence. Never invent a citation, quotation, measurement, or completed experiment.',
      ]
    : [
        'Live source research is not requested or is unavailable. Create an unverified research outline from the question, provided context, and existing conversation only. Do not claim to have searched or checked current literature. Mark factual assertions needing verification and suggest search terms or source types instead of inventing citations.',
        'Do not use research agents or browsing for this brief. If source verification is necessary to answer, identify that as the next step rather than presenting an unsupported finding.',
      ];

  const prompt = [
    'Work with me as a research collaborator. Use the language of my question.',
    `Research question:\n${question}`,
    context ? `Context, constraints, and material I supplied:\n${context}` : '',
    `Research goal:\n${GOALS[input.output]}`,
    'Start with a short plan. Proceed using reasonable stated assumptions; ask a focused question only if a missing detail would materially change the work. Keep the scope bounded to this question.',
    ...sources,
    'Keep observed evidence separate from interpretation and proposed work. State uncertainty in plain language, include rival explanations, and distinguish correlation from causation. Do not invent numerical confidence, sample sizes, or statistical power; state the assumptions and data needed to estimate them.',
    'Produce a concise report with: (1) answer or working hypothesis, (2) evidence and counter-evidence with source links where actually verified, (3) uncertainties and alternative explanations, and (4) the most useful next test or decision. Use a small evidence table when it helps compare claim, source, limitation, and implication.',
    'Label any experiment plan as proposed and not executed. Specify a feasible comparison, outcome measure, stopping or decision rule, and practical constraints. Do not run experiments, contact people, purchase anything, or change external systems as part of this research brief. Conclude with what would change the answer.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { prompt, question, output: input.output, webSearch, deepResearch };
}
