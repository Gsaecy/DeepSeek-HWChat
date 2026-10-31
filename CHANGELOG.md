# Changelog

## 0.3.0

- **独立审核发现的 6 个问题全部修好（含一个键盘完全不可用的功能、一个拖文件静默失败）**。版本号从 0.2.9 升到 0.3.0：0.2.9 已发布，这些是它之后的行为修正。
  - **F1（严重，已复现）：「添加到输入框」按钮用键盘按 Enter/空格时，打开的是图片**。聚焦那个按钮按 Enter，`keydown` 冒泡到外层图片卡片的处理器，它没判断落点就 `preventDefault()`，按钮的默认激活被取消 → 发出去的是 `openAttachment`。**键盘与读屏用户完全用不了这个功能**（鼠标不受影响）。修法：处理函数里加 `if (event.target !== focusTarget) return;`。
  - **F2：可聚焦元素嵌套**。图片卡片原来是 `role="button"` + `tabIndex=0`，又内含真 `<button>` —— 读屏会把整张卡读成复合控件，Tab 顺序也乱。修法：焦点角色移到 `<img>` 上（`makeAttachmentOpenable(figure, attachment, image)`），卡片只负责鼠标点击。
  - **F3：大图复制可能因「用户手势过期」静默降级**。Chrome 的 transient activation 约 5 秒；原来点「复制」后才去要原图（超时 5 s）再 canvas 转 PNG，大图很容易超窗 → `clipboard.write` 抛 `NotAllowedError` → 只复制到文字。修法：**悬停/聚焦复制按钮时就预取并转好 PNG**（`prefetchClipboardImage`，最多缓存 2 份），点击路径只剩一次写入，手势必然有效。实测：悬停后点击不再多发一次 `requestAttachmentData`，剪贴板仍同时有 `text/plain` 与 `image/png`。
  - **F4：注释与阈值打架**。注释写「上限 8 MB」，代码是 `11 * 1024 * 1024`。修法：抽成常量 `ATTACHMENT_DATA_MAX_BASE64`，注释与阈值只保留一个来源。
  - **F5：拖拽只用合成事件验证过**。补上真实输入验证：`dragTo` 走 CDP 派发真实拖拽，确认能落到输入框、拖完高亮复位、且不误触发「打开附件」。
  - **F6（新发现，真机测出来的）：「从 Finder 拖文件进输入框」会静默失败**。`dataTransfer.files` 是 **FileList**，没有 `.slice`，`readClipboardFiles` 直接 `files.slice(0, 20)` 抛 `files.slice is not a function` —— 界面毫无反应，只有控制台一行红字。修法：先 `Array.from(files || [])` 再切。实测拖 `sample.txt` 进来能变成附件。
  - **测试**：新增 `test/check-attachment-keyboard.mjs`（**8 项真实浏览器验证**，可重复运行：真实键盘 Enter/空格、角色归属、图片上 Enter 仍打开、真实鼠标拖拽、拖后高亮复位与不误触、FileList 拖放、无控制台异常）；`check-attachment-reuse.mjs` 增加 6 条守护（落点判断、角色归属、预取缓存及其上限、FileList 转数组、阈值单一来源）；修正 `check-attachment-open.mjs` 里跟丢实现搬家的旧断言。全量 **807/807**、**25** 个 `check-*.mjs` 全绿。

## 0.2.9

- **复制带图片的消息时，文字和图片一起进剪贴板，粘到输入框里两者都在**（用户原话：「历史消息里含有图片，点击复制直接连图片和文字一起复制，且能一起粘贴到输入框，能做到吗」）。
  - **能做到，依据是查过而不是猜的**：
    - VS Code 的剪贴板 API 只有 `writeText`，写不了图片 —— 所以带图的消息改由 **webview 自己**用异步剪贴板写入（`navigator.clipboard.write` + `ClipboardItem`），一次写入两种格式：`text/plain` 与 `image/png`。
    - 这条路在 VS Code 里**是通的**，依据是本机 VS Code 的 workbench 源码：webview 的 iframe 上写着 `allow="cross-origin-isolated; autoplay; local-network-access; clipboard-read; clipboard-write"`（只有 Firefox 会省略最后两项，见 `Qu = userAgent 含 Firefox`），而 webview 跑的是 Chromium —— 授权这一层不需要额外配置。
  - **实测（headless Chromium，与 webview 同内核）**：写入「文字 + 1×1 PNG」后读回剪贴板得到 `["text/plain","image/png"]`；在 `textarea` 里按 ⌘V，`clipboardData` 同时给出 `text/plain` 与 `file:image/png`。完整的端到端测试是**真的按下 ⌘V**：输入框里同时出现正文文字，并生成了 1 条 `image/png` 附件。
  - **实现要点**：
    - 复制要**原图**：界面手里只有 160×120 的缩略图，拿它复制等于把用户截图压糊。新增 `requestAttachmentData` 让扩展把原始 `dataBase64` 给过来（>11 MB 时回 `ok:false` 并降级 —— 十几 MB 的字符串塞进一次 postMessage 会卡住面板）。
    - **非 PNG 先转 PNG**：`ClipboardItem` 只接受 `text/plain` / `text/html` / `image/png` 三种键，直接把 `image/jpeg` 塞进去会抛异常。所以 jpg/webp 先解到 canvas 再导出 PNG。实测 jpg 原图复制后剪贴板里是 `text/plain` + `image/png`。
    - **降级是显式的**：环境不支持（没有 `ClipboardItem`）、写入被拒、或附件已从内存淘汰 → 仍然把文字复制成功，并弹一句「这个环境没能把图片写进剪贴板，只复制了文字（可以用图片上的「添加到输入框」把图放进输入框）」。绝不静默少一张图。
    - **多图**：剪贴板的键是 MIME，一次只能放一张图片，所以只放第一张，并明确提示「已复制文字和第一张图」。
    - 复制按钮的「复制中 → 已复制 → 还原」反馈抽成 `flashCopyLabel()`，两条写入路径（纯文字走扩展、文字+图片走 webview）共用，避免一种生效一种没生效时看不出来。
  - **测试**：真机 headless Chromium **11/11**（端到端 6 项：走 `requestAttachmentData` 而不是纯文字、剪贴板同时有 text/plain 与 image/png、按钮变「已复制」、⌘V 后输入框有文字、⌘V 后同时产生图片附件；边界 5 项：JPEG 转 PNG、纯文字消息仍走 `copyText`、附件取不到时降级并告知、无 `ClipboardItem` 时降级且按钮不卡在「复制中」）。`check-attachment-reuse.mjs` 增加 7 条对这条链路的守护（复制按钮接线、要原图、双格式写入、PNG 转换、显式降级、多图说明、扩展侧大文件兜底）。全量 **807/807**、24 个 `check-*.mjs` 全绿。

- **已发出的图片/附件可以拖回输入框，或点一下再放一份，作为新一轮的附件**（用户原话：「已经发到聊天框的消息里面的图片，想要拖动，或者复制到输入框显示成新的附件」）。
  - **两条入口**：
    - **拖**：把消息里的图片（或文本附件）直接拖到输入框 —— 输入框出现强调色描边 + 内发光，松手就变成一条待发附件；拖到别处不会误加。
    - **点**：图片右上角有「添加到输入框」按钮（悬停 / 键盘聚焦时浮现；`@media (hover: none)` 的触摸屏上常显，否则入口等于不存在），点一下同样加一份。
  - **为什么不让 `<img>` 自己拖**：图片元素默认拖拽会把**图片文件本身**拖出 webview（落到窗口外就变成系统拖拽），落不进输入框。所以把 `img.draggable = false`，改由外面的 `figure` 承担拖拽，走我们自己的通道。
  - **只传标识、不搬内容**：拖拽数据里放自定义 MIME `application/x-hwchat-attachment` + 附件 `id`（文本附件用 `path`）。图片可能有几 MB，而扩展侧本来就按 `id` 索引着完整 `dataBase64`；前端搬运一遍既慢又没必要。`drop` 时用它判断「这是我们自己的附件」，而不是靠全局变量猜（拖动被打断时变量会留下过期值）。
  - **扩展侧的取内容顺序**：① `attachmentIndex` 里的原始副本（同一次会话几乎总命中，不碰磁盘）→ ② 索引被按字符数 LRU 淘汰了（几 MB 的图先出队）但有 `path`，就用**和「选文件」完全相同的读取器**从磁盘重读（大小上限、二进制判定、敏感文件策略都一致）→ ③ 都没有则明确提示「附件已不可用」，不静默失败。
  - **复制必须去掉 `id`**：`id` 是面板从索引取回完整内容的句柄，跟着复制过去会让两条附件共用一个句柄（删掉一条后另一条点开变成别的内容）。`reuseCopy()` 负责这件事。
  - **配额与「选文件」同口径**：最多 20 条、总量上限一致；数量上限在读盘**之前**就挡住 —— 没必要为一个注定放不下的附件去读几 MB。
  - **顺带**：输入框现在是通用的放置目标，从 Finder / 资源管理器 / VS Code 资源管理器直接拖文件进来也会变成附件（走粘贴那条现成通道），因为「能放东西」的落点只认自己的一种来源会让人以为拖错了。
  - **代码**：新增 `src/core/attachmentReuse.ts`（纯函数 `planAttachmentReuse` / `checkReuseLimits` / `reuseCopy`，IO 留给面板）；`chatPanel` 新增 `attachMessageAttachment` 处理器，并把「按当前对话预设解析附件设置」抽成 `attachmentSettings()`（原来只写在 `attachFiles` 里，现在两条入口共用，避免口径走样）。
  - **测试**：`attachmentReuse.test.ts` 12 条（内存命中不读盘、复制去 id、文本附件同样可复制、索引淘汰回落磁盘、只留 id 时报不可用、只给路径也能走、20 条上限、读盘前就挡数量、总量上限与边界值、复核口径一致）；`test/check-attachment-reuse.mjs` 19 条接线守护（按钮回传、事件隔离、自定义 MIME、dragend 清理、`dragover` 必须 preventDefault、落点只绑输入框、Files 通道、扩展侧三档取内容、配额、中英文案、无悬停设备常显等）。真机 headless Chromium **11/11**：按钮回传正确 id、悬停浮现、点按钮不顺带打开附件、拖拽带自定义 MIME、拖到输入框高亮、放下取消高亮、拖放回传 id、dragleave 取消高亮、落在非输入框不加、文本附件同样可拖。全量 **807/807**、24 个 `check-*.mjs` 全绿。

- **修正：面板内容被横向撑出视口后永久裁掉 —— 归档胶囊「拖到最右还是被截断」与「对话框被截断」是同一个根因**（用户两次反馈：「往左边滚动到滚不动为止，右侧的胶囊还是被截断了」「对话框会被截断」）。
  - **根因（headless Chromium 实测，非推测）**：`.chat-pane` 只声明了 `grid-template-rows`，唯一的**隐式列**是 `auto`，会被最宽的那个子元素按 **max-content** 撑开。视口 870px 时，归档胶囊到 40 颗，这一列从 602px 涨到 **1387.59px**，`.composer-wrap` 被推到 `left=537` → 右侧 **514px** 落在视口外；而外层 `.app-shell` 是 `overflow-x: clip`（按设计不建立滚动容器、没有滚动条），那段内容**无论如何滚动都看不到**。于是：胶囊栏自身能滚到最右，可它整体已经在视口外 → 「滚到头也还是被切」；消息区同理 → 「对话框被截断」。这也解释了上一轮那次没能复现的「面板右边被切割」。
  - **修法**：把列宽显式压成 `minmax(0, 1fr)`（`.chat-pane`、`.message-area`），横向滚动交还给真正该负责的元素（`.todo-archive-bar` 的 `overflow-x: auto`、`.message-viewport`）。硬边界仍是 `overflow-x: clip`（不是 hidden —— clip 不建立滚动容器，absolute/sticky 浮层定位不受影响）。
  - **顺带修掉归档栏自身的 4px 溢出**：原来 `width: 100%` + `margin: 0 2px` —— 百分比算的是父容器**内容宽**，再加左右各 2px 外边距，整条栏比父容器宽 4px，右端 2px 永远露不出来。改成 `padding: 0 2px` + `max-width: 100%`（右内边距同时计入 scrollable overflow，滚到最右时最后一颗胶囊离裁切边还有 2px）。
  - **验证（真实布局，11 档宽度 360→1400px）**：归档栏右边界不再超出父容器（`overflowParent=0`）、能滚到真正上限（`scrollLeft == scrollWidth - clientWidth`）、最后一颗胶囊完整可见（离栏右边缘 2px）；文档宽度恒等于视口宽、消息区无横向滚动、`.chat-pane`/`.message-area` 列宽恒等于容器宽。极端内容（40 颗胶囊 + 300 字符不换行 + 40 行超宽代码）下同样成立 —— 唯一「超出视口」的元素是代码块内部的横向滚动容器，属设计内。
  - **测试基建修正**：`test/preview-chat.html` 之前**缺 `.chat-pane` 与 `.message-area` 两层包裹**（还把归档栏套在 `.panel-stack` 里），所以宽窗口下的布局测量根本不代表真实结构 —— 这也正是上一轮「面板右边被切割」没能复现的原因。现已按真实模板补齐，宽度扫描才有效。
  - **守护脚本**：新增 `test/check-layout-containment.mjs` —— 断言 `.chat-pane`/`.message-area` 必须 `grid-template-columns: minmax(0, 1fr)`（并写明为什么）、`.app-shell` 必须是 `overflow-x: clip`、归档栏必须 `max-width: 100%` + 用 padding 内缩（禁止 `margin: 0 2px`）；诊断命令 `HWChat: 复制布局诊断` 增加 `capsuleBar` 一节（栏/父容器矩形、clientWidth/scrollWidth/maxScroll、滚到上限后最后一颗胶囊的位置与被裁多少、margin/padding），以后再出现这类问题一次就能拿到判据。23 个 `check-*.mjs` 全绿，`npm test` 795/795。

- **运行中新消息在小任务边界被重新判断：相关就并进当前分支，不再「隔几条就无限期压着」**（用户原话：「对话框 agent 正在运行，新消息进来，agent 需要执行完小任务后，先读取新消息，如果新消息和正在运行的任务相关，就合并，不管新消息和正在执行的消息之间间隔了多少条消息，都要先停下来判断一下再继续」）。
  - **原来的问题**：一条消息属于「相关指导」还是「独立分支」，只在**发消息那一刻**判一次，判据只有分支标题。一旦判成「排队」，就一直压到整条分支结束 —— 而一条分支可能跑几十轮，这期间它既不会被读、也不会被重新考虑。于是「和正在执行的那条隔了多少条消息」变成了隐式规则：隔得远就等于被无限期搁置。用户截图里那条「灵动岛的待办和书签…」正是这样卡在排队里的。
  - **现在的做法**：每次模型调用之前（也就是一个小任务刚做完、正要继续的时候）把**所有**还没在当前分支判断过的排队消息扫一遍，带上「现在到底在做什么」重新判 —— 判为相关的当场并进当前分支：任务树里从「排队」变成「已合并」，并且**同一个边界就交给 agent 读**（配的是原有的「立即重新评估当前分支、按这条消息调整计划」那段说明），不是等分支结束。
  - **判据不再只有一行标题**：新增实时上下文（`liveContext`）—— 任务清单进度（`3/9 已完成`）、正在做的那一项、下一项、以及最近三步工具动作。同一个标题下分支的焦点会移动，新消息相关的往往是**眼下这一步**。
  - **成本可控**：每条消息在**同一条分支**上只重判一次（队列里 `reviewedFor` 记分支 id），上限就是排队条数，不会把这笔开销摊到每一步。判失败（网络抖动、模型没回话）**不记账**，下个边界重试 —— 宁可多问一次，也不能把用户的话静默当成「已处理」。判定期间用户点了停止，则这次结论直接丢弃。
  - **只在小任务边界做，不在分支收尾做**：`replan`（分支还在继续）才重判；`complete`（分支已跑完）仍走原来的「开新分支」路径，避免把本该独立的任务硬并进一条已完成的分支。
  - **代码**：新增 `src/agent/taskReview.ts`（可测的编排层 `reviewQueuedTasks`）；`AgentTaskQueue` 增加 `pendingReview()` / `resolveReview()` / `awaitRouting()` / `isResumeScope()` / `activeNodeId()`，`PendingTask` 增加 `reviewedFor`；`classifyTaskRelation` 增加可选 `liveContext`。
  - **测试**：`taskQueueReview.test.ts` 8 条（扫描范围与间隔无关、相关→已合并并立刻交出、独立→本分支不重复打扰、换分支后重判、编辑中先不判、撤单幂等、续跑作用域、状态一致）；`taskReview.test.ts` 8 条编排（顺序、实时上下文真的进判定、失败不记账、同分支只判一次、停止即止、零开销、判定期间被撤单不误合）；`taskReviewLoop.test.ts` 2 条**端到端**（用真实 `AgentRunner` + 真实队列：第 1 轮进来的消息在**第 2 轮**就出现在模型收到的 messages 里且带「相关指导」说明，任务树变已合并；不相干的消息不会漏进当前分支上下文）。全量 **795/795** 通过，22 个 `check-*.mjs` 全绿。

- **修正：「编辑这条消息」点了还是没反应（第二次）—— 松手瞬间列表重排把按钮换掉，浏览器干脆不派发 click**。
  - **根因（实测事件序列，不是推测）**：`pointerdown` 落在编辑按钮上 → 按下期间 agent 流式吐 delta，重排被 defer → `pointerup` 时按钮**还在文档里**，老的兜底因此判断「浏览器会正常派发 click」而提前退出 → 可**同一个 pointerup 里后面的监听器** `releaseMessageInteraction()` 立刻 `flushDeferredMessageRender()` → `messageList.replaceChildren()` → 按钮被销毁 → 浏览器随即放弃派发 click（实测 `mouseup` 落到 `message-list` 空白处，`click` 事件完全没有）。所以只在「agent 正在跑」时坏，静态时正常。
  - **修法一（结构性，受益的不止这一个按钮）**：`releaseMessageInteraction` 增加 `afterClick` 选项，`pointerup` 这条路把被推迟的重排推到**下一个任务**（`setTimeout(…, 0)`）：先让 click 落地，再重建列表。消息里所有按钮/链接都受这条保护。
  - **修法二（入口不再赌浏览器）**：编辑按钮以 **`pointerup` 为准** —— 落点在按下时的按钮矩形内、**或**指针下当前就是同一条消息的编辑按钮（按住期间流式内容把气泡推走时），都直接打开；随后补发的 click 由 `editClickConsumed` 吞掉，避免双触发。每次 `pointerdown` 重置该标记，防止上一次没被消费掉时把下一次正常点击吞了。键盘（Enter/空格）不产生 pointer 事件，仍走按钮自己的 click 监听。
  - **修法三（顺手修掉的同类问题）**：`Esc` / `⌘Enter` 原来挂在 textarea 自己身上，焦点一旦被挪走（宿主抢焦点、上一个动作残留）就静默失效 —— 编辑框明明开着却关不掉。改成挂在 `document` 上、以「编辑框是否可见」为条件，并保留 `isComposing` 判断（中文组字时 Esc 是取消候选，不能关框）。
  - **验证（headless Chromium，真实事件）**：50ms 流式下连点 40 次 **40/40**、20ms 极高频 25/25、静态 10/10；每次点击只挂一次闸门（40 次点击 = 40 次 `beginEditTaskMessage` + 40 次 `cancelEditTaskMessage`，不重复、不泄漏）；松手落点偏移 6px 仍算点中、偏移 200px 不误触；原生鼠标（会补发 click）不双触发；焦点不在编辑框时 Esc/⌘Enter 仍有效；组字中的 Esc 不关框。修复前同一场景的复现是「静态能开、有流式就永远打不开」。

- **修正：三个联网工具「发出去了却执行不了」——`search_web` 一律回「工具未被允许」**（用户实测原话：「工具 search_web 未被允许。」→「互联网参考功能没有实现」）。
  - **根因**：`definitions()` 在「互联网参考」打开时把 `search_github_repos` / `search_web` / `fetch_url` 加进了下发给模型的工具清单，但 `ToolExecutor.checkAccess()` 里还留着一份**手抄的 11 项白名单**（只有读写与命令类工具）。于是三个联网工具**发了出去、模型也调了，却在准入那一关被当成「模型瞎编的工具名」拒掉**，前端只看到一句「工具 search_web 未被允许。」——看起来像模型乱调工具，实际是白名单漏了 3 个名字。原先的 `internetReference.test.ts` 测了地址过滤、RSS 解析、提示词注入、开关存储，**唯独没测「下发的工具能不能执行」**，所以整条链路一直是断的。
  - **修法（改结构，不是补三个字符串）**：把白名单提成模块级声明式清单 `LOCAL_TOOL_NAMES` / `RESEARCH_TOOL_NAMES`，准入判断收敛成一个纯函数 `toolAccessError(name, settings)`：本地工具直接放行；联网工具**还要再问一次「互联网参考」开关**（关着时这些名字根本没告诉过模型，真收到就是编的，不能替它联网）；其余名字一律拒绝。`checkAccess()` 只负责调它。
  - **不再逐次弹审批**：联网工具不再套用「文件读取」策略。它读的不是你的文件，探不探网由开关决定（每对话、默认关），若沿用 `fileReadPolicy`，默认 `askAll` 档位下每搜一次都要点一次批准，一次调研十几次调用 —— 而用户早前已明确说过这种弹窗很烦。SSRF 硬检查（拒本机/内网）与地址白名单仍然照旧生效。
  - **拒绝文案分开**：开关关着时说清「是开关没开，去工具栏点地球图标」，而不是复用「未被允许」——后者会让人以为工具坏了或模型在瞎调。
  - **测试（8 条，重点是那条不变量）**：`toolAccess.test.ts` 断言 **「凡是 `definitions()` 会下发的名字，都必须能通过 `toolAccessError()`」**（开关开/关两种状态各跑一遍）；再加「联网工具只在开关打开时下发且恰好三个」「关着时给的是开关提示而非未允许」「编造的工具名仍被拒」「端到端 `fetch_url` 真的走到读取逻辑」「端到端内网仍被拒」「被拒的调用不弹审批」「`askAll` 档位下不逐次弹审批」。以后再加工具忘了同步白名单，第一条会立刻红。
  - **真实网络复核（不是只有单测）**：`fetch_url` 读 MDN `backdrop-filter` → 干净 Markdown（`正文抽取：Markdown（已去掉导航/侧栏等噪声）`，标题修正为 `backdrop-filter CSS property`）；`search_web` → 5 条线索；`search_github_repos` → 39 个匹配里取前 5（带星数/语言/许可证/更新时间）。全量 **777/777** 通过，22 个 `check-*.mjs` 全绿。

- **爬虫正文质量：`fetch_url` 改为真·正文抽取（Markdown），并补齐开源许可证合规**（用户原话：「爬虫功能，参考 GitHub 上高 star 的爬虫开源项目，如果直接用了，记得符合开源协议。」→ 追问后选择「要正文质量」）。
  - **为什么原来不行**：`fetch_url` 拿到的 HTML 只做了一层 `htmlToText()`（去标签 + 压空白），于是导航栏、侧边栏、面包屑、Cookie 横幅、页脚全都混进正文，模型读到的「资料」一半是噪声——反而更容易跑偏。
  - **候选实测（都是高 star 项目，本机真跑过）**：`defuddle` 9.8k★ MIT；`@mozilla/readability` 11.5k★ Apache-2.0（还需配 `linkedom` 解析器）；`crawlee` 26.3k★ Apache-2.0（带浏览器编排，对「抓一页正文」太重）；`cheerio` 30.5k★ MIT（要自己写选择器规则）；`html-to-text` 1.7k★（去标签，不识别正文）。
  - **选 `defuddle` 的理由**：它就是为「网页 → 干净 Markdown」写的（Obsidian Web Clipper 的抽取内核），一次调用直接给出带标题层级/列表/代码块/表格的 Markdown，无需自己维护选择器规则。
  - **质量实测**：MDN 一页 **327 KB HTML → 4057 字干净 Markdown**，导航/侧栏/页脚全部清掉，标题、链接、代码块、表格结构保留。
  - **体积代价（实测）**：`extension.js` 689 KB → **3.38 MB**，VSIX 553 KB → **1.09 MB**。为质量接受这个代价；如果以后嫌大，`defuddle` 的数学公式转换（temml / mathml-to-latex）是主要增量。
  - **实现**：新增 `src/agent/webExtract.ts` —— `extractReadableContent(html, url, maxChars)` 调 `Defuddle(html, url, { markdown: true })`，抽出的正文 **≥ 200 字才采用**（`MIN_EXTRACTED_CHARS`），否则**回退**到原来的整页文本，绝不返回空内容；超长按 `maxChars` 截断并注明。`fetch_url` 的输出会明说这次是「正文抽取：Markdown（已去掉导航/侧栏等噪声）」还是「整页文本（未能识别正文，已回退）」——让模型知道自己读到的是什么。
  - **许可证合规（这是「直接用了就得守协议」的落地）**：MIT / BSD-2 / ISC 都要求再分发时附带版权声明与许可全文，而我们是把这些库 **bundle 进 `extension.js` 再发 VSIX**。所以新增 `scripts/third-party-notices.mjs`：以 esbuild 的 **metafile** 统计「真的从入口走得到」的包（不是照抄 `dependencies`），逐个读它的 LICENSE 全文生成 `THIRD-PARTY-NOTICES.md`；**任何一个包找不到许可证文件就让构建失败**（`process.exit(1)`），不允许静默漏署名。当前清单 **19 个包**（`defuddle` MIT、`@mixmark-io/domino` BSD-2、`temml`、`htmlparser2`、`@xmldom/xmldom`、`@acemir/cssom`、`linkedom` ISC、`mathml-to-latex`、`entities` BSD-2、`css-select` BSD-2、`domutils` BSD-2、`css-what` BSD-2、`turndown`、`domhandler` BSD-2、`dom-serializer`、`nth-check` BSD-2、`domelementtype` BSD-2、`uhyphen` ISC、`boolbase` ISC），清单随 VSIX 一起分发。
  - **`npm run package` 现在三步**：编译 → 生成/刷新许可证清单 → `vsce package`。加这一串的理由是清单必须跟代码同步，不能靠人工记得重跑。
  - **测试**：`webExtract.test.ts` 4 条（真实调用 defuddle：结构保留 + 噪声清除、超长截断、抽不到时回退而非空、`fetch_url` 接线与来源标注）；`thirdPartyNotices.test.ts` 5 条守护（清单存在且声明来源、`defuddle` 与 MIT 全文在册、`package.json` 每个运行时依赖都出现在清单里、`.vscodeignore` 没把它排除、打包脚本包含生成步骤且缺许可证会失败）。全量 **769/769** 通过，22 个 `check-*.mjs` 全绿，VSIX 内确认含 `THIRD-PARTY-NOTICES.md`。

- **排队消息的编辑改成「悬浮编辑框」，并且 agent 会停下来等你改完**（用户原话：「点击有时候没反应，不灵敏…可以做成点击编辑后显示编辑界面在新的层级显示，比如显示一个悬浮编辑窗口，不被 agent 运行输出内容影响…编辑结束之前，如果 agent 刚好运行到这个正在编辑的消息，会暂停等待，修改完，编辑框消失，才会读取更新后的消息内容继续执行」）。
  - **点击不灵敏的根因**：编辑框原来长在消息气泡里，而 agent 运行时消息列表每 70ms 就可能重排一次（流式增量 / 任务树变化）。按下与松开之间按钮被换掉时浏览器**根本不派发 `click`**（和 `<summary>` 那次同一个实测结论），于是「点了没反应」；即使点开了，编辑框也会随下一帧重绘被销毁 —— 光标跳回开头、正在拼的中文被打断。
  - **修法一（结构）**：编辑框搬到 `#messageList` **之外**的独立浮层 `#messageEditor`（fixed + 遮罩 + 居中面板），消息列表怎么重排都碰不到它。同时删掉旧的「编辑中暂停重绘」守卫和气泡内编辑态样式 —— 现在不再需要暂停渲染了。
  - **修法二（点击兜底）**：编辑按钮带稳定的 `data-edit-message`，`pointerdown` 时记下消息 id 与落点，`pointerup` 时若原按钮已被换掉（`isConnected === false`）就按消息 id 重新找回并打开浮层；按钮还在则交给原生 click（不双触发）。
  - **修法三（后端闸门）**：新增 `AgentTaskQueue.holdForEdit()/releaseEdit()`。`take()` 是 agent 循环里唯一「取下一条任务」的入口，在它前面等闸门 = **整轮停下来等人**：agent 走到这条消息时暂停，用户保存后才读到新内容继续；取消则按原内容继续。闸门只等**队首**那一条（后面的任务不抢跑也不被误挡），幂等（重复打开不续命），并且有 **5 分钟超时**（编辑框忘在那里不会把任务卡死）。`finish()` 与「撤回消息」都会释放全部闸门；等待期间这一轮被停止的话，`take()` 会在 await 之后重新检查 `accepting`，不再交出任务。
  - **界面反馈**：浮层标题右侧显示状态 —— 打开时是「保存后 agent 会读新内容」，agent 真的走到这条并停住时变成「agent 正在等你改完」（带呼吸点），提示行同时说明「已暂停执行，最多等 5 分钟」。这来自后端队列的 `waitingForEdit`，不是前端猜的。
  - **保存后同步气泡**：仍然走既有的 `editTaskMessage`（改队列 request + 存档消息 + 回推 `messageUpdated`），所以浮层一关，气泡里的文字就是新的。
  - **测试**：新增 `src/test/editHold.test.ts` 10 条 —— 闸门挡住 `take()`、保存后读到新内容、取消保持原样、`editing/waitingForEdit` 状态、只等队首、幂等、`finish` 释放、超时常量、面板与前端接线；真机 headless Chromium **15/15** —— 浮层不在列表内、点击打开且聚焦、**25 次流式重绘后浮层与输入内容都不丢**、agent 等待提示、保存先关浮层再提交、气泡随保存更新、Esc 放行、**按钮在按下与松开之间被换掉仍能打开**。另在 430/768/1200 三种宽度确认浮层不出界、文档无横向溢出。全量 760/760。

- **新功能：「互联网参考」开关 —— 打开后先上网找成熟方案，再动手**（用户原话：「ai 容易自己瞎写…开启后，agent 执行任务时候，需要先搜索网络上的任务相关的项目，对现在的任务进行优化后再执行」）。
  - **开关位置**：工具栏上**原来的「刷新模型列表」按钮**（那个 ↻）被替换成地球图标的开关。关闭是灰描边，开启是强调色实心底 + 白色地球，`aria-pressed` 与悬停提示都带状态（「已开启…点击关闭」/「已关闭。开启后…」）。
  - **为什么换掉刷新按钮**：模型清单改成了**静默自动刷新**，用户不需要也不该手动点它（见下一条）；而「先查再写」是一个需要随手开关的**工作方式**，放在主工具条比埋进设置页合理。
  - **工作方式（写进系统提示词的三个阶段，每次请求都重新注入，含「继续」）**：
    1. **调研**：`search_github_repos` 找相关成熟开源项目（按星数排序、带许可证与最近更新），`search_web` 找概念与文档入口，再用 `fetch_url` **读原文**，逐条写下「URL + 一句结论 + 与本项目的差异」；
    2. **对齐计划**：把结论并进任务清单（第一项就是调研），剩下的条目按学到的东西调整、甚至推翻原来的想法；
    3. **执行**：按读到的方案动手，与来源不同时用一句话说明原因。
  - **三条硬规矩**（同样写进提示词）：结论必须带 URL，没读过就不能引用；搜索摘要只是**线索**、不能当依据；搜不到就明说「没找到权威方案」并给出 2-3 个候选与代价 —— 不许把猜的包装成调研。引用代码前先看许可证与版本前提。
  - **三个联网工具只在开关打开时下发**（关着时模型看不到它们，不会偷偷联网）：`search_github_repos` / `search_web` / `fetch_url`。后端选择是**实测**出来的，不是猜的：
    - GitHub `search/repositories` API → 200，返回真实仓库（星数/描述/许可证）——正好对应「搜索任务相关的项目」；
    - Bing 的 `format=rss` → 200，可解析，但结果会被本地化带偏（中文查询尤其明显），所以输出里明确标注「只是线索」；
    - `html.duckduckgo.com` / `lite.duckduckgo.com` / `api.duckduckgo.com` → **202 反爬挑战页**，解析不出结果，因此不做搜索引擎结果页抓取。
  - **`fetch_url` 的安全边界**：只允许 http/https，拒绝带凭据的 URL，并**拒绝本机与内网地址**（`localhost`、`127.x`、`0.x`、`10.x`、`192.168.x`、`172.16-31.x`、`169.254.x`、`*.local`、单标签主机名、`::1` 等）——模型在「找资料」时会顺手拼 `http://localhost:3000`，那既取不到东西又会把开发服务器刷满。单页上限 2MB、正文 20k 字符、20 秒超时，`<pre>` 里的缩进保留（代码/目录树不能被「压缩空白」吃掉）。
  - **按对话存储**：与权限预设/最大步骤/思考深度同一套机制（`ConversationControls.internetReference`），随对话存档、重载窗口仍在，默认关闭。只有布尔 `true` 才算开启（`"true"`、`1`、脏值一律当关闭——这一项误开会把内容发给第三方检索服务，所以「读不懂就不联网」）。运行中也能切换，下一次发送生效。

- **模型列表改成静默自动刷新（去掉手动刷新按钮）**。
  - 原来那个 ↻ 按钮只在两种情况下才被用上：**换了 API Key** 之后、以及**第一次拉取失败**之后 —— 因为旧实现把「已尝试」记在一个永不清理的 Set 里（同一 profile+baseUrl 只拉一次），于是这两件事之后清单永远是旧的。
  - 现在 `ensureModelsFresh()`：成功后缓存 **10 分钟**，失败只退避 **60 秒**就允许重试；切 API 配置、保存 API Key 时 `force` 立刻重拉；正在拉取时直接跳过，不会因为切换对话打连环请求。全程不弹提示、不显示加载态 —— 成功就悄悄换新清单，失败就继续用上一次成功的那份。
  - 顺带删掉已经失效的 `#refreshModelsButton.loading .icon { animation: spin }` 死规则，并把 `check-icon-geometry.mjs` 里「refresh 是旋转图标」那条断言换成「工具栏的联网开关用 globe 图标 + 开启态有独立样式」。

- **修正：面板右侧被裁剪（对话框显示不全）** —— 加横向硬边界 + 布局诊断命令。
  - **先查证再动手**：用「从 `chatPanel.ts` 真实 `html()` 模板生成静态页 + 真实 `media/chat.css`」的方式，在 754 / 768 / 800 / 900 / 1000 / 1200 宽逐档测量，并往消息区塞了 2000px 固定宽元素、`nowrap` 600 字符、`pre` 400 字符、长表格、多张 132px 图片行 —— **`document.scrollWidth` 始终等于视口宽，越界元素 0 个**。也就是说正常内容不会撑宽文档，右侧被切不是某条消息内容造成的。
  - **加固（无论根因都能减少损伤）**：`.app-shell` 加 `max-width: 100%` + `overflow-x: clip`（用 `clip` 而不是 `hidden`：`hidden` 会建立滚动容器，里面 absolute 定位的技能面板和「回到最新消息」按钮会失效）；`.message-area` 补 `min-width: 0`；`.message-list` 与 `.composer-wrap` 补 `max-width: 100%`。实测加固后即使塞 2000px 固定宽元素、`nowrap` 长串，`document.scrollWidth` 仍等于视口宽（754），内容被裁在聊天栏内而不是把整页撑宽。
  - **为什么还要诊断命令**：症状有两种完全不同的成因，截图分不出来 ——
    1. 内容把文档撑出横向滚动（我们的 CSS 问题）；
    2. **webview 宽度与可见区域不同步**（宿主没重排），此时 `文档.scrollWidth == 视口 clientWidth`，两者相等却整体偏右被窗口裁掉。
    扩展宿主看不到 webview 的任何尺寸，所以新增命令 **`HWChat: 复制布局诊断`**：面板自己量视口宽/高、`devicePixelRatio`、`innerWidth`、文档与 `body` 的 `scrollWidth`、横向溢出量、`#app` / 侧栏 / 聊天栏 / 消息区 / 消息列表 / 输入框 / 工具栏的矩形与 `scrollWidth`、两条媒体查询命中情况，外加最多 8 个越界元素，复制到剪贴板。这样一次就能分清是哪一种。
  - **测试**：`test/check-panel-budget.mjs` 增加「`app-shell` 必须用 `overflow-x: clip`」「不许改成 `hidden`」「`message-area` 有 `min-width: 0`」「列表与输入框有 `max-width` 兜底」四条守卫；全量 739/739，22 个 `check-*.mjs` 全绿。

- **修正：任务树 + 任务清单都展开时，对话框被挤到看不见**（用户反馈「这种状态下界面对话框显示不全」）。
  - **先量后改（headless Chromium，真实 chat.css，两个面板都展开）**：
    | 窗口 | 改前消息区 | 占聊天栏 | 改后 | 占聊天栏 |
    |---|---|---|---|---|
    | 768×620 | 88px | 14% | 187px | 30% |
    | 768×830 | 264px | 32% | 338px | 41% |
    | 768×1000 | 434px | 43% | 481px | 48% |
    | 430×620 | 103px | 17% | 202px | 33% |
  - **根因**：`.panel-stack` 的 `max-height: min(44vh, 360px)` —— 面板按 vh 要空间，聊天栏又是一行 `minmax(0,1fr)`，消息区只能吃剩下的；620 高的窗口里只剩 88px（一行半字）。
  - **改法**：上限降到 `min(28vh, 260px)`；另加 `@media (max-height: 560px)` → `min(22vh, 180px)`（480 高的窗口实测 101px → 130px）。面板自己有 `overflow-y: auto`，内容再多也能滚（实测 `scrollTop` 可滚到底、最后一项可见）。
  - **试过但否掉的方案**：给 `.chat-pane` 的行加像素下限 `minmax(120px, 1fr)` —— 实测 430×480 会把**输入框顶出视口**（`composer.bottom > pane.bottom`），那比消息区小更糟，所以只下调面板上限。
  - **横向也查了（结论：没问题）**：在 180 / 200 / 220 / 240 / 260 / 280 / 300 / 320 / 380 / 430 / 500 / 600 / 700 / 721 / 740 / 768 / 820 / 900 / 1100 宽度逐档测 `document.scrollWidth` 与「聊天栏内所有元素的右边界」，**0 个溢宽元素**；窄于 720px 走的是既有的单栏 + 抽屉式侧栏。
  - **顺带修好测试夹具**：`test/preview-chat.html` 缺 14 个元素 id，且面板没包在 `.panel-stack` 里（所以预览页量出来的高度和真实 webview 不一致，正是这次差点误判的原因）。已按真实 DOM 结构补齐，以后量布局可以直接用这个页面。
  - **测试**：新增 `test/check-panel-budget.mjs` 守住「上限 ≤ 30vh / 260px、面板自己滚、不被 flex 压扁、矮窗口让步、不要给行加像素下限」；`todoPanelState.test.ts` 里写死 `44vh/360px` 的那条改成「有 vh 也有像素上限且不超过新值」。全量 739/739，22 个 `check-*.mjs` 全绿。

- **每条用户消息气泡都显示执行状态（还没执行 / 执行中 / 已执行 / 已跳过），四种颜色区分**。
  - **需求**：「方便在出现多个气泡，执行中断再继续的时候，查看哪些消息是被执行了，哪些是被忽略了。避免项目执行过程中漏掉任务。」
  - **为什么不能靠任务树**：任务树只在运行期间下发（`runs.has(conversationId)` 才给），运行一结束或点「继续」开新一轮，上一轮的消息跑没跑就看不出来了；而且 `AgentTaskQueue.finish()` 会把 `routing/active/queued` 一律改成结束状态，**排队但一次没跑**的消息在任务树里和「跑完的」长得一模一样。
  - **状态落在消息本身**：`ChatMessage.executionStatus: 'pending' | 'running' | 'done' | 'skipped'`，写进存档，所以运行结束、切对话、重启 VS Code 都还在。
  - **流转时机**：发送（发起本轮）→ `running`；排队消息 → `pending`；`activateResponse()` 取走执行 → `running`；`completeResponse()` 结算 → **按 `activated` 判**「`done`（agent 读过）」或「`skipped`（从没读过）」。异常退出没来得及结算的，启动时 `readMessageForReconcile()` 收口：`running` → `done`、`pending` → `skipped`。
  - **界面**：每条用户消息底部一枚徽标 —— 还没执行（橙 · 虚线）、执行中（蓝 · 呼吸点，`prefers-reduced-motion` 下不动）、已执行（绿 · 实线）、已跳过（灰 · 虚线）；悬停有解释。「编辑这条消息」按钮只在**还没执行**时出现（执行中的那条改不了，见上一条修复）。没有 `executionStatus` 的老消息不画徽标 —— 认不出就不猜。
  - **脏值兜底**：存档里认不出来的状态值在读盘时丢弃（`normalizeExecutionStatus()`），否则手改存档能让界面上出现一个不存在的状态。
  - **测试**：`storage.test.ts` 新增 3 条（写入/读回/落盘重开、脏值丢弃、重启收口）；`bubbleEdit.test.ts` 更新为「每条用户消息都有徽标、编辑按钮只在 pending」；真机 headless Chromium **22 项全部通过**（四态文案、四种颜色互不相同、虚线 vs 实线、只有 pending 有编辑按钮、`messageUpdated` 推送后 running→已执行 / pending→已跳过、浅色主题下颜色仍可区分）。全量 739/739。

- **修正：执行中的任务树节点还能点「编辑」**。
  - **现场**：任务树里标着**执行中**的那一行，悬停后仍有「编辑」，点开是任务树里的**单行输入框** + 保存/取消（见用户截图）。
  - **为什么这是 bug**：`take()` 之后那条 request 已被 agent 读走，`taskQueue.editPending()` 必然返回 `false`；`chatPanel.editTaskMessage()` 对 `false` 的处理是 `this.send(content)` —— 于是「改一条正在跑的任务」实际变成**把内容当新消息再发一遍**，同一件事被排队做第二次。而且单行输入框看不全长内容。
  - **修法**：
    - `taskNodeActions()` 里**去掉 `active`**：执行中的节点不再有任何行内操作（只有状态文字「执行中」）。要改方向就在输入框补一句（走既有的「相关指导」合并），或先停止。
    - **彻底删掉任务树行内编辑**（`editingTaskId` / `editingTaskDraft` / `taskEditBox` / `beginTaskEdit` / `commitTaskEdit` / `cancelTaskEdit` 与 `.task-node-edit*` 样式）：只有一行，长内容没法改。
    - 「已完成」节点的「编辑」保留，但改用**气泡里的多行编辑框**，标题写明「编辑并重新发送」，提示「历史不会改写，保存后作为一条新消息发出」——入口在任务树，编辑界面在气泡。
  - **测试**：`bubbleEdit.test.ts` 增加「执行中/取消/失败等状态一律不给行内操作」「任务树里不存在行内编辑框」「点编辑要打开气泡编辑」；`taskQueueEdit.test.ts` 增加一条后端契约 —— `take()` 之后节点是 `status: 'active'` 且 `pending: false`，`editPending` 返回 `false`（也就是界面判定「不许编辑」的依据）。真机 headless Chromium 复刻用户截图的状态，**15 项全部通过**：执行中行 button 数为 0、排队行只有删除、完成行的编辑开在气泡且带「重新发送」说明。全量 736/736，21 个 `check-*.mjs` 全绿。

- **修正：`chat.tools.edits.autoApprove` 被当成布尔开关写，实际是 glob 映射**。
  - **依据（官方文档 + 本机 VS Code 1.144 的配置声明）**：VS Code 文档《Manage approvals and permissions》与《Secure AI-assisted development》都把它描述为按 glob 配置（例如 `"**/.env": false`）；本机 `workbench.desktop.main.js` 里该键是 `type: "object"`、`additionalProperties: boolean`，默认值形如「普通文件 true / `.git`、`package.json` 等敏感路径 false」。
  - **问题**：`APPROVAL_TARGETS` 把它声明成 `kind: 'boolean'`，于是 `standard` / `everything` 档会往设置里写 `"chat.tools.edits.autoApprove": true`——类型错误，VS Code 会标红并忽略，表现为「设置了但没生效」。
  - **修法**：不再管理这个键（它的默认值本来就放行文件编辑，只排除敏感路径；要全放行走 `chat.tools.global.autoApprove`），并在代码里留下依据与原因。
  - **测试**：`approvalPlan.test.ts` 相应更新，并新增一条回归——四个档位都不得为该键生成操作。

- **单次运行的工具调用总数改为不限制（四个档位全部生效）**。
  - **现场**：上一版把「无限制」档位从 200 放宽到 1000，常规档位保持 200。用户实测后要求整体取消：「执行次数多了，每次运行命令都弹窗，很麻烦，请所有循环轮数情况下，将单次运行工具调用总数都设置为不限制。」
  - **改动**：`MAX_TOOL_CALLS_PER_RUN` 直接设为 `Infinity`，删除按档位分配预算的 `toolCallBudgetForSteps()` 与两档常量；循环里的累计计数器、`totalToolCalls >= maxToolCalls` 判断、`toolBudget` 停止原因与对应提示文案一并移除（不再有「调用次数用尽，回复继续」这种打断）。
  - **单轮节流保留但不再中断**：一轮里超过 12 个调用时，超出的部分仍然不执行，但以前是**结束整次运行**，现在只把「未执行」的 tool 结果回报给模型、循环继续下一轮 —— 模型能看见哪些没跑并据此重新组织，用户不必再回一句「继续」。
  - **剩下的闸门（不限制 ≠ 没有守卫）**：单轮 12 个调用、同一调用连续 3 次判死循环、连续 3 轮全部失败即停、有限档位仍由轮数预算（24 / 68 / 120）封顶、停止按钮随时可用。
  - **测试**：`src/test/toolCallBudget.test.ts` 改写为「无运行总量闸门」的契约；`agentLoop.test.ts` 补一条真机回归 —— 每轮 2 个不同调用连跑 150 轮（**300 次调用**），确认一次都没被拦、没有 `denied` 步骤、没有预算提示；同时把单轮超限那条改成断言「继续到下一轮」。全量 732/732 通过，21 个 `check-*.mjs` 全绿。
  - **补充说明（不在本次代码范围内）**：命令类工具的逐次确认框由 **VS Code 自己**决定（桥接工具 `delegateApproval: true`），与调用次数无关；要一次配平请用命令 `HWChat: 同步 VS Code 审批预设`。README 中英都已写明这一点。

- **排队消息改成在「消息气泡」里编辑，保存后任务树同步**。
  - **问题**：任务树一行只显示一句标题，长消息改起来只能看见一行，前后文全都看不见；而且同一个操作在两处（任务树行内编辑 + 消息本身）容易对不上。
  - **改动**：气泡底部给排队中的消息加一枚「还没执行」标记 + 「编辑这条消息」，点开是**多行编辑框**（整条消息的宽度、按内容自动撑高、最高 420px 后自己滚）。`⌘/Ctrl + Enter` 保存、`Esc` 取消；任务树对排队节点**只保留删除**，标题的悬停提示指向气泡。
  - **同步**：保存仍走既有的 `editTaskMessage` —— 后端改队列里那条 request + 存档里那条消息，再回推 `taskTreeChanged`，所以任务树那一行与气泡会一起变成新内容，界面层不自己写存档。
  - **编辑中不重画**：流式输出、任务树变化都先记下来，退出编辑时才补一次整段重建；否则编辑框会被销毁，光标、选区、以及中文输入法正在拼的字都会丢。排队状态变化时只重画受影响的那几条消息。
  - **边界**：agent 已经取走执行后，气泡里的入口消失（历史不改写）；这时从任务树「编辑」仍然是把改过的内容当新消息再发一次。切对话、删除消息都会收起编辑框，避免把草稿存到别处。
  - **测试**：新增 `src/test/bubbleEdit.test.ts` 14 条（判定函数、任务树按钮集合、文案与接线）；另用 headless Chromium 跑真实界面 **17 项全部通过**（入口只在排队时出现、编辑框装的是完整原文、打开即聚焦、流式中不重建、Esc 不发送、保存发出正确请求、保存后气泡与任务树同步、取走后入口消失）。

## 0.2.8

- **鼠标停在工具步骤模块上时颜色一闪一闪、点击展开/收起很不灵敏** —— 同一个根因，一起修好了。
  - **依据（先查规范再动手）**：
    - **CSS Selectors 4 §9.1**：`:hover` 只在「用户用指向设备**指定**某个元素」期间生效；官方 WPT 用例 `remove-hovered-element.html` 的标题就是「悬停元素被移除后，祖先的 `:hover` 样式被清除」——**元素一旦被换掉，悬停状态立刻失效**，新节点要等 UA 下一次命中测试，中间那一帧就是「没有高亮」。
    - **HTML 规范 §4.11.2**：`<summary>` 的 activation behavior 挂在 **summary 元素自己** 上（「If this summary element is not the summary for its parent details, then return」），只有它自己收到激活才切 `open`。
    - **MDN《Element: click event》**：按下与松开不在同一个元素上时，click 派发到「同时包含两者的最近祖先」。
  - **实测结论（比文档更狠）**：`pointerdown` 之后把 summary 换掉，浏览器**根本不派发 `click`**（`pointerdown` 有、`click` 没有）——所以「用 click 委托兜底」这条路是死的，必须挂在 `pointerup` 上。
  - **根因：结构签名把「临时位置」当成了结构变化**。工具步骤块的插入位置是 `min(contentOffset, 正文长度)`：当这一步工具位于「正文还没写到」的位置时，它只能贴在末尾，而这个临时位置**随着正文每长一个字都在变**。`toolGroupSignature()` 把它算进了签名，于是每一帧都宣布「结构变了」→ 整条消息重排 → `<details>` 与 `summary` 被销毁重建。后果有两个：悬停高亮被反复销毁重建（颜色闪），以及点击落在正要被替换的节点上（点不动）。
  - **实测（headless Chromium，20 帧流式）**：修复前 `tool-execution` 节点被换掉 **20 次 / 127 帧**、hover 状态丢失 **124 帧**、12 次真实鼠标点击丢失 1 次；修复后节点重建 **0 次**、hover 只在内容把元素推走时变化（翻转 1 次）、12 次点击**全部生效**。
  - **修法**：`groupToolsByOffset()` 给分组补一个 `pending` 标记（这一步工具还在正文之后），签名里把 pending 组统一记成 `'pending'` 而不是具体字符位置 —— 只有「工具集合/状态变化」和「正文终于写到那个位置」才会真的触发一次重排。
  - **另加两道保险**：
    1. 点在 `<summary>`（工具步骤、思考过程、任务面板的折叠标题）上之后，把渲染暂停窗口从「立刻释放」延到 **400ms**，让这次展开先落地。
    2. **`pointerup` 兜底**：`pointerdown` 时记下「稳定标识 `data-detail-key` + 节点 + 矩形」；松开时若发现**按下那个节点已经不在文档里**（说明浏览器不会派发 click），就按标识在**当前** DOM 里找回同一个折叠块、切它的 `open` 属性 —— 与规范的 activation 完全等价。节点换了、身份没换，用户点的还是那一步。释放点必须仍在按下时的矩形内，所以「按住拖走再松开」不会误触发；节点还活着时一律交给原生处理，不会双触发。
  - **实测（headless Chromium）**：流式输出 79 帧，工具节点重建 **0 次**、hover 翻转 **1 次**（此前 133 帧里重建 20 次、hover 丢 124 帧）；正常点击 **true**、按下后节点被换掉仍 **true**、按住拖走 **false**。
  - 新增 `src/test/toolGroupStability.test.ts`（5 条：pending 判定、边界、签名抹平前后一致、正文追上后只变一次、点击后延长暂停）。

- **你发出的长消息默认折叠了**。贴进去的长篇需求（一份 ADR、一整段决策表）原本会把对话框顶成几屏，自己刚说的话反倒把回复挤出视野。
  - 阈值：超过 **480 字**或 **12 行**（满足其一即可，纯文本按原始内容算，所以 Markdown 表格这种「字不多但行很多」的也折）。短消息完全不折叠、也不出现按钮。
  - 折叠只切一个 CSS class（`is-clamped`，`max-height` + `mask-image` 渐隐），**不重建任何节点**：正文里的 Markdown、表格、代码块、文件标签和你的选中状态都原样保留，展开时滚动位置也不跳。
  - 展开状态记在模块级集合里，所以后面有新消息触发整段重绘时，已经展开的那条仍然是展开的——不会「刚展开又被缩回去」。
  - 按钮带 `aria-expanded`，文案走 i18n（展开全文 / 收起），中英都有。
  - 新增 `src/test/userMessageClamp.test.ts`（9 条：阈值边界、只看用户消息、折叠不重建 DOM、展开状态持久化、CSS 与文案接线）。headless Chromium 实测：折叠 216px / 展开 472px，按钮文案与 `aria-expanded` 同步，整段重建后仍保持展开。

- **归档胶囊不再限制数量了**。以前一份对话最多 12 份归档，超出的挤掉最早那份；现在胶囊栏支持横向滚动，限量的理由（「太多会变成一排细线」）不成立了，所以**卡片数量不设上限**，一条对话完成多少份清单就保留多少份。
  - 这也是个真实的数据丢失问题：跑到第 13 份清单的长任务里，最早那几份归档会被静默丢弃，用户回头就找不到「刚才做了哪几步」。
  - 单条归档自身仍限制 40 项（`MAX_ARCHIVED_ITEMS`），所以 manifest 的增长与用户实际完成的任务数同阶，不会失控。
  - `appendTodoArchive()` 去掉了 `limit` 参数与裁剪，`normalizeTodoArchives()` 也不再截断；`src/test/todoArchives.test.ts` 的两条上限用例改成「40 份 / 31 份全部保留」。headless Chromium 实测：420px 宽面板下 20 颗胶囊全部渲染且可横向滚到最右（`scrollWidth 690 / clientWidth 420`）。

## 0.2.7

- **思考层级现在和支持它的模型真正打通了：DeepSeek 官方模型可选「默认 / 无 / 低 / 高 / 最大」，与 Copilot 一致**。用户反馈「Copilot 能给 DeepSeek 定思考层级，HWChat 不行，只能看到『能力未知』的灰下拉框」。审计后发现不是没能力发参数——发请求那一侧本来就是对的——而是**能力探测把正确的内置能力表冲掉了**：
  - **根因 1：不认 DeepSeek 官方 `/models` 的元数据结构**。官方把档位放在嵌套对象里：`effort: { supported_levels: ["low","high","max"], default_level: "high" }`，而 `reasoningEfforts()` 只认 6 个扁平数组键（`reasoning_efforts` / `thinking_levels` …），`reasoningCapability()` 又去查 `capabilities` 而不是官方的 `api_capabilities` → 一律读不到 → 能力判成 `unknown`。现在新增嵌套读取（`effort.supported_levels` / `supportedLevels` / `levels`、`capabilities.reasoning_efforts`），并在只有 `default_level` 时按官方取值补齐档位，避免把「确实支持思考」判成未知。
  - **根因 2：探测结果整体替换内置能力表**。`modelOptionsForProfile()` 里 `if (discovered?.length) return discovered…` 直接返回探测结果，而探测只修显示名、不补能力，于是 `configurable` 被洗成 `unknown`（刷新窗口后先短暂显示四档、随即变灰，正是这个顺序）。新增 `core/modelCapabilities.ts` 的 `withFallbackCapabilities()`：**探测到的能力优先，探测缺失才回落到内置值**；`discoverModels()` 推给面板的那份也一并补齐。
  - **根因 3：「无」被当成非法值**。DeepSeek 的 `effort.supported_levels` 按官方定义**不含 `none`**（文档原话：`none`, which turns thinking mode off, is not included），于是按声明列表校验时「无」会被静默改回「默认」——用户以为关掉了思考，实际仍在发 `thinking: enabled`，多烧 token。现在 `none` 对任何「可调」模型都合法（`thinking: {type:'disabled'}` + `reasoning_effort: 'none'`，有请求体断言）。
  - **档位集合对齐官方**：DeepSeek 内置能力表的档位由 `low/medium/high/max` 改为 `none/low/high/max`——`medium` 只是服务端兼容别名（折算成 `high`），声明它会让界面多出一档官方并不存在的「中」。旧存档里存着 `medium` 的对话会显示成「默认（模型官方）」，而两者的实际请求行为一致（都是服务端默认 `high`）。
  - **顺手做的一处重构**：`reasoningEffortForModel()` 从 `views/chatPanel.ts` 移到 `core/modelCapabilities.ts`（纯逻辑、不 import vscode），这样「哪些档位合法」能被单测直接覆盖，而不是只能靠人读代码。
  - 测试 613 → **630**：新增 `test/modelCapabilities.test.ts`（12 条：探测缺失补内置、探测有值优先、`unsupported`/`fixed` 不被内置值改回来、`name===id` 时用内置显示名、无变化时返回原对象、`none` 在声明列表不含它时仍合法、声明外档位回落 `default`、不支持/固定/未知模型一律回 `default`），`deepseekClient.test.ts` 新增 5 条解析用例（`supported_levels`、只有 `default_level`、单档=固定、无元数据=unknown、`capabilities.reasoning_efforts` 且 `minimal`→`low`）与「无 → `thinking:disabled` + `reasoning_effort:none`」的请求体断言。
  - headless Chromium 实测渲染：DeepSeek 模型下拉为 **默认（模型官方）/ 无 / 低 / 高 / 最大值**、可点击；`unknown` 与 `unsupported` 仍禁用（没有伪装能力）；选「无」后不会被静默改回别的档。

> 以下修复与上一条**同批并入 0.2.7 一起上架**：这些改动此前的内部版本号（0.2.8–0.2.13）从未在 Marketplace 发布过，所以不单独占版本，全部随 0.2.7 首次对外生效。

- **「改到一半补一句『提交』，结果被守卫连拦两次」修好了**。用户报告：先让 Agent 改代码，跑到一半回一句「提交」，`git add` 与 `git commit -am` 都被同一条规则拦下（提示「本次对话中用户没有要求提交或推送」），模型只能回头再问一次。
  - **根因：授权只在运行开始时按第一条消息算一次**。`run.scope.gitWriteAllowed` 由 `send()` 用**那一条**消息的文本判定，运行期间后续的跟进消息（任务树里的「相关指导 / 排队任务」）完全没参与判定。而「先让它改，改完说一句提交」恰恰是最常见的用法——只要第一条消息没提提交，这一整轮就再也提不了。实测复现：第一条「先帮我改一下 README 的错别字」→ `gitWriteAllowed=false`；跟进「提交」到达后仍是 `false`。
  - **现在每条跟进消息都重新判定一次，并且只做加法**：`grantFromFollowUp()` 抽成纯函数（`agent/conversationScope.ts`），已授权的不会因为后面一句闲聊被收回——git 写权限不是逐条消息的开关。日志里的那次拦截在修复后实测变成 `gitWriteAllowed=true`。
  - **判定只看用户原话**：任务树给消息加的前缀（`[任务树更新：相关指导]` / `[任务树分支：排队任务]`）是我们自己拼的说明文字，不该参与权限判断。新增 `withoutTaskInstruction()` / `userTextOfTaskRequest()`（`agent/taskQueue.ts`），把外壳剥掉再判。用户当时猜「守卫把带包装的那条判成了任务指导」——包装确实在，但真正的成因是授权没有随跟进消息刷新。
  - **顺带收紧一处误放行**：用户把守卫报错原样贴回来问「为什么会提示已阻止 git commit？」时，报错文字里就带着 `git commit`，旧规则会把这句**提问**当成提交授权。现在「提到被拦截/阻止/拒绝/拦下」且同时是疑问句的，不再授予写权限（`不要提交` 这类否定写法原本就已排除）。
  - 测试 636 → **643**：新增 `grantFromFollowUp` 三条（补授权、只做加法、两类权限独立累积）、`withoutTaskInstruction` / `userTextOfTaskRequest` 两条（剥前缀、多段内容）、`hasGitWriteIntent` 两条（提问不授权、正常要求照旧放行）。另用真实 `AgentTaskQueue` + 取消路径做了一次端到端复现，确认修复前后的 `gitWriteAllowed` 从 `false` 变 `true`。


- **最大步骤 / 思考深度也可以在 Agent 运行中切换了，且只对下一次发送生效**（与权限预设同一套语义）。以前这两个下拉在流式输出期间被直接 `disabled`，用户想「这一轮跑完就换成 68 步 / 更高思考」只能干等。现在：
  - 面板侧 `setAgentMaxSteps()` / `setReasoningEffort()` 不再 `if (this.viewingBusy) return;`；改的是**这条对话**的存档值，正在跑的这轮仍用运行开始时的设置快照（`ConversationRun.settings`），所以不会让同一轮里前后请求的档位不一致。
  - 改了会弹一条说明「已改为 X。当前这一轮仍按原设置执行，下一次发送起生效」，并把同样的提示写进两个下拉的悬停说明——否则用户改了看不见变化，会以为设置没生效。
  - 判据抽成 `core/conversationControls.ts` 的 `controlChangeScope()`（没有运行中的任务 → 立刻生效；运行中改成了别的值 → 下一次发送生效；选回当前运行的值 → 不打扰）。界面与文案共用一个判据，不会分叉。
  - headless Chromium 实测：运行中两个下拉都 `disabled=false`、悬停提示含「下一次发送起生效」；空闲时不显示该提示；运行中改值后选择保持住。

- **停止按钮现在真的「按下即停」：立即 SIGKILL 整个进程组，不再先 SIGTERM 等 1 秒、也不再等 4.5 秒结算**。用户反馈「按了停止后台还在跑」。审计出四个来源，逐个修掉：
  - **`spawnCommand` 的取消路径改了**：原来 `killTree('SIGTERM')` 之后 `setTimeout(SIGKILL, 1_000)`，忽略 SIGTERM 的进程（`npm run dev`、自己管子进程的构建工具）能在这一秒里继续跑。现在直接 SIGKILL，并在 250ms 补一枪覆盖「父进程刚收到信号时正在 fork 孙进程」的竞态窗口。
  - **结算不再等 `close`**：原来要等 `close`（孙进程攥着管道时永不触发）或 `COMMAND_CLOSE_GRACE_MS + COMMAND_HARD_SETTLE_MS` = **4.5 秒**的硬兜底，那段时间界面还显示「运行中」。现在取消时立刻 `destroy()` 管道并 `settle()`，工具调用马上返回「命令已取消」。
  - **停止时同步杀光这次运行的全部子进程**：新增 `ToolExecutor.killRunProcesses(signal)`，子进程按 `AbortSignal` 归组（`children` 从 `Set` 改成 `Map<ChildProcess, AbortSignal|undefined>`）。`ChatPanel.stop()` 改为**先同步 SIGKILL 再 abort**——只靠 `abort()` 是不够的：它只是通知，真正杀进程发生在各工具的取消分支里，只要有一个工具没走到取消分支（在等 IO、或命令还在调度器里排队），进程就会活下来，这正是「假停止」的形态。按信号归组还保证**不影响另一个正在后台跑的对话**。
  - **`dispose()` 也改成立即 SIGKILL**（原来同样有 1 秒 SIGTERM 宽限）。
  - 实测（真实进程，`isProcessAlive` 探活）：`sh -c 'trap "" TERM; sleep 30'` 这种**忽略 SIGTERM** 的进程，取消后 **<500ms 内结算且进程已消失**；`killRunProcesses()` 只杀目标运行（A 被杀后 B 的进程仍在）；杀完 `resourceStats().children` 归零。测试 630 → **636**（新增 6 条：忽略 SIGTERM 也立即死、按运行杀干净、不影响其他运行、`controlChangeScope` 三条语义）。
- **「点继续执行，清单卡在原地不动」修好了**。用户报告：任务清单跑到 6/8 被中断，点「继续执行」后模型既不接着做、清单也不消失。
  - **根因：清单从来没进过模型上下文**。`update_todos` 的返回值是 `role: 'tool'` 消息，而 `requestMessages()` 会跳过**所有** `role: 'tool'` 消息；清单本身又只存在对话摘要的 `todos` 字段里、不落成任何一条 user/assistant 消息。于是续跑那一轮模型收到的实际只有一句「继续执行当前任务清单里尚未完成的条目」——它看不到清单本身，只能猜或者从头再来。
  - **修法：把带状态的清单显式注入 system 消息**（`core/todos.ts` 新增 `renderTodoContext()`）。注入的是结构化列表而不是原始 JSON：已完成标 `[x]`、进行中标 `[>]`、待办标 `[ ]`，再补一句 `Next item to work on: #7 "…"` 和「不要重做已打勾的项」。模型据此就能接着第 N 条往下做。
  - `requestMessages()` 新增 `resumed` 参数：`resumeTodos()` 在发送前会先清掉中断标记（否则面板一直挂着「已中断」），所以「这一轮是续跑」只能由调用方显式告知，注入的文案才说得出「这是被中断后接着做」。
  - 清单全部完成或不存在时不注入，普通对话的 system 消息一字不变。
  - 用本机那份真实清单（8 项、6 项已完成、`todosIncomplete`）跑通了 `requestMessages()` 全链路：system 消息里出现完整清单、`[x]` 标记与 `Next item to work on: #7`，tool 消息仍被正确过滤。
  - 清单「不消失」不是 bug：运行结束仍有未打勾的项时会标「未完成」并留着「继续执行」按钮（引擎替模型打勾等于伪造进度），全部打勾后照常归档成胶囊。模型现在能接着做，清单才会真的走完。
- **「点继续执行，模型直接新开了一份清单」修好了**。用户报告：清单跑到 6/8 被中断，点「继续执行」后模型没有接着第 7 条做，而是重新拆了一份 4 项的新清单——前六条已验证通过的进度被整份换掉。
  - **根因：`update_todos` 允许无条件整份替换**。清单的唯一写入口 `updateTodos()` 直接整体覆盖，没有任何「旧清单还有进度」的概念。`TODO_LIST_PROMPT` 里本来就写着「keep that list… instead of starting a new one」，但提示词不是硬约束：模型看到「继续执行」这个新请求，按「多步任务先列清单」的规则又列了一份（基于最近几轮对话重新归纳，而不是读旧清单）。
  - **修法一（硬约束，`agent/todoScope.ts` 新增 `droppedCompletedTodos()`）**：上一份清单还有未完成项、且提交的新清单**丢掉了其中的已完成条目**时，直接拒绝这次调用、一个字都不写库，并把被丢的条目原文列给模型，要求照抄原文、只重排未完成部分再提交一次。正常续跑 / 末尾加项 / 把某项改回 pending 重做都不会被误拦（已完成项文字仍在）；上一份清单已全部完成（该归档）或一条都没完成（没进度可丢）时放行。
  - **修法二（语义逃生门，`hasTodoReplanIntent()`）**：用户本轮明确说「重新规划一下清单」「把之前的清单丢掉，重新来」「discard the old list」时才允许替换——判定要求出现「清单/任务/计划」+「重做动词」的组合，续跑指令本身不会触发。
  - **修法三（降低触发率）**：`renderTodoContext()` 注入的清单块里补一句「这是同一份清单，照抄条目只改状态，丢已完成项会被工具拒绝」；`TODO_LIST_PROMPT` 第一条补上例外「若上一轮的清单还没做完，那份清单就是计划，不要另写一份」；`todo.resumeInstruction` 的中英文案从「用 update_todos 把下一项标成 in_progress」改成「传入同一份清单、条目原文照抄、不要重新拆一份」。
  - 用存档里读回来的**真实那份 4 项新清单**做了端到端验证：调用被拒绝（`status: error`）、写库 0 次、旧清单 8 条原样保住、提示里列出 6 条被丢的条目并给出可成功的下一步；同一份清单原样重提则正常落库。
  - 新增 `src/test/todoReplacement.test.ts`（10 条）钉住判定与端到端行为。
- **排队中的消息可以编辑和删除了**。用户要求：排队中的消息加编辑、删除按钮；agent 读取前改直接在原消息上生效（任务树里的排队内容同步变）；已经被 agent 开始执行的消息也能改，改完可以再发一次；但已经被读取执行的消息不能删。
  - **数据层**（`agent/taskQueue.ts`）：`AgentTaskNode` 增加 `userMessageId`（界面要靠它读回原话、删除存档里那条消息）与 `pending`（队列是否还持有它）。新增 `editPending()` / `removePending()` / `bind()`。判断「还没被执行」的唯一依据是**队列是否还持有它** —— 一旦 `take()` 取走，两个方法一律返回 false，从结构上保证历史不可改写。
  - `editPending()` 直接换掉队列里那条 request 的内容，所以**下一轮 `take()` 读到的就是新内容**，不需要撤单重发。`withPlainText()` 只换文本部分，粘贴的图片等附件不会被编辑顺手丢掉。
  - `routing`（刚发出、分类还没回来）也算 `pending`：这时候用户最想改，界面不必等分类回来才给按钮。
  - **撤回不删节点**：`removePending()` 把节点标成 `cancelled` 而不是移除。任务树是这一轮发生过什么的时间线，抹掉节点会让「我明明发过一句话」变成没发生过。
  - **存储**（`core/storage.ts`）：新增 `deleteMessage()`——删掉那条还没执行的消息和它的占位回复，同时回退 `messageCount` 与 token 计数；删不存在的 id 幂等，不会把计数越减越少。
  - **面板**（`views/chatPanel.ts`）：`editTaskMessage()` 分两条路径——还在队列里就原地改（存档里的用户消息、任务树标题一起改）；已被取走执行就把改过的内容当成新消息发出去（用户原话：「编辑后的消息也可以再次发出」）。`removeTaskMessage()` 只放行还在队列里的，否则提示「已被 agent 读取执行，无法删除；可以编辑后重新发出」。删除时连 `run.responses` 里的记账一起撤，否则结算会为未激活的 response 补一条提示消息、把刚删掉的一问一答又写回来。
  - **界面**（`media/chat.js`）：任务树节点行内给出「编辑 / 删除」（已执行的只给「编辑」），编辑框初值取存档里那条消息的原话而不是被截断的标题，回车保存、Esc 取消、自动聚焦并把光标放到末尾。**编辑期间不重建任务树列表**（判据是「DOM 里已经有编辑框」）——否则 agent 每完成一步重推一次任务树，编辑框每几百毫秒被销毁重建，光标跳回开头、正在打的字丢失。
  - 新增 `src/test/taskQueueEdit.test.ts`（10 条）、`src/test/taskQueueEditFlow.test.ts`（3 条，走真实 `take()` 验证 agent 读到的就是改过的内容）、`storage.test.ts` +2 条；浏览器实测任务树按钮、编辑框聚焦、保存/删除请求的完整链路。

- **流式输出时「已经显示出来的文字会闪」修好了**。用户报告：输出还在继续时，前面已经输出的文字会闪动，像是同一个位置闪过不一样的文字。
  - **根因一：半截粗体被当成斜体**。`appendInline()` 的斜体规则 `\*[^\s*][^*\n]*\*` 在流式到 `` **重点* `` 时会用第二个 `*` 和结尾那个 `*` 配成斜体，可见文字从 `**重点*` 跳成 `*重点`——已经显示出来的星号少了一个。加上 `(?<!\*)\*(?!\*)[^\s*][^*\n]*\*(?!\*)` 边界后，半截粗体一律按字面量显示，直到 `**` 真正闭合。
  - **根因二：每一帧都重建整条消息的 DOM**。原来每个 delta（70ms 一次）都把整条消息重新解析 markdown、把所有块重建一遍再整条替换。1500 字的回答约 42 块、单帧 20ms，且随长度线性增长，已输出的段落跟着一起销毁重建。现在 `patchGrowingSegment()` 只重新解析「最后一次渲染时最后一个块的起始行」之后的内容，前面的块**节点身份完全不变**。
  - 为此 `appendRichText()` 现在返回「每块从第几行开始」，`appendTable()` / `appendList()` 返回 `{ node, nextIndex }`，`appendMessageFlow()` 返回尾部定位信息（`tailStart` / `tail`），`renderMessage()` 把它挂在 article 上供下一帧使用。
  - **工具块的位置依赖正文长度**（`min(contentOffset, text.length)`），所以 `toolGroupSignature()` 必须把「当前长度下算出的分组」也纳入签名。只看工具自身字段会漏掉「分组变了」，增量更新就会把正文追加到错误的段里（实测块数 2，整条渲染是 5）。
  - 实测（真实 Chromium + 同一段 381 字内容、128 帧流式）：累计新增 DOM 节点 **1672 → 303（-82%）**；每 10 帧新增从 219/233/270（持续上升）降到 56/68/10/35（平稳）；**已输出块被改动 0 次**。增量与整条渲染的等价性用 10 个用例逐一比对（多段落 / 标题 / 嵌套列表 / 有序列表 / 表格 / 代码块 / 引用 / 混合 / 分隔线+行内语法 / 未闭合围栏）全部一致，工具交错结构也一致。
- **「文件标签后面的文字会跳动，像是标签长度在来回变」修好了**。用户报告：agent 继续输出时，正文里的文件标签后面的文字在跳；鼠标停在已输出的文字上更明显。
  - **根因一（宽度来回变）**：核实结果回来前，标签按**猜的路径**写（短，例如 `src/app/WorkspaceSwitcher.tsx`）；扩展核实回来后又改成**真实路径**（可能是整条绝对路径，例如 `/Users/…/src/app/WorkspaceSwitcher.tsx`）。而流式输出每 70ms 会把正在增长的那一段整段重排一遍，标签跟着重造 —— 于是**每一帧都重演一次「短 → 长」**。实测：标签在 209.7px ↔ 543.7px 之间跳，标签后面那句每帧被推 252px，14Hz。
  - **修法**：核实结论按「首选根 + 路径」缓存（`fileReferenceResolution`）。重建出来的标签直接套用上一次的结论，一次画成最终形态；工作区根变化时整份作废。同时把标签文字收成唯一算法 `fileReferenceLabel()` —— 首次渲染、沿用缓存的重建、核实后的原地更新都调它，只要结论相同就算出同一个宽度，不存在「第二套写法」。
  - **根因二（悬停时也在跳）**：整段重排会把段落里的 DOM 全部重建，包括文件标签。用户鼠标正停在上面时，新节点要重新进入 `:hover`、`transition` 从头跑一遍。现在对「接着写普通文字」走**原地追加**：直接把新字追加到末尾的文本节点上，标签节点、悬停状态、动画都不受影响。判定抽成纯函数 `media/inline-append.js`（带单测），刻意保守：出现反引号/星号/方括号/竖线/冒号/斜杠/换行、像扩展名的 `.xx`、或跨帧能拼成路径（`app` + `.tsx`）时一律退回重排。
  - 顺带修掉三个边界：① 空消息的「正在继续处理…」占位不再被当成正文追加；② 段落末尾是文件标签时不再把续写的字贴成散字（`src/app/App.ts` 已被认成标签，接着来的 `x` 要在标签里，不能在标签后面）；③ 末尾不是文本节点时不走快路径。
  - 实测（真实 Chromium，三种核实应答：找到 / 找不到 / 解析到工作区外）：每帧宽度变化 0 次、形态变化 0 次、标签后文字位移 0 次；8 帧纯文字追加后**标签节点身份不变**（悬停状态保持）、**零重复核实请求**。增量与整条渲染 16 个用例逐一等价（多段落/标题/嵌套列表/有序列表/表格/代码块/引用/混合/行内语法/未闭合围栏/文件引用/裸路径/多文件引用/中英混排/数字小数点/链接）。
  - 新增 `media/inline-append.js` + `src/test/inlineAppend.test.ts`（6 条）；`test/check-file-reference-dom.mjs` 增加 8 条接线断言；顺手修好本来就坏的 `test/check-draft-isolation.mjs`（桩环境缺 4 个模块级绑定）。
- **流式输出不再「先显示字面量、再跳成样式」**。同批已经修掉了标签宽度每帧变长与悬停被打断，这一条按官方做法补齐另一半：**未闭合的 markdown 尾巴先补全再渲染**。
  - **依据（查权威源，不是自己猜）**：Vercel AI SDK 官方组件 **Streamdown** 在流式场景的两条核心做法是「block 级记忆化，只重画变化的那一块」+「用 **remend** 补全未闭合的 markdown」；remend 文档明确会补全 bold / italic / inline code / links / strikethrough，让半截语法按**最终形态**渲染。另外 MDN 的 `overflow-anchor` 文档说明：自己管滚动时浏览器的滚动锚定会与手动 `scrollTop` 互相补偿，表现为轻微跳动，应显式关掉。
  - **新增 `media/stream-repair.js`（纯函数，11 条单测）**：只补「尾部还在写的那一段」，前面已完成的段落一个字符都不动；围栏代码块内不做行内补全。
    - 星号按**配对扫描**而不是数奇偶：`**重点` → `**重点**`；`**重点*`（收尾符才写一半）→ 只补 1 个变 `**重点**`，不会变成三个星号；`***粗斜` → 补 3 个。
    - 单个波浪号是**字面量**（`20~25`、`3~5 天`），绝不当开启符；`~~删掉~`（收尾写一半）补 1 个。
    - 链接：地址还是 `h`/`ht` 这种不成形的一小截时，换成安全锚点 `#`，让文字立刻收敛成链接文字（用占位域名补会让点击真的去打开一个不存在的网址）。
    - 行首 `*` 是列表符号，先等长遮罩再配对，绝不被补成斜体。
  - **原地追加要让位于补全**：尾部还有未闭合标记时必须重排（`needsRepair()`），否则追加会把 `**重` 直接贴成字面量、等收尾符到了才跳变。
  - **`overflow-anchor: none`** 加在消息区：我们每帧自己按 autoFollow 决定 `scrollTop`，不该再让浏览器补偿一次。
  - 实测（真实 Chromium，逐字符流式 177 帧）：可见文字回退 **24 → 10 次**，剩下的全是「`**` / `` ` `` / `~~` 这类标记在变成样式的那一帧消失」——markdown 渲染的固有行为（ChatGPT / Claude / Streamdown 同样如此），不是每帧抖动。
  - 增量与整条渲染 14 个用例逐一等价；流式结束态与完成态可见文字 14/14 一致。期间实测抓到并修掉一个真 bug：`增长 3.5 倍` 的空格被尾部 `trim()` 吃掉（`3.5倍`）。

## 0.2.6

- **「删掉的空对话重载后又回来了，还显示『刚刚』」+「对话框不见了」：两个真实故障，都修了。**
  - **幽灵对话**：删除对话时只 `rm conversations/<id>/messages`，把 `conversations/<id>/` 空壳留下了；下次启动 `reconcileManifest` 看到「磁盘上还有这个 id」就把它当一条对话重建 —— 空目录没有消息可读时间，`createdAt` 取的就是当时的 `Date.now()`，于是删掉的卡片全回来了、时间显示「刚刚」。用户磁盘上的证据很直接：12 个空对话的**目录年龄是 911～3415 秒**（当初删除的时刻），而它们的 `createdAt` **全是 107 秒前**（重载的时刻）。现在删除走 `conversationDirectory()` 删**整条目录**（`deleteConversation` 与清理里全部 5 处删除点一起改），并且 `reconcileManifest` 增加一层兜底：**没有 `messages/` 子目录的对话目录一律当成残骸删除**（`createConversation` 一定会 `mkdir messages/`，所以这个判据是安全的），不再重建成幽灵。用用户真实磁盘副本实测：**28 个目录 → 15 个**，清掉 13 个空壳，保留 1 个合法空对话 + 14 个有内容的对话，零误删。
  - **对话框被顶出视口**：`.app-shell` 只声明了 `grid-template-columns`，隐式行是 `auto`，于是侧栏内容有多高、整行就有多高——12 条对话时行高 **956px**，而视口只有 **760px**，右栏的输入框被推到视口外面，看起来就像「对话框不见了」。现在显式声明 `grid-template-rows: minmax(0, 1fr)`，并给 `.history-pane` 补 `min-height: 0`（grid item 默认 `min-height: auto` 会拒绝收缩）。修后实测：`bodyScrollHeight` **956 → 760**，对话列表改为内部滚动（clientHeight 502 / scrollHeight 756），对话框回到视口内。headless Chromium 实测 2 张与 12 张两种情况都 `composerVisible=true`。
  - 新增 4 条测试：删除不留空壳且重载不复活、启动时清掉历史遗留空壳且不重建成幽灵、正常空对话（有 `messages/`）不被误删、以及布局约束（`.app-shell` 必须有 `grid-template-rows: minmax(0,1fr)`、`.history-pane` 必须 `min-height: 0`、列表必须自己滚动）。`npm test` **613 全绿**。

## 0.2.5

- **空对话不再堆卡片；卸载扩展后的残留勾选不再被读取**。两处都是上一版没做对的地方：
  - **「当前就是空对话」时，点新建对话不再产生新卡片**。上一版以为「每点一次都要多一张卡」，结果连点就堆出一串「新对话 · 空对话」（用户截图里 6 张），既分不清是哪一条，也像按钮坏了。现在的规则是：**只有这条对话用过了（有消息），新建才产生下一张卡片**；当前这条还是空的，就只把焦点交还给它。扩展侧（`newChat()` 判 `messageCount === 0`）与界面侧（判 `currentEmpty`）用同一判据，避免「UI 画了卡、服务端没建」的错位。
  - **历史里已经堆起来的空对话会收敛成一张**：清理时只保留最新的那张，其余（0 条消息、未置顶、未归档、非续接、不在保护名单）在 5 分钟宽限期后收掉。这类对话没有任何内容可丢；`prunedDrafts` 会在日志里单列。**「创建成功但从没初始化」的残骸仍按 60 秒规则单独处理**，不参与「保留最新」的竞争。
  - **卸载了「本地skill快捷调用」后，不再读它留下的 `.skill-quick-launch.json`**。真实原因：卸载扩展不会删这个文件（本机残留 35 个 `active`），而 HWChat 照样读它 → 每个技能都被标成「默认启用」并自动打勾，用户看到的是一屏勾选，自然以为是扩展残留。现在 `scan()` 先看扩展在不在，不在就把全局勾选当成空：**「默认启用」0 个、「已调用」0 个、新对话勾选为空**。用本机真实磁盘实测：技能仍扫到 35 个（它们在 `~/.copilot/skills/`，是 Copilot 的技能目录，不随扩展卸载消失），但 badge 与勾选全部为 0。重新装上后 `extensions.onDidChange` 会立刻把勾选接回来。
  - **未安装时星标面板只显示安装提示，不再列技能**。按产品语义，这时候面板的职责只有一个：告诉用户去装那个扩展（标题带「未安装」角标 + 「打开扩展详情」按钮）。列表隐藏用 `.skills-list[hidden]`（它是 grid，会覆盖 `[hidden]` 的默认 `display:none`）。
  - 新增 2 条测试（空对话不新建、空对话收敛成一张）与 1 条真实磁盘验证；`npm test` 609 全绿。headless Chromium 四项实测：未安装只显示提示不列技能 ✅、已安装列表+勾选出现 ✅、空对话点新建不加卡 ✅、有内容点新建正常加卡 ✅。
- **星标（Skill）面板与「本地skill快捷调用」彻底对接**。两件事分开说：
  - **没装这个扩展时**：点星标展开面板，**立刻**看到安装提示（标题带「未安装」角标）、一段说明、以及一个「打开扩展详情」按钮。以前只有「勾了某个 copilot skill」才把提示滚出来，所以正常路径下用户只会看到一片勾选列表、不知道该装扩展。按钮优先用内置命令 `extension.open` 在 VS Code 内打开详情页（装完就能顺手勾选），失败退回 `workbench.extensions.search` 筛选，最后才用 `vscode.env.openExternal` 打开商店网页。
  - **装了之后**：面板显示的勾选状态就是这份扩展的 `active`（`~/.copilot/.skill-quick-launch.json`），并且**只影响本次对话**——在 HWChat 里勾选 / 取消只写当前对话的存档，绝不回写那份全局清单（`skillSelection.test.ts` 有断言禁止出现写回路径）。底部说明文案随安装状态切换：装了才提「只影响本次对话」，没装则说明「新对话从空白开始」。
  - **装完 / 卸掉立刻生效，不用重载窗口**：新增 `vscode.extensions.onDidChange`（官方定义：*fires when `extensions.all` changes … installed, uninstalled, enabled or disabled*）→ `ChatPanel.refreshSkills()` → 重扫并回推。原有的 `.skill-quick-launch.json` watcher 也接到同一个刷新入口，对面改了勾选，HWChat 的「默认启用」跟着变。
  - **「还没动过的对话」跟随全局勾选**：对话一条消息都没有、且用户没在本对话里手动改过勾选时，全局勾选变了它会跟上（并把结果写进这条对话自己的存档）；一旦用户在本对话里勾过/取消过，或已经发过消息，就只看它自己的存档，全局清单不再反过来覆盖它。
  - headless Chromium 实测：未安装时 `hint=true`、按钮文案「打开扩展详情」；已安装时 `hint=false`、两个 copilot skill 打勾且与扩展一致、workspace skill 不打勾；说明文案含「只影响本次对话」。

- **「当前是空对话时，点新建对话不出新卡片」修好了**。上一版为了让历史列表不堆空卡片，在 `newChat()` 里「顺手清掉上一条空对话」——结果当前这条没实际用过时，删旧 + 建新 = 界面上还是 1 张一模一样的空卡片，用户看到的就是「点了没反应」。
  - 现在 **`newChat()` 永远不删任何对话**，每点一次就建一条并用它自己的 id 打开对应空对话框；连点 3 次就是 3 张卡片，各自独立。
  - 空卡片不再自动清理，由用户用行内 ✕ 自行收拾；周期性清理只收「创建成功但从未初始化」的残骸（新建对话会立刻写 `skillSelectionInitialized: true`，所以用户主动建的空对话永远不会被当成残骸删掉）。
  - `test/newChatResponsiveness.test.ts` 新增两条：静态断言 `newChat()` 里不许出现 `deleteConversation` / `pruneEmpty`、必须 `createConversation` 且写入 `skillSelectionInitialized: true`；以及行为断言「已初始化的空对话连跑两轮清理都不会被删」。
- **星标 Skill 面板与「本地skill快捷调用」扩展真正对接**（安装状态 + 勾选状态）。
  - **没装时，点星标就能看到安装提示**。旧实现只在「用户勾了一个 copilot skill」之后才展开安装提示，于是点开星标只看到一长串勾选框、完全不知道该装扩展。现在 `syncSkillsInstallHint()` 会按安装状态**直接显示/隐藏**提示，面板里有醒目的「未安装」角标、说明文字和按钮；底部说明也随之切换（未装 / 已装两套文案），已装时明确写出「在这里勾选只影响本次对话，不会改动它那边的勾选」。
  - **按钮改成「打开扩展详情」，直接跳到扩展详情页**。原来是打开商店网页；现在按顺序兜底：`extension.open` → `workbench.extensions.search`（`@id:` 精确筛出）→ `vscode.env.openExternal` 商店页。内置命令可用性随版本变化，所以每一步失败都不影响下一步。
  - **安装/卸载能实时反映**。接上官方 `extensions.onDidChange`（原文：*An event which fires when `extensions.all` changes. This can happen when extensions are installed, uninstalled, enabled or disabled*），装完扩展立刻重扫并回推，不用重载窗口；`.skill-quick-launch.json` 的 watcher 也会让「默认启用」角标跟着那边改的勾选走。
  - **勾选语义按你的要求落地**：新对话的勾选**读取**「本地skill快捷调用」当前的勾选；在 HWChat 面板里勾选 / 取消**只写这条对话的存档**（`updateConversation({ skillIds })`），从不写回那份全局清单。另外补了一条：还没发过消息、用户也没手动改过勾选的对话，会在那边勾选变化时跟着更新（它就是下一次发送要用的那份选择），一旦用户动过或发过消息就只看它自己的存档。
  - headless Chromium 实测两种状态：未安装 → 提示可见 + 按钮文案「打开扩展详情」；已安装 → 提示隐藏、勾选与扩展一致（2 个）、「默认启用」角标在位。
- **「点新建对话没反应，重载窗口后才出现」：重做交互语义 + 修掉三条根因**。用户截图里连点 4 次、当场毫无变化，重载后冒出 4 条「新对话 · 空对话」。现在点击的语义明确为：**侧边栏立刻出现一条新的对话记录，右侧同时切到这条对话的空对话框**。
  - **新建对话现在是「真建一条对话」并立刻选中它**（以前只把界面切回草稿，历史列表里不会出现卡片）。创建后立刻写入模式与 Skill 勾选（`skillSelectionInitialized: true`），避免出现「建了但没初始化」的半成品。实测点击处理 **5.6ms**；把 `postMessage` 打成黑洞（模拟扩展卡住/失败）时，侧边栏卡片、右侧空对话框、输入框可用三项依然全部成立。
  - **webview 先插一张占位卡**：点击瞬间就在历史列表顶部绘制「新对话」卡片（灰化、操作按钮禁用、点击无副作用），扩展推送的权威列表到达后整体替换它——实测 `pendingCards` 归零、卡片数正好 1 新 + 1 旧、新卡处于选中态，不重复、不残留。
  - **每点一次就多一张卡片**（用户明确要求）：旧实现会在新建时删掉上一条「0 条消息」的空对话，结果是「上一条没实际用过时，再点一次就没有新卡片」，看起来仍像点了没反应。现在每次都建一条新对话，占位卡也**每次各插一张**（不再复用同一张），连点三次就看到三张。空卡片由行内 ✕ 或周期性清理收拾。`send()` 里「先建对话、再写消息」的那几毫秒由 `startingConversationIds` 保护，不会被任何清理逻辑误删。
  - **根因 1（直接原因）：技能扫描失败会连坐整个界面。** 技能扫描走统一搜索调度层，队列满 24 条时抛 `SearchQueueFullError`——用户刚跑完一堆 Agent 任务时最容易触发。而「新建对话」「打开对话」「激活」都在 `await skills.refresh()`，异常一路抛到 `handleMessage` 的 catch，只发一条 toast（如果 webview 通道本身有问题，连 toast 都看不到）。**搜索队列一满，新建对话就变成死按钮**。现在 `SkillRegistry.refresh()` **永不 reject**：失败时保留上一份清单、把原因交给 `onError`（写进 HWChat 输出），并且**不刷新 30 秒新鲜窗口**，所以下一次调用会立刻重试而不是缓存坏结果。「清单可能稍旧」永远比「按钮点不动」好。
  - **根因 2：一次点击推两遍全量状态，连点就并发堆叠。** `newChat()` 是 `open()`（内部已 `sendState()`）之后再 `sendState()`；每次 `sendState` 都要读对话列表、读首页 80 条消息、序列化约 3.4MB 推给 webview。4 次连点 = 8 份推送同时跑。现在：`newChat()` **只推一次**，并新增 `core/singleFlight.ts`——并发请求只跑一份、跑完**必须再补一次**（不丢最后一次点击的结果）。实测 4 次连点：8 份 → 4 份（空闲）/ 3 份（Agent 运行中推送 300ms 时），峰值并发 8 → 1，CPU 89ms → 57ms。
  - **根因 3：点击完全依赖往返，本地什么都不做。** 现在 webview 点「新建对话」**立刻**本地切到草稿（清消息区、清附件/待办/任务树、取消历史高亮、回填空草稿、聚焦输入框），随后的 `state` 只做校准。headless Chromium 实测：处理函数 **2.8ms**、强制布局 **0.3ms**；把 `postMessage` 打成黑洞（模拟扩展卡住/失败）后点击仍然生效——消息区 12 条 → 0 条、标题变「新对话」、旧对话取消高亮。
  - **顺带修掉「空对话」残骸的产生与堆积。** 磁盘上那 4 条的形状是：`messageCount: 0` + `skillSelectionInitialized: false` + 完全没有 `permissionPreset`/`agentMaxSteps`/`apiProfileId`——说明对话建好、初始化却没跑完。现在 ① `send()` 若在「创建成功、初始化失败」时抛错，会**把刚建的对话删掉**（回滚，不留残骸）；② `cleanup()` 会收掉这类「建了但从没初始化、也没有任何消息」的记录（留 60 秒宽限期，避开正在创建的那一瞬；置顶/归档/被保护的不动），并在日志里单列 `（其中空残骸 N）`。**用用户真实历史验证：19 条里精确收掉 4 条，误删 0 条。**
  - **顺带补上「消息丢了没人知道」的观测口。** `post()` 以前把 `postMessage` 的返回值丢掉，webview 不可用时消息静默消失。现在返回 `false`/抛异常都会写一行 `[post] dropped …` / `[post] failed …` 到 HWChat 输出；`handleMessage` 的异常也会先落日志再弹 toast。另外新增 `onDidChangeVisibility`：视图从后台切回来时补推一次完整状态（官方文档写明 webview 内容在切到后台时被销毁、期间的消息会被丢弃），这正是「只能重载才恢复」的形态。
  - `test/newChatResponsiveness.test.ts` 6 条：扫描失败不抛错且会立刻重试、创建失败回滚、清理只收残骸不误删、单飞（连点 5 次只跑 1 份 + 必补 1 次）、空闲调用各自执行、任务抛错不锁死后续推送。
- **命令运行时间的刷新链路：实测下来它几乎不花 CPU，但确实有两条白做的活，已删掉**。用户提示「执行命令时会显示运行时间，30 秒没反应后每 10 秒刷新一次」。逐段测了这条链路的三个环节，结论是「显示本身可忽略，但两处浪费是真的」：
  - **webview 每秒重绘「已运行 12.3 秒」= 1–2 微秒/次**（headless Chromium，60 条消息 + 1/8/20 张工具卡片三种规模实测：0.0015 / 0.0010 / 0.0020 ms 每 tick）。这个数字说明它不是 CPU 问题的来源，**没有动它**——秒数必须每秒走，否则界面看着像卡死。
  - **扩展侧每秒一次的 `tick` 回调是死代码，已删除**。`spawnCommand` 原来每秒 `report({phase:'tick'})` 一次，而唯一的消费者 `agentRunner` 的进度回调第一行就是「不是 stall 就直接 return」；卡片上的秒数本来就是 webview 自己按 `startedAt` 算的，扩展推的这份数据没有任何人读。现在每秒的定时器只在「空闲秒数越过阈值」时才构造对象并回调：实测 `sleep 6` 的回调次数 **6 次 → 0 次**，`phase: 'tick'` 从类型里删除。顺带给 `spawnCommand` 加了 `stallSeconds` 选项，于是「停滞提示」可以在毫秒级测试里验证，不用真等 30 秒。
  - **每 10 秒的「无输出 N 秒」提示不再写盘**。提示走的是 `onToolsChanged`，调用方会因此 checkpoint 整条消息：实测一次 **2.29ms**（6 个工具、120KB 输出），并且让首页消息缓存失效，下一次 `sendState` 从 0.01ms 回到 2.03ms。一条卡住 5 分钟的命令会白写 30 次盘，而这份「可能卡住」的文字本来就不该被持久化——恢复历史后它只会是过期噪音。现在新增 `onToolHint` 纯展示通道：只推界面、不落盘、不 checkpoint。`agentLoop.test.ts` 用一条不变量锁住它——**落盘通道的快照里永远不能出现 `stallHint`**。
  - 明确**没有**改的：停滞提示仍然每 10 秒刷新一次（`30 → 40 → 50…`），因为数字冻住比不显示更让人怀疑界面卡住；toast 仍然只弹一次。
- **每 10 分钟的清理不再重扫整份历史：19.29MB 实测 131ms CPU → 1.0ms**。日志里每 10 分钟一行的 `[cleanup] compacted=0 deleted=0 bytes=20231239` 暴露了它：两轮之间字节数一模一样，说明**什么都没变却把全部消息文件读了一遍 + `JSON.parse` 了一遍**——只为判断「要不要瘦身 / 要不要按保留期删除」。一天 144 次。
  - `ConversationStorage.cleanup()` 现在按对话做增量扫描：每条对话有一个写入序号，`appendMessage` / `updateMessage` / 中断恢复都会 +1，只有「自上次扫描后又被写过」的对话才重读；其余直接复用上次量到的体积与条数，连 `readdir` 都不做。实测同一份 19.29MB 历史：首轮 120.0ms，**第二、三轮 1.7ms / 1.0ms**。
  - 三种情况仍然会重扫，语义不变：① 该对话有写入；② 距上次扫描已超过最短保留窗口（保留期是按时间前进的，不能因为「没人写」就永远判不出过期）；③ `historyRetentionDays` / `taskCacheRetentionHours` 被改过。过期对话的判定用清单里的 `updatedAt` 做便宜的上界，到点才去读盘。
  - 体积统计也改成增量：只对重扫过的对话 `stat`，删掉的对话从合计里减，不再每轮走两遍全目录（`cleanup` 末尾原来还会再调一次 `stats()`，又是一遍）。
  - **日志不再刷屏，但保留了「这窗口到底扫了什么」的证据**：真的瘦身/删除时每次都写一行；每个进程的**第一次**也写一行，带上 `scanned=` 与 `took=` 毫秒（首次扫描一定是满的——增量记账在内存里，新窗口没有基线，19.29MB 实测约 118ms）；其余「什么都没变」的心跳一个字都不写。`onComplete` 里那次向界面推全量状态也只在真有变化时触发（审计日志维护仍然每次心跳都做，它现在是一次 `stat`）。
  - `test/cleanupIncremental.test.ts` 5 条：不变的对话 0 次读盘且消息数/体积仍然准确、写过的那条照样瘦身、**过了保留期即使没写入也照样删除**（这条曾因窗口只有 8.6ms 而偶发失败，已把窗口放宽到 864ms）、改配置强制重扫、删对话后不再留下扫描记录。

- **按官方文档再压一轮 CPU：懒激活、搜索取消令牌、`files.exclude` 语义、首页分页缓存、审计压缩窗口**。这一轮不是「凭感觉优化」：每一条都先拿到官方 API 原文（`@types/vscode` 1.140.0 的 `index.d.ts` 注释 + code.visualstudio.com 对应文档页）再改；改之前用真实历史（21MB / 606 条消息）和本机技能目录做了 A/B 计时，能测的都给了数字，测不到的下面写清楚。
  - **扩展改为懒激活，激活时不再做三件重活**。`package.json` 的 `activationEvents` 清空。官方依据原文：*Note: Beginning with VS Code 1.74.0, commands contributed by your extension do not require a corresponding onCommand activation event declaration*，以及 *views contributed by your extension do not require a corresponding onView activation event declaration*（本扩展 `engines.vscode` 是 `^1.106.0`；`extension.ts` 里注册的 16 条 `hwchat.*` 命令与 `contributes.views` 里的视图全部在清单中声明过，逐条比对无遗漏，因此清空是安全的）；同一页还有 *It is best practice to activate only when a user needs your extension*，而 Extension Host 文档的对应表述是 *VS Code lets extensions declare their Activation Events and loads them lazily … This makes sure that extensions do not consume unnecessary CPU and memory*。需要说清楚的是：`onStartupFinished` 的官方说明是 *it will not slow down VS Code startup*（它排在启动关键路径之外），所以这次省的不是启动延迟，而是**每个窗口在启动后白白花掉的 Extension Host CPU**。同时 `activate()` 里三件重活被移出启动路径：`await storage.initialize()`（整份历史读一遍 + 对账，本机 21MB / 19 对话 / 610 消息实测 **122.8ms CPU / 118.4ms 墙钟**）、`storage.stats()`（对所有消息文件 `stat` 一遍只为打一行日志，实测 **13.9ms**）不再执行（存储层每个方法本来就自带 `initialize()`，统计日志改为固定文案）；`skills.refresh()`（三条 `findFiles` = 真实 ripgrep 全工作区遍历）仍保留在激活里——但激活本身现在只由「用户打开面板 / 执行 `hwchat.*` 命令」触发，于是这次扫描发生在正确的时机，`SkillRegistry` 的 30 秒新鲜窗口 + single-flight 继续挡掉重复调用。代价与取舍见下（定时清理只在扩展激活后发生）。
  - **懒激活的代价，说清楚而不是藏着**：定时清理（`CleanupScheduler` 的保留期清理与 `audit.cleanup`）以及命令面板以外的后台动作，现在只在「这个窗口里 HWChat 被真正用到过」之后才发生；从不打开 HWChat 的窗口不会再替它做磁盘整理。激活时仍会立刻跑一次 `audit.cleanup` 与 `scheduler.run(false)`，所以打开面板的第一时间就会补上该做的清理，语义只是「推迟到有人用」，不是「永不执行」。
  - **搜索现在会真正把取消传给 `findFiles`**。旧代码注释写着「`findFiles` 没有取消参数」——这是错的：官方签名是 `findFiles(include, exclude?, maxResults?, token?: CancellationToken)`，注释原文 *@param token A token that can be used to signal cancellation to the underlying search engine*。`workspaceSearch.ts` 新增 `bridgeCancellation(signal)`，把调度层的 `AbortSignal` 桥成真实的 `CancellationTokenSource`（用完 `dispose()`），于是「用户点停止」不再只是丢掉结果，而是**让 VS Code 自己停掉底层搜索**——这正是取消后 `rg` 还在啃 CPU 的那一段。`test/workspaceSearch.test.ts` 用 mock 的 `getReceivedSearchTokens()` 断言令牌确实传入、且外部取消后令牌状态变为 cancelled。
  - **自定义 `exclude` 不再意外关掉 `files.exclude`**。官方注释原文：*When `undefined`, default file-excludes (e.g. the `files.exclude`-setting but not `search.exclude`) will apply*——也就是说**只要传了 `exclude`，默认排除就整个被替换掉**。我们原来总是传自己的排除列表，用户 `files.exclude` 里排除掉的大目录（`out`、`DerivedData`、自定义缓存）因此又回到搜索范围。现在 `readFileExcludeNames()` 把 `files.exclude` 里「纯目录名」形状的项（`**/node_modules/**`、`**/.git` 之类）并进默认排除（`simpleDirectoryName()` 只认能安全降级成目录名的形状，复杂 glob 一律不动）。`test/workspaceSearch.test.ts` 覆盖合并结果与 `simpleDirectoryName` 边界。
  - **历史首页加了版本化缓存：`getMessages({limit:80})` 从 28.07ms → 0.01ms**。`sendState()` 每推一次状态都要读当前对话最后 80 条消息，而存储是「一条消息一个 JSON 文件」，80 次 `readFile` + 80 次 `JSON.parse` 每次重做。现在按 `(conversationId, limit, before)` 缓存首页，并在 `appendMessage` / `updateMessage` / `cleanup` / 中断恢复 / 删除对话时**显式失效**（缓存键还带一个随写入递增的代数，宁可多失效也不返回旧内容），命中返回浅拷贝，最多留 8 页。
  - **webview 收到一模一样的状态时不再重建消息列表：30.7ms → 5.5ms CPU，布局 12.7ms → 0.4ms**。`sendState` 里技能、模型、权限、任务树、待办等字段经常变，但消息列表常常一个字都没变；`media/chat.js` 原来无条件 `renderMessages()`，而它第一件事就是 `messageList.replaceChildren()`。新增 `messageListSignature()`（消息 id + 角色 + 正文长度 + 工具数 + 附件数 + 运行态），签名一致就跳过重建，只更新其它区域。用 headless Chromium 对同一份 80 条消息的真实 payload 做了前后对比。
  - **审计日志压缩加了 60 秒新鲜窗口：36ms → 0.05ms**。5MB 的 `agent-audit.jsonl` 每压缩一次都要整份读进内存逐行 `JSON.parse`（实测 **36ms**），而它挂在「保存设置」「清理完成」等路径上，几乎每次都是白算。现在同一保留天数下 60 秒内直接跳过，但**先 `stat` 一次**：文件一旦超过 5MB 上限就立刻压缩，上限语义不变；显式操作可 `cleanup(days, { force: true })` 强制。`test/auditLog.test.ts` 新增一条：窗口内第二次压缩确实被跳过（过期行还在），`force` 后立刻清除。
  - **明确「不做」的两件事，附官方原文**。① 不启用 `retainContextWhenHidden`：官方 Webview 文档写的是 *Although retainContextWhenHidden may be appealing, keep in mind that this has high memory overhead and should only be used when other persistence techniques will not work*，同一页还写明 *getState and setState are the preferred way to persist state, as they have much lower performance overhead than retainContextWhenHidden*；本面板本来就能靠 `sendState` 秒级全量恢复。② 不做「只发变化的消息」增量协议：官方文档写明 webview 的内容 *created when the webview becomes visible and destroyed when the webview is moved into the background*，重新可见时按 `webview.html` **重建**、*Any state inside the webview will be lost*——面板被切到后台再切回来，一个只发增量的协议就会少消息（省下的只是 `JSON.stringify` 实测 7.69ms / 3.5MB 的那点开销）。所以改为上面那条「全量状态 + 签名不变就不重建」：语义与今天完全一致，风险为零。

- **新对话的三项初始值改为固定：每次询问 / 24 步 / 默认（模型官方）**。用户反馈「新对话初始的权限预设、最大步数、思考深度没有按要求设置」。排查后确认不是常量写错，而是**初始值来自配置**：`readSettings()` 把 `hwchat.permissionPreset`、`hwchat.agentMaxSteps`、`hwchat.reasoningEffort` 当作新对话的默认值，而旧版本的面板会把选择写进这三项全局设置——本机 `settings.json` 里因此留着 `permissionPreset: autopilot`、`agentMaxSteps: 0`（无限制），于是每条新对话一开就自动执行、无限步，界面上却写着「每次询问 / 24 步」。
  - 三项的**唯一出处**收拢到 `core/conversationControls.ts` 的 `NEW_CONVERSATION_CONTROLS`（每次询问 / 24 步 / `default`），`resolveNewConversationControls()` 只用它加当前草稿的临时选择。`readSettings()` 不再读取这三项，`updateSettings()` 也不再写入它们——配置里的旧值只出现在「显示权限来源」的诊断输出里，并明确标注「声明值不参与判定」。
  - 三个配置键仍保留在 `contributes.configuration` 并加了 `deprecationMessage`（旧的 `settings.json` 不会报未知配置项，也不会被静默删除），设置页对应的三个下拉控件一并移除，改为一段固定说明 + 原有的权限边界对照表（表格里把「每次询问」这一档标出来）。删掉不会生效的控件，而不是留着让人以为改得动。
  - `newChat()` 现在会清空 `draftControls`：上一条新对话里临时改过的预设 / 步数 / 深度不再漏到下一条（旧实现只在发送成功后清空）。
  - 思考深度新增**第一档「默认（模型官方）」**并作为初始值：不发送 `reasoning_effort` 与 `thinking`，由服务端按该模型自己的官方默认值处理。此前初始值是写死的 `high`，等于替模型改默认档、还多烧 token；`reasoningEffortForModel()` 也改为始终接受 `default`，非法值回落到 `default` 而不是 `high`。
  - 新增 `src/test/newConversationDefaults.test.ts` **6 项**：固定初始值；用本机那份真实设置完整复现「autopilot + 0 步 + high」并断言新对话仍是每次询问 / 24 / default；草稿临时选择仍生效且「不限制」被保留；已有对话的存档值优先（升级不丢选择）；`presetChangeScope` 的四种组合；以及面板 / webview 的接线断言（运行中不得因 `viewingBusy` 提前返回、必须写对话存档、不得改运行中的设置快照、webview 流式期间不得禁用预设下拉）。

- **任务运行中可以切换权限预设，且只对下一次对话生效（与 Copilot 一致）**。以前 `setPermissionPreset()` 开头就是 `if (... || this.viewingBusy) return;`，webview 在流式输出期间也把预设下拉 `disabled`，用户想收紧一个正在跑的任务只能先点停止。
  - 现在运行中也能切换：新预设照常写入这条对话的存档，但**正在执行的任务不受影响**——每次运行在 `send()` 时快照一份 `run.settings`，本轮所有工具调用（含排队分支）都读这份快照，面板不会去改它。因此「改完立即生效」与「不影响正在跑的任务」两件事同时成立：生效范围天然是下一次对话。
  - 新增纯函数 `presetChangeScope({ runningPreset, requested })`（`core/conversationControls.ts`）把「立即生效 / 下一次生效」的判定写死在一处，面板据此弹提示：运行中切换会明确说「当前任务仍按「X」执行，本次任务结束后的下一次对话使用新预设」，并写入 webview 的悬停提示。放宽到 Autopilot / 完全访问仍然要二次确认。
  - `media/chat.js`：`permissionPresetInput` 不再随 `state.streaming` 禁用；`syncPermissionHint()` 在运行中追加「下一次生效」说明；步数与思考深度仍在运行中锁定（它们影响的是调用参数，中途改只会让同一轮的前后请求不一致）。

- **「CPU 100% / `spawn rg EAGAIN`」这一轮的根因审计与修复：四处仍在重复烧 CPU 的路径**。搜索调度层、Agent 步数预算、EAGAIN 退避与取消回收在上一轮已经落地；这次把剩下的「无上限、重复、按缓冲区大小线性」的路径逐条改掉，并用可重复的测试钉住。
  - **技能清单不再跟着每次状态重发去全工作区扫描（本次最大的重复搜索来源）**。`ChatPanel.sendState()` 以前第一件事就是 `skills.refresh()`，而一次扫描 = 三条 `findFiles` pattern（每条在 VS Code 里都是一次真实的 ripgrep 全工作区遍历）+ 逐个读取 `SKILL.md`。`sendState` 会被十几次界面操作与每轮 Agent 结束触发——点一下界面就是几十次全工作区扫描，正是「CPU 顶满 + 进程表打空 → `rg EAGAIN`」的形态。现在 `sendState` 只读内存里的清单；`SkillRegistry.refresh()` 自带 **30 秒新鲜窗口 + single-flight**（并发调用共享同一次扫描），刷新点收窄为：激活、watcher（文件真的变了，强制）、显式「重新扫描」、打开/新建对话、以及**发送消息前一次**（模型拿到的技能清单仍然是新的）。`test/skillRefresh.test.ts` 用调度层的真实完成计数断言：一次扫描 = 3 次搜索、窗口内 10 次刷新 = 0 次搜索、5 个并发刷新 = 1 次扫描、200 个文件事件被 debounce 合并成最多 1 次扫描。
  - **不再在 VS Code 启动时无条件激活所有「提供语言模型工具」的扩展**。旧代码在 ChatPanel 构造后 1 秒执行 `warmToolContributors()`，对**所有**声明了 `languageModelTools` 且未运行的扩展调用 `extension.activate()`。本机日志里能直接看到这条链（`root cause: honor-world.hwchat`）；在装了 Copilot Chat、Claude Code、Codex 这类重扩展的机器上，等于「装了 HWChat，开机就被别人吃 CPU」。现在只在**打开 HWChat 面板**或**发送消息**时预热，并且所有调用方共享同一个预热 Promise（旧实现先置布尔标记，`send()` 可能在激活完成前就去读工具列表，导致这一轮工具定义缺项）。`test/nativeToolWarmup.test.ts` 断言：只激活真正的工具贡献者、无关扩展不被拉起、并发调用共享同一次预热并等它结束、单个扩展激活失败不影响其它工具。
  - **命令输出累积从「每个 chunk 重拼整个缓冲区」改成有界 O(chunk)**。`spawnCommand` 的 `collect()` 以前每收到一个 data 事件就 `stdout = truncate(stdout + chunk, max)`，而 `truncate` 先对整个字符串做一次 `Buffer.byteLength`（UTF-8 全量编码）再切片。留 200KB 输出时，watch 模式 / dev server / 详细测试输出每秒上千个 chunk 就是每秒几百 MB 的无谓编码与拷贝——命令本身几乎不占 CPU，Extension Host 却顶到 100%。新增 `appendBoundedText` / `renderBoundedText`：越界时只做一次前缀截断，之后只记账不拼接，内存与 CPU 都是 O(chunk)。A/B 基准（2 万个 chunk、200KB 上限）：旧写法 3.8 秒 CPU，新实现 2 毫秒；语义保持一致（保留开头 75%，按全部输出字节报告原始大小），并由 `test/commandOutput.test.ts` 的 6 项断言（含真实 `spawn` 跑一条 500KB 输出）覆盖。
  - **命令侧也有资源压力冷却了**。搜索调度层本来就会在 `EAGAIN` 后把并发压到 1；命令侧只有「单条命令自己退避重试」，排队中的另一条命令会立刻补上空出的并发名额继续 fork，EAGAIN 因此连成一片。`CommandScheduler` 新增 `markResourcePressure()`：命令重试时登记 5 秒冷却，冷却期内并发降为 1，冷却结束后恢复。`test/commandPressure.test.ts` 用可注入时钟断言冷期内峰值并发 = 1、冷却后恢复 = 2、排队中被取消的命令不会执行、dispose 后不再接单。
  - **启动时历史只读一遍**。`initialize()` 以前先 `recoverInterruptedMessages()` 全量读一遍消息，再 `reconcileManifest()` 全量读一遍（首尾文件还额外再读两次）。现在中断消息的修复合进对账的同一次遍历：21MB / 606 条历史的实测 `initialize` 从 **252ms CPU / 305ms 墙钟** 降到 **122ms CPU / 117ms 墙钟**，语义完全一致（`storage.test.ts` 的中断恢复、清单重建、token 合计用例全部通过）。
  - **废弃的单项权限策略不再写回用户设置**。`updateSettings()` 还会把 `fileReadPolicy` / `commandPolicy` / `dangerousCommandPolicy` 等五项写进 settings.json，尽管判定完全由预设推导、读取侧从不使用它们——留下的只是「日志里写着 `allow`、实际另有来源」的混淆。这些键仍保留在 `contributes.configuration` 并带 `deprecationMessage`（老配置不报未知项），但不再被写入；`settings.test.ts` 新增一条断言钉住「保存设置不会落盘这五项」。
  - **架构边界进测试**。`test/searchBoundary.test.ts` 静态断言：`workspace.findFiles` 只允许出现在 `agent/workspaceSearch.ts`；`spawn` / `node:child_process` 只允许出现在 `agent/toolExecutor.ts`；递归文件监听只允许出现在 `agent/skillRegistry.ts`；默认排除列表必须包含依赖/构建/缓存目录；并且 `sendState()` 的方法体里不能再出现 `skills.refresh`。这些是行为测试覆盖不到、只有真机才会暴露的越界。
  - 明确**没有**改的：`hwchat.agentMaxSteps` 的 `0 = 无限制` 语义保持不变（四档：24 / 68 / 120 / 无限制），因为「无限制」并不是无限循环——`ToolLoopGuard`（同一调用连续 3 次）、连续 3 轮无进展、单次运行 200 次工具调用硬上限、以及取消都会先终止它；`agentLoop.test.ts` 覆盖了这四道闸，`agentBudget.test.ts` 覆盖了脏值与 200 步安全上限。文件引用核实的 `exclude: 'minimal'` 也保留：它需要能解析到 `out/extension.js` 这类构建产物，改成默认排除会让正文里的引用点不开。

- **流式输出不再「一闪一闪」地跳**。用户反馈：助手回答时整块内容一直在跳。根因是**每个 delta 都触发一次整段重建**——`streamDelta` 70ms 来一次，每次都调 `renderMessages()`，而它第一件事就是 `messageList.replaceChildren()` 把整个列表清空，再把 N 条消息全部重新造一遍。于是每个 tick 都在做 O(N) 的销毁 + 重建，四个症状同时出现：
  - `.stream-cursor` 每次都是新节点，`blink` 关键帧每 70ms 从头开始——光标在抖；
  - 其它消息的 `<details>`（思考过程、步骤详情）被重造，展开状态靠事后回填，中间会闪一下，正在展开的那条最明显；
  - 附件图标、正文里被换成 SVG 的 emoji 全部重建一次；
  - 整个列表的高度在同一个任务里先塌到 0 再涨回去，滚动位置只能靠 rAF 补，肉眼就是「跳」。
  - 现在只替换发生变化的那**一条**：新增 `patchMessage(messageId)`，按 id 找到索引、先核对那个位置上的 `dataset.messageId` 确实是同一条，再 `current.replaceWith(next)`——节点数从 O(N) 降到 O(1)，其余消息的 DOM 对象连动画状态都原封不动。光标节点显式「换回原来那个」，`blink` 因此不中断；`<details>` 只快照这一条、也只在这一条上恢复。
  - 两道安全阀：DOM 与 `state.messages` 顺序对不上时 `patchMessage` 返回 `false`，调用方退回整段重建——宁可多画一次，也不能按索引换错那一条；用户正在选字或拖动时不碰 DOM（动 DOM 会丢选区、丢了就没法复制），推迟到交互结束再补。
  - `scheduleMessagePatch` 把 70ms 内的多个 delta 合成一次；`renderMessages()` 与 `messageComplete` 都会先清掉 `pendingPatchId`，避免一条消息已经结束后还被一次待办的局部更新按旧内容画回去。旧的 `scheduleMessageRender` 已彻底移除，三种流式消息（正文、工具执行、技能使用）统一走这条路径。
  - 新增 `test/check-stream-patch.mjs` **25 项**：从 `media/chat.js` 原样抽出 `patchMessage` / `scheduleMessagePatch` / `runPendingMessageRender` / `captureDetailOverrides` / `restoreDetailOverrides`，配一个「用了没支持的选择器就直接抛错」的最小假 DOM 跑真实逻辑——静态 grep 只能证明代码在，证明不了「别的节点没被动过」。断言的都是只有跑起来才看得出的性质：未变消息的节点对象没被换掉、光标是同一个节点、用户点开的思考过程仍是展开的、翻上去看历史时 `scrollTop` 一点不动、跟着底部时贴底、结构对不上退回整段重建、选字中推迟、三个 delta 只排一次定时器、找不到 id 时返回 `false` 且不留半截状态，以及 40 条消息跑 20 个 tick 只重画 20 次（整段重建是 800 次）。

- **刷新按钮的图标现在真的在按钮中心**。用户反馈：那颗圆形刷新箭头在圆角方块里明显偏向右下。量出来比看上去更糟——墨迹包围盒中心在 (14.0, 14.1)，比 24 格网格的中心 (12, 12) **偏右 2.0、偏下 2.15**；墨迹高 22.1 格，底边到 y=25.2，**探出 viewBox 1.2 格**，而 SVG 最外层默认 `overflow: hidden`，多出来的那一条被静默裁掉。最隐蔽的一处：这个按钮在加载态跑 `spin`，旋转绕的是 `svg` 盒子中心，而它的圆环圆心在 (14.0, 16.3)、离盒子中心 **4.3 格**，所以转起来不是原地打转，是绕着盒子中心甩。
  - 根因在路径本身，不在样式：旧形状（r=8 的圆环 + 一段 7 格长的直角箭头）整体被**推低了 4.3 格**，箭头才有头顶的位置。圆的墨迹太高太偏，靠 CSS 平移补不回来——往上补，箭头就被裁。`.icon-button` 的 `place-items: center` 作用在 `svg` 盒子上，不是墨迹上，所以盒子居中而墨迹偏心这件事，CSS 从头到尾都不会替你说一句。
  - 改成重绘：圆环 **r=9、圆心正好 (12, 12)**，与同排的 `history` 同一构造；箭头顶角收在圆环的包围盒之内，于是整体墨迹中心也正好落在 (12, 12)。实测墨迹 **19.80×19.80**，与 `history` 的 19.80×19.81 对齐，不再比邻居大一圈或小一圈；圆心与盒子中心重合，`spin` 终于是原地转。
  - 用户接着指出「箭头都接到转圈的尾部了」——这一条也是真的，而且原因不在居中：那条路径把圆弧的**起点**（3 点钟方向）直接当成箭头的折点，于是箭头挂在了弧的**尾部**、方向也反了，画出来像一个箭头从外面斜插进圆环。现在弧从 (21, 12) 起、绕大半圈收在右上 −48°，再经一小段径向短线接到箭头折点 (21, 8)：箭头接在**弧的末端**、落在弧的缺口里，与 lucide `rotate-cw` 同一构造。判定不靠具体坐标，而是拿箭头路径的每个顶点分别量到弧的起点与终点——`toEnd ≤ 0.35` 且 `toEnd < toStart`。实测箭头折点离弧末端 **0.00 格**、离弧起点 **4.00 格**；把折点挪回弧起点（复现被投诉的那个接法）后变成**离起点 0.00、离末端 5.65**，两条断言同时失败。只判「贴着某一端」是不够的，所以这两条断言必须成对出现。
  - 新增 `test/check-icon-geometry.mjs` **21 项**：真解析 `src/views/webview.ts` 里的手写路径（M/L/H/V/C/S/Q/T/A/Z 及相对形式；弧按 SVG 规范 F.6.5 解圆心，曲线按 32 段采样，遇到不认识的命令直接抛错而不是猜一个包围盒），然后断言三件事——14 个图标的墨迹**都不出 viewBox**（`refresh` 是唯一违反的）、`refresh` 的**圆环圆心与墨迹中心**都在盒子中心 ±0.35 内、尺寸与 `history` / `export` 相差不超过 12%。特意不比 `archive`：它的盖子横跨整个网格、宽度天生 23.8，拿它当基准会要求 refresh 也变得那么宽。`--report` 模式只打印实测几何，改图标时用来看数字。
  - 反向验过三种坏形状，都能被打挂：换回旧路径 → 「不出 viewBox」「圆环居中」「墨迹居中」「与 export 尺寸相近」四条失败；圆环半径缩到 6 → 三条居中断言 + 两条尺寸断言失败；整体右移 1.5 格（偏心但不出界）→ 两条居中断言失败。验完自动还原源码。
  - 顺带记录一处**刻意没动**的：`skills`（星形）的墨迹中心在 (12, 9.75)，比网格中心高 2.25 格。星形只有一个顶点朝上，包围盒中心本来就不等于视觉重心，它也不参与旋转；几何脚本只断言它不出界，没断言它居中。要不要一并调，等你决定。

- **标题旁的项目徽标改成本对话涉及的全部项目**。用户反馈：这一轮确实改了「本地skill快捷调用」那个项目（`src/activeState.ts`、`CHANGELOG.md` 等），可标题下方仍然只显示 `DeepSeek-HWChat`。原因是徽标只认一个 `projectRoot`——它在**首次**写盘时绑定，之后只读不改，所以「这次改过哪些项目」这件事根本没有被记录过。
  - 采集：`ToolExecutionScope` 里那个一直声明着却**从未被调用**的 `touchProjectRoot` 接上了。写文件、替换、移动、删除成功后各上报一次项目根，跨项目移动时两端都算；git 写操作（暂存、提交这类会改动仓库状态的命令）成功时也算。
  - 口径：只在改动**已经成功落盘之后**上报。被权限拒绝、被版本号策略拦下、或写失败的调用没有改动任何文件，不该让徽标凭空多出一个项目；只读命令（查状态、跑测试）同样不算——把只读命令算进去比漏掉更误导。
  - 落库：新的 `projectRoots` 字段只做展示，`projectRoot` 仍是相对路径与 git 写操作归属的唯一依据，二者不互相改写。同一对话里写 30 个文件只入库一次（面板按对话登记已上报的项目根，避免每次都读一遍存档）；读盘时逐项校验必须是绝对路径并去重，脏值直接丢掉。
  - 展示：按「主项目在前、其余按首次触达顺序」排列，用 `·` 连接，一行放不下时折成 `+N`，悬停给出完整清单。**升级前的老对话**没有这个字段，但会从工具记录里 `changedFiles` 的文件夹名前缀反推（多根工作区里 `asRelativePath` 带前缀），所以已有的历史对话也能立刻显示出多个项目；单根工作区不参与反推，避免把文件名当成项目名。
  - 测试 477 → **545**（`npm test`）：`workspacePaths.test.ts` 增 8 条（主项目在前且不重复、工作区根被移除后丢弃、上限截断、单根不反推、老对话反推、同名文件与相近项目名不误判），`storage.test.ts` 增 3 条（`projectRoots` 落库且不碰主项目、载入时丢相对路径/重复项/非字符串、写空数组即清空）。新增 `test/check-project-badge.mjs` **27 项**：从 `media/chat.js` 原样抽出 `renderProjectBadge` 配最小 DOM 跑真实渲染（单项目不变、两个项目两个名字都显示、超出折 `+N` 且悬停含全部名字、未绑定仍是红字、脏值被过滤），并逐条钉住接线（写/改/移/删/命令都上报、上报在写盘之后、被拒绝的不上报、只读命令不算、作用域里传了 `touchProjectRoot`、徽标走 `involvedProjectRoots`、`sendState` 把消息交给徽标、存档放行并归一化 `projectRoots`、webview 接收 `others`）。反向验过：把 `others` 从渲染里去掉、删掉两处上报、或摘掉作用域里的 `touchProjectRoot`，对应的断言都会失败。

- **清单做完就归档，不再占着面板**。用户反馈：任务已经执行完、面板上明明写着「6/6 已完成」，那份清单却一直挂在输入框上方不走。原因有两个，都是「只在整轮运行结束时才归档」带来的：
  - **模型标完最后一项后还要继续干活**（写总结、跑验证），这段时间清单一直占着位置；
  - **收尾那一步可能根本不会执行**：进程被杀、窗口被关、扩展重载，正好夹在「最后一项打勾」和「运行结束」之间，于是这份已完成的清单就永远留在面板上。
  - 现在 `update_todos` 里只要提交的清单**全部完成**就当场压成胶囊（与手动归档同一套 `createTodoArchive` / `appendTodoArchive`），面板立刻收走；`viewTodos` 读到「已全绿但还留着」的存档（上面第二种残局）也会补一次归档。判据抽成纯函数 `planCompletedList`，未完成的清单照旧留在面板上，不会被悄悄归档。
  - **重复提交不会多出胶囊**：模型收尾时常把同一份进度再发一次，`sameTodoList` 比对最后一条归档的内容与状态，一致就不追加（但清单仍然从面板撤掉——它已经归档过了）。
  - 归档时回给模型的正文多一句说明（`todo.archivedHint`），它下一轮不会以为自己还占着面板。
  - 工具卡摘要用新的 `todo.archived`（「任务清单全部完成（N 项），已归档成胶囊」），不再笼统写「已更新」。

- 测试 471 → **477**（`npm test`）：`src/test/todoArchives.test.ts` 增 7 条（全绿立刻归档、没全绿不归档、空清单不归档、重复提交不重复追加但应撤掉清单、内容变了算新的一份、归档上限仍丢最早的、`sameTodoList` 的顺序/条数/状态判定，以及一条接线断言：`planCompletedList` 在写入口与读取入口各调一次、存档与推送都用 `keepList` 分支而不是未过滤的 `submitted`）。`test/check-todo-scope.mjs` 的三处断言原来是按旧字面量匹配的（`todos,` / `type: 'todos', conversationId, todos,`），改成从过滤那一行往后定位写入区块，并新增一条「写入口里不许出现 `submitted`」——否则「过滤后的清单才落库」这条底线会随着代码形状变化而失效。

- **勾选归属改成「对话级」：扩展提供新对话的默认值，对话自己说了算**。上一版把 HWChat 的勾选直接写进 `~/.copilot/.skill-quick-launch.json`，于是在一条对话里临时取消某个 Skill，等于顺手改掉了以后所有对话的默认值——另一个面板里会看到自己的全局配置被悄悄改了。现在按需求分成两层：
  - **新对话**读一次「本地skill快捷调用」的全局勾选（`active`），作为这条对话的初始勾选；
  - **对话里勾选 / 取消只影响当前这条对话**（写 `skillIds` 存档），不再写回共享文件。已有对话的选择不受全局清单后续变化影响——否则用户在对话里取消的技能会被全局清单顶回来，勾选框「自己弹回去」。
  - 判据收在一个纯函数 `resolveSkillSelection(initialized, storedIds, sharedActiveIds)` 里：有记录用自己的（包括「全都取消」这个空集合），没记录才取全局。这一条决定了两种 bug 都不出现，所以单独测。
  - 仍会写回共享文件的只剩 `lastUsed`（「这个技能最近被真正加载过」，供那个扩展显示「已调用」角标），且**只写它认得的那个名字**（`sharedName`：frontmatter 名 → 目录名）。勾选字段一个都不碰。
  - 快捷调用面板改了勾选，HWChat 会收到通知（`RelativePattern` 盯住那个文件）并刷新画面：已有对话不动选择，只有**还没被用户动过的草稿**跟着变——那一稿就是「下一份新对话」。
  - 运行中（正在跑或排队）改勾选会被拒绝并回推一次真实状态，避免勾选框停在一个没生效的位置。

- **没装「本地skill快捷调用」时不再拦着勾选**，只展开一段安装提示。上一版是「必须先装才能勾」，理由是勾选要写进它的文件；勾选改成对话级之后这条理由不成立，拦着反而让不想装那个扩展的人完全用不了 Skill。现在点受它托管的 Skill（`source === 'copilot'`）的勾选框时，勾选照常生效，同时展开说明：新对话的默认勾选来自那个扩展，没装时每个新对话都从空白开始，并给出「打开扩展商店」按钮。提示块默认隐藏，装上后随状态回推自动收起；样式显式声明 `[hidden] { display: none }`，否则 `display: grid` 会把它盖成常显。

- **共享状态「读不懂就不写」**：`~/.copilot/.skill-quick-launch.json` 由两个扩展共同读写（我们写 `lastUsed`，它写全部配置），而两边都是「截断再写」。「读-改-写」里一旦把「读失败」当成「空状态」，写回去就会抹掉对方的分类改名、自建分类、自定义名称与历史调用时间——一次误读清空用户攒的配置，而且不可撤销。
  - `readQuickLaunchRaw()` 区分三种结果：读到 → 用它；**文件不存在**（首次使用）→ 空对象，允许新建；**存在但读不懂**（内容损坏、另一个扩展正写到一半）→ 放弃本次写入。只有 `FileNotFound` / `EntryNotFound` / `ENOENT` 才算「不存在」，权限不足之类不再被当成首次使用。
  - 记录调用时间写不进去直接放弃（少一个「已调用」角标，远比清空配置划算），写文件失败也不再往外抛：它只影响角标，不该让这一轮对话失败。
  - 新增跨项目契约断言：本机若存在 `Local_skill_quick_access` 检出，测试会读它的 `package.json` 与 `src/*.ts`，钉住「扩展标识 = `${publisher}.${name}`」「共享状态文件名一致」。这条断言刚写完就抓到一次真实漂移——对面把状态路径常量挪进新模块后，按文件名写死的检查立刻失效（现在改为扫整个 `src`）。

- 测试 **470**（`npm test`）：`src/test/skillSelection.test.ts` 覆盖「新对话取全局 / 已有对话只用自己的记录（含空集合）/ 两种来源都去重滤脏值 / 共享名只看 frontmatter 与目录名 / 读不懂时不写且只认三种「文件不存在」错误码 / 源码里不再有写回 `active` 的路径」。`test/check-skill-toggle.mjs` **19 项**：从 `media/chat.js` 原样抽出 `renderSkills` / `syncSkillsInstallHint` / `showSkillsInstallHint`，配最小 DOM 桩跑真实事件——按 `selectedSkillIds` 打勾、取消勾选发 `toggleSkill` 且界面不擅自改本地状态、未安装时照样发意图并把提示展开（不把勾选框退回）、装上后重渲染自动收起、源码里不再出现 `setSkills`。

- **步数改成四档 24 / 68 / 120 / 无限制，思考深度改成四档 低 / 中 / 高 / 最大**（新对话默认 24 步、思考深度「高」）。
  - 步数只有四档可选，且来源唯一：`src/core/agentLimits.ts` 的 `AGENT_STEP_PRESETS = [24, 68, 120, 0]`。这个文件刻意不 import `vscode`，因为存储层清洗历史存档要用同一份规则——两处各写一份迟早会漂。工具条与设置页的 `<select>` 都由它生成，设置页不再让人自由填数字（只挡负数）。
  - `0` 是「无限制」的哨兵值，且**只有显式选择**才写出 0：空字符串 / `null` / 布尔 / 负数 / 非有限数一律回落到 24。这条单独测，因为 `Number('')` 与 `Number(null)` 都是 `0`——空值被当成「无限制」是最危险的方向（本来只是没填，结果再也不停）。有限预算取整并夹到 200；「无限制」在循环里换算成 `Infinity`，仍受同一调用连续 3 次、连续多轮无进展、单次运行的累计工具预算、停止按钮这几道闸约束。
  - 忠实回填：存档里若有别的合法数字（老对话写过 8 / 40 / 80），工具条会把它补成一个选项显示出来，不静默改成最近的一档——把 8 悄悄变成 24 会让人以为「设过的东西自己变了」。
  - 思考深度四档 `low / medium / high / max`，默认「高」。发参按各模型官方接口分别处理，**不做多余的本地折算**：
    - DeepSeek 官方接口按文档接受 `none / low / high / max`，并明确把 `minimal` 折算成 low、把 `medium` 与 `xhigh` 折算成 high，所以四档原样发出，由服务端自己折算；同时按文档带 `thinking: { type: enabled | disabled }` 作为思考模式开关。
    - 其他 OpenAI 兼容接口通常只有 `minimal / low / medium / high`、没有 `max`，于是只把「最大」折成它的最高档 `high`，其余原样透传。
    - 接口若回「Unknown parameter: reasoning_effort」这类 400 拒绝，会逐个去掉不被支持的思考参数后重试（`reasoning_effort` 与 `thinking` 各一次，删完就停），而不是让整轮对话直接失败。
  - 档位只在该模型**声明可调**时开放：能力解析把 `default` / `none` 这类非档位值过滤掉，固定思考或能力未知的模型不伪装成可调。
  - 测试 **554**（`npm test`）：新增 `src/test/agentBudget.test.ts` 7 条（预设就是四档、默认仍是 24、0 是「无限制」而负数/非数字才是脏值、有限预算取整并夹到 200、循环预算把「无限制」换算成 Infinity、四档深度都能通过归一化、对话控制继承「无限制」而不当脏值丢掉），`deepseekClient.test.ts` 钉住「DeepSeek 四档原样发送 / 其他接口把 max 折成 high / 不被支持时去掉参数重试」。新增 `test/check-runtime-controls.mjs` **38 项**：从 `media/chat.js` 原样抽出 `normalizeStepValue` / `stepsLabel` / `ensureStepOption` / `syncReasoningSelector`，配最小 DOM 跑真实逻辑——`0` 与 `"0"` 都保持「无限制」、`999` 夹到 200、`-1` 与空串回落到 24（负数不是无限制）、非预设值 8 补成选项并显示成「8 步」、文案走 `chat.stepsUnlimited`；同时钉住工具条与设置页的选项都来自 `AGENT_STEP_PRESETS` / `REASONING_DEPTHS`、设置页允许 0 只挡负数、四档深度文案走 `chat.reasoning.*`、能力数据里的 `default` / `none` 被过滤掉。

- **新对话的默认权限预设改成「每次询问」**，并顺手修掉两处「切了预设却按别的档位判定」的漏洞。
  - **默认值取最严格的一档**：默认值决定的是「用户开口之前 Agent 能自己做什么」，这类错误不可撤销（一条没被确认的递归删除发出去就收不回来）。四档里只有 `每次询问` 一项都不自动放行——读、写、只读命令、正常命令逐次确认，危险命令直接拒绝，敏感文件禁止；旧默认 `风险操作询问` 会把常规命令静默执行掉。
  - **切换后保持不变**：切换只写当前这条对话（还没有对话时写在草稿上），面板重渲染、发送、切对话都不会把它顶回默认值，只有用户再切一次才改。默认值仅在「这条对话没有任何值」时参与，所以老对话的存档值不受这次改动影响。
  - **切换后权限只看当前预设**：`send()` 用 `applyRuntimeControls` 从新预设整套重算策略，不会把切换前那一份 allow/ask 一起带过去。
  - **附件读取漏点**：`attachFiles` 以前拿全局 `readSettings()` 判敏感文件，和当前对话切过的预设无关。于是全局是「每次询问」时，刚切到「完全访问」的用户附 `.env` 仍被敏感文件禁止挡住；反过来全局是「完全访问」时，停在「每次询问」的用户又能静默附上敏感文件，绕过确认。现在按当前对话的生效预设展开，`readAttachment` 的 `settings` 也从默认可省改成必填参数，避免以后再被省成全局值。
  - 默认值散落在四处（`core/permissions.ts` 的唯一出处 `DEFAULT_PERMISSION_PRESET`、`settings.ts` 的读取兜底、`package.json` 的设置项默认值、`media/*.js` 的界面兜底），新增断言把这四处钉在一起；`permissionPresetDetail` 的兜底也从写死的 `details[1]`（正好是 review）改成按默认档取，默认值再改不会错位。

- **模态确认框不再自带「取消」**。切到「完全访问」的确认框里并排出现过两个「取消」：一个是 VS Code 自己追加的（`modal: true` 的对话框总会带一个本地化的 Cancel），一个是我们又传进去的 `tt('common.cancel')`——两个按钮文字和行为都一样，还把主按钮挤到第三个位置。五处模态框（权限放宽、清空本地数据、删除对话、语音授权、隐私同意）现在都只传各自的确认按钮，取消交给 VS Code；点原生取消返回 `undefined`，各处判断照常成立。新增 `src/test/confirmDialogs.test.ts`：做括号配平取出每个 `show*Message(...)` 的真实参数，凡是带 `modal: true` 的都不许再传取消类按钮（i18n 键或 `'取消'` / `'Cancel'` 字面量），并保证扫描确实覆盖到 6 个以上模态框、权限确认框仍有确认按钮——已验证把 `tt('common.cancel')` 加回去时这条断言会失败。

- 测试 446 → **458**（`npm test`）：新增 `src/test/permissionDefaults.test.ts`（9 条：默认档是每次询问且是四档中最严格的一档、什么都没配置时读到每次询问、`package.json` 默认值与代码唯一出处一致、非法/旧存档值回落、未知预设取说明文案回落不错位、用户切换后不被默认值顶回、切换后的策略只看当前预设、webview 三处兜底同为 `askAll`、附件读取按当前对话预设判定）与 `src/test/confirmDialogs.test.ts`（3 条）。`test/check-*.mjs` 16 个脚本全部通过。
- 归档胶囊栏支持横向滚动，但没有滚动条。胶囊不再随面板变窄而缩小或裁掉右侧，统一保持 10.67×32px、3:1 宽高比；两种滚法都支持：**鼠标滚轮**悬停在胶囊栏时转为横向滚动（触控板本来就能横滑），以及**按住鼠标横向拖动**（光标为 `grab`，拖动中变 `grabbing`；触摸屏保留浏览器原生惯性滚动，右键不接管）。滚到两端后滚轮继续交还给页面纵向滚动，不会卡住。
  - **为什么把滚动条去掉**：6px 的横条快赶上胶囊本体的一半厚度（10.67px），既挡视线又抢注意力，而这条栏本来就只承载「颜色 + 顺序」这点信息。代价是必须补上拖动这种滚法，否则只剩滚轮一个入口。
  - **拖动后的那个 click 要吞掉**：浏览器在 `pointerup` 之后仍会补发 `click`，落在胶囊上就会把「拖一下」当成「点这一颗」，拖完莫名多展开一个面板。做法是位移超过 3px 才在栏的 `dataset` 上打一个**一次性**标记，胶囊点击处理先问一次 `consumeArchiveDragClick`，读到即清。位移小于 3px 的抖动不算拖动，点击照常生效。
  - **指针捕获要等到真的拖起来才做**：`pointerdown` 就 `setPointerCapture` 会把后续事件（含 `click`）改派给栏本身，胶囊就再也收不到点击——「按一下没动」的正常点击会全部失效。所以捕获发生在位移超过阈值、确认是拖动的那一刻；手拖出栏外、甚至拖出窗口仍继续跟手，松手也一定收得到 `up`，再配 `pointercancel` / `lostpointercapture` 兜底，不会卡在「拖动中」。位移从按下时的 `scrollLeft` 起算，不逐次累加，越界由浏览器自己夹住。
  - 新归档排在最右端，条数变多时胶囊栏会自动跟到末尾一次——栏窄到要滚动时它本来在视野之外，不跟过去用户会以为「这次没归档」；而展开/收起引起的重渲染不会动滚动位置，不然你往回看旧胶囊时会被弹回最右。

- **胶囊滚动的验证**：新增 `test/check-capsule-drag.mjs`（**26 项断言**）：从 `media/chat.js` 原样抽出 `bindTodoArchiveDrag` 与 `consumeArchiveDragClick`，配一个带指针捕获、`classList`、`dataset` 与 `scrollLeft` 夹取的最小桩跑真实操作序列——拖动方向（手往左拖、内容跟着往左）、从起点算不累加、拖过内容宽度被夹在最大值、抖动 2px 不算拖动、松手即停、按下时不捕获指针而拖起来才捕获、松手释放捕获、丢失捕获后复位、触摸与右键不接管、别的指针的 move 被忽略、拖动后的 click 只吞一次、拖到空白松手留下的标记在下次按下时清掉。运行 `node test/check-capsule-drag.mjs`。`test/check-capsule-geometry.mjs` 补 3 条（滚动条确实隐藏且没留 webkit 滑块、`grab`/`grabbing` 光标、拖动已接线且胶囊 click 先过一遍 `consumeArchiveDragClick`）；`test/check-panel-exclusivity.mjs` 补**场景 11** 4 条端到端断言：拖动后的 click 不展开面板、两个面板保持原状、标记被消费掉、紧接着的正常点击照常展开那颗胶囊。

- **正文里的文件引用先核实、再显示**。上一版把「有扩展名就算文件」的片段渲染成可点引用、再拼到项目根上——于是模型正文里顺口提到的裸文件名（`extension.js` 其实指 `out/extension.js`，也可能根本不存在）会变成一个指向 `<项目根>/extension.js` 的标签，点开报「文件不存在」。现在渲染之后会把每条引用回问扩展侧一次，由它实探文件系统：
  - 绝对路径 → 只认它本身，存在才算，且必须落在工作区内；
  - 带目录的相对路径 → 依次试项目根与各工作区根（确定性，与原来一致），都不存在就不认，**不回退**到按文件名搜索（`src/a.ts` 被替换成别处的同名文件等于骗人）；
  - 裸文件名 → 也先按根目录拼（`package.json`、`README.md` 就在根上），拼不到才按文件名整棵树搜一次，**而且只有唯一命中才算数**：同名多份时猜错文件比不给引用更糟；
  - 判不出来就**降级成普通文本**：用户看到的还是原文，只是没有图标和右键菜单；
  - 查到的可能是**另一个文件**（`extension.js` → `out/extension.js`），所以标签、悬停提示、左键与右键的目标一起换成真实路径，不会出现「标签写 A、点开是 B」。
  - 一条消息里的引用合并成一次请求（渲染是同步的，用一个微任务批处理）；命中结果一直缓存，**未命中只缓存 10 秒**——用户完全可能在看到引用之后才把文件建出来。
  - 按文件名搜索时只排除 `node_modules` 与 `.git`；构建产物目录（`out` / `dist` / `build`）照搜——`extension.js` 的实际位置就是 `out/extension.js`，把它排除掉这条主用例反而修不好。同名多份的歧义由「只有唯一命中才算数」兜住，不会指向错文件。
  - 纯逻辑在 `src/agent/fileReferenceResolve.ts`：不 import `vscode`，存在性由 `exists` 注入、命中集合由调用方用 `workspace.findFiles` 取来喂进去，所以「同名多份不认」这类判断能单测，不用起编辑器。
- 测试 431 → **446**（`npm test`）：新增 `src/test/fileReferenceResolve.test.ts`（15 条：根目录命中优先、唯一命中才认、同名多份不认、带目录不回退搜索、多根工作区的优先级、绝对路径必须在工作区内、glob 元字符不拿去搜、Windows 大小写合并）。`test/check-file-reference-dom.mjs` 43 → **61** 项：6 条接线断言（`verifyFileReferences` 消息存在、扩展侧确实用 `chooseReferenceMatch` 实探而不是猜、只有裸文件名才 `findFiles`、搜索不排除 `out` 这类构建目录、同名多份只认唯一命中、核实结论确实回给界面）加 12 条**运行时**断言（一条消息只发一次核实请求、请求里带正文原始写法与项目根、核实不到就降级、降级后原文一字不差、核实到 `out/extension.js` 后标签/悬停/点击目标一起换、反引号里的裸文件名也先渲染成引用、没有工作区根时不瞎拼）——后半部分只能靠真实渲染验证。

- **本地安装收成一条命令**：仓库里新增 `scripts/install-local.sh`，自动挑项目根目录最新的 VSIX、自动定位 `code` 命令行工具、同版本带 `--force` 覆盖安装。找不到 `code` 时不直接失败，而是打印两条替代路径（`Shell Command: Install 'code' command in PATH`，或扩展视图 `⋯` → `Install from VSIX…`）——`code` 不在 PATH 是 macOS 上的常见默认状态，只报错等于把人丢在原地。`--check` 只报告会装哪个包、当前装了什么；`--list` 只列已装版本；`HWCHAT_CODE_CLI=/path/to/code` 可指向 Insiders 这类非默认安装。脚本本身不进安装包（`.vscodeignore` 已排除 `scripts/**`）。
  - 顺手挡掉一个只在老 bash 上出现的坑：`$VAR` 后面紧跟全角括号时，macOS 自带的 bash 3.2 会把括号的首字节算进变量名，`set -u` 下直接 `VSIX…: unbound variable` 并中止。所以脚本里紧贴中文的变量引用一律写成 `${VAR}`，另加一条静态检查确认没有漏网。
  - 安装路径与分支都用桩 CLI 跑过：未安装走「全新安装」、已装同版本走「`--force` 覆盖」、已装旧版本走「改为 x.y.z」、安装失败给出排查清单、`--list` / `--check` / 非法参数（退出码 2）各自正确。

- **搜索与子进程不再无上限并发，`spawn rg EAGAIN` 有了确定的处理路径**。现场：macOS 上跑 Agent 任务时 CPU 顶到 100%、VS Code 卡死，日志里是 `spawn …/@vscode/ripgrep-universal/bin/darwin-arm64/rg EAGAIN`。审计本地源码后确认 HWChat 自己就是 rg 的调用方：
  - `list_files` / `search_files` 每次都用 `workspace.findFiles`（VS Code 的文件搜索会启动 ripgrep），而且**多根工作区里逐根循环**——真实会话有 17 个根，一次工具调用就是 17 次 rg 启动；
  - 没有并发上限、没有去重、没有缓存：同一轮里模型连发几次相同搜索，就是几十个 rg；`agentMaxSteps` 还是 `0 = 不限制` 时能一直堆下去；
  - 失败被原样丢回模型，模型立刻换措辞重试，`EAGAIN` 因此变成了正反馈。
  - 现在所有内部搜索都走新的 `src/agent/searchScheduler.ts` + `src/agent/workspaceSearch.ts`：活动搜索默认 **1** 个、队列上限 24（满了直接拒绝并说明原因）、相同参数的并发请求用 single-flight 合并、成功结果缓存 1.5 秒并在每次写入/保存/删除/重命名后立刻失效。`EAGAIN`/`EMFILE`/`ENFILE`/`ENOMEM` 归为暂时性资源错误，最多 3 次退避重试（200/600/1500ms），期间把并发压到 1；用完仍失败就返回「系统暂时无法启动搜索进程」并提示缩小范围。语法错误、路径不存在等一律不重试。
  - Skill 注册表也改走这一层（一次保存会触发多个 watcher 事件，现在合并成一次 250ms 防抖刷新），并给 `git rev-parse` 补了 5 秒上限——网络盘上它同样可能把整个工具调用拖住。
  - 默认排除依赖、构建、缓存与工具链目录（`.git`、`node_modules`、`dist`、`build`、`out`、`coverage`、`.next`、`.turbo`、`.venv`、`venv`、`__pycache__`、`DerivedData`、`.cache`），并新增 `hwchat.searchExclude` 供项目级追加。不再用「全工作区递归 FileSystemWatcher」做失效——那本身就贵，改用保存/新建/删除/重命名事件 + 短 TTL。
  - `search_files` 的扫描也收了边界：24MB 读取预算（1500 个 512KB 文件曾经等于几百 MB IO）、命中上限 120、逐文件取消检查，并且先用整篇小写文本判断「有没有命中」，只有命中的文件才按行拆分——旧实现无条件对每一行跑 `toLocaleLowerCase`，是 Extension Host CPU 打满的直接来源之一。遇到符号链接逃逸只跳过该文件，不再让整次搜索失败。
- **Agent 循环有了真正的单轮预算与死循环保护**：
  - `agentMaxSteps` 默认 24、绝对上限 200。`0`（旧的「不限制」）与非法值一律回落到默认值——历史会话存档里的 0 也会被夹住（`normalizeStoredSteps` 直接丢弃 0）。
  - 连续 3 次完全相同的工具调用（参数按键排序后比较）会被拦下并说明原因，不再自动重试；连续 3 轮「所有工具都失败」也会停下。
  - 单轮最多执行 12 个工具调用、整轮请求最多 200 个；超出的调用补一条「未执行」的工具结果（否则历史消息序列非法）后结束本轮。
  - 步数用尽时保留全部步骤与结果，提示回复「继续」接着执行；提示文案已同步更新（中英）。
- **取消和停用真正能停下工具与进程**：`AbortSignal` 现在一路传到工具内部。
  - 同一轮里用户点了停止，剩余的工具调用一个都不会再执行；
  - `run_command` 支持取消，触发后按**进程组** SIGTERM → 1s 后 SIGKILL，并在秒级结算；
  - 命令有独立的并发闸门（2 个活动、8 个排队，满了直接拒绝），不再和搜索抢同一个很小的全局并发；
  - `ToolExecutor.dispose()` 不再是什么都不做：取消排队命令、杀掉仍在运行的进程树、释放搜索调度器与缓存；
  - 调度器释放/取消后，排队中的任务不会「稍后偷偷执行」。
- **结构化诊断**：每次工具调用向 HWChat 输出面板写一行 JSON（`turnId`、`toolCallId`、`toolName`、`operation`、`queueWaitMs`、`durationMs`、`activeSearches`、`pendingSearches`、`activeCommands`、`resultCount`、`truncated`、`cancelled`、`errorCode`，不含命令正文/文件内容/凭据），并新增命令 **HWChat: 显示资源统计**（`hwchat.showResourceStats`）查看实时计数。
- **权限审计结论（未改判定逻辑）**：日志里的 `permissionPreset → autopilot` + `dangerousCommandPolicy → allow` 是 **Autopilot 预设本身的既定语义**（自动执行危险命令，仅拦敏感文件），不是用户级单项配置把权限放开了；五项单项策略完全由预设推导，用户级 `dangerousCommandPolicy: allow` 不会放宽 `review`。这两点已补测试钉死。
- 测试 477 → **524**（`npm test`）：新增 `src/test/searchScheduler.test.ts`（13 条：10 次并发合并成 1 次、峰值并发 ≤ 上限、队列容量拒绝、取消排队任务不执行、取消运行中任务释放名额且不影响其他等待者、缓存失效、失败后可恢复、EAGAIN 重试成功/重试耗尽、普通错误不重试、取消后不再重试、dispose 清理）、`src/test/agentLoop.test.ts`（9 条：有限预算、0 回落默认、超限夹到 200、重复调用拦截、正常任务不受影响、取消后不再调用、单轮超量、连续失败停止、参数键序不影响判重）、`src/test/resourceCleanup.test.ts`（9 条：已取消不启动进程、取消杀掉进程组、命令并发/队列、排队取消、取消命令、dispose 杀进程、暂时性错误识别、重试上限与取消优先、EAGAIN 映射成可读错误）、`src/test/workspaceSearch.test.ts`（10 条：默认排除目录、文件级/项目级 `searchExclude`、`minimal` 档仍看得见构建产物、相同搜索合并、相同查询只扫一次、写文件后缓存失效、已取消不搜索、搜索中途取消）、`src/test/perfSearch.test.ts`（3 条算法级 A/B：10 次相同搜索从 10 次真实搜索 + 10 次扫描降到 1 次；排除列表对比 1000 → 400 个文件），并把 `conversationControls` / `agentRunner` 的「0 = 无限」旧断言改成「0 回落默认」。性能测试只用进程内替身，不消耗模型额度。

- **正文文件引用核实不再把整机 CPU 打到 98%**（真实故障，实机复现并定位）。现场：一条总结消息里几十个裸文件名，HWChat 为**每个名字各搜一次** 17 根工作区（`findFiles` + `--follow`，实测单次 1.7 s、76% 是内核 sys 时间），且**未命中的名字每 10 秒重搜一次**——消息只是显示在屏幕上，CPU 就长期 96–99%、VS Code 卡死。证据：rg 命令行用的是 `minimal` 排除档 `**/{node_modules,.git}/**`（只有这条路径用它），`-g` 全是正文裸文件名，同一时间 HWChat 日志里 `[tool]` 为 0 条（不是 Agent 工具循环）。
  - 新增 `src/agent/fileReferenceBatch.ts`（纯逻辑、可单测）：缓存 + `existsSync` 先判，剩下的裸文件名**合并成一次**花括号 glob 搜索；**最多两次搜索**（先只搜本项目根，未命中再搜全部根），与引用个数无关。
  - 超过合并上限（64 个名字）或名字含 glob 元字符的，**直接降级成普通文本**，不再逐个补搜。
  - 未命中的结论缓存从 **10 秒 → 10 分钟**（写入文件会让搜索代数 +1 主动失效），彻底断开「每 10 秒重搜一遍」的循环。
  - 测试 524 → **545**：新增 `src/test/fileReferenceBatch.test.ts`（10 条：40 个裸文件名只发 1 次搜索、重名合并、不安全名字不进 glob、上限截断且不额外搜索、未命中缓存后重复渲染 0 次搜索、TTL 过期后走 existsSync、确定性命中不启动 ripgrep、项目根命中不再扫全部根、文件只在别的根时仍能找到、单次请求条目数上限）。

## 0.2.4

- 发布版本号推进到 **0.2.4**，构建产物为 `hwchat-0.2.4.vsix`。0.2.3 已发布，同一个版本号传不上去，所以这次以补丁号发出。本版把「附件可点击查看、通知停留时长按阅读量自适应、续跑作用域只绑定一次、任务分类先判不相关、任务清单排除推送与版本号、正文里的文件引用可点开并定位到系统文件管理器或 VS Code 资源管理器」合并为同一个发布。

- **正文里被提到的文件可以点开，也能直接在系统的文件管理器里定位**。模型回复里出现的路径（`src/core/ids.ts`、`media/chat.js:745`）不再只是一段等宽的代码片段：
  - **显示**：写在反引号里（引用格式）的路径渲染成一枚小标签，显示相对路径 + 行号——短、好读，并且会先按工作区根解析一次，确认它到底指向哪个文件；正文里**没写引用格式**的裸路径同样认得出，但显示**完整绝对路径**。这条是用户明确要求的：完整路径能让人在 VS Code 之外（Finder / 资源管理器）对着它找到文件。落在工作区外的路径没有相对写法，也只能整条显示。
  - **悬停**：标签轻微上浮并带一层同色阴影，提示里给出完整绝对路径和「左键 / 右键分别能做什么」。`prefers-reduced-motion` 下不位移、不加阴影，只保留颜色变化。
  - **左键**：在编辑器里打开；带行号时定位到那一行那一列。行号可能已经过期（文件被改短了），所以一律夹到合法范围内，不会抛一个跟「点了个链接」无关的异常。
  - **右键**：菜单四项——在 Finder / 资源管理器中显示（用 VS Code 官方的 `revealFileInOS`，打开文件管理器并**选中该文件本身**）、在资源管理器视图中显示（`revealInExplorer`，只动 **VS Code 自己的侧边栏**，把项目树展开并选中该文件，编辑器内容不变）、在编辑器中打开、复制完整路径。三平台命名分开：macOS 叫 Finder，Windows 叫资源管理器，其余统一叫文件管理器；平台判断只有一处（`revealTargetFor`），界面只负责查文案表。
  - **两条「显示」为什么要分开**：前者是「离开 VS Code 去系统里找」，后者是「留在编辑器里看它在项目树的哪一层」，命令和失败条件都不同，所以走两条独立消息（`revealFile` / `revealFileInExplorer`），不是同一条加个参数。第二项还有一道额外判断：`revealInExplorer` 对**工作区外**的文件静默无效，不报错也不移动，用户点了会毫无反应——所以先用 `isInsideWorkspace` 判一次，界外直接给提示。定位完还会把资源管理器视图调出来，否则树折叠着或视图被切走，「选中了但看不见」等于没做（HWChat 在 `secondarySidebar`，资源管理器在 `primarySidebar`，切换不会把聊天面板挤掉）。
  - **第二项的措辞是选过的**：Windows 上系统文件管理器也叫「资源管理器」，两项若都叫「在资源管理器中显示」就分不清哪个开系统窗口、哪个定位侧边栏。所以第二项采用 VS Code 自带右键菜单的措辞「在资源管理器视图中显示」/ `Reveal in Explorer View`。校验脚本里有一条断言专门盯这个区分。
  - **判定用扩展名白名单，不用「看着像路径」**：正文里到处都是 `v0.2.4`、`e.g.`、`example.com`、`https://…`、`--force`，只要「有扩展名就算文件」，它们全会长出右键菜单，点下去是一个不存在的文件。`com` / `org` / `net` / `io` / `dev` / `app` 刻意不收——它们恰好是最常见的域名后缀。带空格的路径只在反引号里认：正文里没有边界能判断起止，宁可漏认也不误认。
  - **中文贴着路径也能认**：`修改src/core/ids.ts。` 里能准确捞出 `src/core/ids.ts`。按空白切词会把前面的汉字一起吃进路径，于是拼出一条不存在的绝对路径、点开就报「文件不存在」——所以只捞 ASCII 片段，汉字天然被当成分隔符，同一句里的多个路径也能一次捞出。
  - **只读，不动文件**：`revealFileInOS` 和编辑器打开都是只读操作，不移动、不改名、不重写被引用的文件。路径不存在时给一条提示（`文件不存在：…`），而不是静默什么都不发生。
  - 纯函数层是 `media/file-reference.js`（识别、行号拆分、相对→绝对、正文扫描），决策层是 `src/agent/fileReveal.ts`（平台映射、入参清洗），两者都不碰 DOM 和 vscode，可以单测。入参清洗挡掉空路径、`~` 开头的家目录写法和控制字符——正文里的路径是模型输出，不能直接喂给 `revealFileInOS`。
- 测试 404 → **431**：新增 `src/test/fileReference.test.ts`（16 条：常见写法、行号/列号/`#L` 区间、15 个「绝不能误认」的反例、网址主机名陷阱、带空格只在反引号里认、相对→绝对、无工作区根时不瞎拼、Windows 盘符、正文扫描的偏移与中文贴合）和 `src/test/fileReveal.test.ts`（11 条：平台映射、空路径与控制字符、不展开 `~`、行号只收正整数、带空格路径原样保留，以及 `isInsideWorkspace` 的 6 条——子路径算在内、前缀相似必须判在外、多根工作区、空根不当成 `/`、相对路径按 cwd 解析、Windows 大小写不敏感而 macOS 敏感）。
- 新增 `test/check-file-reference-dom.mjs`（**43 项断言**）：20 条接线断言 + 用真实段落代码配最小 DOM 跑行为——裸路径显示完整路径、版本号不长出引用、反引号显示相对路径与行号、左键发出 `openFileReference`、右键弹四项菜单、两项「显示」各发各的消息且互不误发、菜单点完自收、Windows 平台上两条文案必须能区分。运行 `node test/check-file-reference-dom.mjs`。

- **任务清单不再包含「推送」和「版本号更新」**。规则来自用户：「拆分任务的时候就排除掉，执行完任务再找用户单独确认推送和版本更新。」
  - 原因不是洁癖：清单一旦写上 `6. 提交并推送`，用户点「继续执行」时看到的就是这六条，而「点击继续」= 认可接下来要做的事——于是用户没说过的「推送」借清单拿到了授权。这不是模型故意夹带，而是「顺手把提交做完整」这种**合理扩写**，恰恰最不容易被用户逐条核对。
  - **两层实现，缺一层就会漏**。第一层是提示词（`TODO_LIST_PROMPT`）：拆分任务时就不写进去，并声明完成后单独征询；第二层是落库前的过滤（新增 `src/agent/todoScope.ts`），模型还是写了也要摘掉——一条漏网就够。
  - **识别刻意保守**：`实现消息推送` / `推送通知的开关` / `推送通知到用户设备` 是正常功能任务，绝不误摘；只有 `git push`、`推送到远端 / origin / 分支`、`推送代码到 origin` 这类**仓库动作**才命中。版本一侧还认「升到 0.2.4」这种只给数字的写法，但 `打包为 0.2.3 版本`、`修复版本号显示错误` 不算——那是构建和改文案，不是改号。
  - **不重复声明版本工具名单**：直接复用 `releasePolicy.versionBumpCommand`。两处各写一份工具表，迟早会在「新工具支持了吗」这个问题上分叉。写这个文件时还撞上过一次现成的教训：版本闸门会扫描写入内容里的工具名，第一版把工具名照抄进新模块，被自己拦下了——改成复用后既没有误判，也不再有两份口径。
  - **整份清单都是推送 / 版本号时不写空清单**：写空会把正在跑的清单连同进度一起清掉。这种情况返回 `success`（不是 `error`——模型没有调错工具，只是判断错了任务类型），并明确告知它把真正的实现步骤写进清单。
  - 摘掉的条目不是静默丢弃：工具返回正文里附带说明，要求模型**完成并验证后**单独用一句话征询，得到明确同意再执行。
- **「点击继续」的语义写进提示词**：它批准的是「接着做你已经要求过的事」，**不等于批准清单里的每一项**；清单是模型自己写的计划，不是用户批准过的记录。如果某条是模型自作主张加的（推送、升版本、发布、删数据、改历史），要当作自己的提议单独确认。
  - 这条规则在结构上本来就有支撑，现在补了单测钉住：授权判定只看用户文本，而「继续执行」按钮发出的是固定文案，其中不含推送 / 版本字样——所以点继续在运行时**根本不可能**授权推送或升版本，不需要靠模型自觉。
- 测试 393 → **404**：新增 `src/test/todoScope.test.ts`（11 条：推送六种写法、五种「推送通知」类不误摘、版本五种写法、四种构建类不算、拆分保序、已完成也摘、整份被摘为空、两条提示词规则、续跑文案不授予两类权限、用户原文仍放行）。
- 新增 `test/check-todo-scope.mjs`（**25 项断言**）：只管接线——保留部分是否重新绑定为 `todos`（杜绝误用未过滤清单）、过滤是否发生在写存档之前、整份被摘分支是否真的不写存档也不推空清单、四个文案键是否都在、提示词两条规则是否都在。运行 `node test/check-todo-scope.mjs`。
- **对话列表改为按「新建时间」排序**（新的在最上面）。`sortedSummaries()` 原来用 `b.updatedAt - a.updatedAt`，而 `updatedAt` 会随每条新消息、每次换模型、每次置顶变化——于是在一条旧对话里接着聊一句，它就窜到列表最上面，位置随使用不停跳动，每次找一条对话都要重新扫一遍。现在按 `createdAt` 倒序：每条对话的位置在它建好的那一刻就固定了，只有新建的才插到最上面。
  - 两个既有优先级原样保留：**归档的始终沉底、置顶的始终浮顶**；`createdAt` 撞车（同毫秒建两条）时退化为比 `updatedAt`，纯粹为了让结果稳定。
  - 侧边栏树（`historyView`）和面板内的列表都走 `storage.listConversations`，所以改排序函数一处即两边同时生效，不需要分别处理。
  - 顺带记一个容易踩的既有语义：`listConversations()` **不带参数时包含归档项**（过滤器在 `archived === undefined` 时直接放行），要排除必须显式传 `archived: false`。这次没有改动它（改了会影响其它调用方），但在测试里写清楚了，避免以后误判。
- 测试 309 → 313：新增「最新的对话排最前」「发消息 / 换模型都不重排」「置顶仍浮顶、归档仍沉底」「`createdAt` 顺序重启后不变」四条。
- **修复输入框内容串到别的对话**。根因是输入框是**面板级共享**的：`media/chat.js` 里 `promptInput.value` 全局只有一份，切换对话时只重置了 `autoFollow` / `expandedArchiveId` / `titleEditing`，**没有任何代码碰输入框**。于是在 A 里敲了半句没发、切到 B，那半句原样躺在 B 的输入框里，顺手一回车就发到了错的对话。服务端其实每次都清了 `pendingAttachments`（附件不串），唯独文字没人管。
  - 现在草稿按对话分开存：`state.drafts` 以对话 id 为键（还没落库的新对话用 `'draft'` 键），切走时 `saveDraft(previousConversationId)` 存下、切回来时 `restoreDraft(incoming.conversation?.id)` 贴回。草稿是**跟着对话走**的，切回去还在，不是简单清空。
  - **同一个对话的普通 `state` 刷新不能动输入框**：`sendState()` 会频繁推送状态，若无条件恢复草稿，用户每敲一个字就可能在推送时被覆盖。所以保存/恢复只在「对话 id 真的变了」时发生。
  - 发送后清空输入框的同时把草稿槽删掉（`saveDraft` 遇到空串即删键），不会残留空字符串把下次切回来弄成「看起来有草稿」。`openSelection` 注入的 `draft` 消息也写进草稿槽，切走再切回不丢。
  - 新增 `test/check-draft-isolation.mjs`（17 项断言）：把 `chat.js` 里 `case 'state': { ... }` 这一整块**原样抽出来**配最小 state 跑，而不是另写一份逻辑来测逻辑——那样改坏了 `chat.js` 照样全绿。覆盖切到 B 清空、A 的草稿入槽、切回 A 恢复、同 id 刷新不动输入框、新建对话空格、`draft` 槽往返、发送后删槽。这个脚本用 `git show HEAD:media/chat.js` 的旧版代码反向验证过：旧代码跑出来输入框仍是「A 里还没发出去的话」，确实复现了你报的现象。运行 `node test/check-draft-isolation.mjs`。

- 发布版本号推进到 **0.2.3**，构建产物为 `hwchat-0.2.3.vsix`。0.2.2 已发布，同一个版本号传不上去，所以这次修复以补丁号发出。
- **修复「面板区有滚动条却滚不动、内容被截断」**。上一条改动给 `.panel-stack` 加了 `max-height` + `overflow-y: auto`，但滚动实际上从未生效，根因是 **flex 把面板压扁了**：
  - 三个面板是 `.panel-stack` 的 flex 子项，默认 `flex-shrink: 1`；而 `.todo-panel` / `.task-tree` 都设了 `overflow: hidden`，按 Flexbox 规范这类子项的自动最小尺寸会归零，于是总高超过 `max-height` 时浏览器把面板**压缩**到刚好塞进容器；
  - 多出来的条目被面板自己的 `overflow: hidden` 裁掉，**容器因此从不溢出**，`overflow-y: auto` 不生成滚动条，滚轮也就没有滚动对象——看到的不是「滚走了」，而是「被裁掉了」，滚不回来。
  - 现在给 `.panel-stack > *` 加 `flex: 0 0 auto`，三个面板固定为内容高度，容器才真正溢出、滚动才生效。三个面板一视同仁，**归档清单和正在执行的清单都能滚**（它们共用同一个 `.todo-list` 样式，本来就没有单独的 `max-height`）。
- **滚动条改为常显**。macOS 的覆盖式滚动条不滚动就完全不可见，用户会以为「不能滚」——这也正是「明明有滚动却感觉没有」的直接原因。现在显式设置 `.panel-stack::-webkit-scrollbar`（10px 轨道 + 圆角滑块，悬停加深），滚动条常驻，同时兼作「下面还有内容」的提示。
- **面板区高度上限上调**：常规态 `min(38vh, 300px)` → `min(44vh, 360px)`；展开某份归档的聚焦态另给 `min(58vh, 470px)`——那时任务树和清单都被锁着只剩 28px 标题栏，有空间可用。按每条约 26px 计，常规态可容纳约 13 条、聚焦态约 17 条不再需要滚动（此前 10 条就会截断）。
- **不把清单内部做成独立滚动容器**：`.todo-list` 保持无 `max-height` / 无 `overflow`，全仓库只有一个滚动容器（`.panel-stack`），避免嵌套滚动（滚到底时滚轮先滚内层再滚外层、容易卡住）。
- 测试 276 → 278：新增「面板不许被 flex 压扁（断言 `flex: 0 0 auto` 存在、`.todo-list` 无 `max-height` 与 `overflow-y: auto|scroll`、`::-webkit-scrollbar` 存在）」「聚焦态上限必须高于常规态（按数值比较，不是硬编码）」，并把原来写死 `min(38vh, 300px)` 的断言改为 `min(44vh, 360px)`。运行 `npm test` 可复现。
- **回复正文里的「提醒」按危险程度分级显示**。此前所有提醒都长一个样，真正会造成损失的那条和一句普通说明埋在同一个视觉层级里，只能靠逐字阅读去分辨。现在分成三档：
  - **危险**：标题取红色（`--danger`），图标取亮黄色。
  - **重要但不危险**：标题保持正文色（不动），只有图标变橘黄色。
  - **其它**：完全不变，仍按原来的引用块渲染。
- **分级由显式标记决定，不猜语义**。语法是引用块首行写 `> [!DANGER] 短标题` 或 `> [!IMPORTANT] 短标题`，下面继续用 `>` 写说明。为什么不自动判断一段话危不危险：误判一次，红色警告就永久失去分量。`[!DANGER]` 与 `[!WARNING]` 同级（模型两种写法都常见），`[!IMPORTANT]` 单独一档；**没登记的标记（如 `[!NOTE]`）不识别、原样显示**——悄悄吞掉标记会让作者以为生效了。
  - 解析放进 `media/callout-meta.js`（纯函数，可单测），规则是「首行标记 + 同行短标题 + 其余为正文」，并去掉标记后那个空 `>` 行产生的多余留白；标记大小写与行首空格都容忍。
  - 只写标记不写标题时，用文案表的默认名（中文「危险」/「重要」，英文 Danger / Important），不会出现「一个图标下面空一片」。
  - `media/chat.js` 里造节点用 `calloutNode(plan, renderBody)`：正文渲染走回调而不是直接调 `appendRichText`，因为后者是递归函数，直接引用会让这段代码无法单独切出来跑。`callout-meta.js` 没加载成功时解析恒为 `null`，所有引用块退回原样——少一种样式好过让用户看到一堆方括号。
- **图标用 `warn`（三角 + 感叹号），颜色是唯一的分级差异**。亮黄取固定的 `#ffcc00` 而不是主题的警告色（主题那支通常是暗琥珀，和「亮黄」是两个观感）；但亮黄压在浅色背景上对比度只有约 1.6:1，几乎看不见，所以给危险图标加了一层 `0.7px` 的暗色投影当描边——深色主题下只是稍微收紧边缘。提醒块本身**不额外铺底色**，沿用引用块的引用线，分量来自红色标题而不是整块涂色。
- **系统提示词新增 `NOTICE_PROMPT`**（`src/agent/noticePrompt.ts`）：判定口径按用户定义收敛为「**极大破坏性 + 安全隐患 + 隐私泄露**」三类，只有这三类才配 `[!DANGER]`——(1) **破坏项目**：删除或覆盖源码、未提交改动、无法恢复的历史，或 force-push 已共享的提交；(2) **破坏磁盘与系统**：格式化或重新分区、往设备裸写字节、清空主目录、损坏 shell 与终端环境（rc 文件、`PATH`、`sudoers`、系统库、卸载关键组件）；(3) **凭据与隐私外泄**：打印或提交密码、私钥、API key、token、证书、`.env` 内容，或任何会让别人读到项目、取得项目控制权、进入这台机器的暴露。
- **给出一条可自检的反向排除，防止红色被滥用**：整条判定只问一句「事情发生后，用户还能不能把工作和机器原样拿回来？」能，就不是 `[!DANGER]`。临时文件/生成文件的删除、可逆改动、例行确认、普通代码改动一律是纯文本，**看起来再大也不标红**。上一版写的是「破坏性/不可逆操作、删数据」，太宽——删一个临时文件也满足「删数据」，结果就是满屏红字、红色彻底失去分量。`[!IMPORTANT]` 则被显式限定为「**不会造成上述任何损失**」的必知必做项，而不是「重要就标」。
- **测试护栏的方向是「提示词教的必须能渲染」**，而不是反过来：允许解析器多认几个别名（`WARNING`），但绝不允许提示词教一个渲染不出来的标记——后者会让 `[!XXX]` 原样显示成正文。
- 测试 313 → 326：新增 `src/test/calloutMeta.test.ts`（13 条，覆盖两种级别、未知标记返回 `null`、只有标记时的空标题、大小写与行首空格、空输入、`toneFor` 真值表、`WARNING` 作为 `DANGER` 别名、提示词与解析器的标记方向一致、提示词不许点名未识别的标记；另加 4 条钉住判定口径：三类破坏（项目/磁盘与系统/凭据外泄）必须被点到、凭据类型与「失去控制/被入侵」后果必须被点到、必须存在「能否原样恢复」的反向排除且点名排除临时文件与可逆改动、`IMPORTANT` 必须显式排除三类损失）。这 4 条用改写前的旧提示词实测会 10/10 全部缺失，确认不是空转。新增 `test/check-callout-dom.mjs`（30 项断言）：把 `chat.js` 里造图标与提醒块的代码原样切出来配最小 DOM 跑，验证 danger / important 的 `data-tone`、head 结构、图标真的产出 svg、无正文时不生成空容器、默认标题取自文案表；并直接读 `chat.css` 断言三条配色规则（危险标题红、危险图标亮黄、重要图标橘黄）与「重要标题必须 `inherit` 且不含 `--danger`」「提醒块不铺底色」，再断言 `callout-meta.js` 在 `chat.js` 之前注入。运行 `node test/check-callout-dom.mjs`。
- **用户自己把明文凭据贴进对话时，界面直接给出危险提醒**。这是「凭据外泄」这一类的第二个场景：前一个场景靠模型声明标记，但用户在对话里贴 API key 时，密钥**已经发出去了**——等模型在回复里提一句已经晚了，而且模型不一定会提。所以这一条不走模型，改由界面层在渲染用户消息时自己认。
  - 新增 `media/secret-scan.js`（纯函数，可单测）：识别有名的密钥格式（私钥头、AWS `AKIA`、GitHub `ghp_`、Anthropic `sk-ant-`、OpenAI `sk-`、Google `AIza`、Slack `xox`、JWT、`Bearer`）以及 `password: xxx` / `api_key = "xxx"` 这类显式赋值，返回 `{ kind, field, length, index }`。
  - **绝不回显凭据原文**：提醒里只写类型和字符数（如「检测到 Anthropic API 密钥（36 个字符）」）。提醒本身再把密钥打印一遍，就是在同一个已经泄漏风险的会话里做二次泄漏。这条有专门断言：把整棵 DOM 的文字拼起来，必须不含密钥原文，也不含其片段。
  - **占位符必须排除**：`sk-xxxx`、`your_api_key_here`、`<YOUR_TOKEN>`、`${DB_PASSWORD}`、`{{SECRET}}`、`changeme`、全同字符（`0000000000`）都不触发。教程与代码示例里全是这种写法，不排除的话问一句「怎么写配置」就满屏红框，红色很快就会变成狼来了。
  - **不做熵判断**：只认有名的格式与显式赋值，不靠「看着像随机字符串」判。加了熵判断会把 commit hash、base64 图片、依赖版本号全算成泄漏。有断言钉住 `commit 08c07c6f...`、`@openai/sdk 4.12.0`、`password 字段不能为空` 都不触发。
  - **纯数字弱密码仍然上报**（如 `1234567890`），只有全同字符才当填充值。这是刻意的取舍：它在示例里常见，但也可能是真实弱密码，漏报一条真密码的代价比多一次提示大。
  - 提醒复用已有的 `danger` 样式（红色标题 + 亮黄图标），因此不需要新增任何 CSS；位置在用户消息正文之后，顺序上对应「你说的话 → 系统的警告」。
  - 退化策略两条：`secret-scan.js` 没加载成功时返回 `null`（不显示提醒），扫描器自己抛异常时也返回 `null`（不拖垮消息渲染）。宁可少一条提示，也不要因为探测失败把每条消息标红。
- **提示词补上「凭据已经出现在对话里」这一情形**：`NOTICE_PROMPT` 原来只约束「不要打印/提交凭据」，属于事前；现在明确要求「只要凭据已经明文出现在对话的任何位置（用户贴的、文件里的、命令输出里的），开头就用 `[!DANGER]` 提醒立刻吊销并轮换」，并且**不许把值复述回去**——只说类型与字符数。理由是复述等于扩散，而这一条正好和界面侧的「不回显」对上。
- 测试 326 → 338：新增 `src/test/secretScan.test.ts`（11 条：11 种格式各一例、`sk-ant` 不被重复报成 OpenAI、结果里不含原文与片段、10 种占位符不触发、纯数字弱密码仍上报、赋值类报出字段名、有名格式优先于赋值规则、7 类不该误报的内容、短值不触发、按出现位置排序、`kinds()` 完整），并在 `calloutMeta.test.ts` 加 1 条钉住「对话里已经出现凭据时必须要求吊销且不许复述」。新增 `test/check-secret-warning.mjs`（25 项断言）：把 `chat.js` 里真实的 `secretWarningNode` 原样切出来配最小 DOM 跑，验证命中时是 `data-tone="danger"`、标题与图标正确、点名凭据类型与长度、**整棵 DOM 不含密钥原文与片段**、普通提问/空输入/占位符/commit hash 都不生成提醒、多命中合成一条列表、两条退化路径都返回 `null`，并断言「只在用户消息上调用」「`secret-scan.js` 必须早于 `chat.js` 注入」「每种类型都有文案」。运行 `node test/check-secret-warning.mjs`。
- **隐私泄露也算危险：用户输入里的身份证号、银行卡号、手机号同样触发危险提醒**。上一版只认「密钥类」凭据，但用户定义的判据是「泄漏后能造成实际损失」——卡号可盗刷、身份证可冒用、手机号可精准诈骗，和一把 API key 的性质一样。所以识别范围扩到两类，`scanSecrets` 的每条命中多带一个 `category`（`credential` / `privacy`）：
  - **靠结构校验而不是数位数**：身份证走 **mod 11 校验位 + 出生日期合法性**（`110101199003071233` 能认、`110101199003071235` 不认）；银行卡走 **Luhn**，全同数字单独排除（`0000000000000000` 也满足 Luhn）；手机号按 `1[3-9]` 号段。这样时间戳（`1759837200000`）、版本号（`4.12.0`）、20 位流水号、普通订单号都不会误报。
  - **类型不许报错**：18 位、前 6 位像省码、中间像合法日期但校验位算错的串，不再被银行卡规则收走报成「银行卡号」——类型报错比不报更误导人。
  - **两类分开成段给建议**：密钥要「吊销并轮换」，身份证/卡号「无法吊销、发出去就是永久的」，要挂失、留意盗刷。混成一张列表会让人照着「吊销密钥」的建议去处理身份证。标题随之分三档：只有凭据、只有隐私、两者都有。
  - 仍然**绝不回显号码原文**，只说类型与长度；`NOTICE_PROMPT` 的第 (3) 类与「已经出现在对话里」那一条同步补上个人隐私，并明确「隐私不能轮换，只说类型和长度，提示用户留意诈骗、必要时挂失或报警」。
  - 测试 338 → 344：`secretScan.test.ts` 加 6 条（三型隐私各自识别并带 `privacy` 分类、凭据类仍是 `credential`、身份证校验位错误不报且不被误报成银行卡、银行卡 Luhn 错误不报、6 类不该误报的内容、`kinds()` 含隐私类），`check-secret-warning.mjs` 25 → 42 项（身份证/银行卡/手机号各自生成 `danger` 提醒、标题走隐私文案、两类同时出现时标题说明两类都有且两段建议都在、**整棵 DOM 不含号码原文**、4 类不误报）。
- **命令卡住时 HWChat 必须通知用户，不能再无声转圈**。这是一次真实故障的修复，现场证据：Agent 执行 `cargo test --offline 2>&1 | tail -30`，卡片一直停在「准备运行命令」，30 分钟后实测测试进程只用了 **0.01 秒 CPU**（子进程 `qlmanage` 0.03 秒），3 秒两次采样 CPU 时间完全不变——它不是在跑，是彻底卡住了。原因有两条，叠在一起才变成「永远不动」：
  - **被测代码自己卡住**：那条 `cargo test` 里有个 macOS 用例对「按名字排序后的第一个 App」调 `qlmanage -t` 生成缩略图，`qlmanage` 在这台机器上不返回，测试线程就一直等。
  - **HWChat 的超时只杀掉了 shell**：`child.kill()` 作用于直接子进程（`sh`），`cargo`/`tail`/`qlmanage` 全部存活并被 init 收养（实测 `cargo` 的 PPID 变成 1）。它们仍攥着 stdout 管道，而代码只等 `'close'`——管道不关，这个 Promise 永不 resolve，工具调用与卡片就永久挂起。**顺带说明**：请求里的 `timeoutSeconds: 420` 从来没生效过，实际取 `min(设置值, 请求值)`，默认设置是 120 秒。
  - **三重结算，任何一条都能保证返回**：`'close'` 正常结束；`'exit'` 之后给 1.5 秒宽限（子进程退出 ≠ 管道关闭），等不到就按已拿到的输出结算；超时并 SIGKILL 之后再挂 3 秒硬结算，无条件返回。结算时主动 `destroy()` 掉 stdout/stderr，不留悬挂的读端。
  - **按进程组杀**：POSIX 下 `detached: true` 让 shell 成为新进程组组长，超时时 `process.kill(-pid)` 杀掉整组，`cargo`/`qlmanage` 这类孙进程不再变成孤儿。Windows 上退回 `child.kill()`（没有进程组语义），属于**已知降级**，已在代码注释里写明。
  - **stdin 接到 /dev/null**：需要密码或确认的命令（`sudo`、`ssh`、不带 `-m` 的提交命令）立刻读到 EOF 失败，而不是无限等待一个永远不会到来的输入。这也说明一件事——**HWChat 没有「把终端交给用户」的能力**，`sudo` 的密码框永远不会出现，只能改用无交互方式。
  - **运行中显示实时计时**：卡片按秒刷新「命令 · 已运行 12.3 秒」。此前耗时只在结束后才出现，于是「在算」和「卡死」在界面上长得一样。
  - **停滞检测 + 主动提醒**：超过 30 秒没有输出，卡片变成警示色并在正文写明「已 40 秒无输出，可能在等终端输入」，同时弹一条 toast。
  - **秒数每 10 秒刷新一次，不再冻住**：上一版 `stall` 只推一次，于是卡片左边「已运行 43.3 秒」在跳、右边「已 30 秒无输出」定格在 30，两个数字对不上，看着像界面又卡了。现在按 10 秒刷新（30 → 40 → 50…），既不刷屏也不撒谎。判定抽成纯函数 `shouldReportStall(idleSeconds, lastReportedIdle)`，才能在毫秒级单测里验证刷新节奏，而不是真等 40 秒写一条没有意义的静态断言。
  - **toast 仍只弹一次**（`stallToastSent` 把住）：卡片文字每次刷新，但弹窗重弹等于噪音，用户会学会无视它。文案同时补上超时上限——「到达 {timeout} 秒上限会自动终止」，让用户知道它什么时候会自己结束，而不是只有「点停止」一条出路。
  - 提示放在卡片正文而不只是 `summary` 的小字，是因为窄窗口下 `summary small` 会被媒体查询隐藏；pending 卡片默认展开，正文那一行在任何宽度下都看得见。
  - 测试 344 → 352：新增 `src/test/commandSettle.test.ts`（8 条，前 6 条全部是**真实起进程**的行为测试，不是静态断言）：孙进程继续攥着 stdout 时仍在宽限期内结算、正常命令返回退出码、超时按组杀掉并置 `timedOut`、`cat` 因 EOF 立即结束、运行期确实推送进度、进度回调抛错不影响命令；后 2 条用纯函数钉住停滞刷新节奏（30 秒首报、31/39 秒不重复、40 与 50 秒重新刷新、刷新间隔常量）。第一条已用修复前的实现反向验证过：同一场景 5 秒仍未结算（`still-hanging`），修复后约 1.5 秒返回。
  - 新增 `test/check-command-notify.mjs`（32 项断言）：把 `chat.js` 里真实的 `runningToolMeta` 原样切出来配假节点跑，验证运行中一定带秒数、停滞时一定带「可能在等终端输入」、拿不到开始时间不输出 `NaN`，并静态核对执行器的 detached / 负 PID / stdin / 宽限 / 硬结算 / 断开管道、进度回调接线、停滞刷新间隔、toast 只弹一次、toast 文案带超时上限、`stallHint` 落定后清除、CSS 与文案。运行 `node test/check-command-notify.mjs`。
  - **toast 显示时长按文字量算，不再一律 4.2 秒**：实测反馈是「弹了一次但消失太快，没看清」——提示确实弹了，但六十多个汉字的停滞提醒在 4.2 秒里读不完，等于没起作用。现在 `media/toast-timing.js` 按「阅读单位」算时长：中文一字算一、拉丁字符折 0.4（英文按词读快两三倍，不折算会得到两三倍过长的弹窗），每秒 6 单位，`neutral` / `warning` / `error` 下限 4 / 6 / 7 秒，封顶 20 秒。中文停滞提醒由 4.2 秒变成 **9.1 秒**，短提示（「标题已保存」）仍是 4 秒不变。另外 toast 现在**点一下就收起**，何时消掉由用户决定；模块读不到时退回原来的 4.2 秒，与改动前一致。
  - 测试 352 → 359：新增 `src/test/toastTiming.test.ts`（7 条）：长警告至少翻倍、短提示维持 4 秒、语气只抬下限（含未知语气不返回 `NaN`）、时长随文字量单调增长、封顶 20 秒、中文一字 / 拉丁 0.4 的折算、英文长警告不因字符数多而顶到上限。另新增 `test/check-toast-duration.mjs`（20 项）：加载真实的 `toast-timing.js` 直接调用，并核对 `chat.js` 读取模块、保留 4200 退化兜底、`hideToast` 会清掉待触发的定时器、点击关闭、`role="status"` 未被破坏、注入顺序早于 `chat.js`。

- **「需要你做的」清单里的 `[ ]` 方括号从根上修掉了**。用户反复反馈「又冒出来了」，而上一轮只是把它记成「改用户级 skill」的待办，**HWChat 自己的系统提示词里一个字都没有这条规则**——`src/agent/` 下只有 `todoPrompt` / `noticePrompt` / `commandPrompt` / `releasePolicy` 四个提示词模块。模型爱写 `1. [ ] **动作**`，渲染出来就是一串字面方括号，没有任何一层拦它。现在改成两层：
  - **提示词**：新增 `src/agent/followUpPrompt.ts`，接进 `agentSystemPrompt()`，排在对话历史摘要之前（不会被历史挤掉）。规则是「普通有序列表 `1. **动作**`，禁止 `[ ]` / `[x]` 复选框标记」，并说明为什么——面板会把方括号原样显示出来。
  - **渲染兜底**：新增 `media/follow-up-format.js`，`appendList` 在构造列表项时剥掉开头的复选框标记。提示词管「尽量别写」，这一层管「写了也不显示」，所以即使模型不听话，界面上也不会再出现方括号。
  - **只剥有序列表**：`- [ ]` / `* [x]` 是 GFM 合法的任务列表写法，模型用它表示「这是一份任务清单」时是有意义的，抽掉会丢信息；而 `1. [ ]` 这种「数字 + 方括号」在正常排版里没有语义，正是截图里那种情况。`[x]foo` 这种紧贴文字的也不算标记。剥离只作用于渲染，消息原文不变，复制按钮复制的仍是模型写的原文。
  - 模块读不到时原样显示，行为与改动前完全一致（`followUpFormat ? … : match[3]`）。
  - 测试 359 → 366：新增 `src/test/followUpFormat.test.ts`（7 条，用 vm 加载真实的 `media/follow-up-format.js`）：截图原样三种写法都能剥、无序任务列表不动、正文方括号与行内链接不动、`[x]foo` 不算标记、异常输入不抛错、提示词含禁写规则、提示词排在历史摘要之前、注入早于 `chat.js`。
  - 新增 `test/check-follow-up-format.mjs`（16 项）：**把 `chat.js` 里真实的 `appendList` 切出来配最小 DOM 跑一遍**，断言最终列表项文本里没有方括号——静态 grep 只能证明代码在，证明不了渲染结果。同时用「不挂载模块」的同一套代码验证退化行为，等价于改动前的实现。

- **粘贴或发送的附件现在可以点开查看**（粘贴错了能先核对再发）。此前附件只是一个缩略图或一行文件名，点不动，用户只能凭记忆判断「刚才粘的是不是那张图」。
  - **先分清两种附件，这决定了怎么打开**：从磁盘选的文件带 `path`，直接打开磁盘上那个文件本身；从剪贴板粘贴的图片/文本**从来没有落过盘**，只以 `dataBase64` / `content` 存在于内存里（`attachClipboardFiles` 全程不写文件）。所以「打开」对前者是只读引用，对后者必须先造出一份可显示的东西。
  - **有路径的一律打开原文件，不复制、不另存、不移动**：这是用户明确提过的约束。打开动作只调用 `vscode.open`（图片进图像预览、文本进编辑器），不写任何字节，原文件的位置和内容都不变。
  - **没有路径的文本开未命名文档**：`openTextDocument({ content })` 不落盘，也就谈不上影响任何文件位置。编辑后要保存时会走 VS Code 自己的另存流程，由用户决定存到哪。
  - **没有路径的图片派生一份内容寻址的副本**：图像查看器只能打开磁盘文件，所以副本写在扩展自己的 `globalStorage/attachment-cache/`，**不在用户工作区里**，项目目录不会凭空多出文件。文件名取内容的 sha256 前 32 位，同一张图点开多次只会命中同一个文件，不会堆重复截图。
  - **决策与 IO 分离**：`src/agent/attachmentOpen.ts` 是纯函数（`planAttachmentOpen` 返回 `path` / `text` / `image` / `unavailable` 四种动作），不 import vscode，因此可以直接单测「哪条分支被选中」，不需要启动编辑器。
  - **前端只回传标识，不回传内容**：`attachmentForWebview` 本来就会剥掉 `dataBase64`（避免几 MB 的图片常驻前端），所以点击时按 `id` 回传，由扩展用 `attachmentIndex` 取回完整附件。`id` 通过 `context.id ??= …` 写回源对象——不这样做的话每次重绘都会新增一条索引，旧条目永远命中不到，等于把整段历史的图片都留在内存里。索引另有 48 M 字符上限，超出按插入顺序逐出最旧的。
  - **删除按钮不会顺带打开附件**：删除按钮就在同一个 chip 里，点击处理里先 `closest('button')` 拦一道。这条最容易回归，所以 `check-attachment-open.mjs` 用真实 DOM 事件跑了一遍「点删除不打开、点容器才打开」。
  - **键盘可达**：附件带 `role="button"` 与 `tabIndex`，Enter / 空格都能打开。
  - 新增 `src/test/attachmentOpen.test.ts`（9 条，覆盖路径优先、粘贴图片、jpeg/png 扩展名回退、粘贴文本、正文已清理时退化、空白 path、空附件、内容寻址同名异名）与 `test/check-attachment-open.mjs`（27 项，把 `chat.js` 里真实的 `makeAttachmentOpenable` 切出来配最小 DOM 跑点击、键盘、删除按钮互斥，并交叉校验协议与接线）。

- **侧边栏对话卡片里的「运行中」改成蓝色**。此前「运行中 · 刚刚 · N tokens」整段都是同一个灰色（`--muted`），正在跑的那条和普通时间戳分不出来。现在把状态词单独包成一个节点（`.conversation-status.running`）用强调色 `--accent`，时间戳和 token 数保持原色——只给状态词上色，否则整行都染蓝就失去了「拎出重点」的意义。「等待授权」仍保持原色（这次没有要求改动，不夹带）。

- **修复任务树把不相关的任务标成「已合并」**。根因很具体：分类结论的解析写的是 `normalized.includes('RELATED')`，而 `UNRELATED` 里正好包含子串 `RELATED` —— 模型回答「不相关」，代码读出来却是「相关」，于是新任务被合并进当前分支。
  - 现在把解析抽成纯函数 `parseTaskRelation`，**先否后肯**：`UNRELATED` / `NOT RELATED` / `IRRELEVANT` 一律判为 `queued`，再看 `QUEUED`，最后才认 `RELATED`，都认不出时返回 `undefined` 交给关键词兜底（与原行为一致）。
  - **分类提示词同时收紧**：原来写着「requests about the same files or goal are RELATED」，而当前任务若是「继续执行任务清单」这类没有具体文件范围的通用任务，同项目里的任何新需求都会被判成相关。现在明确要求回答**一个词**、不许加否定，并写明「同一项目、同一批文件、同一技术栈都不足以算相关，换的是交付物就算 QUEUED」，来不及判断时答 QUEUED。
  - 新增 `src/test/taskRelation.test.ts`（5 条）：直白回答、四种否定形式（回归）、大小写标点、带解释的回复、认不出时返回 `undefined`。

- **通用「继续执行」指令只绑定暂停中的清单，且只生效一次**。上一条修的是「解析把不相关读成相关」，这一条修的是更上游的问题：续跑按钮发出的是一句固定文案「继续执行当前任务清单里尚未完成的条目…」，任务队列直接拿它当根标题，于是它成了「当前任务」。这句话没有交付物、没有文件范围，后面任何新需求拿去跟它比较都像「同一个目标」——即使分类器完全正常工作，也只会得出 related。用户看到的就是：清单还暂停着，新增一个不相干的需求，任务树里立刻显示「已合并」。
  - **续跑不再构成任务身份**：新增 `src/agent/resumeScope.ts`，`resolveResumeScope()` 在发送瞬间取出暂停清单的**未完成条目**，用它们当作这一轮的任务作用域；通用原文只留在消息气泡里。比较基准从「一句没有范围的话」变成「清单上真正要做的事」，新需求因此能被正确判成排队。
  - **没有暂停清单时不生效**：全部条目已完成、或对话上本来就没有清单时，`resumeScopeTitle()` 返回 `undefined`，退回消息原文当标题。通用指令不会凭空变成一个常驻的任务身份。
  - **「只生效一次」是结构上的，不靠状态记录**：绑定是发送瞬间对清单的一次快照，不写回任何字段；队列每轮新建，下一轮要么重新判定、要么就没有可绑定的清单。此外 `AgentTaskQueue` 记住续跑根节点的 id，一旦 `take()` 换到排队分支，续跑判定立刻变回 false —— 一个已经结束的续跑不会继续污染后续分支。
  - **按钮路径用显式标记，不靠文本猜测**：`resumeTodos()` 在调用 `send()` 之前就把 `todosInterrupted` / `todosIncomplete` 清掉了，发送时已无从判断，所以 `send()` 新增可选参数 `resumedTodos`，由按钮显式告知。手打或改写过的通用指令另有保守文本判定：必须带续跑语气（继续/接着/resume/continue…），且要么指向清单（清单/待办/未完成/进度…），要么是去掉客套话后什么都不剩的裸指令（「继续」「接着做」）。
  - **判定刻意保守**：带路径、代码片段或文件扩展名的消息一律不算通用续跑——「继续修复登录刷新并发问题」「接着改 src/views/chatPanel.ts」「继续把侧边栏改成蓝色」都保留自己的范围。误判成通用续跑会抹掉这条消息自己的范围，比漏判更糟。
  - **分类提示词加一条**：作用域来自续跑清单时，明确告知分类器「这是一份工作清单而不是单一交付物，说到不同交付物的消息一律 QUEUED」。
  - 新增 `src/test/resumeScope.test.ts`（11 条，直接读 `src/core/i18n.ts` 取官方中英文续跑文案来验证，避免测试里抄一份、以后和文案漂移）；`src/test/taskQueue.test.ts` 补 2 条（续跑标记只作用于根分支、换到排队分支后失效、普通队列从不声明续跑语义）。
  - 新增 `test/check-resume-scope.mjs`（23 项断言）：静态核对接线——模块导出、发送侧用清单作用域取代原文、按钮显式传标记、队列按当前节点判定、分类器接受并按需追加规则、旧的单参构造已不存在。

- 测试 366 → 393，校验脚本 11 → 13 个（新增 `check-attachment-open.mjs` / `check-resume-scope.mjs`）。

## 0.2.3

- **界面图标从「拿文字当图标」改成一套自绘的扁平 SVG**。此前状态标记直接写在代码里当字符用：`✓ ● ○ … ↳ − ! × ↗ ↺ □`，折叠箭头则用 CSS `content: "▸" / "▾"`。这三个问题都无法用 CSS 修掉：
  - 字形由系统字体决定——同样是 9px，Windows 的 `✓` 比 macOS 细一截，同一个 16px 徽标里有时顶到边、有时缩成一小点；
  - 基线不齐——这些字符的 ascent/descent 各不相同，`vertical-align` 要逐个调；
  - 字重不可控——想让勾粗一点只能加 `font-weight`，结果整个字符被拉宽；字体里没有的字符还会掉成方框。
  - 现在全部换成内联 SVG：形状、笔画、留白由规格决定，`currentColor` 跟随主题，与系统字体无关。
- **新增 `media/ui-icons.js`**：图标形状的唯一来源（纯函数，不碰 DOM，可单测）。规格是 16 格网格 + 四周 2 格安全区 + `currentColor` + 扁平（无渐变、无阴影、无滤镜）。当前 20 个图标：`check` `minus` `bang` `ellipsis` `dot` `ring` `turn` `square` `close` `arrowUpRight` `restore` `chevronRight` `chevronDown` `pencil` `bell` `pin` `bulb` `rocket` `search` `warn`，按语义命名而不是按形状命名（调用方说「这是成功」，不关心画成勾还是别的）。
- **描边宽度按「最小渲染尺寸」反推**，不是随手填的：最小一档是 10px（`.todo-status .ui-icon svg`），16 格网格上 2.0 的描边渲染出来是 `2/16×10 = 1.25px`，这是能看清的下限。白色对勾画在彩色圆底上要更重，单独提到 2.6（≈1.63px）；空心圆环 2.4（≈1.5px），和原来 12px 圆圈的 1.6px 边框基本一致，否则它会比旁边的勾明显发虚。
- **折叠箭头改成「一个遮罩 + 旋转」**：`::before` 用 `mask` 加载 `chevronRight` 的 data URI，展开时 `transform: rotate(90deg)`，不再在两套字符之间切换——字符切换会让箭头大小和中心点跳动。CSS 里这条路径和 `ui-icons.js` 是同一份（测试会比对 `d=` 字符串，防止两处各画一套）。`prefers-reduced-motion` 下旋转过渡也关掉。
- **`chat.js` 的 `statusSymbol` / `taskStatusSymbol` 换成图标节点**：`iconNode()` 用 `DOMParser` 以 `image/svg+xml` 解析后再 `importNode`（SVG 是外来命名空间，用 HTML 解析器容易走错分支）。**保留文字退路**：`ui-icons.js` 没加载成功或解析器报错时退回原来的字符——字形不好看总比徽标变成空白好。同时把会话行的操作按钮（继续 / 固定 / 归档 / 删除）和附件删除按钮也改成图标。
- **`ui-icons.js` 必须在 `chat.js` 之前注入**（`chat.js` 启动时就要读 `HWChatIcons`）；测试会检查 `<script>` 标签的先后顺序，而不是源码里的变量声明顺序。
- **不引入第三方图标库**：图形全部自绘，所以没有额外的许可与署名义务，也不存在上游改许可证的风险。
- 测试 278 → 291：新增 `src/test/uiIcons.test.ts`（13 条，覆盖同 viewBox、名字唯一、未知名字不抛错、只用 `currentColor`、无硬编码颜色、不引用外部资源、坐标不越出 16 格、实心元素必须 `stroke="none"`、描边宽度下限、CSS 与 JS 路径一致、`chat.css` 不再出现 `▸`/`▾` 字符、`chat.js` 已换图标且保留退路、`<script>` 注入顺序）。
- 新增 `test/check-icons-dom.mjs`（29 项断言）：把 `chat.js` 里那段图标代码原样切出来配最小 DOM 跑，验证每个图标名都真的产出了 `<svg>`、没有写成文字内容、脚本缺失与解析失败时正确退化。运行 `node test/check-icons-dom.mjs`。
- `test/check-panel-exclusivity.mjs` 补了图标桩与两条断言（执行中仍是三个跳动点、待办挂的是图标节点而不是字符），互斥与还原的全部断言保持通过。
- 新增 `test/preview-icons.html`：图标预览页（复用真实 `chat.css` 与 `ui-icons.js`），用浏览器打开即可肉眼核对各容器里的实际观感。
- **对话标题可以自己改**。标题栏右侧出现铅笔图标，点开后在原位变成一条带下划线的输入框（不是弹窗），右侧换成对勾与叉：对勾保存、叉放弃，Enter / Esc 等价于这两个按钮。标题上限 48 字符（与自动命名的截断长度一致，由 `maxlength` 挡住输入、`shortTitle` 兜底），空标题或没改动时只退出编辑、不发请求。
- **自定义标题不会被首条消息覆盖**。原来的自动命名靠「标题是否仍是『新对话』」判断，用户改完名字后若第一句还没发出，那句话会把他刚起的名字替换掉。现在新增 `titleCustomized` 标记（存档里持久化，归一化时只认严格的 `true`），改名后永久让位给用户的选择。
- **改名不算「对话有新活动」**：`setTitle` 不更新 `updatedAt`，否则历史列表的时序会因为「改了个名字」而跳动。
- **标题旁显示本次对话所属的项目**：已绑定到某个工作区文件夹时用橘黄色显示文件夹名（`--project`，优先取主题的图表橙）；绑定不上时用红色显示「项目待建立」。这个状态是真实的、必须让用户看见的——`projectRootFor` 返回 `undefined` 时相对路径会落到第一个根目录、且 git 写操作会被拒绝，显示一个猜出来的目录名会让人误以为已经绑定好了。首次写入文件（`bindProjectRoot`）后补推一次状态，徽标随即从红字变成橘黄。
  - 判定规则抽成纯函数 `chooseProjectRoot` / `projectNameOf`（`src/agent/workspacePaths.ts`），行为与原 `projectRootFor` 完全一致：存档绑定 → 当前编辑器所在项目 → 单根工作区的唯一根 → 否则未绑定。抽出来是为了能单测（原方法依赖 `vscode.window.activeTextEditor`）。
  - **项目标签的位置与样式**：从标题行下移到状态行（`.conversation-status-line`），与「准备就绪 · N 个工具」同处一行。早期版本用 `margin-left: auto` 把它推到右端，又套了圆角边框 + 半透明底色，看起来像个可点的徽标按钮；现在改成**纯文字 + 左对齐**：`margin: 0`，`padding` / `border` / `border-radius` 全部归零，`background: none`，紧跟状态文字右侧、中间固定隔 8px（整行 `justify-content: flex-start`）。两个信息在同一行上是连续的阅读流，中间不再隔着一大片空白。过窄时**先省略项目名**（`max-width: 55%` + `text-overflow: ellipsis`），状态文字因此至少保留 45% 宽度——和以前正好相反，以前是先砍状态文字。项目标签若有多个，同样从状态文字右侧按从左到右排列。`test/check-title-editing.mjs` 加了结构断言（读 `chatPanel.ts` 模板与 `chat.css`），锁住「标签在状态行」「纯文字无底色边框」「左对齐」「间距固定 8px」，防止以后调版式时把它挪回标题行或改回色块。
- **标题区腾出空间的控件收窄**：
  - 三个下拉框（Agent 模式 / AI 供应商 / AI 模型）去掉边框和底板，只留文字与下拉箭头；箭头用 `--chevron-down` 遮罩绘制（路径与 `ui-icons.js` 的 `chevronDown` 是同一份，测试比对 `d=`），到文字的间距由固定的 `padding-right: 19px` + `right: 5px` 决定，控件变宽变窄都不变。宽度同时收紧：模式 92→68px、供应商 96→84px、模型 132→118px。
  - skills 按钮从「星形图标 + 数量」的方形按键改成纯图标按钮（与刷新按钮同宽 30px）。数量没有丢：移到 `title` 与 `aria-label`（`选择 Skill · 3`），由新增的 `syncSkillsButton` 统一同步，勾选变化时也走同一个函数。
  - 已经是纯图标的按钮（刷新、设置、归档、导出、历史）没有改动。
  - **三个下拉框按内容定宽，谁也不吸收剩余宽度**：模型框原来是 `flex: 1 1 auto`，会把整行剩余宽度全部吸走——宽面板上它变成一个远宽于内容的空盒子，下拉箭头被推到右端、离文字很远。现在三个控件都是 `flex: 0 1 auto` + 固定宽度：模式 60px（`Agent` 5 字符 ≈ 30px + 内边距 25px ≈ 55px）、供应商 82px（`DeepSeek` 8 字符 ≈ 73px）、模型 150px（`DeepSeek-V4.1-Flash` 19 字符 ≈ 139px）。宽度是按等宽字体的字符宽算出来的，不是试出来的；保留 `flex-shrink: 1` 是为了极窄面板下先压窄控件，而不是硬溢出。
  - **控件行改成两端对齐（`justify-content: space-between`），并为此把分组包装去掉**：间距本来写的是 6px，但视觉上并不相等。原因有两层——`.connection-group` 曾是 `flex: 1 1 240px`，把剩余宽度吸进组内，在刷新按钮后面留下一大块空白；`.utility-group` 又有 `margin-left: auto`，把自己推到最右端。把这两个「自动空隙」取消后，间距确实只剩一个来源，但控件之间仍然**不均匀地分散**：用户要的是等间距的两端对齐。只加 `space-between` 不够——三个 `control-group` 还在时，剩余宽度只会在**组与组之间**分配，组内仍是固定的 `--control-gap`，于是又变成「组内 6px、组间一大段」的两种间距，只是换了个位置复现同一个问题。所以把模板里的三个包装层直接删掉：`chat.js` 从不引用这些分组类（已核对），八个控件因此都是 `.toolbar-controls` 的直接 flex 子项，剩余宽度被平均分到每两个相邻控件之间，任意相邻两个控件的距离恒等，首尾分别贴住左右两端。`gap` 仍然保留作**最小间距**兜底：控件几乎填满整行时靠它避免贴在一起。CSS 里 `.mode-group` / `.connection-group` / `.utility-group` / `.control-group` 四条规则与窄屏那条 `.connection-group { flex: 0 0 auto }` 一并删除，`test/preview-chat.html` 的头部结构同步扁平化。`test/check-title-editing.mjs` 的版式断言随之改写：锁住「控件行是 `space-between`」「CSS 里不再有分组规则」「`chatPanel.ts` 的控件行没有 `control-group` 包装」「间距只来自 `--control-gap`」「控件行没有 `margin-left: auto`」。
- 测试 292 → 305：新增「自定义标题带标记且不被后续消息覆盖」「改名不改 `updatedAt`」「空标题不清空」「48 字符上限」「标记重启后仍在」「首条消息仍能自动命名」「项目根判定 6 条」「徽标名取文件夹名且根目录视为无名」，并把箭头遮罩一致性测试扩展到 `chevronDown`。
- 新增 `test/check-title-editing.mjs`（59 项断言）：把 `renderProjectBadge` / `startTitleEdit` / `finishTitleEdit` / `syncSkillsButton` 原样抽出来配最小 DOM 跑，验证徽标的绑定与未绑定两态、编辑态的显示切换、确认/放弃/未改动/空标题四条路径、草稿不允许改名、以及 skills 数量挪到提示后仍然可读；末尾另有 23 条版式断言，直接读 `src/views/chatPanel.ts` 与 `media/chat.css`，锁住「徽标在状态行、不在标题行」「状态文字可省略」「项目标签是纯文字且左对齐」「三个下拉框按内容定宽且 flex-grow 为 0」「控件行是 `space-between` 两端对齐」「CSS 与模板里都没有 `control-group` 分组包装」「间距只来自 `--control-gap` 一个变量」。运行 `node test/check-title-editing.mjs`。

- **归档胶囊初始高度减少 1/3**（16px → 10.67px，即 `CAPSULE_BASE_HEIGHT = 16 * 2 / 3`）。宽高比仍是 3:1，所以宽度同步从 48px 变成 32px；圆角按高度 30% 走，从 5px 变成 3px。缩放下限 6px 不变——它是「再挤也要留住可点的方块」的底线，不是常规尺寸，跟着降会让胶囊变成一条看不清的线。`media/chat.css` 的三个兜底值（`--capsule-h` / `--capsule-w` / `--capsule-radius`）与 `min-height` 里的 16px 一并同步，避免脚本未运行时闪回旧尺寸。
  - `test/check-capsule-geometry.mjs` 改为**从 `media/chat.js` 直接读取三个常量**，并与 `media/chat.css` 的兜底值交叉比对。此前脚本自己复制了一份 `16 / 6 / 3`，改基准高度时脚本不会跟着变，「测试全绿」和「尺寸其实变了」可以同时成立，等于没有守住；现在两边不一致会直接报错。

- **任务清单顶栏新增「继续执行 / 取消任务」**（只在清单停在半路时出现：已中断、或模型收尾时漏了打勾）。此前中断只是一个只读标记，面板上没有任何恢复入口，用户只能自己再发一条消息。
  - 「继续执行」复用 `send()`，不另开执行通道：`requestMessages()` 是从存档重建上下文的，模型因此能看到自己写下的清单与中断前每一步的工具结果，天然能接着做；发出去的是专门的续跑指令（`todo.resumeInstruction`），并先用 `update_todos` 把下一项标成 `in_progress`。发之前先撤掉 `todosInterrupted` / `todosIncomplete`，面板不会一边真跑一边还挂着「已中断」。代价是消息区会多一条用户气泡——那是事实记录，不做隐藏，悄悄让模型动起来更难解释。
  - 「取消任务」清空清单、**不归档、不留胶囊**（`clearedTodoState()`：`todos` 与两个标记一起置空）。正在跑的时候**必须先停再清**：`send()` 的 `finally` 会做一次中断结算并回写清单，先清后停会把刚清掉的清单原样写回来。所以先 abort，再 `waitForRunToLeave()` 等这一轮真正退出（上限 8 秒，网络卡住也照样往下走——清空是用户的明确意图，不能因为一轮请求挂在半空就没反应）；那种极端情况下再点一次即可。
  - 判定抽成 `isResumableTodos()`：刻意不看有没有 `in_progress`（中断结算会把它降级成 `pending`），只认「还剩没打勾的项」。
  - **续跑没跑起来时必须把中断态补回来**。`resumeTodos()` 的顺序是「先清两个标记 → 再 `send()`」，可这一轮有几种情况根本不会真正跑起来：权限同意被拒、发送被 `pendingSends` 挡住、发送前就抛错。这些路径都不会走到 `settleTodosAfterRun`，于是没人把标记写回去，结果是**一份永远继续不了的清单**——按钮消失、状态还停在半路，用户只能自己再打一条消息。现在 `send()` 之后重新读一次存档：若仍有没打勾的项、且两个标记都是空的（说明结算确实没发生过），就恢复成 `interrupted`。判定依据是「结算过就一定会留下至少一个标记」，不靠猜哪条路径失败。
  - 两个按钮包在 `<summary>` 里，所以点击时显式 `preventDefault` + `stopPropagation`，否则会顺带把面板折叠掉。
- **顶栏三段（标题 / 状态 / 动作）改为固定宽度、各自左对齐**。此前的状态区是 `flex: 0 1 118px`，**能被压缩**：清单一切到中断态，状态文字一变长就把标题往左顶，字数变回去又把布局晃回来，看着很乱。现在：
  - 状态区 `flex: 0 0 132px`（不涨不缩），宽度按 9px 字号量过中英文最长的一条——中文「0/6 已完成 · 已中断，可继续」约 114px，英文归档行的「Archived · 12:34 · 6/6 done」约 115px，留余量防止字体渲染差异把它挤成省略号；
  - 标题与状态区的文字都 `text-align: left`，永远贴左起第一格；
  - 动作区用 `margin-left: auto` 贴最右。两个按钮宽度固定、且一起显隐，贴右不会产生跳动；
  - 任务树顶栏没有动作区，也不该有。
  - **英文状态文案同步缩短**：`interrupted, can be resumed` / `not finished, can be resumed` 会把状态区撑到 170px，整个顶栏都得为它让路；「可以继续」已经由右侧按钮本身表达，不必再写一遍，于是改回 `interrupted` / `not finished`。
- **助手输出里的 emoji 换成同一套扁平图标**。此前正文里的 `🔔 ✅ ⚠️` 是系统 emoji 字体画的：彩色、带立体高光、大小不一致，和这套单色扁平界面完全不是一回事，而且「扁平/单色」由 emoji 字体决定，CSS 改不动。现在 `ui-icons.js` 再多 7 个图形（`bell` `pin` `bulb` `rocket` `search` `warn`，共 20 个），`chat.js` 新增 `flattenEmojiIcons()` 在渲染后把正文里的 emoji 换成内联 SVG。
  - **在 DOM 上换、不在字符串上换**：正文里可能有代码块，`echo 🔔` 里的 emoji 是内容本身，字符串替换会把别人的代码改错。所以走文本节点，遇到 `<pre>` / `<code>` 直接跳过。
  - **只换登记过的 9 个**（`🔔 📌 💡 🚀 🔍 ⚠ ✅ ❌ 📝`），其余 emoji 原样保留——把用户自己打的 🎉 换成某个我们画的图形只会更奇怪。
  - **只对助手输出生效**（`message.role !== 'user'`）：用户打的 emoji 是他输入的内容，不该被改写。
  - 变体选择符 U+FE0F 先归一化：`⚠️` 与 `⚠` 是同一个符号的两种写法，不处理会漏掉一半。
  - 图标尺寸用 `1em` 而不是固定的 11px（14px 正文旁边挂 11px 图形会显得小一圈），`vertical-align: -.14em` 让 SVG 盒子随基线微微下沉，不至于浮在字上方。

- 测试 305 → 309：新增「可继续判定（中断 / 未完成 / 全完成 / 空清单）」「取消状态真的清空三项且不留归档」。新增 `test/check-todo-actions.mjs`（31 项断言）：把 `syncTodoSummaryActions` 与 `bindSummaryAction` 原样抽出来配最小 DOM 跑，验证按钮的显隐、点击发出 `resumeTodos` / `cancelTodos` 且不折叠面板，并静态核对模板（两个按钮在清单 `summary` 内、任务树顶栏没有）、后端（两个消息都被接住、取消走 `clearedTodoState`、落库前先等运行退出）、CSS（状态区 `flex: 0 0 132px`、动作区 `margin-left: auto`、文字左对齐）。末尾还有一条**宽度实算**：从 `src/core/i18n.ts` 读中英文状态文案，按 9px 字号算出最长一条，超过 132px 直接报错——文案被改长时状态区会静默截断，这种错误在截图上极难发现。运行 `node test/check-todo-actions.mjs`。
- `test/check-icons-dom.mjs` 从 43 项扩到 60 项：新增 emoji 映射表逐条校验（每一对都必须指向真实存在的图标）、变体选择符归一化、未登记 emoji 返回空，以及 `flattenEmojiIcons` 的实际行为（正文 emoji 换成图标节点、中文原样保留、`<code>` / `<pre>` 内不动）。
- `test/check-panel-exclusivity.mjs` 补上 `syncTodoSummaryActions` 与三个新元素的桩，并把胶囊常量改成从 `media/chat.js` 读取，不再在本文件里复制一份。

## 0.2.2

- 发布版本号定为 **0.2.2**，构建产物为 `hwchat-0.2.2.vsix`。本版把「面板互斥展开、归档胶囊配色与状态边框、任务清单唤起修复」和「命令块的位置/工具标注、列表内围栏不再漏成纯文本」合并为同一个发布。
- **同一时刻只展开一个面板（任务树 / 任务清单 / 归档快照）**：此前三个 `<details>` 可以同时展开，点开底下胶囊里那份归档清单时，上面的任务树和「正在执行的清单」还占着版面，内容一多就把输入框挤出窗口。现在：
  - 点开胶囊里的归档清单 → 任务树与当前任务清单自动收起并**锁住**（标题变暗、光标 `not-allowed`、点击给出提示而不是静默无反应），屏幕上只显示那一份清单；
  - 收起归档清单（点它自己的标题栏）或**再点一次同一颗胶囊** → 解锁，并**还原进入前的展开状态**（原来开着的会重新打开，原来收着的仍收着）；
  - 点另一颗胶囊 → 直接换过去，仍然只有一个面板展开；进入聚焦前的状态只记录一次，连续换胶囊不会把它覆盖成「都收着」；
  - 面板区套进 `.panel-stack`：`max-height: min(38vh, 300px)` + 内部滚动，输入框不会再被顶出窗口；胶囊栏留在容器外面，永远可见；
  - 切换对话时自动退出聚焦，避免上一份对话的锁带到新对话里。
- **归档胶囊改为「浅蓝 → 深蓝」连续渐变**，不再经过绿色：`#7cbef0` → `#1e4fd8`，按位置均匀取样（`archiveColorRatio`），所以相邻两颗之间的色差相等——看起来是一段过渡，而不是几块跳色。
- 互斥规则抽进 `media/todo-panel-state.js`（纯函数，不碰 DOM）：`planPanelToggle`（点击标题栏后的 `allowed` / `open` / `collapsePeers` / `exitArchiveFocus`）与 `nextArchiveFocus`（点同一颗收起、点另一颗换过去）；`shouldRevealTodoPanel` 增加 `archiveFocused` 入参——聚焦期间新到的一份清单不会被顶开。
- 测试 263 → 272。
- 新增 `test/check-panel-exclusivity.mjs`：把 `chat.js` 里相关函数原样抽出来配最小 DOM 跑一遍真实操作序列（22 项断言），验证「同一时刻只展开一个、收起后还原、锁住时点了不开」。运行 `node test/check-panel-exclusivity.mjs`。
- **任务清单胶囊改成纯色圆角矩形，并用边框指示状态**：胶囊里不再放任何图标或文字（去掉了原来的「归档匣」符号），也不再挂 `title` 悬停提示——鼠标停在上面不再弹出内容。形状从整圆胶囊（`border-radius: 999px`）改成圆角矩形，圆角按高度约 30% 计算（16px 高对 5px），缩到 6px 高时圆角同时收到 2px。颜色仍然由扩展按「越新越蓝」逐颗算好，点一下照旧展开那份归档快照。
  - **展开中的那颗显示红色边框**（`--danger`，2px），一眼能看出当前打开的是哪一份归档。
  - **鼠标悬停的那颗显示浅红色边框**（红色与白色混合，约 1.5px），只标明指针停在哪颗上，不改变胶囊本身的纯色（去掉了原来的 brightness 悬停效果）。
  - 边框用 `box-shadow: inset` 画而不是 `border`：不占布局，胶囊不会因为出现边框而变大或跳动；同时跟随 `border-radius`，也不会被归档条的 `overflow: hidden` 裁掉。`.active` 规则排在 `:hover` 之后，所以悬停不会把展开态的实红盖成浅红；键盘聚焦（`:focus-visible`）另用强调色内阴影，不影响鼠标操作的红色语义。
- **修复「新任务出现，任务清单没有唤起」**：`#todoPanel` 是 `<details>`，展开状态由浏览器记住，而 `chat.js` 只切换过 `hidden`、从来没设置过 `open`。所以上一份清单被收起后，新任务把清单发过来时面板依旧是收起的，看起来就像清单根本没出现。现在按「清单签名」（所有条目内容拼成的字符串，不看状态）区分两种情形：**换了一份新清单 → 自动展开**；同一份清单只是推进度 → 保持用户当前的收起状态，不反复把面板顶开。归档后再来一份内容相同的新清单也算新清单（归档时清单被清空，签名随之复位）。
- 清单签名与展开规则抽成 `media/todo-panel-state.js`（纯函数、不碰 DOM）：`todoSignature` / `shouldRevealTodoPanel` / `capsuleRadius`。由 `chatPanel` 在 `chat.js` **之前**注入；脚本没加载成功时 `chat.js` 退化为「永远不自动展开」，面板照旧能显示和点击。
- 新增 `TODO_LIST_PROMPT`（`src/agent/todoPrompt.ts`）并接入 system prompt：多步任务（不止一次工具调用或不止一个文件要改）必须先用 `update_todos` 列出完整计划，之后每完成一步再调一次，同一时刻只有一项 `in_progress`；**不能用清空清单或空数组表示完成**，要把整份清单带着全部 `completed` 发回来由界面归档；面板上已有被中断的清单时，用户要求继续就沿用它而不是另起一份。这样即便模型把「看似多步」判成一步，也有提示词层面的约束，而不是只靠工具描述里那句「任务只有一步时不要使用」。
- 胶囊的无障碍名称精简为「归档任务清单 {done}/{total} 完成」，不再拼进条目预览（预览已无悬停提示可显示）。
- 测试 254 → 263：新增 `src/test/todoPanelState.test.ts`（9 条：清单签名只看内容不看状态、空清单与脏输入返回空串、新清单自动展开、同一清单推进度不重复展开、归档后来同样内容仍算新清单、胶囊圆角显著小于整圆且最小值托底、`chat.js` 确实接上 `open` 且没有 `todo-capsule-mark` / `capsule.title`、`chat.css` 用 `--capsule-radius` 且不存在 `999px`、提示词三条关键约束）。
- **简介不再硬编码版本号与仓库地址**（方案 2）。Marketplace 详情页右侧的「版本」读 manifest、发布后立即更新，而描述正文来自 README、更新存在延迟，于是出现过「右侧显示 0.2.1、正文写着 0.2.0」的错位。现在两份 README 的简介只保留一句定位描述：版本号、仓库、许可证、问题链接全部由 `package.json` 提供，扩展视图与 Marketplace 会自动显示，打包时不再需要改 README。
- 安装与构建段落不再绑定具体版本号：安装命令改为安装项目根目录下最新的 VSIX（`$(ls -t hwchat-*.vsix | head -n 1)`），构建产物写作 `hwchat-<version>.vsix`。
- **命令不再漏成纯文本：列表里的代码块能正常渲染**。此前 `appendList` 把「缩进的续行」一律 trim 后拼进条目正文，再用 `appendInline` 渲染，于是写在列表项里的围栏（`- 打开窗口` / `  ```bash` / `  cd …`）整段被当成正文，屏幕上直接显示三连反引号——而这种「要你手动跑的命令」几乎总出现在列表里。现在缩进的围栏由 `collectFenceBlock` 整块收走，用占位符记住位置，渲染时按原顺序还原成 `<div class="code-block">`，前后的说明文字仍走原来的行内格式；没有代码块的条目完全走旧路径，渲染结果不变。
- **需要用户自己执行的命令会标出「位置」和「工具」，并可直接复制**。标题栏显示 `位置：本地终端` / `位置：服务器终端` / 自定义位置（如 `loc="GitHub Actions runner"`）与 `工具：bash`、`工具：cmd`、`工具：powershell`；服务器位置额外用警示色（`.is-remote`）区分，避免把远程命令贴进本地终端。复制按钮只复制命令本身，不含任何标注。围栏写法：```` ```bash loc=local tool=bash ````、```` ```sh loc=server tool=bash ````；未标注位置时退回旧行为，只显示工具。
- 围栏解析抽成 `media/code-block-meta.js`（纯函数、不碰 DOM）：`parseFenceInfo` / `normalizeLocation` / `collectFenceBlock` / `dedentCode` / `matchFenceStart` / `isShellLanguage`。由 `chatPanel` 在 `chat.js` **之前**注入，脚本没加载成功时 `chat.js` 退化为「只认语言」的旧行为，代码块照旧能渲染和复制。代码块还会去掉列表缩进（`dedentCode` 只删公共前缀，保留 YAML / Python 的相对层级），复制出去的命令不会带前导空格。
- `COMMAND_BLOCK_PROMPT`（`src/agent/commandPrompt.ts`）：要求模型把命令写成真正的围栏块、用 `loc=` 标明本地还是服务器、用 `tool=` 写明 cmd / powershell / bash / zsh，列表里缩进两格但围栏单独成行，且不得把位置说明或 `$` / `>` 提示符写进代码里。
- 测试 240 → 254：新增 `src/test/codeBlockMeta.test.ts`（14 条：语言-only 旧行为、位置/工具解析、引号内的自定义位置、`where` / `host` / `pwsh` 别名与未知键、本地与服务器的中英文写法、工具归一、围栏开头识别（含 4 个反引号）、列表内缩进围栏整块收集、流式未闭合、公共缩进去除且保留相对层级、提示词示例能被解析器认出、以及防止前端被改回旧写法的静态断言）。
- **修复「任务明明做完了，清单却显示已中断」**：结算发生在 `send()` 的 `finally` 里，而它只看清单是否全绿，**从不看这一轮是怎么结束的**，于是「模型漏了给最后一项打勾」和「用户点了停止 / 请求报错」被归成同一件事，一律标成「已中断，可继续」。现在按运行结局区分：`planTodoSettlement` 新增第 4 个参数 `outcome`（`completed` / `stopped` / `failed`），正常跑完却还有没打勾的项 → `action: 'incomplete'`，界面标「**未完成**，可继续」（中性色，不用警告黄）；被停止或报错才标「已中断」。运行结局由 `send()` 里的 `runOutcome` 记录：Agent 循环正常返回后置 `completed`，`catch` 里按 `cancelled` 置 `stopped` 或 `failed`。
- 存档新增 `todosIncomplete` 字段，与 `todosInterrupted` **互斥**：置任一标记都会清掉另一个；`sanitizeSummary` 在存档里两个同时为真时按「已中断」算，避免面板同时挂两个标签、也避免出现互相矛盾的存档。换新清单、归档时两个标记一起清空。
- **引擎刻意不替模型打勾**：遗留的 `in_progress` 只降级成 `pending`，绝不自动改成 `completed`——清单是模型对「做完了没」的陈述，引擎代打勾等于伪造进度。真正的预防放在提示词：`TODO_LIST_PROMPT` 增加硬规则，要求**结束本轮前再读一遍清单**，某项工作已经完成并验证过却还标着 `in_progress` 时必须补一次 `update_todos` 把它置为 `completed`（**包括最后一项**）；确实没做完则留成 `pending` 并在正文里说明。
- 测试 272 → 276：新增「正常跑完却没全打勾 → `incomplete` 且遗留项只降级成 `pending`、不谎报 `completed`」「正常跑完全绿仍归档」「失败与停止都算 `interrupt`」「没有清单时任何结局都 `none`」，以及存档层「两个标记互斥（双向）+ 重启后仍在」「存档里两个标记同时为真时按已中断算」。运行 `npm test` 可复现。

## 0.2.1

- 发布版本号定为 **0.2.1**（沿用 0.2.x 补丁号），构建产物为 `hwchat-0.2.1.vsix`。本版把「任务清单归档胶囊 / 多线程对话」与「git、项目、版本三条边界 + 每条对话独立设置」合并为同一个发布。
- **版本号也不再主动升级，改为「任务完成后询问」**（用户规则第 4 条）。以前模型很容易把「顺手把版本号也改了」当成收尾步骤，而没有任何一处区分「用户要升版本」和「模型自己想升」。现在：
  - 提示词硬规则（`VERSION_RULE_PROMPT`，`src/agent/releasePolicy.ts`）：不得自行改动版本清单里的 `version` 字段，不得跑 `npm version` / `yarn version` / `cargo set-version` / `standard-version`，不得打 tag。需要升版本或提交时，**只在这两个时刻**问一次——短任务：本轮对话里提到的所有问题都做完、验证过之后；长任务：明确的阶段边界或整个任务做完之后。任务进行中不问，得到明确同意之前不动版本与 git。
  - 运行时闸门 `ToolExecutor` + `releasePolicy`：`write_file` / `replace_in_file` 在落盘前比较版本清单里**项目自身**的 `version` 字段，变了就拒绝并提示「先去问用户」；`run_command` 识别 `npm version` 一类升版本命令并拒绝；桥接的 VS Code 工具用 `argumentsMentionVersionBump()` 检查 JSON 参数，换个通道也绕不过去。只读查询（`npm --version`、`git tag -l`）始终放行。
  - 只认项目级版本号，不做粗粒度文本匹配：`package-lock.json` 里依赖的版本变化、`Cargo.toml` 依赖表里的 `version = "1.0"` 都不会被误判；清单解析失败（例如文件被写坏）时**不拦**，宁可放过也不打断正常的文件修复。支持 JSON / TOML / YAML / MSBuild / Info.plist 五类清单。
  - 授权口径与 git 一致：用户本轮明确要求（`不要升版本` 这类否定写法排除）或已启用技能规则要求，二者之一即放行。
- 测试 216 → 240：新增 `src/test/releasePolicy.test.ts`（20 条：五类清单的版本提取、新建文件不算升版本、依赖版本不被误判、解析失败不拦、升版本命令识别与 `npm --version` / `echo` / 提交说明不误杀、命令链与 npx 包装、桥接参数、中英文意图与否定写法、技能规则、提示词是否同时写明「不主动升版本」与两种询问时机），以及 `src/test/toolExecutorVersion.test.ts`（4 条端到端：未授权时版本改动被拒绝**且文件保持原样**、授权后正常写入、普通字段与非清单文件不受影响、`npm version` 被拒而 `npm --version` 放行）。
- **HWChat 不再主动提交 git**。以前「收尾顺手提交」完全靠模型自觉，而默认预设 `review` 会把 `git add` / `git commit` 判成「正常命令」直接放行，于是模型把提交当收尾步骤时既没人拦、也不弹审批。现在有两道保证：
  - 提示词里写成硬规则：除非用户在本轮明确要求，或已启用技能的规则要求「完成后提交」，否则不得执行任何 git 写操作（`git add / commit / push / tag / reset / clean / merge / rebase / checkout / restore / stash`）；只读检查（`status / diff / log / show`）始终允许。
  - 运行时闸门 `src/agent/conversationScope.ts` + `ToolExecutor.gitWriteBlockReason()`：每次 `run_command` 都解析命令里的 git 子命令，未获授权直接拒绝并给出可执行的下一步，**不再依赖模型是否遵守提示词**。授权来源只有两个——用户本轮消息里的明确要求（含「不要提交」这类否定写法的排除），或已启用技能正文里的提交规则（技能正文是说明文字，用宽松匹配识别）。
- 桥接通道同样受控：VS Code 侧工具（如 `run_in_terminal`）的授权委托给 VS Code，模型换个通道就能绕过原生闸门。现在对桥接工具的 JSON 参数做递归检查（`argumentsMentionGitWrite()`），未授权时直接拒绝，两条通道口径一致。
- **git 只作用于本次对话的项目**。修复一条真实危险路径：`run_command` 的 `cwd` 默认值是 `'.'`，在多根工作区里会解析到**第一个**工作区根目录（本项目 19 个根里排第一的是另一个项目），于是「提交一下」可能提交掉完全无关的项目，而且不弹审批。现在：
  - `ConversationSummary` 新增 `projectRoot`，首次写入文件或显式指定 `cwd` 时绑定（`resolveWorkspacePath` 新增 `preferredRoot`，`'.'` 直接解析成该项目根，多根同名文件优先取项目内的那一份，新文件也在项目里创建）。
  - git 写操作前用 `git rev-parse --show-toplevel` 取真实仓库根，要求它与项目根一致（或项目根在某个工作区根之内）；**仓库根若还罩着另一个工作区项目，也拒绝**——否则一次 `git add -A` 会把别的项目改动一起收进去。
  - 项目根尚未绑定时，git 写操作只接受**显式 `cwd`**，绝不把「默认落到第一个根」当成项目归属。
- **每条对话的运行时设置互不污染**（多线程对话的前提）。以前权限预设 / 最大步骤 / 思考深度 / 模型全部写进 `hwchat.*` 全局设置：在对话 A 把预设调成「完全访问」，正在后台跑的对话 B 会立刻跟着放宽；对话 B 把步骤数改成 8，正在跑的 A 下一轮就被截断。现在这三项 + 模型都归属对话（`ConversationSummary.permissionPreset / agentMaxSteps / reasoningEffort / model`），采用与模式一致的优先级：**对话存档值 → 工具条草稿选择 → 全局默认值**（`src/core/conversationControls.ts`）。全局设置只作为新对话的默认值，面板上的改动写回当前对话。
- 存档侧同样做了脏值防御：`normalizeStored*` + `sanitizeSummary()` 在载入时把非法枚举、非数字步骤、非字符串项目根一律丢掉（回落到全局默认），而不是带着脏值去猜；`agentMaxSteps` 保留 `0 = 不限步` 的语义，字符串 `'99'` 不会被当成 99 或「不限」。
- 测试 189 → 216：新增 `conversationScope.test.ts`（13 条：写的识别、读子命令不误判、`git -C` / 全局选项、命令链拆分、`echo "git commit"` 不误杀、混合子命令按参数分类、中英文意图与否定写法、技能规则授权、桥接 JSON 参数检测）、`conversationControls.test.ts`（6 条：默认继承、对话值优先且不反向污染全局、非法预设回落、步骤 0 与脏值、思考深度回落而非变成 `default`、枚举校验）、`workspacePaths.test.ts` 新增 5 条 `preferredRoot` 用例、storage 新增 2 条（项目根与三项设置随 manifest 持久化且不影响其他对话；非法值载入时丢弃）。
- **中断的清单（停止 / 失败 / 关窗口）改成「保守待办」显示**，不再出现「什么都没在跑、界面却一直跳执行中」的假象。运行结束的结算收敛到一个纯函数 `planTodoSettlement()`（`src/core/todoArchives.ts`）：全部完成 → 归档成胶囊；否则 → 清单留在面板上，把 `in_progress` 降级成 `pending` 并记 `todosInterrupted: true`。`send()` 的 `finally` 对成功 / 失败 / 停止走同一条路径，所以模型报错、网络中断、用户点停止的处理完全一致。
- 关窗口 / 进程被杀时 `finally` 不一定会跑到：`sendState()` 读清单时补一次归位（`viewTodos()`），把存档里残留的 `in_progress` 降级成待办，重开面板不会再有假跳动。
- 用户**接着做**：模型沿用原清单、把当前项改回 `in_progress`，全绿后照常归档；用户**换新任务**：新清单整体覆盖旧清单（`updateTodos()` 同时清掉中断标记），旧清单不保留、也不进归档。`update_todos` 的工具说明补上这条约定，让模型知道要沿用被中断的清单。
- `ConversationSummary` 新增 `todosInterrupted`，随 manifest 落库；读盘只认严格 `true`，老存档没有该字段按「未中断」处理，被改坏的值（如字符串）在载入时丢弃且不影响清单本身。
- 界面：折叠框标题在中断时显示「{done}/{total} 已完成 · 已中断，可继续」，边框转警示色；条目本身仍是「等待执行」的绿色空心圆圈，不新增第四种状态。
- 测试 181 → 189：`planTodoSettlement` 三条（全绿归档 / 失败降级且条目顺序不丢 / 无清单不处置）、`settleInterruptedTodos` 三条（降级、无执行中不改动、空输入）、storage 两条（中断标记持久化并可清空、manifest 里非布尔标记载入时丢弃）。
- **任务清单自动归档成胶囊**。清单里每一步都是 `completed` 时，运行结束（`send()` 的 `finally`）会把这份清单从面板上收走、压成输入框上方一颗纯色胶囊；「任务清单」折叠框随之消失，直到模型再次调用 `update_todos` 开始一份新清单才重新出现。中途被停止 / 报错 / 还有 `pending` / `in_progress` 的清单**不归档**——半成品留在面板上可见，不会被藏进胶囊里。模型在一轮里开第二份清单时，已全部完成的上一份会先归档再写新的，两步合并成一次落库（避免面板闪过一帧空清单）。
- 归档的存储与兼容：`ConversationSummary` 新增 `todoArchives`（`{ id, createdAt, todos }[]`），随 manifest 落库；单对话上限 12 份（`MAX_TODO_ARCHIVES`），超出丢最早的一条。读盘时统一过 `normalizeTodoArchives()`：整体不是数组、单条 `todos` 不是数组、条目为空、时间戳非法都不会把面板打崩（时间戳非法按 0 处理，保持排序稳定）。
- 胶囊的视觉规则按需求实现：**宽高比恒为 3:1**，初始高度 16px（宽 48px）；**永不换行**（`flex-wrap: nowrap` + `overflow: hidden`）；胶囊变多或面板变窄时**宽高一起缩小**，脚本按可用宽度反解高度（`总宽 = n×3h + (n−1)×gap`，`gap = max(2px, 0.25h)`，缩到 6px 高为止），缩到 11px 以下自动隐藏胶囊里的归档图标，只留纯色形状。尺寸算法有独立校验脚本 `test/check-capsule-geometry.mjs`（846/700/620/500/400/320/240px × 1/2/3/5/8/12 颗的笛卡尔组合，断言 3:1、高度不越界、除触底外都放得下）。
- 胶囊配色：按归档顺序在 **绿 → 浅蓝 → 深蓝** 之间插值（`#2ea043` / `#4aa8e0` / `#1e4fd8`），最早的在左、最新的在右，每颗都是纯色；只有一条时取绿色起点。颜色由扩展算（`archiveColorHex(archiveColorRatio(index, total))`）后随 `todoArchives` 下发，脚本只负责画，避免前后端各写一套色表。点胶囊展开/收起那份历史清单（展开时清单标题写「已归档任务清单」、汇总带归档时间、边框改虚线），再点一次收起。
- **多线程对话**：运行状态从「面板上一个 `activeAbortController`」改成按对话保存的 `Map<conversationId, ConversationRun>`（各自持 controller / 任务队列 / 响应快照 / 步骤边界 / 检查点链）。因此**对话进行中也能点「新建对话」、也能点别的历史记录**——原来这两处直接 `toast` 拦下（`notice.agentBusyNewChat` / `notice.agentBusySwitch`），现在一律放行，被切走的对话继续在后台跑，切回来看得到实时输出。
- 多线程的边界收窄：停止按钮只停**当前显示**的那条线程；`stop` / `归档` / `删除` 只拦同一条对话；模型 / 模式 / 技能 / 权限预设这些控件只在这条对话自己忙（跑着或在准备发送）时禁用，不再因为「另一条对话在跑」而全盘锁死。`sendPending` 布尔量换成按对话计的 `pendingSends` 集合。
- 多线程的消息隔离：`taskTreeChanged` 全部带上 `conversationId`，面板按当前对话过滤（此前后台对话的任务树会渲染到正在看的对话上）；`streamIdle` / `messageStart` 也做了对话判定；历史列表新增「运行中」蓝点与「等待授权」黄点，并显示 `运行中 · …` / `等待授权 · …` 前缀。后台线程结束时只推一份轻量 `history` 快照更新列表，不动当前对话的滚动位置（`sendState()` 会重建消息区并把滚动拉到底）。
- **工具授权不再弹模态框**。`requestToolApproval()` 原来是 `showWarningMessage({ modal: true })`：模态框会锁住整个 VS Code 窗口，Agent 一停下来等授权，连侧边栏边框都拖不动、别的对话也点不了——这正是「对话时无法拖动边框唤起侧边栏」的直接原因。现在改成输入框上方一张**面板内卡片**（标题 / 摘要 / 可折叠详情 / 拒绝 / 允许一次），窗口完全不被占用。等待授权时若用户正看着别的对话，会提示「有对话正在等待你的授权」，切回去就能看到卡片；任务被停止或结束时该请求立即按「拒绝」结算（监听 run 的 `AbortSignal`），不会让那条线程的 `finally` 永远等下去。只有在面板视图已被销毁（`this.view` 不存在）时才退回**非模态**通知，不再使用 `modal: true`。点已失效的旧卡片会提示「这次授权请求已失效」。
- 测试 174 → 181：新增 `src/test/todoArchives.test.ts`（6 条：完成判定、未完成不归档、追加+上限裁剪、配色锚点与越界夹取、脏数据归一化），以及 storage 两条回归（归档随对话落库并能整体清空；manifest 里被改坏的归档条目在载入时丢弃且不影响对话本身）。
- 新增 `test/preview-todo-archive.html`（胶囊栏窄/宽两档 + 审批卡片 + 已归档清单的静态对照页）与 `test/check-capsule-geometry.mjs`（胶囊几何断言，可直接 `node` 跑）。

## 0.2.0

- 发布版本号提升到 **0.2.0**，构建产物为 `hwchat-0.2.0.vsix`。次版本号递增而不是补丁号，因为这个包改变了运行时行为（模式的取值来源与工具集都变了），不是纯文案/样式变更。
- 修复「HWChat 不认自己在界面里设置的工作模式」。根因有两处，都在 `ChatPanel`：`activeMode` 被写死成 `'agent'`，只在 `newChat()` / 切换会话时才去读一次 `hwchat.defaultMode`；而 `sendState()` 又用 `conversation?.mode ?? this.activeMode` 推给界面。于是面板首次打开（以及设置页改了默认模式、窗口重载后再打开视图）显示和实际执行都还是 Agent——界面明明选了 Plan/Chat，发的却是 Agent 那一套工具与提示词。现在模式的取值收敛到 `src/core/modes.ts`：`resolveActiveMode()` 定义优先级（存档模式 → 工具条里的草稿选择 → `hwchat.defaultMode` → `agent`），`sendState` / `send` / `setMode` 四处都调用它，`resolveConversationMode()` 负责单值校验，非法值不再可能悄悄落进 Agent 分支。
- 工具条切换模式不再可能「显示新值、实际按旧值跑」：`setMode()` 在任务执行中不再静默 `return`，而是把真正生效的模式回推给界面并提示「当前任务还在执行，模式改动没有生效」；没有落库对话时的选择记为草稿模式，随新对话一起落库。
- `createConversation()` 新增 `mode` 参数（默认仍是 `agent`），新对话在建库那一刻就带上正确模式，不再先写 Agent 等 `send()` 事后纠正——任何在建库与发送之间读摘要的路径都不会看到错的值。
- 系统提示词里的模式说明改由 `modePromptInstruction()` 统一生成，明确写出当前模式名（与下拉文案 Agent / Plan / Chat 完全一致），并声明「以本轮为准、不要沿用历史消息里的模式假设」；此前只有一句 "You are in X mode"，同一对话里跨模式发消息时模型容易沿用旧假设。
- 状态栏的可用工具数按当前模式统计（`toolExecutor.definitions(mode)`）；Chat 模式本轮不下发任何工具，工具数固定为 0，不再显示一个根本调不到的数量。
- 新增 `src/test/modes.test.ts`（7 条，含「存档 > 草稿选择 > 设置默认值 > agent」的优先级用例）与 `createConversation` 模式落库、`hwchat.defaultMode` 非法值回落两条回归，测试 165 → 174。

## 0.1.9

- 发布版本号提升到 0.1.9，用于重新出包上传。代码内容与 0.1.8 一致（中英文界面切换、可折叠任务清单等特性见下方 0.1.8 一节），本次只有版本号与文档变化。
- 修正 `package-lock.json` 里滞后三个版本的 `version` 字段：它一直停在 `0.1.5`，与 `package.json` 不符。锁文件不参与打包（`.vscodeignore` 已排除），但版本号对不上会让后续 `npm version` 或依赖审计误判。现在两处都是 `0.1.9`。
- README 截图改为「输入框不显示任何文字」的空界面。此前截图把预览页模拟粘贴的示例文字留在了输入框里，根因是 `docs/screenshots/build.mjs` 清空输入框时依赖一条中间产物（先把「混合剪贴板文字」译成英文、再按英文清空），而预览页的样例文案后来改成了「宿主剪贴板文字」——两条替换同时静默失效，脚本只打印“未命中”就继续出图。现在改为按结构清空：模拟粘贴携带的 `clipboardData` 与剪贴板回读两处都清，占位提示（`chat.promptPlaceholder*`）也在生成截图页时从词表置空。
- `docs/screenshots/build.mjs` 新增渲染后断言：画面不能残留任何中文（同时检查 `innerText`、表单 `value` 与 `placeholder`——`<textarea>` 的 `textContent` 不等于 `value`，只扫文本节点会漏掉输入框），且输入框的值与占位提示都必须为空。两条断言都用反向对照验证过：注入中文会被中文探针拦住，注入英文会被空输入框断言拦住。
- 两份 README 的「当前版本」、安装示例与构建产物名同步为 `0.1.9` / `hwchat-0.1.9.vsix`。

## 0.1.8

- Agent 执行期间的停止按钮改为红色高亮 + 呼吸光环，并把 `stop` 图标从描边方块改成实心方块（描边方块配红底之后线条与底色几乎同色，反而看不见）。底色没有直接用 `var(--danger)`：深色主题的 `errorForeground` 通常是浅红（如 `#ff6961`），白字压上去对比度只有 2.3:1。改用固定 `#d32f2f`，两种主题实测都是 4.98:1（图标/文字）与亮色 4.98:1、暗色 3.12:1（按钮 vs 输入框底色，UI 元素要求 ≥3:1）；光晕仍取主题的 `--danger`。按钮本身只在 `state.streaming` 时取消 `hidden`，所以高亮天然只在“正在跑”时出现，`prefers-reduced-motion: reduce` 下不播放动画。
- 回复正文从“整段纯文本 + 代码块”升级为真正的结构化排版，面向不写代码的读者：`appendRichText` 现在按块解析标题（`#` ~ `######`）、有序/无序列表（按缩进嵌套，序号沿用原文写的数字）、表格（表头 + `|---|` 分隔行，含 `:---:` 对齐）、引用（`>`）、分隔线（`---` / `***` / `___`），行内新增 `~~删除线~~` 与 `[文字](链接)`——后者只有目标以 `http(s)://`、`mailto:`、`#` 或 `/` 开头才会被当成链接，`[文字](javascript:…)` 之类保持原文，免得渲染出半个链接加一个多余的右括号。代码块抽成 `codeBlockNode`，终端命令与普通代码继续区分配色。全程 DOM + `textContent` 构造，模型输出里的尖括号不会变成标签。表格外加 `.table-wrap` 横向滚动，避免 420px 侧栏里把正文撑破。`test/preview-chat.html` 的示例消息换成含标题/嵌套列表/表格/引用/分隔线的文本，可直接当排版回归样本。
- 思考过程与回答走同一套 Markdown 排版：`renderReasoning` 也调用 `appendRichText`，所以思考里的标题、列表、引用、表格都会渲染成结构，而不是一整段等宽文字。思考过程默认折叠（`<details>`，`data-default-open="0"`），折叠标题上直接写状态——流式中显示「正在思考…」，结束后显示「N 字 · 点开查看」——不点开也能判断值不值得看。展开/收起状态在流式重渲染时会被保留（沿用已有的 `data-detail-key` 机制），展开后内容区限高 360px 内滚动，不会把正文挤到屏幕外。三角标记是自绘的（`summary` 改成 flex 之后浏览器自带的标记会消失）。行内新增 `*斜体*`；只认单个星号、不认 `_斜体_`，所以 `a_b_c` 这类变量名不会被吃掉，`2 * 3 * 4` 也不会被当成斜体。
- 正文可读性：`.message-content` 行高提到 1.7，并补齐 h1–h6 的字号/间距（h1 带下边框）、列表缩进与 `::marker` 灰色标记、嵌套列表收窄到 18px、表格斑马纹与浅底色表头、引用左侧强调线。思考过程复用同一套结构但整体压到 12px，避免抢正文。
- 执行过程措辞改为面向非技术读者：`N 个执行步骤 · 修改 M 个文件` → `处理过程 · 共 N 步，改动 M 个文件`，工具详情标题 `输入` / `结果` → `提交内容` / `返回结果`，等待态 `等待执行结果。` → `正在等待结果…`。
- 输入框右下角四个按钮（添加文件 / 语音输入 / 发送 / 停止）的尺寸现在按实算统一。原来按钮框是 `26 / 26 / 30 / 30`、图标框 `14 / 17 / 14 / 13`；把四个 SVG 路径解析成墨迹包围盒之后，问题有多不对称一目了然——24 格网格里回形针占 `20.96×22.74`、麦克风 `15.80×21.80`、发送箭头 `15.80×15.80`、停止方块 `12.00×12.00`，给同样大的图标框，画出来的最大边会从 `6.50px` 差到 `15.44px`，也就是麦克风大一圈、停止小一圈。现在按钮框统一 `26×26`（窄屏 24×24），图标框按「墨迹最大边统一到约 10.4px」逐个反解：回形针 `11px`、麦克风 `11.5px`、发送 `16px`、停止 `18px`。回形针收得最多（它最满），发送箭头反而要放大（它最虚），停止是实心方块、同尺寸下读起来更重，所以墨迹收到 `9px` 才和邻居齐平。最大边跨度从 `8.94px` 收到 `1.53px`（`9.00~10.53px`），窄屏按比例各降约 1px。尺寸只剩 `--icon-box-*` 一组来源，`.stop-button .icon` 和窄屏那段重复声明都已删除。
- 危险命令分级与 `approvalPlan.ts` 对齐：`git push`（不再只限 `--force`）与 `curl` / `wget`（除纯 `--version` / `--help`）现在都算 `severe`。此前这两类被判成 `standard`，`review` 预设下会被静默执行，而同一个产品在写入 VS Code 自己的 `chat.tools.terminal.autoApprove` 时却把它们列为不可自动批准——两套口径互相矛盾，且推送与网络下载都是不可撤销的对外动作。`git fetch`、`git commit`、`npm test` 等仍为 `standard`。
- 打包加固：`.vscodeignore` 现在排除 `.hwchat-*`、`.tmp-*`、`.vsix-check/**`。排查过程中留在仓库根的 `.hwchat-approval-probe.txt` 和一次性探针 bundle `.tmp-perm-probe.mjs` 都曾被静默打进 `hwchat-0.1.8.vsix`，这两类临时产物现在不会再出现在用户安装的包里。
- 修复 Agent 多轮执行时正文「挤成一行」的排版问题。模型在每次调用工具前会写一句行动说明（「先读 X，再确认 Y」），这些文字与最终回答共用一个 `message.content` 字段，而 `agentRunner.ts` 里的 `content += delta.content` 与面板侧的 `response.content += delta.content` 都只做字符串累加，轮次之间**没有插入任何分隔符**——于是十几轮下来，所有句子首尾相接。正文默认 `white-space: pre-wrap`（真实换行是保留的），所以问题不在样式，而在拼接处根本没产生换行。现在每轮确认还有工具调用、会继续往下说时，给累积正文补一个段落分隔（已以空行结尾则不重复叠加），同时通过 `onDelta` 同步推给前端，保证流式展示与刷新后的存档完全一致；发给模型的历史仍用当轮 `round.content`，行为不受影响。测试 147 → 149。
- 回复里的「行动说明」和它触发的步骤现在交错显示：先说「我打算做什么」，紧跟着这一步真正执行了什么、结果如何，再回到下一段说明。以前整轮的说明全部拼在正文里，步骤列表另成一块堆在正文之前，读的人得在两处之间来回对照才知道哪一步对应哪句话。做法是在每条步骤上记一个 `contentOffset`（`core/types.ts`），面板在 `onToolsChanged` 里把正文当时的长度钉在**新出现**的那条步骤上（按 `callId` 存在 `toolContentOffsets` 里，否则后面几次快照会把边界覆盖掉），渲染时按这些边界把正文切成若干段，每段后面紧跟它那一组步骤。同一轮连续调用的多个工具边界相同，因此合成一组；空段直接跳过，不留空白。`groupToolsByOffset` 返回 `null` 表示这条消息没有边界信息（旧数据），自动退回原来的「步骤块 + 正文」排法，历史对话不受影响。另外一组只有一步时不再显示「处理过程 · 共 1 步」标题——分段后每组通常只有一两步，重复标题只会把版面撑长。`test/preview-chat.html` 的样例消息改成「说明 → 步骤 → 说明 → 步骤 → 结论」，并把 `flow` 顺序写进 `dataset.layoutMetrics`，可直接用浏览器核对。
- 审批弹窗的默认按钮改成「拒绝」。VS Code 模态框里第一个按钮是默认项，按回车就直接选中，而这里原本把「允许一次」排在第一位——急着回车或手滑就等于批准，危险命令会被这么放过去。现在「拒绝」在前，「允许一次」在后：回车 / Esc 都只做保守处理，真要同意必须主动点第二个按钮。放行条件仍是 `answer === '允许一次'`，误触不会再变成授权。
- 分级补一个漏判：单写一条 `sudo`（不带参数、等着输密码）原先被判成 `standard`，因为提权正则要求命令名后必须跟一个空白。改成「后面是空白或字符串结束」都算 `severe`，`sudo -n true`、`doas ls`、`su - root`、`cd sub && sudo -n true` 一并纳入回归测试。
- 修掉设置页权限矩阵与真实策略不一致：`media/settings.js` 里手写了一份 `[读取, 写入, 只读命令, 正常命令, 危险命令, 敏感文件]` 镜像表，用于切换预设时填充那几个锁定的下拉框。它的 Autopilot 一行把「危险命令」写成 `ask`，而 `src/core/permissions.ts` 里的真实策略是 `allow`——于是同一个页面上，上方的对照表写着「自动允许」，下方的危险命令下拉框却显示「逐次确认」，把档位显示得比实际更严格。改为 `allow` 与真实策略对齐。新增回归断言：直接解析 `media/settings.js`，把这张镜像表与 `PERMISSION_PRESET_PROFILES` 逐项比对（已验证把旧值放回去时该断言会失败）。测试 149 → 150。
- 移除权限预设里的「自定义」档位，现在只剩四个内置档位（每次询问 / 风险操作询问 / Autopilot / 完全访问），设置页那五个策略下拉框始终锁定、只作展示。移除前只有「自定义」会让这几列真正参与判定，其余三档一律被预设覆盖——同一项配置在不同档位下时灵时不灵，很容易让人以为“我把它调严了”，实际运行时却按预设放行。改动面：`PermissionPreset` 类型、`PERMISSION_PRESET_PROFILES` / `PERMISSION_PRESET_DETAILS`、`commandPolicyFor` 与 `sensitiveFilePolicyFor` 的 `custom` 分支、`isPermissionPreset` 校验、两个面板的 `isRiskyPermissionPreset`、`package.json` 的枚举与枚举说明、`media/settings.js` 的解锁条件。`readSettings()` 不再读取那五项单项策略，`resolvePolicyValue` / `resolveGuardedValue` / `POLICY_RESTRICTIVENESS` 随之删除；这些配置项仍在 `package.json` 里注册但已标记为弃用，并有明确说明“由预设推导、手动修改不生效”，以免出现“设置里写着禁止、实际按预设放行”的错觉。旧配置若残留 `"hwchat.permissionPreset": "custom"`，读取时按非法值回落到 `review`，不会让策略表出现查不到的档位（已加断言覆盖）。顺手修掉 README 权限表里 Autopilot 的「危险命令」被写成“逐次确认”的错误——真实策略是 `allow`，与之前设置页镜像表属同一处笔误。测试 150 项全过。
- 新增全局中英文切换：设置页「通用 → 界面语言」可选 `自动` / `中文` / `English`，配置键为 `hwchat.language`（`auto` 跟随 VS Code 显示语言，中文环境用中文、其余用英文）。词表集中在 `src/core/i18n.ts`，扩展宿主用 `tt()` 取值，两个 webview 则在生成 HTML 时把当期语言的扁平表注入为 JSON 块（`messageScriptTag`）——文案只有一份来源，界面、通知与错误提示不会各写一句。切换后 `refresh()` 检测到 `renderedLanguage` 与当前语言不一致会重建整页 HTML，立即生效、不需要重载窗口。
- 中英文覆盖范围：对话面板与设置页全部静态文案、运行时 toast、确认框（隐私同意、权限预设变更、删除对话、语音输入）、工具执行摘要与详情（读取 / 修改 / 运行命令 / 退出码 / 超时）、路径隔离与敏感文件提示、API 错误、Agent 进度标签、权限预设名称与七列对照表。权限对照表不再手写文字，改为由 `PERMISSION_PRESET_PROFILES` 的策略值推导（`matrixCell`），界面与真实策略在结构上不可能再出现不一致。
- 扩展壳层按 VS Code 官方 NLS 本地化：`package.json` 里的命令标题、配置说明、枚举说明、视图欢迎页都换成 `%key%` 占位符，由 `package.nls.json`（英文，默认）与 `package.nls.zh-cn.json`（中文）提供文案，共 77 条，跟随编辑器显示语言。扩展描述默认英文。
- 新增 `src/test/i18n.test.ts`（8 条断言）：中英两边键集合一致且无空文案；同名键不能中英照抄（防止漏译）；扫描源码与前端脚本里所有 `t(...)` / `tt(...)` 的字面量键，断言键真实存在（防拼错）；`resolveLanguage` 的 auto / 显式 / 非法值行为；`t()` 占位符插值与缺值保留；`messageScriptTag` 生成的 JSON 块可解析且不含裸尖括号。测试 150 → 158。
- README 拆成英文 `README.md`（默认）与中文 `README.zh-CN.md`，英文版配两张英文界面截图。截图由 `docs/screenshots/build.mjs` 生成：用 esbuild 把真实词表打包成 ESM 取出英文文案，注入真实预览页，复用同一份 `media/*.css` 渲染，再用本机 Chrome 无头模式截取——布局与扩展里完全一致，只有语言不同。脚本会校验生成页的可见区是否还有中文残留。
- 新增任务清单（待办工具）。需要拆成多步的任务，Agent 可以调用内置工具 `update_todos` 写一份清单，面板在**任务树与输入框之间**按执行顺序列出来：左边是序号 + 这一步要做什么，右边是状态。三种状态对应三种视觉——等待执行是绿色空心圆圈，执行中是绿色跳动的三点省略号，已完成是实心绿色圆圈加白色对勾；「跳动」用 `transform` + `opacity` 的 1.05s 循环，`prefers-reduced-motion: reduce` 下不播放。绿色取固定值（浅色 `#1a7f37`、深色 `#3fb950`）而不是 `--success`：VS Code 主题的 `testing-iconPassed` 在少数主题里偏黄偏青，圆圈和勾会看不出是绿色。
- `update_todos` 走面板的 `extraTools` / `executeExtraTool` 通道，不经过 `ToolExecutor` 的权限分级——清单是纯元数据，既不读也不写工作区、不执行命令，记一下待办却弹授权框只会让人误以为它有副作用。工具定义要求模型每次传**整份清单**而不是增量，并按“同一时刻只有一项 in_progress”约束；清单按数组顺序渲染，不做任何排序，因为顺序就是执行顺序。
- 清单随对话持久化（`ConversationSummary.todos`），重载窗口或切回该对话仍在；模型传入的内容按不可信输入处理：条数上限 40、单条压成一行并截断到 200 字符、未知状态一律降级为 `pending`、空条目丢弃，避免一条工具调用把面板和存档撑爆或渲染出没有样式的空状态。若模型给了多个 `in_progress`，工具会回一句提示让它自己纠正，而不是悄悄改写它给的状态。
- 预览页 `test/preview-chat.html` 增加任务清单样例，「说明 → 步骤」与清单可以在浏览器里直接核对；`docs/screenshots/build.mjs` 现在会先删掉预览页自带的中文词表再注入英文词表——同一 id 下浏览器只取第一个块，不删就会截出「英文界面 + 中文文案」的图。截图命令补上 `--virtual-time-budget=3000`，等渲染定时器跑完再截，否则拿到的是首帧空列表。测试 158 → 165。

- 任务清单改成可折叠：结构从 `<section>` 换成 `<details>` + `<summary>`，点标题就能收起和展开，与任务树一致。`summary` 一旦是 `display: flex`，浏览器就不再绘制 `::marker`，所以箭头改成自绘（`▸` 收起 / `▾` 展开，沿用 `.reasoning` 的写法），并给任务树补上同一个箭头——它此前同样没有可见的折叠提示。默认展开，用户收起后在同一次会话里保持收起（面板不重建就不会被重置）。实测：面板高度 173 → 30（收起）→ 173（再展开），箭头随 `open` 状态切换。
## 0.1.7

- Added `HWChat: 查看生效权限与来源` plus an automatic log line in the `HWChat` output channel (at activation and whenever `hwchat.*` configuration changes). It prints every permission key with the value that is actually in effect and the raw value found at each scope — `文件夹: DeepSeek-HWChat="review"｜工作区: 无｜用户: "autopilot"｜默认: 无` — so “我写了 review 但危险命令还是直接跑” can be answered without reading source. The resolver already prefers the most specific scope; this makes its decision auditable in the running build. Test count 144 → 146.

## 0.1.6

- Fixed permission settings written into a folder's `.vscode/settings.json` being silently ignored in a multi-root workspace. `readSettings()` used `workspace.getConfiguration('hwchat')` **without a resource**, and per `vscode.d.ts` a `workspaceFolderValue` only applies to "one of the workspace folders under which the requested resource belongs" — so the documented `"hwchat.permissionPreset": "review"` in a root never reached the executor. With the user settings on `autopilot`, `chmod 777 <file>` therefore ran with no confirmation at all while the repo claimed `review`: the preset on disk had no effect. Permission keys (`permissionPreset`, `fileReadPolicy`, `fileWritePolicy`, `commandPolicy`, `dangerousCommandPolicy`, `sensitiveFilePolicy`) are now resolved explicitly — most specific scope first (workspace folder → `.code-workspace` → user settings), strictest value winning when several folders disagree (`askAll` > `review`/`custom` > `autopilot` > `full`, and `deny` > `ask` > `allow` for the policy columns). The six keys also declare `"scope": "resource"` so VS Code accepts folder-level overrides officially. The test `vscode` stand-in now models `workspaceFolderValue` the same way (only with a resource), which is why this class of bug was previously invisible to tests. Test count 137 → 144.

- Fixed command path isolation missing the bare filesystem root: `rm -rf /` — also `chmod -R 777 /`, `chown -R me:me /`, `ls -la /` — passed the path scan because the absolute-path pattern requires at least one character after `/`. The real root can never fall inside a workspace root, so a lone `/` token is now detected separately and refused with `路径 / 不在当前工作区内`. Redirections to `/dev/null`, quoted absolute workspace paths, and outputs such as `date +%Y/%m/%d` are unaffected; tests cover both sides. Test count 135 → 137.

- Fixed `run_command` rejecting legitimate `sed` / `grep` invocations whose *pattern* is slash-wrapped: `sed -n '/"name"/,/displayName/p' package.json` was refused as “路径 … 不在当前工作区内”, and the only escape was rewriting the command. Pattern/script positions are now masked before the path scan — the argument after `-e` / `--expression` / `--regexp`, and the first non-option operand of `sed` / `grep` / `rg` / `awk` — while real file arguments (`sed -n 'p' /etc/hosts`, `sed -f /etc/x.sed`) and unrelated commands (`cat /etc/hosts`) are still refused. Shell segments (`&&`, `||`, `;`, `|`) are analysed one by one so `cd x && grep …` keeps working. Tests cover the allowed and still-blocked shapes.
- VS Code bridge tools now say when their file arguments must be absolute (`path` / `filePath` 必须传工作区内绝对路径) instead of letting a relative path fail with VS Code's `Invalid input path: … Be sure to use an absolute path.` The hint is derived from each tool's declared input schema, so it only appears on tools that really take a path.
- Composer bottom row: removed the trailing hint text (`Enter 发送 · Shift+Enter 换行`, `发送后自动判断任务关系`, `归档对话为只读`). It sat to the right of the three selectors and squeezed them, so values collapsed to `Autopil…` / `能力未…`. The freed width now belongs to 权限预设 / 最大步骤 / 思考深度 (150/132/132 → 190/150/158). Keyboard behavior is unchanged (Enter sends, Shift+Enter inserts a newline), and the archived / streaming status remains visible in the textarea placeholder.
- Added `HWChat: 同步 VS Code 审批预设` / `HWChat: 还原 VS Code 审批设置`. VS Code extension tools (anything routed through `vscode.lm`, such as `run_in_terminal`) are authorized by VS Code through each tool's own `prepareInvocation`, so `hwchat.permissionPreset` can never suppress those prompts. The new commands write VS Code's own `chat.tools.*` approvals instead: at runtime they detect which of `chat.tools.terminal.autoApprove`, `chat.tools.terminal.enableAutoApprove`, `chat.tools.edits.autoApprove`, `chat.tools.global.autoApprove`, `chat.tools.autoApprove` actually exist in the installed build, show a full diff before writing, only touch user settings, and back up the previous values so one command can revert. Off / read-only / read-only + build / everything are the four levels; dangerous prefixes (sudo, rm, shred, git push, git reset --hard, publish, curl/wget, chmod) are always written as explicit denies after the allow rules. Pure planning logic lives in `src/core/approvalPlan.ts` with unit tests, including a `find` rule that excludes `-exec` / `-delete`.
- `Autopilot` now means what its name says: dangerous commands are auto-approved too, and only sensitive-file reads stay blocked. It was previously identical to `风险操作询问` in every column, so the option did nothing. Presets now differ: `风险操作询问` asks for dangerous commands, `Autopilot` runs them, `完全访问` runs them and also asks before reading sensitive files.
- Fixed command path isolation rejecting legitimate absolute paths: the old check denied any command containing `/Users`, `/home`, `/etc`, … even when the path was inside the workspace, so `cd "…/AI projects/some repo" && npm test` was refused. Absolute paths are now resolved one by one and only rejected when they fall outside every workspace root; HOME expansion (`~`, `~user`, `$HOME`), `..`, and outside paths are still blocked, and `/dev/null` style redirections stay allowed. The logic moved to `src/agent/commandPaths.ts` with unit tests.
- Fixed settings changes silently not taking effect when the key was already defined in a `settings.json`: `updateSettings` always wrote to the Global target, so any workspace- or folder-scoped `hwchat.*` value kept overriding the UI (the permission preset dropdown looked dead). Writes now go back to the scope that actually defines the key — folder level first, then `.code-workspace`, then global.
- Added `hwchat.permissionPreset` to `capabilities.untrustedWorkspaces.restrictedConfigurations`; without it an untrusted workspace's `.vscode/settings.json` could still change the preset.
- Fixed relative paths resolving to the wrong folder in a multi-root workspace. `resolveWorkspacePath` only ever tried the first root for a relative input (`if (!absoluteCandidate && index > 0) continue;`), so `read_file` with `src/agent/commandPaths.ts` stat'ed `<first root>/src/agent/commandPaths.ts` and surfaced a bare `ENOENT` pointing at a folder the user never mentioned. Resolution now takes an optional existence probe: a relative path is checked in every root, the single existing match wins, zero matches still fall back to the first root, and a path that exists in several roots raises an error naming the candidates and asking for a root-name prefix. Absolute paths and explicit `Root/…` prefixes are unchanged. `src/agent/workspacePaths.ts` keeps the logic pure and unit-testable; both callers (`toolExecutor`, `vscodeTools`) pass `fs.existsSync`.
- Composer bottom row is now forced onto a single line at every width: `flex-wrap: nowrap`, and the `max-width: 560px` rules that gave the selector group and the icon group `flex: 1 1 100%` (the actual cause of the two-row layout) are removed. The footer is declared a size container, so the row reacts to its own width instead of the viewport: labels hide in the requested order — 思考深度 first, then 最大步骤, then 权限预设 — while each select keeps its currently selected value visible, and attach / voice / send never leave the row.
- Raised composer control contrast. Labels no longer use `--muted` (`descriptionForeground`) but 85% foreground, and grew from 9px/8px to 10px/9px; the select caret went from `--muted` to 72% foreground; a disabled select now renders at `opacity: .82` instead of `.5`. The reasoning selector is disabled whenever the model does not declare configurable effort (`media/chat.js:533`), so `能力未知` used to be painted at half opacity — that was the washed-out text.
- Removed the manual collapse button at the bottom right of the conversation pane, reverting to 0.1.5 behaviour: the conversation list is no longer collapsible by a button, and the side-bar boundary is the only control. Above 720px the 268px list is a permanent column; at 720px and below (where the 420px `initialSize` default lands) it is an overlay drawer toggled by the 对话记录 toolbar icon. Every intermediate variant is gone: the `⌘B` primary-side-bar toggle, the `⌘⌥B` auxiliary-bar hide, the whole-`.app-shell` slide-out, the rightward `translateX(100vw)` fold, and the `workbench.action.increaseViewWidth` / `decreaseViewWidth` calls that narrowed the host panel in 60px steps. Those calls were the headline of the previous revision, but a fixed 60px increment cannot match a 268px column (4 steps move 240px) and the rounding showed up in the chat width, so the panel-width borrowing, the persisted owed-step counter, and the status-bar 展开对话列表 entry are all deleted too. Dropped with it: the `.history-footer` wrapper and its styles (设置 is a direct child of the aside again), the `collapse` icon and its `IconName` member, and the `hwchat.expandCollapsedSidebar` command.
- Task tree rows show their status label (`执行中` / `判断关联性` / `排队` / `已合并` / `完成` / `已取消` / `失败`) again on narrow panels. `@media (max-width: 720px)` carried `.task-node small { display: none; }`, and HWChat opens in a secondary side bar whose `initialSize` is 420px, so that branch always applied: the label was still in the DOM (`renderTaskTree` appends `taskStatusLabel(node.status)` as the third grid column) but painted nowhere, leaving the right half of every row blank. The rule is now `display: block`; the title column keeps `text-overflow: ellipsis`, so a long title truncates instead of pushing the label out.
- Added a "back to latest message" button so scrolling up through history no longer requires dragging the scrollbar back down. It floats at the bottom-right of the message area — `bottom: 12px` (10px on narrow panels), i.e. just above the composer, since `.message-area` ends exactly where `.composer-wrap` (status line, task tree, input) begins — and appears **only when needed**: the viewport must actually overflow (more than 120px of hidden content) and the user must be away from the bottom, reusing the same `isNearBottom()` signal that drives `autoFollow` — so the button disappears by itself once reached, and never shows in an empty or short conversation. The message viewport is now wrapped in `.message-area`, which is the positioning reference: an absolutely positioned child *inside* the scroll container would slide away with the content. Clicking it re-enables `autoFollow` and smooth-scrolls to the end, so streaming resumes following.
- Fixed `list_files` / `search_files` answering "找到 0 个文件" when the glob carried a workspace-root prefix. `path` arguments already accepted `Root/...`, but a glob such as `DeepSeek-HWChat/src/**/*.ts` was handed to `findFiles` unchanged, matched nothing in any root, and reported an empty result — indistinguishable from "the file really isn't there". `normalizeWorkspaceGlob` now strips the prefix on the same convention as `path` and scopes the hits back to that root.
- Fixed `list_directory` without a `path` silently listing only the first workspace root in a multi-root workspace, which returned a different project's tree while the caller was working in another one. It now lists every root under its own `## <root>` heading.
- Fixed command path isolation rejecting every `..`, even when it resolved inside the workspace (`cat ../package.json` from `<root>/src`). `..` is now resolved against the command's `cwd` — which is itself validated — and only rejected when it lands outside every root; without a known `cwd` it stays conservatively blocked, and the HOME / `~user` / outside-absolute rules are unchanged.
- When a quoted token is really a sed/grep address (`sed -n '/a/,/^b/p'`), the isolation error now says so and points at `grep -e` / `sed -e` instead of reporting an unexplained outside path.
- Fixed `list_files` / `search_files` returning nothing for a glob that reduced to a bare `**` after the root prefix was stripped (`DeepSeek-HWChat/**` → `**`). `findFiles` matches no file at all for a lone `**`, so the tool answered "没有匹配文件" while the directory was full of them. Stripping now normalises a bare `**` to `**/*`; `src/**` and `src/**/*.ts` are untouched.
- Fixed multi-root glob queries silently scanning only the first workspace root. Unscoped `findFiles` applies its limit across *all* roots, so the old `200` ceiling was spent entirely on the first root — an 18-root workspace searched 200 files from one project and reported "找到 0 处匹配" for strings that existed in 17 others. Unscoped queries now run once per root via `RelativePattern` with a per-root ceiling, and every truncated result says so (`已达上限，可能还有更多`) instead of pretending to be complete. `search_files` additionally stops at a file-read budget and reports when it does.
- Fixed `search_files` failing the whole search when any file in range was binary: the NUL-byte check threw and aborted the run, so one `.vsix` / `.png` in the glob produced `该文件似乎是二进制文件` instead of results. Unreadable and binary files are now skipped and the search continues.
- Added `src/test/support/vscodeMock.ts` plus an esbuild alias for test builds, so `ToolExecutor` — the layer that actually enforces permissions — can finally run under `node --test`. The new `toolExecutor.test.ts` covers the preset matrix (askAll / review / autopilot / full / custom), plan mode, untrusted workspaces, sensitive files, path escape, unknown tools, audit records, and the external `vscode.lm` approval path. Test count 80 → 114.
- Fixed a **security hole in the VS Code bridge**: `hwchat_vscode_copilot_readFile` with `/etc/hosts` returned the file, and `copilot_listDirectory` with `/etc` listed the whole system directory. HWChat's own `read_file` / `run_command` are confined to the workspace roots, but anything routed through `vscode.lm.invokeTool` was passed straight through with no path check — the same product shipped one locked door and one unlocked one. `externalToolPathViolation` now inspects path-shaped arguments (`path`, `filePath`, `files`, `directory`, `cwd`, `target`, …) before the tool is invoked and refuses HOME references (`~`, `$HOME`), absolute paths outside every root, and `..` traversal that escapes. Only *argument names* are matched, so payload arguments such as `content` / `command` / `text` are never mistaken for paths. Rejected calls never reach VS Code, and the message is a plain `路径隔离策略拦截：…` instead of the opaque `Invalid stream` that an out-of-workspace `copilot_createFile` used to produce. Tests cover the pure rule and an end-to-end bridge call that asserts `invokeTool` is never reached.
- Fixed root-prefixed globs still returning 0 files after the earlier `**` normalisation. Normalising `DeepSeek-HWChat/**` to `**/*` was not enough: the scoped branch passed that *string* glob to `findFiles`, which searches **every** workspace folder and shares one limit. In an 18-root workspace the 1000-file ceiling was spent on the first 16 roots, so filtering the hits back to `DeepSeek-HWChat` left zero — and because the pre-filter count hit the ceiling, the tool even added `已达上限，可能还有更多` to a result that contained nothing. Scoped queries now use `new vscode.RelativePattern(folder, glob)` so the scan really is confined to the named root. Regression test builds 1050 files in the first root and one file in the second and asserts the second is found with a plain `找到 1 个文件`.
- Fixed `search_files` without a glob still answering `找到 0 处匹配` after the per-root query fix. Per-root `findFiles` was correct, but the merged list was `root1 files → root2 files → …`, so the 1500-file scan budget was consumed before the last roots were ever opened — which is exactly why searching `scrollToBottomButton` in the 17th root reported nothing while the symbol existed. The merge now interleaves the per-root arrays round-robin, so the budget is shared instead of spent on whichever root sorts first. Regression test uses four noise roots of 420 files each plus a target root placed last. Test count 114 → 130.

## 0.1.5

- Rebuilt the chat header so the conversation title keeps its own row; work mode, API profile, model, refresh, and the right-aligned Skill, archive, export, and settings controls moved to a dedicated row underneath and wrap instead of squeezing the title. The Skill button now sits directly left of settings.
- Merged the composer into one bordered card: the textarea sits on top, and a single bottom row inside the card holds the permission preset, maximum steps, reasoning depth, and the attach, voice, and send/stop buttons (attach is now left of the voice button).
- Reworked the permission matrix to the requested shape: presets now carry six independent columns (read, write, read-only commands, regular commands, dangerous commands, sensitive files). Read-only and regular commands are auto-approved from "review risky actions" upward, "full access" also auto-runs dangerous commands, and sensitive-file reads are confirmed one by one even in "full access".
- Replaced the `allowSensitiveFiles` / `allowDangerousCommands` booleans with the tri-state `hwchat.sensitiveFilePolicy` and `hwchat.dangerousCommandPolicy` (allow / ask / deny). Old booleans are kept as deprecated fallbacks and migrated on read.
- Added a sensitive-file guard that asks once per tool call with the concrete target paths, denies them under stricter presets, and keeps skipping them in workspace-wide searches unless the policy is "allow".
- Updated the settings matrix, composer preset tooltips, `package.json` enum descriptions, and docs to the new six-column model.
- Consolidated the permission model in `src/core/permissions.ts` as the single source of truth: command tiers (read-only / regular / dangerous), the six-column preset table, and the sensitive-file policy all resolve from there, so the settings matrix, composer tooltips, and runtime checks cannot drift apart.
- VS Code tool calls and built-in editor previews no longer prompt under `Autopilot` / `完全访问`; in fact every VS Code extension tool now delegates authorization to VS Code itself: tools that need no authorization run immediately, tools that declare a confirmation still show VS Code's own dialog, and cancel/deny is recorded as a denied step instead of an error.
- Fixed VS Code tools being silently dropped from the tool list: the 100-tool cap is raised to 400 with stable sorting, extensions that contribute language model tools are activated in the background (and once more on demand when the model calls a tool that is not registered yet), and unknown tool ids now return a clear message instead of a generic failure.
- Fixed tool-execution, reasoning, and Skill disclosure rows collapsing right after a click: the streaming re-render now captures and restores user expand/collapse state, and pauses rebuilding while the pointer is down in the message list.
- Fixed the toolbar collapsing into stacked full-width rows when a webview kept an older HTML structure: `media/chat.css` now also styles the legacy `.toolbar-main` / `.toolbar-connection` wrappers, and media URLs are versioned (`?v=<version>`) so HTML, CSS, and JS always come from the same build instead of a stale webview cache.
- Dimmed the composer placeholder/hint text (`--placeholder` uses 55% of the theme placeholder color) so the hint no longer competes with real input.
- Changed the user message bubble to normal editor foreground text (the label and body used to render in orange/yellow) while keeping a subtle accent background and border.
- Added a permission boundary matrix to the settings page and matching tooltips on the composer preset selector.
- Anchored the Skill panel to the dynamic header height so it keeps opening directly below the toolbar when controls wrap.
- Replaced the font-dependent glyphs with vector/CSS shapes: the composer runtime selectors draw their caret as a CSS triangle instead of the `⌄` character (which fell back to unreadable glyphs in some font stacks), and the export button now uses an inline SVG icon like every other toolbar button.
- Synced the dev preview `test/preview-chat.html` with the shipped markup (title row plus control group row, inline SVG icons), so previewing it no longer shows the retired two-wrapper toolbar or placeholder text glyphs.

## 0.1.4

- Added native multi-root workspace discovery, directory listing, and editor file opening. Requests such as opening a workspace Markdown file now use VS Code APIs directly instead of terminal commands, `code` CLI calls, or external Copilot tools.
- Added read-only task-history continuation. Any conversation can start a new linked conversation with a bounded local handoff summary and an on-demand source-history search tool; referenced source histories are protected from automatic cleanup.
- Paired every message sent during an active Agent run with its own queued or streaming assistant response, so related guidance and independent queued tasks render their answers immediately below the correct user message.
- Improved runtime command behavior and documentation: authorized Agents can execute regular commands inside trusted workspace roots, while Workspace Trust, path isolation, sensitive-file protection, and dangerous-command confirmation remain enforced.
- Filtered retired, disabled, unavailable, expired, and user-excluded models from direct API discovery, and prevented refresh from restoring models that were manually removed.
- Made reasoning controls model-aware. Adjustable levels are offered only when provider metadata declares multiple supported efforts; fixed, unsupported, and unknown models use their declared/default behavior.
- Added regression coverage for multi-root path resolution, linked-history persistence and cleanup protection, queued-response recovery, inserted-message ordering, retired-model filtering, and reasoning capability parsing.

## 0.1.3

- Changed model discovery to query each configured API's `/models` endpoint directly, preserving provider display names without depending on Copilot or models registered by other VS Code extensions.
- Updated the official DeepSeek fallback catalog to `deepseek-flash` and `deepseek-v4-pro`; when the API directory no longer contains the selected model, HWChat now switches the UI and active conversation to the first available model together.
- Kept the chat mode, Skill count, and settings controls visible on one responsive toolbar row, with profile and model selectors sharing the available width below it.
- Added persisted thumbnails for pasted images and included them in scheduled completed-task cache compaction.
- Fixed the unregistered `hwchat.reasoningEffort` upgrade-window error with a local fallback, and fixed active-section tracking in the settings navigation.
- Made the settings navigation fixed while content scrolls, removed gradient styling, and improved foreground/background contrast in light and dark VS Code themes.
- Tightened the composer action controls and hid the textarea scrollbar while preserving keyboard, wheel, and touch scrolling.
- Replaced the boxed runtime dropdowns with compact labeled text selectors for permission preset, maximum steps, and reasoning depth.

## 0.1.2

- Added runtime task trees: messages sent while Agent is running are classified as related guidance or queued branches. Related guidance triggers replanning at the next tool boundary, while independent work continues after the active branch finishes.
- Kept the composer editable during Agent runs, added explicit running state, and stopped forcing the message viewport to the bottom after the user scrolls upward.
- Added permission, unlimited-step, reasoning-effort, and voice controls directly below the composer. Risky permission presets require an explicit risk acknowledgement and persist immediately.
- Added pasted image, screenshot, and file attachments with multimodal request support and scheduled removal of cached attachment bodies and image Base64 data.
- Added automatic model discovery, reasoning-parameter compatibility retries, built-in editor previews, and invocation of tools exposed by other VS Code extensions through the Language Model Tool API.
- Added dedicated terminal command blocks with one-click copying through the VS Code clipboard.
- Fixed intermittent chat copy/paste failures by preserving text selections during streaming, acknowledging clipboard writes, and supporting text plus file/image clipboard payloads together.
- Added regression coverage for unlimited Agent rounds, runtime replanning, queued tasks, reasoning fallback, and image-cache compaction.

## 0.1.1

- Moved the complete chat and history experience into the VS Code Secondary Sidebar so selecting or creating a conversation no longer opens an editor tab.
- Added multiple API profiles with per-profile SecretStorage keys, endpoint/model switching, custom model lists, and HTTPS enforcement for remote endpoints.
- Added permission presets for ask-all, review, Autopilot, full-access, and custom workflows while retaining Workspace Trust, path isolation, and dangerous-command confirmation boundaries.
- Integrated `~/.copilot/skills` and the shared local-skill-quick-launch state. Default-selected Skills use route-on-demand loading, and each reply records only the Skills actually loaded.
- Added per-reply and cumulative conversation Token usage in `M tokens`, including aggregation across Agent tool rounds and retention through cache compaction.

## 0.1.0

- Added real multi-round native tool calling for Agent and read-only Plan modes.
- Added workspace file search/read/write/replace/move/trash tools, diagnostics, and bounded command execution.
- Added per-operation permission policies, Workspace Trust enforcement, sensitive-file protection, dangerous-command blocking, privacy consent, and local audit records.
- Added local Skill discovery and per-conversation Skill selection.
- Added file attachments from the composer and Explorer context menu.
- Added collapsible persisted execution records with concise summaries and expandable details.
- Added conversation archive/restore and protected archived records from retention and budget eviction.
- Extended scheduled cache compaction to tool details and attachment bodies.
- Bounded and redacted Agent audit data, and omitted full file-write bodies from expandable execution history.
- Added Agent-loop, streaming tool-call, archive, compaction, and data-clearing tests.
- Added a native-feeling chat panel with streaming replies and code selection context.
- Added an Apple-inspired settings panel with secure API key storage.
- Added durable, per-message history storage with atomic writes and recovery backups.
- Added scheduled task-cache cleanup, retention rules, and a configurable disk budget.
- Added history export, pinning, deletion, and an integrated conversation list.
