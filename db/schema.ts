import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
export const kernelOwners = sqliteTable('kernel_owners', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: text('created_at').notNull(),
});
export const kernelStates = sqliteTable('kernel_states', {
  userId: text('user_id').primaryKey(),
  body: text('body').notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});
export const workspaceStates = sqliteTable('workspace_states', {
  userId: text('user_id').primaryKey(),
  body: text('body').notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

export const contextVersions = sqliteTable('context_versions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  language: text('language').notNull(),
  blobKey: text('blob_key').notNull(),
  receipt: text('receipt').notNull(),
  createdAt: text('created_at').notNull(),
});
export const contextActive = sqliteTable('context_active', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  language: text('language').notNull(),
  versionId: text('version_id').notNull(),
  revision: integer('revision').notNull().default(0),
});

export const sharedKnowledge = sqliteTable('shared_knowledge', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workspaceSecrets = sqliteTable(
  'workspace_secrets',
  {
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    destination: text('destination').notNull(),
    sealed: text('sealed').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.name] })],
);

export const chatSettings = sqliteTable('chat_settings', {
  userId: text('user_id').primaryKey(),
  body: text('body').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const userTiers = sqliteTable('user_tiers', {
  userId: text('user_id').primaryKey(),
  tier: text('tier').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const usageEvents = sqliteTable('usage_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  runId: text('run_id').notNull(),
  model: text('model').notNull(),
  metered: integer('metered').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const contextCandidates = sqliteTable(
  'context_candidates',
  {
    userId: text('user_id').notNull(),
    language: text('language').notNull(),
    fingerprint: text('fingerprint').notNull(),
    text: text('text').notNull(),
    annotation: text('annotation').notNull(),
    uncertainty: real('uncertainty').notNull(),
    tokens: integer('tokens').notNull(),
    createdAt: text('created_at').notNull(),
    reviewedAt: text('reviewed_at'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.language, table.fingerprint] })],
);

export const learningPolicies = sqliteTable('learning_policies', {
  userId: text('user_id').primaryKey(),
  enabled: integer('enabled').notNull().default(0),
  useApproved: integer('use_approved').notNull().default(1),
  collectSyntax: integer('collect_syntax').notNull().default(0),
  retentionDays: integer('retention_days').notNull().default(30),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

export const learningExamples = sqliteTable('learning_examples', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  runId: text('run_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull().default('pending'),
  prompt: text('prompt').notNull(),
  response: text('response').notNull(),
  correction: text('correction'),
  redactions: text('redactions').notNull(),
  createdAt: text('created_at').notNull(),
  reviewedAt: text('reviewed_at'),
  revision: integer('revision').notNull().default(0),
});
