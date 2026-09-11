/** A bounded arithmetic parser.
 *
 * Deliberately a parser and not an evaluator: the model supplies the
 * expression, so anything that could execute code is out of the question. It
 * accepts decimal numbers, parentheses and + - * / ^ and nothing else.
 *
 * Lives in the engines layer because both the browser workspace tools and the
 * server-side agent tools use it, and the server path must not have to import
 * browser modules to reach it.
 */
export function arithmetic(expression: string): number {
  if (
    typeof expression !== 'string' ||
    expression.length > 256 ||
    !/^[\d\s.eE+\-*/^()]+$/.test(expression)
  )
    throw Error('Use numbers, parentheses, + - * / ^ only.');
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?|[()+\-*/^]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s/g, ''))
    throw Error('Invalid arithmetic expression.');
  let i = 0,
    depth = 0;
  const checked = (n: number) => {
    if (!Number.isFinite(n) || Math.abs(n) > 1e100)
      throw Error('Result outside supported finite range.');
    return n;
  };
  function atom(): number {
    if (++depth > 32) throw Error('Expression is too deeply nested.');
    let v;
    if (tokens[i] === '(') {
      i++;
      v = add();
      if (tokens[i++] !== ')') throw Error('Missing closing parenthesis.');
    } else {
      const t = tokens[i++];
      if (!t || !/^\d|^\./.test(t)) throw Error('Expected a number.');
      v = Number(t);
    }
    depth--;
    return checked(v);
  }
  function power(): number {
    let v = atom();
    if (tokens[i] === '^') {
      i++;
      v = checked(v ** unary());
    }
    return v;
  }
  function unary(): number {
    if (tokens[i] === '+') {
      i++;
      return unary();
    }
    if (tokens[i] === '-') {
      i++;
      return -unary();
    }
    return power();
  }
  function mul(): number {
    let v = unary();
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++],
        r = unary();
      if (op === '/' && r === 0) throw Error('Division by zero.');
      v = checked(op === '*' ? v * r : v / r);
    }
    return v;
  }
  function add(): number {
    let v = mul();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++],
        r = mul();
      v = checked(op === '+' ? v + r : v - r);
    }
    return v;
  }
  const result = add();
  if (i !== tokens.length) throw Error('Unexpected input after expression.');
  return checked(result);
}
