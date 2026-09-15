/** What a spawned process is allowed to inherit.
 *
 * An allowlist rather than a denylist. A denylist has to be updated every time
 * the service gains a variable, and the cost of forgetting once is the owner's
 * vault key sitting in `env` output. An allowlist fails the other way: a missing
 * variable is a visible annoyance.
 *
 * This lived in `terminal.ts`, which meant the interactive shell was filtered
 * and the assistant's commands were not — `shell.ts` spawned with the whole of
 * `process.env`. It is its own module now so both paths can use it without
 * `shell.ts` having to import `node-pty`.
 */

const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'HOSTNAME',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLORTERM',
];
/** Locale variables are a family, not a fixed list. */
const INHERITED_PREFIXES = ['LC_'];

/** The allowlist itself, with nothing added. */
function inherited(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (INHERITED_ENV.includes(key) || INHERITED_PREFIXES.some((p) => key.startsWith(p)))
      env[key] = value;
  }
  return env;
}

/** Only the variables an interactive shell genuinely needs cross into it. */
export function shellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = inherited(source);
  // A pty with no TERM leaves curses programs drawing nothing at all.
  env.TERM = env.TERM ?? 'xterm-256color';
  env.COLORTERM = env.COLORTERM ?? 'truecolor';
  return env;
}

/**
 * The same allowlist, for a command whose output the model reads.
 *
 * `TERM=dumb` and no `COLORTERM`: this output goes into a transcript, not onto a
 * screen, and a program that decides to emit colour escapes makes it worse to
 * read for no gain. The interactive path wants the opposite, which is why these
 * are two functions over one list rather than one function with a flag.
 */
export function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = inherited(source);
  delete env.COLORTERM;
  env.TERM = 'dumb';
  return env;
}
