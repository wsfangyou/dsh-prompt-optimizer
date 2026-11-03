/**
 * dsh-prompt-optimizer 冒烟测试:纯契约 + 结构校验(无网络、无浏览器)。
 * 覆盖:宿主 Config 默认值与启动校验、stripFence/resolveRoute 纯函数、
 * /prompt-optimizer/optimize 路由各分支(405/403/400/413/503/成功/模型报错/围栏剥离)、
 * 浏览器 bundle 的注册形态(slots/locale/条目)与 makeOptimize 的 fetch 契约,
 * 以及包清单/patch/两端常量的一致性。
 *
 * 从安装位置运行:node test/smoke.mjs(依赖经 profile 祖先 node_modules 解析)。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const results = [];
const ok = (label) => { results.push(`[OK] ${label}`); console.log(`[OK] ${label}`); };

// ── 1) 宿主纯函数与 Config ────────────────────────────────────────────────
const host = await import("../lib/index.js");
const parse = (schema, data) => schema["~standard"].validate(data);
{
	const defaults = parse(host.Config, {}).value;
	assert.equal(defaults.provider, "");
	assert.equal(defaults.model, "");
	assert.equal(defaults.maxInputChars, 16000);
	assert.equal(defaults.maxOutputTokens, 1500);
	assert.equal(defaults.timeoutMs, 45000);
	ok("host Config: defaults");
}
{
	assert.equal(host.stripFence("```\n优化后文本\n```"), "优化后文本", "fence stripped");
	assert.equal(host.stripFence("```markdown\nA\nB\n```"), "A\nB", "lang tag stripped");
	assert.equal(host.stripFence("普通文本"), "普通文本", "plain passthrough");
	assert.equal(host.stripFence("```\n内层 `code` 保留\n```"), "内层 `code` 保留", "only outer fence stripped");
	assert.equal(host.stripFence("内层 ```fence``` 保留"), "内层 ```fence``` 保留", "no outer fence = untouched");
	ok("host stripFence: outer fence only");
}
{
	const cfg = (provider, model) => ({ provider, model });
	const route = { provider: "p1", model: "m1" };
	const svc = { currentSelection: () => ({ provider: "pd", model: "md" }) };
	assert.deepEqual(host.resolveRoute(cfg("pc", "mc"), route, svc), { provider: "pc", model: "mc" }, "config wins");
	assert.deepEqual(host.resolveRoute(cfg("", ""), route, svc), { provider: "p1", model: "m1" }, "session route second");
	assert.deepEqual(host.resolveRoute(cfg("", ""), null, svc), { provider: "pd", model: "md" }, "default model third");
	assert.deepEqual(host.resolveRoute(cfg("", ""), { provider: "x" }, svc), { provider: "pd", model: "md" }, "partial session route skipped, falls to default");
	assert.equal(host.resolveRoute(cfg("", ""), null, void 0), null, "nothing resolvable -> null");
	ok("host resolveRoute: precedence chain");
}

// ── 2) 路由各分支 ─────────────────────────────────────────────────────────
function mockReq({ method = "POST", headers = {}, body = "{}" }) {
	return {
		method,
		headers,
		async *[Symbol.asyncIterator]() { yield Buffer.from(body, "utf8"); },
	};
}
function mockRes() {
	return {
		statusCode: 0,
		headers: {},
		body: "",
		headersSent: false,
		setHeader(k, v) { this.headers[k] = v; },
		end(b) { this.headersSent = true; this.body = b ?? ""; },
		json() { return JSON.parse(this.body); },
	};
}
const goodHeaders = { origin: "http://127.0.0.1:55999", host: "127.0.0.1:55999", "x-dsh-prompt-optimizer": "1" };
const baseConfig = { provider: "", model: "", maxInputChars: 100, maxOutputTokens: 50, timeoutMs: 5000 };
{
	const route = host.makeRouteHandler({ llm: void 0, agentDefaultModel: void 0 }, baseConfig);
	const res1 = mockRes();
	await route(mockReq({ method: "GET", headers: goodHeaders }), res1);
	assert.equal(res1.statusCode, 405);
	const res2 = mockRes();
	await route(mockReq({ headers: { ...goodHeaders, "x-dsh-prompt-optimizer": void 0 } }), res2);
	assert.equal(res2.statusCode, 403);
	const res3 = mockRes();
	await route(mockReq({ headers: { ...goodHeaders, origin: "http://evil.example" } }), res3);
	assert.equal(res3.statusCode, 403, "cross-origin rejected");
	const res4 = mockRes();
	await route(mockReq({ headers: goodHeaders, body: "not-json" }), res4);
	assert.equal(res4.statusCode, 400);
	const res5 = mockRes();
	await route(mockReq({ headers: goodHeaders, body: JSON.stringify({ text: "   " }) }), res5);
	assert.equal(res5.statusCode, 400, "blank text rejected");
	const res6 = mockRes();
	await route(mockReq({ headers: goodHeaders, body: JSON.stringify({ text: "字".repeat(101) }) }), res6);
	assert.equal(res6.statusCode, 413, "over maxInputChars rejected");
	const res7 = mockRes();
	await route(mockReq({ headers: goodHeaders, body: JSON.stringify({ text: "做个工具" }) }), res7);
	assert.equal(res7.statusCode, 503, "no route resolvable -> 503");
	assert.equal(res7.json().error.startsWith("model-not-configured"), true);
	ok("host route: 405/403/400/413/503 branches");
}
{
	let captured;
	const stream = host.makeRouteHandler(
		{
			agentDefaultModel: { currentSelection: () => ({ provider: "ap", model: "am" }) },
			llm: {
				stream(options) {
					captured = options;
					return (async function* () {
						yield { type: "text-delta", index: 0, text: "```markdown\n" };
						yield { type: "text-delta", index: 0, text: "改写一\n改写二" };
						yield { type: "text-delta", index: 0, text: "\n```" };
					})();
				},
			},
		},
		baseConfig,
	);
	const res = mockRes();
	await stream(mockReq({ headers: goodHeaders, body: JSON.stringify({ text: "原提示词" }) }), res);
	assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
	assert.equal(res.json().optimized, "改写一\n改写二", "fenced output cleaned");
	assert.equal(res.json().model, "ap/am");
	assert.equal(captured.provider, "ap");
	assert.equal(captured.model, "am");
	assert.equal(captured.system, host.SYSTEM_PROMPT);
	assert.equal(captured.messages.length, 1, "one message built");
	assert.ok(Array.isArray(captured.messages[0].content) && captured.messages[0].content.length === 1, "single content part");
	assert.equal(captured.messages[0].content[0].text, "原提示词", "draft passed verbatim");
	assert.equal(captured.maxTokens, 50);
	ok("host route: success path (default model, fence strip, stream options)");
}
{
	const failing = host.makeRouteHandler(
		{
			agentDefaultModel: void 0,
			llm: { stream() { throw new Error("AUTH: no api key"); } },
		},
		baseConfig,
	);
	const res = mockRes();
	await failing(mockReq({ headers: goodHeaders, body: JSON.stringify({ text: "abc", route: { provider: "pp", model: "pm" } }) }), res);
	assert.equal(res.statusCode, 502, "provider failure surfaces as 502");
	assert.equal(res.json().ok, false);
	assert.match(res.json().error, /no api key/);
	ok("host route: model failure -> 502 with message");
}

// ── 3) 浏览器 bundle(沙箱求值,stub react)──────────────────────────────
{
	const code = readFileSync(path.join(pkgDir, "lib", "client.js"), "utf8");
	assert.ok(!code.includes("</style"), "client CSS must not contain </style");
	const jsxRuntime = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
	const FakeReact = {
		useState: (init) => [init, () => {}],
		useRef: (init) => ({ current: init }),
		useEffect: () => {},
	};
	const styles = [];
	const dom = {
		head: { appendChild: (el) => styles.push(el) },
		getElementById: () => null,
		createElement: () => ({ id: "", textContent: "" }),
	};
	let definition;
	const win = { __ModuleLoader__: { load: (def) => { definition = def; } } };
	new Function("window", "document", code)(win, dom);
	assert.ok(definition, "bundle registers via __ModuleLoader__.load");
	assert.equal(definition.id, "dsh-prompt-optimizer", "bundle id = package name");
	const required = [];
	const bundle = definition.factory((id) => {
		required.push(id);
		if (id === "react") return FakeReact;
		if (id === "react/jsx-runtime") return jsxRuntime;
		throw new Error(`unexpected require ${id}`);
	});
	assert.deepEqual(bundle.inject, ["slots", "locale"], "ctx keys declared");
	// fake client ctx
	const dicts = [];
	const registrations = [];
	let parentSlot;
	const ctx = {
		effect(fn) { const dispose = fn(); ctx._disposers.push(dispose); },
		_disposers: [],
		locale: { register: (ns, dict) => { dicts.push([ns, dict]); return () => {}; } },
		slots: {
			inject: (name, fn) => { parentSlot = name; registrations.push(fn()); },
			register: (opts, Comp) => ({ opts, Comp }),
		},
	};
	bundle.apply(ctx);
	assert.deepEqual(required.sort(), ["react", "react/jsx-runtime"], "only platform modules required");
	assert.equal(styles.length, 1, "style injected once");
	assert.equal(styles[0].id, "dsh-prompt-optimizer-styles", "style carries the plugin id");
	assert.equal(dicts[0][0], bundle.NS, "dictionary registered under NS");
	for (const lang of ["zh", "en"]) {
		const keys = Object.keys(dicts[0][1][lang]);
		for (const key of ["button", "busy", "done", "changed", "failed", "network", "title"]) {
			assert.ok(keys.includes(key), `${lang} has ${key}`);
		}
	}
	assert.equal(new Set(Object.keys(dicts[0][1].zh)).size, Object.keys(dicts[0][1].zh).length, "zh keys unique");
	assert.deepEqual(Object.keys(dicts[0][1].zh).sort(), Object.keys(dicts[0][1].en).sort(), "zh/en key parity");
	assert.equal(parentSlot, "conversation.input.left", "slot parent");
	const entry = registrations[0];
	assert.equal(entry.opts.name, "conversation.input.left");
	assert.equal(entry.opts.id, "prompt-optimizer", "entry id");
	assert.equal(entry.opts.locale, bundle.NS);
	assert.equal(typeof entry.Comp, "function", "component registered");
	const injected = entry.opts.inject();
	assert.equal(typeof injected.optimize, "function", "optimize action injected");
	ok("client bundle: load shape, dictionary parity, slot registration");

	// makeOptimize 的 fetch 契约
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		return {
			status: 200,
			json: async () => ({ ok: true, optimized: "优化后", model: "p/m" }),
		};
	};
	const out = await injected.optimize("原文", { provider: "p", model: "m" });
	assert.equal(out, "优化后");
	assert.equal(calls[0].url, bundle.ROUTE_PATH);
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers[bundle.REQUEST_HEADER], "1");
	assert.deepEqual(JSON.parse(calls[0].init.body), { text: "原文", route: { provider: "p", model: "m" } });
	globalThis.fetch = async () => ({ status: 502, json: async () => ({ ok: false, error: "boom" }) });
	await assert.rejects(() => injected.optimize("x", null), /boom/, "server error message thrown");
	globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
	await assert.rejects(() => injected.optimize("x", null), /Failed to fetch/, "network failure rethrown");
	ok("client makeOptimize: headers, body, error surfacing");
}

// ── 4) 清单与跨端一致性 ──────────────────────────────────────────────────
{
	const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	assert.equal(pkg.name, "dsh-prompt-optimizer");
	assert.equal(pkg.main, "lib/index.js");
	assert.equal(pkg.exports["./client"], "./lib/client.js");
	assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
	assert.equal(pkg.dsh.client.platform, "web");
	assert.equal(pkg.dsh.client.immediately, true, "composer button must run at startup");
	const patch = readFileSync(path.join(pkgDir, "cordis.patch.yml"), "utf8");
	assert.match(patch, /id: prompt-optimizer/);
	assert.match(patch, /name: dsh-prompt-optimizer/);
	assert.equal(host.name, "prompt-optimizer", "entry id = host plugin name");
	assert.equal(host.ROUTE_PATH, "/prompt-optimizer/optimize");
	ok("manifest + patch + cross-side constants aligned");
}

console.log(`\n${results.length} groups passed.`);
