/**
 * dsh-prompt-optimizer 浏览器半边(手写发布格式,无构建步骤)。
 *
 * 在 composer 工具行左段(conversation.input.left)注册一个「优化提示词」按钮:
 *   1. 点击时读取当前草稿(useInput 标准 prop)与当前会话模型路由
 *      (useProjection("modelSelection") 标准 prop);
 *   2. 同源 `POST /prompt-optimizer/optimize`(宿主用 ctx.llm 一次性改写);
 *   3. 成功后若草稿未被用户改动,`inputActions.setDraft(optimized)` 整段替换;
 *      若已改动则不覆盖,给出提示,可再点一次;
 *   4. 失败/超时在按钮上短暂回显原因(约 4 秒),绝不静默吞错。
 *
 * 草稿里的引用芯片会以剪贴板文本形态参与改写(setDraft 为纯文本写入),
 * 文件/路径等标识字符串原样保留(见宿主 SYSTEM_PROMPT 规则 4)。
 *
 * 契约:导出 { inject, apply };inject 声明所需 ctx 键(slots、locale)。
 *
 * @module dsh-prompt-optimizer/client
 */
window.__ModuleLoader__.load({
	id: "dsh-prompt-optimizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let jsx_runtime = require("react/jsx-runtime");
		let React = require("react");
		const { jsx, jsxs } = jsx_runtime;

		/** locale 命名空间(注册字典与 slot locale 共用同一字符串)。 */
		const NS = "prompt-optimizer";
		/** slot 条目 id(conversation.input.left 的自有席位)。 */
		const ENTRY_ID = "prompt-optimizer";
		/** 宿主路由(与 lib/index.js 的 ROUTE_PATH 一致)。 */
		const ROUTE_PATH = "/prompt-optimizer/optimize";
		/** 写请求自定义头(与宿主 REQUEST_HEADER 一致;跨源请求必触发预检,天然挡 CSRF)。 */
		const REQUEST_HEADER = "x-dsh-prompt-optimizer";
		/** 回显提示停留时长(毫秒)。 */
		const NOTE_MS = 4000;

		const zh = {
			"button": "优化提示词",
			"title": "在不改变原意的前提下,把草稿改写得更精确、更易被 agent 执行",
			"busy": "优化中…",
			"done": "已优化",
			"changed": "草稿已变化,未替换;可再点一次",
			"empty": "输入框里没有内容",
			"failed": "优化失败:{message}",
			"network": "无法连接宿主({status})",
		};
		const en = {
			"button": "Optimize Prompt",
			"title": "Rewrite the draft to be more precise for the agent, keeping the original meaning",
			"busy": "Optimizing…",
			"done": "Optimized",
			"changed": "Draft changed while optimizing; not replaced. Click again.",
			"empty": "Nothing in the input box",
			"failed": "Optimize failed: {message}",
			"network": "Cannot reach the host ({status})",
		};

		/** 行内样式(纯类名,挂载一次;经 textContent 注入,不含任何标签字面量)。 */
		const BUTTON_CSS = [
			".dpo-btn{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:12px;gap:5px;padding:3px 10px;display:inline-flex;align-items:center;cursor:pointer;font:inherit;font-size:11px;line-height:16px;white-space:nowrap}",
			".dpo-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dpo-btn:disabled{opacity:.5;cursor:default}",
			".dpo-btn .dpo-icon{flex:none}",
			".dpo-note{color:var(--dsw-alias-label-tertiary)}",
			"@media (prefers-reduced-motion:no-preference){.dpo-busy .dpo-icon{animation:dpo-pulse 1s ease-in-out infinite}}",
			"@keyframes dpo-pulse{50%{opacity:.35}}",
		].join("");

		/** 样式只注入一次(模块级幂等)。 */
		function installStyles() {
			if (document.getElementById("dsh-prompt-optimizer-styles")) return;
			const style = document.createElement("style");
			style.id = "dsh-prompt-optimizer-styles";
			style.textContent = BUTTON_CSS;
			document.head.appendChild(style);
		}

		/**
		 * 调用宿主改写路由。
		 *
		 * @param optimize - (text, route) => 改写后的文本;route 可为 null。
		 *   失败时 throw Error(可展示消息)。
		 */
		function makeOptimize() {
			return async function optimize(text, route) {
				const headers = { "content-type": "application/json", [REQUEST_HEADER]: "1" };
				const response = await fetch(ROUTE_PATH, {
					method: "POST",
					headers,
					body: JSON.stringify({ text, ...(route ? { route } : {}) }),
				});
				let payload = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				if (payload && payload.ok === true && typeof payload.optimized === "string" && payload.optimized.length > 0) {
					return payload.optimized;
				}
				const message = payload && typeof payload.error === "string" && payload.error.length > 0
					? payload.error
					: `HTTP ${response.status}`;
				const error = new Error(message);
				error.status = response.status;
				throw error;
			};
		}

		/**
		 * 「优化提示词」按钮(conversation.input.left 条目)。
		 * 标准 props:sessionId / useInput / useProjection / inputActions;业务 prop:optimize。
		 */
		function OptimizeButton({ inputActions, useInput, useProjection, optimize, t }) {
			const draft = useInput((state) => state.draft) ?? "";
			const selection = typeof useProjection === "function" ? useProjection("modelSelection") : undefined;
			const [phase, setPhase] = React.useState("idle");
			const [note, setNote] = React.useState("");
			const draftRef = React.useRef(draft);
			draftRef.current = draft;
			const timerRef = React.useRef();
			React.useEffect(() => () => clearTimeout(timerRef.current), []);
			const text = draft.trim();
			const busy = phase === "busy";
			const flash = (message) => {
				clearTimeout(timerRef.current);
				setPhase("note");
				setNote(message);
				timerRef.current = setTimeout(() => {
					setPhase("idle");
					setNote("");
				}, NOTE_MS);
			};
			const onClick = async () => {
				if (busy || text.length === 0) return;
				setPhase("busy");
				setNote("");
				const route = selection ? (selection.next ?? selection.lastUsed) ?? null : null;
				try {
					const optimized = await optimize(text, route);
					// 只替换点击时捕获的那份草稿:期间用户又改了就不动,给提示。
					if (draftRef.current.trim() === text) {
						inputActions.setDraft(optimized);
						setPhase("idle");
						flash(t("done"));
					} else {
						setPhase("idle");
						flash(t("changed"));
					}
				} catch (error) {
					setPhase("idle");
					flash(t("failed", { message: error instanceof Error ? error.message : String(error) }));
				}
			};
			const icon = jsx("svg", {
				className: `dpo-icon${busy ? " dpo-busy" : ""}`,
				width: 11,
				height: 11,
				viewBox: "0 0 24 24",
				fill: "currentColor",
				"aria-hidden": true,
				children: [
					jsx("path", { d: "M12 2l1.8 6.2L20 10l-6.2 1.8L12 20l-1.8-8.2L4 10l6.2-1.8L12 2z" }, "spark"),
					jsx("path", { d: "M19 15l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3z" }, "mini"),
				],
			}, "icon");
			return jsxs("button", {
				type: "button",
				className: "dpo-btn",
				disabled: busy || text.length === 0 || !inputActions,
				title: t("title"),
				"aria-label": t("button"),
				onClick,
				children: phase === "note" && note.length > 0
					? [icon, jsx("span", { className: "dpo-note", children: note }, "note")]
					: [icon, jsx("span", { children: busy ? t("busy") : t("button") }, "label")],
			}, "button");
		}

		const inject = ["slots", "locale"];

		/**
		 * 客户端插件主体:挂样式、注册字典,并把按钮装进 composer 工具行左段。
		 *
		 * @param ctx - 客户端 cordis 上下文(已注入 slots/locale)。
		 */
		function apply(ctx) {
			installStyles();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }));
			const optimize = makeOptimize();
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: ENTRY_ID,
				order: 10,
				locale: NS,
				inject: () => ({ optimize }),
			}, OptimizeButton));
		}

		exports.NS = NS;
		exports.ROUTE_PATH = ROUTE_PATH;
		exports.REQUEST_HEADER = REQUEST_HEADER;
		exports.OptimizeButton = OptimizeButton;
		exports.makeOptimize = makeOptimize;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
