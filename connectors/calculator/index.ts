/** Calculator connector: safe arithmetic evaluation.
 *
 * Manifest claims: evaluates an arithmetic expression and returns the
 * result. No `eval`, no Function constructor — a small tokenizer and
 * recursive-descent parser, so a hostile expression cannot escape into code
 * execution. Permission requested: `calc:compute`.
 */
import type { ConnectorDefinition, ConnectorResult } from '@/lib/catalog/connector.ts';

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '%' | '^' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

function tokenize(expression: string): Token[] | { error: string } {
  const tokens: Token[] = [];
  let i = 0;
  const fail = (error: string) => ({ error });
  while (i < expression.length) {
    const ch = expression[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      let dots = 0;
      while (
        j < expression.length &&
        ((expression[j] >= '0' && expression[j] <= '9') || expression[j] === '.')
      ) {
        if (expression[j] === '.') dots++;
        j++;
      }
      if (dots > 1) return fail(`Bad number near "${expression.slice(i, j)}".`);
      const value = Number(expression.slice(i, j));
      if (!Number.isFinite(value)) return fail(`Bad number near "${expression.slice(i, j)}".`);
      tokens.push({ kind: 'number', value });
      i = j;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '^') {
      tokens.push({ kind: 'op', op: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    return fail(
      `Unexpected character "${ch}". Only digits, decimal points, +-*/%^ and parentheses are allowed.`,
    );
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    const value = this.expr();
    if (this.pos < this.tokens.length) throw new Error('Unexpected trailing input.');
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expr(): number {
    let value = this.term();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.op === '+' || t.op === '-')) {
        this.pos++;
        const rhs = this.term();
        value = t.op === '+' ? value + rhs : value - rhs;
      } else return value;
    }
  }

  private term(): number {
    let value = this.factor();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.op === '*' || t.op === '/' || t.op === '%')) {
        this.pos++;
        const rhs = this.factor();
        if (t.op === '*') value *= rhs;
        else if (t.op === '/') {
          if (rhs === 0) throw new Error('Division by zero.');
          value /= rhs;
        } else {
          if (rhs === 0) throw new Error('Division by zero.');
          value %= rhs;
        }
      } else return value;
    }
  }

  /** Right-associative exponent. */
  private factor(): number {
    const base = this.unary();
    const t = this.peek();
    if (t?.kind === 'op' && t.op === '^') {
      this.pos++;
      return Math.pow(base, this.factor());
    }
    return base;
  }

  private unary(): number {
    const t = this.peek();
    if (t?.kind === 'op' && (t.op === '-' || t.op === '+')) {
      this.pos++;
      const value = this.unary();
      return t.op === '-' ? -value : value;
    }
    return this.primary();
  }

  private primary(): number {
    const t = this.peek();
    if (!t) throw new Error('The expression ended unexpectedly.');
    if (t.kind === 'number') {
      this.pos++;
      return t.value;
    }
    if (t.kind === 'lparen') {
      this.pos++;
      const value = this.expr();
      const close = this.peek();
      if (close?.kind !== 'rparen') throw new Error('A closing parenthesis is missing.');
      this.pos++;
      return value;
    }
    throw new Error('A number or an opening parenthesis was expected here.');
  }
}

function evaluate(expression: string): number {
  const tokens = tokenize(expression);
  if (!Array.isArray(tokens)) throw new Error(tokens.error);
  if (tokens.length === 0) throw new Error('The expression is empty.');
  const result = new Parser(tokens).parse();
  if (!Number.isFinite(result)) throw new Error('The result is not a finite number.');
  return result;
}

export const definition: ConnectorDefinition = {
  name: 'calculator',
  requiredPermissions: ['calc:compute'],
  run(input: unknown): ConnectorResult {
    const expression = (input as { expression?: unknown } | null)?.expression;
    if (typeof expression !== 'string' || expression.trim().length === 0)
      return { ok: false, code: 'bad-input', error: 'Pass { "expression": "2 * (3 + 4)" }.' };
    if (expression.length > 500)
      return {
        ok: false,
        code: 'expression-too-long',
        error: 'Expressions are limited to 500 characters.',
      };
    try {
      return { ok: true, data: { expression, result: evaluate(expression) } };
    } catch (error) {
      return {
        ok: false,
        code: 'evaluation-failed',
        error: error instanceof Error ? error.message : 'Could not evaluate.',
      };
    }
  },
};
