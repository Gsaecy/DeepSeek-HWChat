<!-- plaitcode:project-doc v1 -->

<!-- 本文件由 PlaitCode 维护：只追加，不重写。 -->

## 不可违反的约定


## 已定的决策

- 切割生成器页（trace.html）的定位确定为「切割几何构建法」：① 载入 → ② 轮廓规整 → ③ 半径族 R 圆弧/直线拟合 + 相切校验 → ④ 按模数 a = 长边 ÷ N 出施工图。页面标题/描述/OG 与页脚统一用这套命名，导航标签仍是「切割生成器」。
- trace.html 之前只暴露了一部分控件，而 assets/trace.js 早已为 #traceRender…（示例叶/环）、#traceGrid、#traceConstruct、#traceCanon、#traceFit、#traceFamily、#dlAiQuick 写好了绑定，且 style.css 里 .rfam/.tool__row 等样式也已存在。本轮按「引擎与样式是权威、HTML 是残缺副本」补齐页面，而不是删 JS 里的死绑定。
- 导航栏统一为 10 项，固定顺序：规范速查 · 设计原理 · 元素总览 · 组件画廊 · 产品蓝图 · Logo 规范 · 设备示例 · 图标库 · 切割生成器 · 测试工具；当前页统一用 aria-current="page" 标记（原先全站都没有）。
- 切割生成器（trace.html）实测产出质量不达标，按用户要求整页删除：同时移除 assets/trace.js、style.css 里 trace 专用的 .rfam / .trace-status / .trace-thumb / .trace-progress 样式（保留夹在其中的 [data-theme="dark"] .icon-cell img 共用规则）、9 个页面导航里的「切割生成器」入口、sitemap.xml 的 trace.html 条目、README 的页数徽章/页面表/目录结构三处。全站导航由 10 项回到 9 项，页面总数 9 个。
- 工作区遗留的一次性审计/测试产物按「全部删除」处理：tmp-app-guidelines 根目录 _a15.js、_audit.js、_audit2.js、_audit3.js、_check.js、_srv.js、_verify.js、_og.ps1、_og.txt、_titles.txt 与 _tt/ 下 gen.ps1 + 10 张 png 全部移入废纸篓，并删掉空的 _tt 目录。删除前已确认没有任何被跟踪文件引用它们，git status 现为零改动。没有选择加进 .gitignore 保留文件的做法。
- 核实结果修正了此前记录的未完成项：全站 html/js/css/md/xml 里已不存在 trace.html 引用（导航 9 项、sitemap、README 都干净），testing.html 里的「壁纸 / 壁纸状态 / 128 MB」等 MacWall 串项目文案也已不存在，两条旧待办可以视为已关闭。

## 已否决的做法（不要再试）

- 没有把投递区改成 <label for="traceFile">：trace.js 已在该元素上绑了 click→input.click()，用 label 会二次触发文件对话框。改为 role="button" + tabindex="0" + aria-label/aria-describedby，并在 JS 里补 Enter/Space 处理（MDN 的 file input 可访问性页给出的两条路里选了后者）。
- 没有查证 potrace 的参数映射（turdsize/alphamax/opttolerance ↔ 本页「节点简化」）：potrace.sourceforge.net/potrace.html 返回 403，读不到原文，因此页面文案里不写「简化 ≈ alphamax」这类未经核实的一一对应。

## 已完成（不要重做）

- 完成：继续优化logo的切割几何构建法的页面（页面添加到导航栏） （改动 deepseek-hwchat/tmp-app-guidelines/_nav.js、deepseek-hwchat/tmp-app-guidelines/_ids.js、deepseek-hwchat/tmp-app-guidelines/_grep.js、deepseek-hwchat/tmp-app-guidelines/_grep2.js、deepseek-hwchat/tmp-app-guidelines/_range.js、deepseek-hwchat/tmp-app-guidelines/_grep3.js 等）
- 完成：测试切割生成器，效果不达标就不要 （改动 deepseek-hwchat/tmp-app-guidelines/_tt/gen.ps1）
- 完成：删掉切割生成器 （改动 deepseek-hwchat/tmp-app-guidelines/trace.html、deepseek-hwchat/tmp-app-guidelines/index.html、deepseek-hwchat/tmp-app-guidelines/assets/style.css、deepseek-hwchat/tmp-app-guidelines/principles.html、deepseek-hwchat/tmp-app-guidelines/elements.html、deepseek-hwchat/tmp-app-guidelines/components.html 等）
- 完成：还有更改没清理 （改动 deepseek-hwchat/tmp-app-guidelines/_a15.js、deepseek-hwchat/tmp-app-guidelines/_audit.js、deepseek-hwchat/tmp-app-guidelines/_audit2.js、deepseek-hwchat/tmp-app-guidelines/_audit3.js、deepseek-hwchat/tmp-app-guidelines/_check.js、deepseek-hwchat/tmp-app-guidelines/_srv.js 等）

## 未完成

- testing.html 里有明显的串项目文案残留：对比度/组件状态示例写着「壁纸已设为桌面背景 · 128 MB」「壁纸状态」等 MacWall 项目的内容。本轮范围是切割页 + 导航，未动它；下轮可单独清。
- 站点标注 v2.3.0 未升；本轮改动未提交、未推送。仓库根目录还留着上一轮的审计脚本（_a15.js、_audit*.js、_check.js、_srv.js、_verify.js、_og.ps1、_og.txt、_titles.txt），用户尚未决定删还是留。
- 删切割生成器这轮改动尚未提交、未推送；站点仍标注 v2.3.0 未升。testing.html 里「壁纸已设为桌面背景 · 128 MB」「壁纸状态」等 MacWall 串项目文案仍在，未处理。仓库根目录的历史审计脚本（_check.js、_d7.js、_p19.js、_p55.js、_p67.js 等）仍引用已删除的 trace.html，未清理，也未被 git 跟踪。
- 仓库根目录还剩 4 个已被提交跟踪的旧审计脚本 _d7.js、_p19.js、_p55.js、_p67.js（其中 _p19/_p55/_p67 仍写着已删除的 trace.html）。它们不在 git 改动列表里，删除会产生一次删除提交，等用户确认后再动。

<!-- 最后更新：2026-11-17 -->

