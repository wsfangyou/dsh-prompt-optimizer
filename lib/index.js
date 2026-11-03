/**
 * dsh-prompt-optimizer 宿主半边。
 *
 * 做一件事：注册 `POST /prompt-optimizer/optimize` 路由——浏览器端的「优化提示词」
 * 按钮把输入框草稿（以及当前会话已选定的模型路由）发来，本路由用 `ctx.llm.stream`
 * 发起一次**一次性、无工具、无历史**的改写调用，把改写后的提示词原文返回。
 *
 * 模型路由解析优先级（第一个可用者）：
 *   1. 条目 config 显式的 provider+model（固定改写模型时用）；
 *   2. 请求体里浏览器带来的会话投影路由（modelSelection.next ?? lastUsed）——
 *      与用户当前会话正在使用的模型保持一致；
 *   3. `ctx.agentDefaultModel.currentSelection()`（新会话默认模型）。
 * 三者都拿不到 → 503 `model-not-configured`。
 *
 * 改写契约（见 SYSTEM_PROMPT）：保持原意、不增删任务、输出仅含改写后的提示词本身。
 * 模型偶发用代码块围栏包裹输出时，服务端剥掉最外层围栏再返回。
 *
 * 与 dsh-ui-skin 同一套约定：写请求必须带 `x-dsh-prompt-optimizer: 1` 自定义头
 * （跨源自定义头必触发预检，天然挡 CSRF），Origin 存在时须与请求 Host 同机。
 *
 * @module dsh-prompt-optimizer
 */
import z from "@deepseek-ai/schemastery";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

/** Cordis 插件名（诊断用），与 cordis.patch.yml 的条目 id 一致。 */
const name = "prompt-optimizer";

/** 路由入口的绝对路径（exact，无尾斜杠）。 */
const ROUTE_PATH = "/prompt-optimizer/optimize";

/** 写请求必须携带的自定义头（与浏览器半边一致）。 */
const REQUEST_HEADER = "x-dsh-prompt-optimizer";

/** 请求体字节上限（草稿远小于此；超上限先拒，不喂给模型）。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * bundle 可配项（结构性字段，随补丁层静态配置）。
 * provider/model 必须成对给出；留空 = 自动（见模块头的解析优先级）。
 */
const Config = z.object({
	/** 固定改写模型 provider；空串 = 不固定。 */
	provider: z.string().default(""),
	/** 固定改写模型 id；空串 = 不固定。 */
	model: z.string().default(""),
	/** 草稿字符上限（超出直接 413，不发起模型调用）。 */
	maxInputChars: z.number().default(16000),
	/** 改写输出 token 上限。 */
	maxOutputTokens: z.number().default(1500),
	/** 单次改写的墙钟上限（毫秒）；超时按 504 报给浏览器。 */
	timeoutMs: z.number().default(45000),
});

/** 改写系统提示词：中文进中文出，保持原意，只输出结果本身。 */
const SYSTEM_PROMPT = [
	"你是提示词优化器。用户消息就是一段要发给 AI agent 的提示词草稿。把它改写得",
	"更精确、更结构化、更能被 agent 准确理解与执行，同时严格保持原意。规则：",
	"1. 不改变、不新增、不删减用户的目标与需求；只做表达上的澄清与组织。",
	"2. 保持原文语言：中文输入用中文改写，英文输入用英文改写。",
	"3. 把含糊指代改成明确对象；把多个诉求整理成有顺序的要点；补全隐含的执行框架",
	"   （目标、上下文、约束、期望输出），只允许从原文已能推出的内容中补。",
	"4. 原文中的专有名词、路径、代码、数字、文件名一律原样保留。",
	"5. 改写结果应同样简洁：默认不超过原文长度的约 3 倍，不堆砌套话。",
	"6. 只输出改写后的提示词本身——不要任何解释、前言、引号或代码块围栏。",
].join("");

/** 剥掉模型偶发套上的最外层代码块围栏（```…```），只剥一层。 */
function stripFence(text) {
	const match = /^```[^\n`]*\n([\s\S]*?)\n?```$/.exec(text.trim());
	return match ? match[1].trim() : text.trim();
}

/** 统一 JSON 响应。 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(body);
}

/** 一次性读完请求体，超过 maxBytes 立即抛 413。 */
async function readBody(req, maxBytes) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > maxBytes) {
			const error = new Error(`payload too large (limit ${maxBytes} bytes)`);
			error.status = 413;
			throw error;
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

/**
 * 校验写请求：自定义头 + Origin 同机双保险（与 dsh-ui-skin 的 assertWriteRequest 同构）。
 */
function assertWriteRequest(req) {
	const headers = req.headers ?? {};
	const custom = headers[REQUEST_HEADER];
	const present = Array.isArray(custom) ? custom[0] : custom;
	if (present !== "1") {
		const error = new Error(`missing ${REQUEST_HEADER} header`);
		error.status = 403;
		throw error;
	}
	const origin = headers.origin;
	if (typeof origin === "string" && origin.length > 0 && origin !== "null") {
		let originHost;
		try {
			originHost = new URL(origin).host;
		} catch {
			originHost = "";
		}
		const requestHost = typeof headers.host === "string" ? headers.host : "";
		if (originHost === "" || originHost !== requestHost) {
			const error = new Error("cross-origin write rejected");
			error.status = 403;
			throw error;
		}
	}
}

/**
 * 解析改写模型路由：config 固定值 → 浏览器带来的会话路由 → agent 默认模型。
 *
 * @param config - 已校验的条目配置。
 * @param bodyRoute - 请求体里的 `{provider, model}`（会话投影，可缺省/不完整）。
 * @param agentDefaultModel - agentDefaultModel 服务句柄（可为 undefined）。
 * @returns `{provider, model}` 或 null（无任何可用路由）。
 */
function resolveRoute(config, bodyRoute, agentDefaultModel) {
	if (config.provider !== "" && config.model !== "") {
		return { provider: config.provider, model: config.model };
	}
	if (bodyRoute !== null && typeof bodyRoute.provider === "string" && typeof bodyRoute.model === "string" && bodyRoute.provider !== "" && bodyRoute.model !== "") {
		return { provider: bodyRoute.provider, model: bodyRoute.model };
	}
	const selection = agentDefaultModel?.currentSelection?.();
	if (selection !== void 0 && typeof selection.provider === "string" && typeof selection.model === "string" && selection.provider !== "" && selection.model !== "") {
		return { provider: selection.provider, model: selection.model };
	}
	return null;
}

/**
 * `POST /prompt-optimizer/optimize` 处理器工厂。
 *
 * @param state - 惰性填充的服务句柄（`llm`、`agentDefaultModel`）。
 * @param config - 已校验配置。
 * @returns 注册给 webServer 的处理函数。
 */
function makeRouteHandler(state, config) {
	return async function route(req, res) {
		const method = (req.method ?? "GET").toUpperCase();
		if (method !== "POST") {
			sendJson(res, 405, { ok: false, error: `method ${method} not allowed; use POST` });
			return;
		}
		let status = 200;
		let payload;
		try {
			assertWriteRequest(req);
			const raw = await readBody(req, MAX_BODY_BYTES);
			let body;
			try {
				body = JSON.parse(raw.toString("utf8"));
			} catch {
				const error = new Error("body must be JSON");
				error.status = 400;
				throw error;
			}
			if (body === null || typeof body !== "object") {
				const error = new Error("body must be a JSON object");
				error.status = 400;
				throw error;
			}
			const text = typeof body.text === "string" ? body.text.trim() : "";
			if (text.length === 0) {
				const error = new Error("text is required and must not be blank");
				error.status = 400;
				throw error;
			}
			if (text.length > config.maxInputChars) {
				const error = new Error(`text is ${text.length} chars, exceeding maxInputChars ${config.maxInputChars}`);
				error.status = 413;
				throw error;
			}
			const route_ = resolveRoute(config, typeof body.route === "object" && body.route !== null ? body.route : null, state.agentDefaultModel);
			if (route_ === null) {
				sendJson(res, 503, { ok: false, error: "model-not-configured: pick a model for this session once, or set provider+model in the prompt-optimizer entry config" });
				return;
			}
			if (state.llm === undefined) {
				sendJson(res, 503, { ok: false, error: "llm service is not ready yet" });
				return;
			}
			const options = {
				provider: route_.provider,
				model: route_.model,
				system: SYSTEM_PROMPT,
				messages: [createUserMessage({
					content: [{ type: "text", text }],
					source: { kind: "dsh-prompt-optimizer" },
				})],
				maxTokens: config.maxOutputTokens,
				temperature: 0.2,
				signal: AbortSignal.timeout(config.timeoutMs),
			};
			const assembler = new BlockAssembler();
			for await (const chunk of state.llm.stream(options)) {
				assembler.push(chunk);
			}
			const optimized = stripFence(assembler.blocks()
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""));
			if (optimized.length === 0) {
				sendJson(res, 502, { ok: false, error: "model returned no text; try again" });
				return;
			}
			payload = { ok: true, optimized, model: `${route_.provider}/${route_.model}` };
		} catch (error) {
			status = Number.isInteger(error?.status) ? error.status : /timeout|abort/i.test(String(error?.name) + String(error?.message)) ? 504 : 502;
			payload = { ok: false, error: String(error?.message ?? error) };
			if (status >= 500 && error?.status === void 0) console.error("[dsh-prompt-optimizer] rewrite failure:", error);
		}
		sendJson(res, status, payload);
	};
}

/**
 * 插件主体：懒绑 `llm`+`webServer`（缺一则路由不注册，等组合就绪），另起一路捕获
 * 可选的 `agentDefaultModel` 句柄。
 *
 * @param ctx - cordis 上下文。
 * @param config - 经 Config 校验的条目配置。
 * @throws {Error} provider/model 只填了一个时启动即失败（配置要响亮地错）。
 */
function apply(ctx, config) {
	if ((config.provider === "") !== (config.model === "")) {
		throw new Error('dsh-prompt-optimizer: config.provider and config.model must be supplied together (or both left "" for automatic)');
	}
	if (!Number.isInteger(config.maxInputChars) || config.maxInputChars < 16) {
		throw new Error("dsh-prompt-optimizer: maxInputChars must be an integer >= 16");
	}
	if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 16) {
		throw new Error("dsh-prompt-optimizer: maxOutputTokens must be an integer >= 16");
	}
	if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000) {
		throw new Error("dsh-prompt-optimizer: timeoutMs must be an integer >= 1000");
	}
	const state = { llm: void 0, agentDefaultModel: void 0 };
	ctx.inject(["agentDefaultModel"], (defaultCtx) => {
		state.agentDefaultModel = defaultCtx.agentDefaultModel;
	});
	ctx.inject(["llm", "webServer"], (serviceCtx) => {
		state.llm = serviceCtx.llm;
		const handler = makeRouteHandler(state, config);
		const disposeRoute = serviceCtx.webServer.register({ kind: "exact", path: ROUTE_PATH, handler });
		ctx.effect(() => disposeRoute);
	});
}

export { Config, REQUEST_HEADER, ROUTE_PATH, SYSTEM_PROMPT, apply, makeRouteHandler, name, resolveRoute, stripFence };
