# NAWABAN webui

kibo-ui + shadcn 前端,吃 `board_view.py`(8813)现有的只读 API。深色为默认(D 风格 exact
hex,见下),不做主题切换。

单卡 DAG 页(8813 `?view=dag`)在 `nawaban/dagview/`:只有 index.html + vendor/;设计与调研文档(README/DESIGN/research)在分支 proto/dagview

## 起

```bash
bash nawaban/board-up.sh   # 板没起的话先起(8813)
cd nawaban/webui
npm install
npm run dev                                  # http://localhost:5173(开发,热更新)
npm run build                                # 产物进 dist/,8813 的 / 直接吐它 —— 日常只开这一个地址
```

改完前端跑一次 `npm run build` 即生效(board_view.py 每次请求读 dist,不用重启)。
没有 dist 或 `/?view=legacy` 时回落到内嵌旧板。

`vite.config.ts` 把 `/api` 代理到 `http://127.0.0.1:8813`(同源,免 CORS)。板本身只读,
唯一写通道是 `POST /api/answer`(收件箱回答),板 fork `cli.py` 子进程写,继承库层全部闸。

## 页面

- **顶部持久导航栏**(`App.tsx`):左 NAWABAN 标题,中间全局搜索框(`/` 聚焦、Esc 清空,
  过滤当前视图的卡片:id/标题/owner/epic),右侧 Board/模块/收件箱 三个 nav 项——收件箱
  带未读数徽标(轮询 `/api/inbox.total`)。点任何卡片打开右侧 `TaskDetailSheet`
  (吃 `/api/task?id=`:成功判据/约束/touches/依赖边/决策/事件/引用)。
- **看板**(`BoardKanban.tsx`):kibo-ui `KanbanBoard`。四列 = API 五列的 `claimed`+
  `in_progress` 合并成「进行中」。拖拽只做视觉——`onDragEnd` 把数据重置回最近一次
  `/api/board` 拉取的结果并 toast 提示「状态变更走 CLI」,不发明绕过库层闸的写路径
  (kibo 的 dnd-kit sensor 加了 `activationConstraint` 距离阈值,否则任何 mousedown
  都会被当拖拽处理,卡片上的点开详情永远等不到)。owner 头像用反白圆点(`bg-avatar`)。
- **模块流转**(`ModulesView.tsx`):左栏按 `epic` 分组、分状态(done/待验收/进行中/已认领/
  待认领)彩色分段进度条,按未完成量降序,进度 % 只数 done。右侧选中模块的**内部依赖链
  分层拓扑**:按 `depends_on` 算层级(上游第 1 级在左,下游在右,与所在层无关的独立卡
  归到底部「独立卡」区),原生 SVG 贝塞尔连线画层间依赖;每卡左侧 3px 状态色条(这个视图
  唯一的状态信号,不按状态分列)+「被挡」琥珀 Badge(某个上游未 done,判据全局,跨模块也算)
  + 跨模块依赖 Badge(`← 依赖 X`)。**专注模式**开关:开着时点任意卡,它的全部上下游链
  (全局)高亮(连线换 accent 色变粗),其余卡与连线压暗到 22% 透明度,再点同一张卡退出。
  头部一行「现在动着的:id(第 n/m 级)」列出该模块里 in_progress/claimed 的卡。
  布局算法(`buildIndex`/`layers`/`isBlocked`/连线测量)是
  `nawaban/board_view.py` MODULES_PAGE 内嵌 JS(index/layers/blocked/wires)
  的直接翻译,没有重新设计;数据仍是现成的 `/api/modules`(`tasks`+`deps`),没碰后端。
- **收件箱**(`InboxView.tsx`):三组(放行/验收/拍板),字段与交互对齐旧板 INBOX_PAGE 的
  `askHTML()`/`submit()`,**视觉层用 shadcn Card 语言**(与看板同一套 `bg-card #232327` +
  `rounded-md`,不是旧板那套色左条 + 裸拼 `<b>key</b> value`):kind 用 Card 头部一枚
  Badge(放行 = accent(`#5e6ad2`)描边、验收 = `warn` 琥珀、拍板 = `destructive` 我们自己的
  红,不是旧板那个 `#eb5757`)+ `#id` mono + 停留天数右对齐;question 是 `CardTitle`;
  `blast` 用 `<dl>` 结构化两列;`decide` 的 `options` 用带分隔线的 `<ul>`;`task_ids` 每个
  一枚可点的 `secondary` Badge,点开复用现成的 `TaskDetailSheet`(所以 `InboxView` 现在也
  接 `onSelectTask`,`App.tsx` 一并接上);按钮行在 `CardFooter` 右对齐(收下 = 实底、
  打回 = outline、授权/就这么定 = 实底)。自批归档 digest 每条也 Card 化成轻量小卡。
  字段与交互逻辑本轮未动(v3 已验):accept 类「收下」(固定 verdict 直接提交)+「打回」
  (Dialog 必填理由);authorize/decide 类单按钮 + 必填回答 Dialog;`hands_on`/`confidence`/
  `authorize` 提示段照旧渲染。所有回答走 `POST /api/answer`。

## 配色

用户点验过的原型 `kanban-styles.html` 的 `body.D`(kibo-ui 深色)一套,exact hex 写进
`src/index.css` 的 `:root` token(不是 shadcn zinc 默认 oklch 值):页底 `#09090b`、
列/面板面 `#18181b`(新开 `--panel-bg`/`--color-panel` token,没有塞进 `--secondary`——
那个槽位已经是 chip 用的)、卡面 `#232327`、卡边框 `#2e2e33`(hover `#3f3f46`)、列边框
`#27272a`、正文 `#fafafa`、次要 `#a1a1aa`、chip 底 `#2e2e33`/字 `#a1a1aa`(= shadcn
`secondary` badge variant,天然复用)、警示琥珀 `#3a2f16`/`#fbbf24`(新增 `warn` badge
variant,不复用 `destructive`——语义不同,一个是"等xx"提示不是错误态)、avatar 反白
`#fafafa`/`#18181b`。

## kibo-ui 来源

`npx kibo-ui@latest add kanban` 走 shadcn registry 装的(`src/components/kibo-ui/kanban/index.tsx`),
不是手工 vendor——真组件,含 `@dnd-kit` 拖拽与 `tunnel-rat` 的 drag overlay。为对齐 D 风格
配色 + 补 sensor 激活阈值,对这个文件做了本地小改(列面板 bg/border、卡片 hover 边框、
MouseSensor/TouchSensor 的 activationConstraint)。

## 技术栈

Vite + React 19 + TypeScript + Tailwind v4(`@tailwindcss/vite`)+ shadcn/ui(`new-york` 风格,
zinc base 起步、token 已覆盖成 D 风格,`components.json` 里配好别名 `@/*`)。

## 验证过什么

- `npx tsc --noEmit` 零错;`npm run build` 成功(dist ~122KB gzip)。
- `curl localhost:5173` 200;`curl localhost:5173/api/inbox` 与直连 8813 的响应 **byte-identical**
  (`diff` 验证过)。
- Chrome 里实际打开页面逐项操作并截图:看板四列真数据 + 等拍板琥珀 Badge + owner 头像、
  点卡片开详情侧栏(网络请求确认真打了 `/api/task`)、全局搜索过滤看板与模块两个视图、
  收件箱自批归档 digest 展开显示 33 条真数据 + 复制按钮真触发 clipboard + toast。
- 模块流转视图:选 IAM2 实测出 15 级依赖链(`第 15 级 · 下游`)、SVG 连线跨多列正确画出;
  专注模式点卡后该卡的上下游链高亮、其余卡与连线压暗,再点同一张卡退出恢复;搜索词
  能让不匹配的卡在分层视图与独立卡区都正确压暗、点击仍可用。
- 收件箱:accept 类(#72/#79/#80)「收下」+「打回」都在,`hands_on` 琥珀 Badge、evidence、
  task_ids 都渲染;decide 类(#70/#74)红色左条 + `options` 列表(选项+后果都渲染出来)+
  单个「就这么定」Dialog(空输入禁用提交,填了才能提交)。当前真实数据里没有 authorize
  类条目,该分支(蓝色左条 + 授权按钮 + fanout 提示段)靠代码走查确认,结构与已验证的
  decide 分支对称,没有额外分叉逻辑。
- 全程 `read_console_messages(onlyErrors)` 零 error。

**踩坑记录**:
- 这台机器的 Vite dev server 只监听 IPv6(`localhost` 解析得到 `::1`),
  `curl 127.0.0.1:5173` 连不上是正常的——用 `curl localhost:5173`。
- `npx shadcn@latest add sheet` 这次跑出了个怪 bug:没解析 `@/*` 别名,字面创建了一个叫
  `@` 的目录(`webui/@/components/ui/sheet.tsx`)而不是写到 `src/components/ui/sheet.tsx`——
  手动挪的文件、删的坏目录。装其他组件(button/badge/card/... 那批)时没出现,原因未查。
- kibo 的 `KanbanProvider` 默认没给 dnd-kit 的 `MouseSensor` 激活阈值,任何单纯点击(不
  移动)都会被当成一次拖拽会话处理,`onDragEnd` 照样触发——不只是"点了卡片打不开详情"
  这么简单,还会让"拖拽只做视觉"那条 toast 在每次点击时都乱弹。根因在 sensor 配置,不是
  在业务层加"是否真的移动了"的补丁能治本的(虽然也顺手加了这一层防御)。
- 自批归档 digest 里有条真实 evidence 含一长串不含空格的标识符(`revoke_all_assignments_for`),
  在 `flex` 容器里靠 `truncate`(= `white-space: nowrap`)会撑爆父容器整个横向溢出页面——
  这是 flexbox 的经典坑(flex item 默认 `min-width: auto` 会把 nowrap 文本的完整宽度算进
  最小宽度)。修法是把展示長文本的地方统一换成 `break-words`(允许折行)而不是
  `truncate`+`min-w-0`(两条都要配对,漏一个就复发)。

## v4:收件箱视觉重做

用户反馈 v3 的收件箱字段虽然对了但视觉还是旧板语言(色左条 + 裸拼文本)。v4 只动视觉层,
字段/交互逻辑全部保留:改用 shadcn `Card`/`CardHeader`/`CardTitle`/`CardContent`/
`CardFooter`,与看板 tab 同一套 token,截图并排对比过——两个 tab 的卡片背景色、圆角、
Badge 胶囊形状现在是同一个视觉家族。验证过:accept 类(#72)、decide 类(#34/#68/#74)
的 Badge 颜色、options 分隔线列表、task_ids 徽标点开详情侧栏、digest 展开后每条 Card 化,
`tsc`/`build` 全绿,控制台零 error。authorize 类当前收件箱仍无真实数据,视觉分支
(accent 描边 Badge)靠代码走查确认,结构与已验证的 accept/decide 分支对称。

## v5:decide 类改成选项式提交(v6 已把交互从 Dialog 挪到卡面,见下)

拍板(decide)是选择题,`options` 里已经有「选项|后果」,不该让用户默写。新增共享组件
`OptionsList`(Card 正文的只读展示、可点选列表用同一份渲染,`onSelect` 传不传决定要不要
可点),末尾恒定补一个「其他…」兜底项。选中真实选项后出现非必填的「补充说明」输入,
verdict = 选项文本(填了补充则拼成「选项 · 补充:xxx」);选中「其他…」换成必填的自由
回答框,verdict = 那段文本。authorize 类没有 options,继续用原来的自由回答 Dialog;
accept 类未动;decide 没有 options 时兜底复用同一个自由回答 Dialog。服务端契约不变,
还是 `POST /api/answer {ask_id, verdict}`。

## v6:decide 选项直接在卡面点选,去掉弹窗

用户实测反馈:在卡片正文里看到选项列表却点不了,以为是摆设——期望直接在卡面点选、点
「就这么定」提交,不必先点按钮再进 Dialog 选。改法:`OptionsList` 现在直接渲染在
`CardContent` 里且可点(`onSelect` 恒定传,不再区分"只读展示"和"Dialog 内可选"两种
用法,只读只剩 authorize/accept 那种压根没有 `onSelect` 的分支);选中态就是原来那套
accent 描边 + 淡色底,直接长在卡面上。补充说明/「其他…」必填框也跟着挪进卡面,选中哪项
就在选项列表下面就地展开。CardFooter 的「就这么定」按钮直接绑 `submit(decideVerdict, …)`
——不再弹 Dialog,点了就交。未选中时按钮 `disabled` 且带 `title="先选一个选项"`(浏览器
原生 tooltip,没有另装 tooltip 组件)。整个 decide 专属 Dialog 连同 `decideOpen`/
`closeDecide` 状态一起删掉,只剩 `resetDecide()` 在提交成功后清空选中态。accept 的打回
Dialog、authorize 的自由回答 Dialog 原样保留。

用真实数据(#34,3 个选项)实点验证过:未选中「就这么定」是灰的 → 点"其他…"就地展开
必填回答框、按钮仍灰(空文本)→ 点"rebase 到当前 main 单开 PR"切走选中态、下方变成非必填
「补充说明」、按钮立刻变亮(实底)。没有真的点提交(那是对真实收件箱数据的不可逆写操作)。
`tsc`/`build` 全绿,控制台零 error。

## v7:模块页视觉 kibo 化

用户反馈模块页(依赖链视图)还是老 UI 样式,跟收件箱 v4 同等待遇——只动视觉层,`layers`/
`wires`/`buildIndex`/`isBlocked`/`groupByEpic`/专注模式/搜索压暗逻辑一行没改。`ModulesView.tsx`
的改动:
- 左栏 `ScrollArea` 加 `bg-panel border-panel-border`(#18181b 面板底色);每个模块从
  `hover:bg-accent` 的裸 button 换成 `bg-card` 卡片,选中态是 accent(`#5e6ad2`)描边 +
  淡色底(跟 `InboxView` 的 `OptionsList` 选中态、看板卡片 hot 态同一套视觉语言)。
- 依赖链的每个层级列包一层面板(`rounded-md border border-panel-border bg-panel`),列头
  独立成一条带下边框的标题栏(`第 n 级 · 上游/下游`,大写字距 muted),结构对齐 kibo
  `KanbanBoard`/`KanbanHeader` 的做法。
- 卡片背景从 `bg-panel` 换成 `bg-card`(#232327,跟看板/收件箱卡片同一个 token),padding
  统一到 `p-3`(12px),状态左侧色条保留(这个视图唯一的状态信号)。被挡/进行中/待验收/
  跨模块依赖从裸 `<span>` 换成 `Badge` 组件(被挡=`warn` variant,跨模块依赖=`secondary`
  variant,进行中/待验收沿用原来的语义色但包成 Badge 胶囊)。
- 头部统计行、`现在动着的…`、图例合并成跟收件箱顶部汇总一致的单行 muted 排版;独立卡区
  标题换成跟分组头一样的大写字距小字。
- 专注模式开关从原生 `<input type="checkbox">` 换成新装的 shadcn `Switch`(`size="sm"`)。
- SVG 连线颜色本来就是 `#3f3f46`/专注高亮 `#5e6ad2`,跟 token 要求一致,没改。

`npx shadcn@latest add switch` 这次又撞上了之前遇到过的同一个 CLI 怪 bug——没解析
`@/*` 别名,字面写到 `webui/@/components/ui/switch.tsx`,手动挪到 `src/components/ui/switch.tsx`
删了坏目录(第二次遇到,和 v2 装 `sheet` 时一样,原因依旧未查)。

验证:IAM2 实测仍出 15 级链(`第 15 级 · 下游`),`zoom` 截图确认 SVG 连线端点精确落在卡片
右/左边缘没有错位;专注模式点卡后该卡 accent 描边高亮、链上卡片与连线保持原色、其余压暗
到 22%,再点同一张卡恢复;切到「未分组」模块(全部独立卡,没有依赖链)验证了空链路提示
文案和独立卡区网格布局。`tsc`/`build` 全绿,控制台零 error。

## v3 待办(本轮没做)

- 构建产物接进 8813(现在只有 dev server,没有 `board_view.py` 托管 `dist/` 的路径)。
- 拖拽写通道要不要开(现在故意只做视觉预览 + toast)。
- Kanban 列内按 `fold` 分组折叠(旧 HTML 板有,本轮用的是扁平卡片列表)。
- 全局搜索目前只过滤看板与模块的卡片列表,收件箱的搜索匹配字段较窄(id/question/evidence,
  没有像看板那样统一到 owner/epic——inbox ask 本身没有 owner/epic 字段)。
- 模块流转视图的搜索是「压暗不匹配」而不是「移除不匹配」——移除会打断依赖链分层与连线
  端点,压暗才不破坏图结构,但没有像旧板那样只在 rail 层面做模块名过滤。
