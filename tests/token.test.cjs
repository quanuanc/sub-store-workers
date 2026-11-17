const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// Exercise the Workers override, with an in-memory replacement for KV storage.
const code = transformSync(
    readFileSync(path.join(__dirname, '../src/restful/token.js'), 'utf8'),
    { format: 'cjs' },
).code;

function setup(tokens) {
    let writes = 0;
    const app = {
        read: () => tokens,
        write: (value) => { tokens = value; writes++; },
    };
    const dependencies = {
        '@/core/app': app,
        '@/constants': { TOKENS_KEY: 'tokens' },
        '@/vendor/open-api': {},
        '@/restful/response': {},
        '@/restful/errors': {},
        '@/utils/database': {},
        '@/utils/create-item-position': {},
        '@/utils/archive': {},
        '@/utils/age': {},
    };
    const module = { exports: {} };
    vm.runInNewContext(code, {
        module,
        require: (name) => Object.hasOwn(dependencies, name)
            ? dependencies[name] : require(name),
    });
    return {
        consume: module.exports.consumeShareTokenForRequest,
        writes: () => writes,
        tokens: () => tokens,
    };
}

const share = (extra = {}) => ({ token: 'secret', type: 'sub', name: 'demo', ...extra });
const request = (extra = {}) => ({ query: { token: 'secret' }, params: { name: 'demo' }, ...extra });

test('consumes the last use once within a request, rejecting the next request', () => {
    const ctx = setup([share({ mode: 'count', count: 1, usedCount: 0 })]);
    const req = request();
    const result = ctx.consume(req, 'sub');
    assert.equal(result.usedCount, 1);
    assert.equal(ctx.consume(req, 'sub'), result);
    assert.equal(ctx.writes(), 1);
    assert.equal(ctx.consume(request(), 'sub'), null);
});

test('does not reuse the cached token for a different token, name, or type', () => {
    for (const [change, type] of [
        [(req) => { req.query.token = 'other'; }, 'sub'],
        [(req) => { req.params.name = 'other'; }, 'sub'],
        [() => {}, 'file'],
    ]) {
        const ctx = setup([share({ mode: 'count', count: 2 })]);
        const req = request();
        ctx.consume(req, 'sub');
        change(req);
        assert.equal(ctx.consume(req, type), null);
        assert.equal(ctx.writes(), 1);
    }
});

test('rejects expired, exhausted, and invalid count tokens without writing', () => {
    for (const extra of [
        { exp: Date.now() - 1000 },
        { mode: 'count', count: 1, usedCount: 1 },
        { mode: 'count', count: 0 },
        { mode: 'count', count: 2, usedCount: -1 },
    ]) {
        const ctx = setup([share(extra)]);
        const req = request();
        assert.equal(ctx.consume(req, 'sub'), null);
        assert.equal(req.subStoreShareToken, undefined);
        assert.equal(ctx.writes(), 0);
    }
});

test('allows unlimited and unexpired datetime tokens without updating storage', () => {
    for (const extra of [{}, { exp: Date.now() + 60000 }]) {
        const ctx = setup([share(extra)]);
        assert.equal(ctx.consume(request(), 'sub'), ctx.tokens()[0]);
        assert.equal(ctx.writes(), 0);
    }
});

test('handles missing request fields and unknown tokens', () => {
    const ctx = setup([share()]);
    for (const req of [{}, { params: { name: 'demo' } }, request({ query: { token: 'unknown' } })]) {
        assert.equal(ctx.consume(req, 'sub'), null);
    }
    assert.equal(ctx.writes(), 0);
});
