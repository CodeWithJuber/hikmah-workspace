/** The owner's agents.
 *
 * Seeded from the built-in templates on first read rather than by a migration,
 * because a migration runs once per database and these belong to a person.
 *
 * Seeded only when the owner has none at all, which is a deliberate difference
 * from the MCP catalogue. Those are a managed list where a server added later
 * genuinely should reach existing owners. An agent is a starting point the owner
 * then owns: once they have edited, renamed or deleted one, re-seeding by name
 * would resurrect what they threw away and sit the original next to their
 * version of it. The cost is that a template added later reaches only new
 * owners, which is the right side to err on for something that is theirs.
 */
import { AGENT_TEMPLATES, BUILT_IN_TOOLS } from './templates.ts';

export type AgentRow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  instructions: string;
  /** JSON array of built-in tool names. Empty means "everything on offer". */
  tools: string;
  model: string;
  built_in: number;
  created_at: string;
  updated_at: string;
};

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  model: string;
  builtIn: boolean;
};

export class AgentError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
  }
}

/** One person's presets; more than this is a list nobody reads. */
const MAX_AGENTS = 60;

export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

const text = (value: unknown, limit: number, field: string): string => {
  if (typeof value !== 'string') throw new AgentError(`${field} is text.`);
  const trimmed = value.trim();
  if (trimmed.length > limit)
    throw new AgentError(`${field} is limited to ${limit.toLocaleString()} characters.`);
  return trimmed;
};

/** Only tools that exist, so an agent cannot be saved that offers nothing. */
function toolList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AgentError('Tools are a list of names.');
  const names = [...new Set(value.filter((name): name is string => typeof name === 'string'))];
  const unknown = names.filter((name) => !BUILT_IN_TOOLS.includes(name));
  // Named rather than dropped: an agent silently missing the tool its owner
  // chose is worse than one that would not save.
  if (unknown.length) throw new AgentError(`Not a tool in this workspace: ${unknown.join(', ')}.`);
  return names;
}

export function toAgent(row: AgentRow): Agent {
  let tools: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tools);
    if (Array.isArray(parsed))
      tools = parsed.filter((name): name is string => typeof name === 'string');
  } catch {
    /* a row written by something else reads as "every tool", not as an error */
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    tools,
    model: row.model,
    builtIn: row.built_in === 1,
  };
}

export function createAgentStore(
  db: SqliteHandle,
  options: { now?: () => string; newId?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId =
    options.newId ??
    (() => 'agent_' + Math.random().toString(36).slice(2) + Date.now().toString(36));

  const statements = {
    list: db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY built_in DESC, name'),
    get: db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM agents WHERE user_id = ?'),
    seeded: db.prepare('SELECT COUNT(*) AS n FROM agents WHERE user_id = ? AND built_in = 1'),
    insert: db.prepare(
      `INSERT INTO agents
         (id, user_id, name, description, instructions, tools, model, built_in, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE agents SET name = ?, description = ?, instructions = ?, tools = ?, model = ?, updated_at = ?
       WHERE id = ? AND user_id = ? RETURNING id`,
    ),
    remove: db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ? RETURNING id'),
  };

  function seed(userId: string) {
    // An owner with any agent at all has been here before, and what they have
    // is theirs. Only an empty workspace gets the templates.
    if ((statements.count.get(userId) as { n: number }).n > 0) return;
    const stamp = now();
    for (const template of AGENT_TEMPLATES) {
      statements.insert.run(
        newId(),
        userId,
        template.name,
        template.description,
        template.instructions,
        JSON.stringify(template.tools),
        '',
        1,
        stamp,
        stamp,
      );
    }
  }

  const store = {
    list(userId: string): Agent[] {
      seed(userId);
      return (statements.list.all(userId) as AgentRow[]).map(toAgent);
    },

    get(id: string, userId: string): Agent | null {
      const row = (statements.get.get(id, userId) ?? null) as AgentRow | null;
      return row ? toAgent(row) : null;
    },

    /** Create one, or replace one this owner already has. */
    save(
      userId: string,
      input: {
        id?: string;
        name: unknown;
        description?: unknown;
        instructions?: unknown;
        tools?: unknown;
        model?: unknown;
      },
    ): Agent {
      const name = text(input.name, 80, 'The name');
      if (!name) throw new AgentError('Give the agent a name.');
      const description = text(input.description ?? '', 240, 'The description');
      const instructions = text(input.instructions ?? '', 12_000, 'The instructions');
      const model = text(input.model ?? '', 256, 'The model');
      const tools = JSON.stringify(toolList(input.tools));
      const stamp = now();

      if (input.id) {
        const updated = statements.update.get(
          name,
          description,
          instructions,
          tools,
          model,
          stamp,
          input.id,
          userId,
        );
        // Not found and not yours are the same answer, so the reply cannot be
        // used to discover that someone else's agent exists.
        if (!updated) throw new AgentError('Agent not found.', 404);
        return store.get(input.id, userId)!;
      }

      const { n } = statements.count.get(userId) as { n: number };
      if (n >= MAX_AGENTS) throw new AgentError(`This workspace holds up to ${MAX_AGENTS} agents.`);

      const id = newId();
      statements.insert.run(
        id,
        userId,
        name,
        description,
        instructions,
        tools,
        model,
        0,
        stamp,
        stamp,
      );
      return store.get(id, userId)!;
    },

    /** Returns false when it was not this owner's, which is not an error. */
    delete(id: string, userId: string): boolean {
      return (statements.remove.get(id, userId) ?? null) !== null;
    },
  };

  return store;
}

export type AgentStore = ReturnType<typeof createAgentStore>;
