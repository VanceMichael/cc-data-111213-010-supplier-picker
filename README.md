# 异步联想控件的供应商录入自动化

supplier-picker 用于合作资料的本地查看和来源保存。当前版本支持人工触发的整份资料查看与字节级归档，资料对象按内容摘要保存，每次领取保留单独回执。自动组织领域资料的能力与人工查看入口分别演进。

## 运行环境

使用 Node.js 22。依赖已锁定；首次准备执行 `npm ci --ignore-scripts`，正式运行无需下载资料或软件。全部样例使用合成数据与本机来源，不连接生产系统。

```bash
npm run check
npm test
npm run demo
```

`npm run demo` 在临时目录实际读取资料、归档并重新核验摘要，退出时清理临时内容。浏览器项目还会启动本地门户和 Chromium 并完成可见页面查看；浏览器在环境准备阶段安装，正式运行不下载。正常演示应在九十秒内结束。

## 本地来源门户

`fixtures/portal/` 是合成业务来源的页面与交互脚本，由 `src/portal.js` 提供本地 HTTP 服务；浏览器功能测试直接操作这些页面。

运行 `npm start -- --port 4173` 后访问终端显示的本地地址，按 Ctrl+C 停止；端口也可由 `PORT` 配置。

## 资料操作

```bash
npm run cli -- inspect fixtures/portal.json
npm run cli -- capture fixtures/portal.json .local/archive
npm run cli -- list .local/archive
```

`capture` 只表示来源字节已保存，不声称领域流程已自动完成。已有查看功能只展示现有资料，不替代业务接纳判断。`scripts/create-fixtures.js` 用于维护者重建合成资料；运行与测试直接读取已提交的资料。

## 录入自动化

`src/intake.js` 在真实 Chromium 中完成待办录入，面向嵌套 shadow root、可访问性标签与虚拟化选项的联想控件：

- 按可访问性名称定位控件；中文查询走输入法组词（组词期间不触发检索），税号等按字符输入。
- 慢网络下乱序到达的响应不参与判断，身份确定只依据本次查询的响应；候选按税号唯一对应才点击，显示文字不作为身份，也不按下拉位置编排。
- 主体变更后旧分支必须失效并重新加载，分支按选项值选择，不沿用屏幕残留文字。
- 候选无法唯一对应税号（重名税号、税号缺失）或分支不属于所选主体时转人工，不逐一试点；登记被服务端拒绝同样转人工，不重复提交。
- 登记以页面回读与服务端状态双重核对，不绕过门户自身校验；正常完成与转人工都留下结论。

```bash
npm run cli -- intake run fixtures/todos.json .local/intake
npm run cli -- intake resume .local/intake T-002 --portal http://127.0.0.1:4173
npm run cli -- intake list .local/intake
```

每条待办在记录目录的 `records/` 下保留可恢复记录：每次查找依据、候选集合、页面回读身份与最终结论，中断后可恢复。恢复前会比对服务端登记与页面快照，识别页面已被人改过；与待办不一致的人工登记不会被自动化覆盖，直接转人工。人工查询入口保留：`npm start` 打开本地门户人工处理，`intake list` 标出待人工项。

## 目录约定

- `src/domain.js`：现有领域读取和查看接口。
- `src/archive.js`：内容对象、来源回执与完整性检查。
- `src/intake.js`：待办录入自动化与可恢复录入记录。
- `fixtures/`：本地资料、领域配置与待办样例。
- `test/`：已有行为的运行验证，使用独立临时目录。

## Linux 环境

`Dockerfile` 使用 Node.js 22 镜像；浏览器项目使用包含 Chromium 的运行镜像。可执行 `docker build -t supplier-picker:local .` 后运行 `docker run --rm --network none supplier-picker:local npm test`。测试中的 HTTP、MQTT 和门户都仅绑定回环地址；不需要第二个容器。构建阶段准备依赖，运行时不安装依赖。
