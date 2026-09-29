/** Reading and writing the owner's workspace files.
 *
 * The old surface had these too, over files held in the browser's workspace
 * blob. Moving them to rows changes what the agent can actually do with them: a
 * file written in one conversation is there in the next, and it survives the tab
 * that wrote it — which is the difference between a scratchpad and a workspace.
 *
 * Not gated behind approval. These write inside the owner's own workspace, which
 * nothing else reads and no program runs; a file written here has no effect
 * until someone asks for one. `bash` and `ssh_exec` are gated because they act
 * on a machine.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { FileError, MAX_FILE_CHARACTERS, type FileStore } from '../../files/store.ts';

export type FileToolContext = {
  userId: string;
  files: FileStore;
};

/** How much of a file one read returns, when the caller does not say. */
const DEFAULT_WINDOW = 12_000;
const MAX_WINDOW = 40_000;

/** A refusal the model can act on, rather than a stack trace it cannot. */
const refuse = (error: unknown) => ({
  error: error instanceof FileError ? error.message : 'That file operation did not work.',
});

export function fileTools(context: FileToolContext) {
  return {
    list_files: tool({
      description:
        'List the files in this workspace, with their sizes. Names and sizes only — use read_file for contents. Prefer this over `ls` via bash for listing workspace files.',
      inputSchema: z.object({}),
      execute: async () => {
        // Named apart from the listing: usage carries a file *count*, and
        // spreading it over a key called `files` would replace the list with a
        // number.
        const { files: count, characters } = context.files.usage(context.userId);
        return { files: context.files.list(context.userId), count, characters };
      },
    }),

    read_file: tool({
      description:
        'Read a workspace file, in windows. Use the returned nextOffset to continue a long file rather than asking for it all at once. Prefer this over `cat`/`head`/`tail` via bash when you only need a workspace file’s contents.',
      inputSchema: z.object({
        path: z.string().min(1).max(700),
        offset: z.number().int().min(0).max(MAX_FILE_CHARACTERS).optional(),
        limit: z.number().int().min(1).max(MAX_WINDOW).optional(),
      }),
      execute: async ({ path, offset = 0, limit = DEFAULT_WINDOW }) => {
        try {
          const file = context.files.read(context.userId, path);
          // Named as missing rather than thrown, so the model can create it or
          // correct the name instead of ending its turn.
          if (!file) return { error: `There is no file called "${path}".` };
          const content = file.body.slice(offset, offset + limit);
          return {
            path: file.path,
            content,
            // null rather than absent, so "there is more" is a value the model
            // reads rather than an absence it has to infer.
            nextOffset: offset + limit < file.body.length ? offset + limit : null,
            length: file.body.length,
          };
        } catch (error) {
          return refuse(error);
        }
      },
    }),

    write_file: tool({
      description:
        'Create or replace a workspace file. Writing an existing path replaces it entirely, so read it first if you mean to change only part of it. Folders are allowed: "src/app.ts".',
      inputSchema: z.object({
        path: z.string().min(1).max(700),
        content: z.string().max(MAX_FILE_CHARACTERS),
      }),
      execute: async ({ path, content }) => {
        try {
          const file = context.files.write(context.userId, path, content);
          return {
            path: file.path,
            length: content.length,
            ...context.files.usage(context.userId),
          };
        } catch (error) {
          return refuse(error);
        }
      },
    }),

    delete_file: tool({
      description: 'Remove a workspace file. Deleting something that is not there is not an error.',
      inputSchema: z.object({ path: z.string().min(1).max(700) }),
      execute: async ({ path }) => {
        try {
          return { path, deleted: context.files.delete(context.userId, path) };
        } catch (error) {
          return refuse(error);
        }
      },
    }),
  };
}
