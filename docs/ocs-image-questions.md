# OCS 图片与公式题配置

从 ZError 2.2.13 起，题库配置支持 OCS 新版图片优化协议。

## 更新已有配置

1. 退出旧版 ZError 后安装新版，启动题库服务。
2. 在 ZError 首页打开 OCS 配置，点击“复制配置”。
3. 用新配置替换 OCS 中已有的 ZError 题库配置并保存。
4. 为本题选择支持图片输入的模型，并启用该模型的视觉能力。

旧配置不会随着安装程序自动更新。仅升级 ZError、继续使用旧的 GET 配置时，OCS 仍会提示题库尚未支持图片优化。

## 传输内容

新版配置使用 POST JSON，保留原始 `title`、`options`、`type`，并接收：

| 字段 | 内容 |
| --- | --- |
| `images` | 图片的 Base64 Data URL 数组 |
| `suggestion_title` | 用 `[图片1]` 等编号替代图片地址的题干 |
| `suggestion_options` | 用相同编号替代图片地址的选项 |

`images` 使用 OCS 的字段解析器返回数组，避免把图片列表变成字符串。ZError 将编号与图片一并传给视觉模型，复用白底和小图尺寸处理；题库匹配及答案校验保留原始题面语义。旧版 GET 请求仍然兼容。

公式图片与普通图片共用这条链路；本次协议没有单独的 LaTeX 或 MathML 字段。图片优化可传递浏览器已经读取的图片，减少应用再次访问原始图片地址时遇到登录状态或防盗链限制的问题。

联网检索仍受整题预算约束。默认整题最多等待 120 秒时，建议把 OCS 的“搜题最大耗时”设为 150 秒。

## 协议来源

- [OCS 开发文档](https://docs.ocsjs.com/docs/other/api)
- [OCS 图片环境变量及兼容检测实现](https://github.com/ocsjs/ocsjs/blob/8b25a3f44523a0d4b7373878488056f4aa478cf6/packages/scripts/src/utils/answerer-env.ts)
- [OCS 题面图片提取与答案还原](https://github.com/ocsjs/ocsjs/blob/8b25a3f44523a0d4b7373878488056f4aa478cf6/packages/scripts/src/utils/work.ts)
