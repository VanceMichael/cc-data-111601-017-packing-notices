# packing-notices

装运交付中包装层次与订单分配采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

可分隔 X12 交换信封和段并保存原件，并已按 856 实际 HL 关系形成装运内容接收：保留 HL 父子层次、MAN 包装标识与 PRF 订单分配，不再把报文摊平成商品行。

`src/reader.mjs` 提供现有单件读取契约；`src/shipment.mjs` 提供装运内容解释；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、装运修订与解释结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品，领取一件原件并执行一次结构化装运领取，打印箱与订单的对应关系，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。

这四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。

## 装运内容接口

- POST /shipment-intakes，JSON 为 {"path":"/shipments/multi"}：领取并解释一件 856。返回中每个交易集给出 `locator`、`status`、`shipmentKey`、箱数与问题代码；整体 `status` 为 `accepted`、`partial` 或 `rejected`。被拒交易集返回 422，但仍登记原件与证据。
- GET /shipments：按票返回装运视图，含每票的 `identity`、当前有效版本 `current`、全部修订摘要与被拒尝试 `rejectedAttempts`。
- GET /shipments/{key}：读取单票视图，键由 `shipmentKeyOf` 生成（发送方/接收方/票号），包装键以该票为作用域。

解释规则：

- HL02 父号可前向引用，整个交易集读完后按实际引用挂接；不按出现顺序或固定深度推断。
- 父子类型接受 S-O-P-I 与 S-P-O-I 两种约定；其他组合、悬空父号、循环引用、重复节点号都判为矛盾。
- 一张订单可分散在多箱，箱上的 `orders` 与订单上的 `packages` 双向保留；商品行取最近的包装祖先与最近的 O 层订单祖先。
- 存在任何交易级问题时，该交易集不出 `packages`/`orders`，只保留带段位置的 `evidence` 与 `hierarchy`，避免形成看似可出库的箱单。
- 同一文档中某个交易集失败不连带其他交易集；`partial` 表示仅部分交易集可用。同一票被拆到多张交易集时按票合并；若两张交易集声明了同一包装标识，判为跨交易集冲突而不合并。
- 同摘要重领返回同一收件记录，不追加修订。不同内容按票号追加为新修订，当前有效版本取最新 `accepted` 修订；坏报文只进入 `rejectedAttempts`，不会覆盖已有有效版本。
- 包装标识只在所属票内唯一；不同票即使 MAN 号相同也各自独立，不互相覆盖。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，856 层次、包装与订单分配在 test/shipment.test.mjs，持久修订与票内隔离在 test/integration.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t packing-notices:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
