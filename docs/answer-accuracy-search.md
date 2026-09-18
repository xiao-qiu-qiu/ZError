# 答案校验与自主搜索

本分支实现计划第一、第二阶段：修复答案输出/缓存复用，并接通实际搜索工具。尚未进行大样本准确率评估；联网成功和格式正确不等于知识答案一定正确。

## 使用

在「设置 → 常规设置 → 联网搜索」选择：

- **自动**（默认）：模型按题目需要调用搜索。
- **每题检索**：进入 AI 答题后必须取得真实检索来源，否则返回待复核。已通过校验的题库缓存仍直接复用。
- **关闭**：仅使用模型自身知识和本地题库。

供应商：

通用搜索在“每题检索”下会先用题干执行首轮搜索，再交给模型核对和决定是否继续检索，避免上游忽略强制工具调用参数。仅有图片、没有可用题干文字时，由视觉模型提取检索词后调用工具。

- **公开搜索（Bing，无需密钥）**：默认选项。通过公开 RSS 搜索获取标题、链接和摘要，适配能调用函数工具的模型。结果相关性和网站可访问性存在差异；模型可用 `read_page` 进一步核对正文。
- **内置搜索**：使用所选模型同一平台的 `/v1/responses`，发送 `web_search`。只记录实际搜索事件、来源及引用。使用这一模式会为该次答题选择 Responses 协议，自定义模型脚本不参与该模式。
- **Tavily**：填写自己的 API 密钥，服务地址默认 `https://api.tavily.com`。
- **SearXNG**：填写自己实例的地址，并在实例上启用 JSON 输出。

2026-09-17 在用户 codeq 上的定向验证：

| 模型 / 接口 | 路径 | 结果 |
| --- | --- | --- |
| gpt-5.6-luna / Responses | 原生搜索 | 已返回真实 `web_search_call` 和来源；生产适配器流式验证通过 |
| grok-4.6 / Chat | Bing 函数工具 | 已完成搜索、结果回传和答案校验 |
| gpt-5.6-luna / Anthropic | Bing 函数工具 | 已完成流式工具参数拼接、搜索和结果回传 |
| grok-4.6 / Responses | 原生搜索 | 本次上游未实际执行；HTTP 200 不作支持证明，请使用通用搜索 |

模型/中转行为可能变化，以每道题的检索记录为准。模型密钥、用户配置与原始探针响应均不进入 Git。

## 时间与费用控制

默认每题最多搜索 2 次、读取 3 页；普通工具在执行前检查上限。整题默认预算 120 秒，覆盖模型、工具、重试和裁决。搜索请求默认 20 秒。相同查询结果默认在进程内缓存 30 分钟（最多 100 项），同题相同工具调用复用结果；取消一个消费者不会取消其他仍在等待的模型。

原生搜索在供应商内部运行，本地根据搜索事件计数并中止超限响应；无法保证供应商在中止前没有额外计费。codeq 的 Luna 拒绝 `max_tool_calls` 参数，因此不发送该字段。通用函数工具的次数在本地严格执行。

OCS 的「通用 → 全局设置 → 高级设置 → 搜题最大耗时」建议设为 **150 秒**。OCS 题库 JSON 没有独立的 timeout 字段，额外添加不会改变等待时间。官方当前 UI 最大值为 180 秒；如果提高 ZError 预算，也需协调 OCS 设置。

官方源码依据：

- [OCS 题库配置类型](https://github.com/ocsjs/ocsjs/blob/890686a5e54f9a6d52d1169bae9ea5971e0863c7/packages/core/src/core/answer-wrapper/interface.ts#L27)
- [OCS 全局超时设置](https://github.com/ocsjs/ocsjs/blob/890686a5e54f9a6d52d1169bae9ea5971e0863c7/packages/scripts/src/projects/common.ts#L520)
- [OpenAI 搜索接口](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI 函数工具结果回传](https://developers.openai.com/api/docs/guides/function-calling)

## 答案与缓存规则

模型最终答案使用唯一的 `{"answer":"..."}`；证据不足时使用 `{"answer":"","needs_review":true,"reason":"..."}`。单选仅接受一个有效选项，多选按选项集合比较，判断题统一为正确/错误，空数明确的填空题校验答案数量。

多个基础模型答案一致时直接采用规范化结果；答案冲突或格式有误时，使用配置的总结模型独立裁决，未配置时使用第一个基础模型复核一次。多个裁决结果仍不同则待复核。各模型原始回答保留在详情中，但不拼接为最终答案。

无效或待复核输出返回 HTTP 422 / `code:0`，不自动入库。历史纯文本答案仍可使用；已标记待修正的记录退出精确及模糊匹配。题目选项参与校验，非选择题不把 C、H 等正文当作选项字母。

请求详情展示本题检索记录、参考来源和摘要；资料可能来自不同模型的尝试，检索记录本身不表示每条来源均支持最终答案。新 AI 响应的 `data.search_evidence` 可供查询日志查看，原有 `data.answer` 对接方式保持不变。

## 开发验证

```powershell
npm ci
npm run build
bun test tests
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

关键回归覆盖答案格式、多选顺序、缓存待修正、选项重排、协议工具回传、流式参数、搜索证据和取消行为。真实接口探针存放于本地忽略目录 `tmp/`。

日常使用前建议由用户在实际 OCS 课程内跑少量已知答案题，观察待复核率、耗时与真实答题结果。第三阶段的大样本准确率和成本对比不属于本次交付。

## Windows 手动安装包

fork 的 Windows x64 安装包使用 NSIS，构建命令：

```powershell
npm ci
npm run tauri -- build --ci --bundles nsis --config src-tauri/tauri.release-manual.conf.json -- --locked
```

请使用上述 Tauri 生产构建命令：它会先生成 `dist/`，再以生产资源协议编译并嵌入前端资源。单独运行 `cargo build --release` 不等同于完整应用构建，可能产生启动时提示 `asset not found: index.html` 的程序。发布前应启动打包后的程序，确认主界面实际显示。

Rust 安装在自定义目录时，设置 `CARGO_HOME` 和 `RUSTUP_HOME`；启动脚本优先从 `CARGO_HOME/bin` 查找 Cargo，未设置时使用用户目录中的 `.cargo/bin`。

此配置仅关闭上游自动更新签名产物的生成，不需要上游私钥。安装包发布在本 fork 的 GitHub Releases，用户下载后退出 ZError（包括系统托盘），沿用原目录覆盖安装。安装包没有 Windows Authenticode 签名；Release 同时提供 SHA-256 校验文件。

应用内更新检查仍使用上游地址，本 fork 的安装包应从 GitHub Release 下载。安装前建议备份原安装目录中的配置和题库数据；不要先卸载并清除数据。
