// The GitHub client against a stubbed fetch: no test ever touches the real
// API. Run: node --test tests/github-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient, GitHubApiError, paramsHash } from '../lib/github/client.ts';

const headers = (extra = {}) => ({
  get: (name) => extra[name.toLowerCase()] ?? null,
});

const jsonResponse = (status, payload, headerExtra) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: headers(headerExtra),
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

const stubFetch = (handler) => async (url, init) => handler(url, init);

test('getFileContent decodes the base64 payload', async () => {
  const seen = [];
  const client = createGitHubClient({
    token: 't',
    fetchImpl: stubFetch(async (url, init) => {
      seen.push([url, init]);
      return jsonResponse(200, {
        type: 'file',
        path: 'README.md',
        sha: 'abc',
        encoding: 'base64',
        content: Buffer.from('hello\n').toString('base64'),
      });
    }),
  });
  const file = await client.getFileContent({ owner: 'o', repo: 'r', path: 'README.md' });
  assert.equal(file.content, 'hello\n');
  assert.equal(file.sha, 'abc');
  assert.ok(seen[0][0].includes('/repos/o/r/contents/README.md'));
  assert.ok(String(seen[0][1].headers.authorization).startsWith('Bearer '));
});

test('a directory at the path is a not-found, not a file', async () => {
  const client = createGitHubClient({
    token: 't',
    fetchImpl: stubFetch(async () => jsonResponse(200, { type: 'dir' })),
  });
  await assert.rejects(
    () => client.getFileContent({ owner: 'o', repo: 'r', path: 'src' }),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.kind, 'not-found');
      return true;
    },
  );
});

test('401 and 403 classify as auth failures', async () => {
  for (const status of [401, 403]) {
    const client = createGitHubClient({
      token: 'bad',
      fetchImpl: stubFetch(async () => jsonResponse(status, { message: 'nope' })),
    });
    await assert.rejects(
      () => client.verifyToken(),
      (error) => {
        assert.ok(error instanceof GitHubApiError);
        assert.equal(error.kind, 'auth');
        assert.equal(error.status, status);
        return true;
      },
    );
  }
});

test('a 500 classifies as a retryable server failure', async () => {
  const client = createGitHubClient({
    token: 't',
    fetchImpl: stubFetch(async () => jsonResponse(502, { message: 'bad gateway' })),
  });
  await assert.rejects(
    () => client.verifyToken(),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.kind, 'server');
      return true;
    },
  );
});

test('a network failure classifies as network, not server', async () => {
  const client = createGitHubClient({
    token: 't',
    fetchImpl: stubFetch(async () => {
      throw new Error('socket hang up');
    }),
  });
  await assert.rejects(
    () => client.verifyToken(),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.kind, 'network');
      return true;
    },
  );
});

test('rate limiting is its own kind', async () => {
  const client = createGitHubClient({
    token: 't',
    fetchImpl: stubFetch(async () =>
      jsonResponse(429, { message: 'too many' }, { 'x-ratelimit-remaining': '0' }),
    ),
  });
  await assert.rejects(
    () => client.listIssues({ owner: 'o', repo: 'r' }),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.kind, 'rate-limit');
      return true;
    },
  );
});

test('createDraftPull posts draft:true and returns the PR', async () => {
  let sent;
  const client = createGitHubClient({
    token: 't',
    fetchImpl: stubFetch(async (url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse(201, {
        number: 7,
        html_url: 'https://github.com/o/r/pull/7',
        head: { ref: 'fix' },
        base: { ref: 'main' },
        draft: true,
      });
    }),
  });
  const pull = await client.createDraftPull({
    owner: 'o',
    repo: 'r',
    title: 'Fix',
    body: 'b',
    head: 'fix',
    base: 'main',
  });
  assert.equal(pull.number, 7);
  assert.equal(pull.draft, true);
  assert.equal(sent.draft, true);
  assert.equal(sent.title, 'Fix');
});

test('paramsHash is stable and content-bound', () => {
  const a = paramsHash({ owner: 'o', repo: 'r' });
  const b = paramsHash({ owner: 'o', repo: 'r' });
  const c = paramsHash({ owner: 'o', repo: 'x' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});
