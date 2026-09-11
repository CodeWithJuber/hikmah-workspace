import {sqliteTable, text, integer, primaryKey} from 'drizzle-orm/sqlite-core';
export const kernelOwners=sqliteTable('kernel_owners',{id:text('id').primaryKey(),userId:text('user_id').notNull(),createdAt:text('created_at').notNull()});
export const kernelStates=sqliteTable('kernel_states',{userId:text('user_id').primaryKey(),body:text('body').notNull(),revision:integer('revision').notNull().default(0),updatedAt:text('updated_at').notNull()});
export const workspaceStates=sqliteTable('workspace_states',{userId:text('user_id').primaryKey(),body:text('body').notNull(),revision:integer('revision').notNull().default(0),updatedAt:text('updated_at').notNull()});

export const contextVersions=sqliteTable('context_versions',{id:text('id').primaryKey(),userId:text('user_id').notNull(),language:text('language').notNull(),blobKey:text('blob_key').notNull(),receipt:text('receipt').notNull(),createdAt:text('created_at').notNull()});
export const contextActive=sqliteTable('context_active',{id:text('id').primaryKey(),userId:text('user_id').notNull(),language:text('language').notNull(),versionId:text('version_id').notNull(),revision:integer('revision').notNull().default(0)});

export const sharedKnowledge=sqliteTable('shared_knowledge',{id:text('id').primaryKey(),body:text('body').notNull(),updatedAt:text('updated_at').notNull()});

export const workspaceSecrets=sqliteTable('workspace_secrets',{userId:text('user_id').notNull(),name:text('name').notNull(),destination:text('destination').notNull(),sealed:text('sealed').notNull(),updatedAt:text('updated_at').notNull()},table=>[primaryKey({columns:[table.userId,table.name]})]);
