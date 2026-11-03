# dsh-prompt-optimizer

在会话输入框(composer 工具行左段)添加一个 **「优化提示词」** 按钮:

- 点一下,当前草稿被送到宿主,由 **你正在使用的同一个模型** 做一次一次性改写;
- 改写遵守「保持原意」契约:不增删任务、只澄清与组织语言、中文进中文出、
  路径/代码/数字原样保留,输出只有改写后的提示词本身;
- 成功后整段替换回输入框;若你在改写期间又改了草稿,则不覆盖,给出提示;
- 失败/超时在按钮上短暂回显原因,不会静默吞错。

## 工作原理

| 半边 | 文件 | 职责 |
|---|---|---|
| 宿主 | `lib/index.js` | 注册 `POST /prompt-optimizer/optimize`(exact webServer 路由);用 `ctx.llm.stream` 发起无工具、无历史的一次改写;模型路由:条目 config 固定 → 浏览器带来的会话投影路由 → `agent-default-model` |
| 浏览器 | `lib/client.js` | 手写模块加载格式(无构建);在 `conversation.input.left` slot 注册按钮;读 `useInput` 草稿与 `useProjection("modelSelection")` 路由;`inputActions.setDraft` 回填 |

写请求需带 `x-dsh-prompt-optimizer: 1` 自定义头 + 同源 Origin 核对(与 dsh-ui-skin 同款防跨源设计)。

## 配置(cordis.patch.yml 条目 `prompt-optimizer`)

| 字段 | 默认 | 含义 |
|---|---|---|
| `provider` / `model` | `""`(自动) | 成对填写则固定改写用模型;留空跟随会话模型 |
| `maxInputChars` | 16000 | 草稿字符上限,超出 413,不发起调用 |
| `maxOutputTokens` | 1500 | 改写输出 token 上限 |
| `timeoutMs` | 45000 | 单次改写墙钟上限,超时向浏览器报 504 |

## 安装 / 卸载

安装:把本目录放入 profile 的 `node_modules/`,并在 profile `package.json` 的
`dsh.profile.bundles` 追加 `"dsh-prompt-optimizer"`;`patchReload: live` 下重新组合即生效。

卸载:从 `dsh.profile.bundles` 移除该名字并删除包目录即可,不影响其它配置。

## 已知边界

- 草稿中的引用芯片以剪贴板文本形态参与改写,回填为纯文本(路径等标识原样保留)。
- 首次点击前如果本会话从未发过消息且宿主拿不到默认模型,会返回 503 并提示先在会话里选一次模型。
- 改写是一次性的:不读对话历史,只有草稿本身参与。

冒烟测试:`node test/smoke.mjs`(从安装位置运行;纯 node,无网络无浏览器)。

---

## 许可

[MIT](LICENSE)

> 本仓库不含 `node_modules`：依赖由 DSH profile 的扁平层解析。克隆后走设置页「导入插件…」选中本目录，或手动复制到 `<数据目录>/profiles/web/node_modules/`，再把包名加进该 profile `package.json` 的 `dsh.profile.bundles`。

