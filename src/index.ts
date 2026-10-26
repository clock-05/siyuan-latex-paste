import { Plugin, showMessage } from "siyuan";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { convertLatex, countLatexDelimiters, hasMarkdownMath } from "./latex";
import {
  extractMathNodes,
  extractSiyuanComments,
  hasMathNodes,
  restoreMath,
  stashMathInHtml,
  stripHtml,
  type MathSegment,
} from "./html";
import { renderSiyuanBlocks } from "./blocks";
import { collapseBlankLines } from "./markdown";

interface IPasteDetail {
  protyle: any;
  resolve: (data: IPastePayload) => void;
  textHTML: string;
  textPlain: string;
  siyuanHTML: string;
  files: any;
}

interface IPastePayload {
  textHTML: string;
  textPlain: string;
  siyuanHTML: string;
  files: any;
}

/** 整页网页复制经常好几 MB，超过这个量就放弃处理，别让编辑器卡住 */
const MAX_HTML_LENGTH = 2 * 1024 * 1024;

module.exports = class LatexPaste extends Plugin {
  private turndown: TurndownService | null = null;
  /** 事件总线最近一次接管的时间戳，用来判断 DOM 兜底是否还需要出手 */
  private lastBusHandled = 0;
  /** 只有注册失败才有内容，等 onLayoutReady（UI 就绪）再弹；成功路径一个消息都不发 */
  private loadReport = "";

  async onload() {
    // 这个插件没有设置项：在思源里启用即生效，停用走思源自己的插件开关。
    // 也因此全程不写任何存储 —— saveData 会落到 petal 目录、被广播给所有窗口，
    // 每个窗口的插件随之重载，多窗口下会变成无限重启。零写入就没有这个隐患。
    // 每一步单独 try/catch：只要有一处抛错，后面的注册就全废了。
    // 之前就是 addCommand 出问题，把 click-blockicon 一起带走了。
    const steps: string[] = [];
    const attempt = (name: string, run: () => void) => {
      try {
        run();
        steps.push(`${name}: ok`);
      } catch (error) {
        steps.push(`${name}: FAIL ${(error as Error)?.message ?? error}`);
        console.error(`[latex-paste] 注册 ${name} 失败`, error);
      }
    };

    // 路径一：思源的事件总线（能拿到 protyle，判断最准）
    attempt("paste-bus", () => this.eventBus.on("paste", this.handlePaste));
    // 路径二：DOM 捕获阶段直接改写剪贴板，不依赖思源版本
    attempt("paste-dom", () => document.addEventListener("paste", this.onDomPaste, true));

    // 真正能用的入口，靠主动触发：
    // 块图标菜单 —— 选中块后点图标，不依赖快捷键也不依赖浏览器事件
    attempt("block-icon", () => this.eventBus.on("click-blockicon", this.onBlockIcon));
    // 内容区右键菜单 —— 选中文字后右键就能用，比顶栏更顺手
    attempt("content-menu", () => this.eventBus.on("open-menu-content", this.onContentMenu));
    // 命令不带 hotkey：思源里 ⌘⇧C 是「复制块引用」，⌘⌥C 也不一定干净。
    // 想让快捷键生效，去「设置 → 快捷键」里给这个命令自己绑一个。
    attempt("command", () =>
      this.addCommand({
        langKey: "commandCopyAsMarkdown",
        callback: this.copyAsMarkdown,
      }),
    );

    const failed = steps.filter((step) => step.includes("FAIL"));

    this.log("插件已加载", steps);

    // 提示别在这里弹：onload 阶段思源的 UI 还没就绪，showMessage 会静默失效。
    // 先记下来，等 onLayoutReady 再弹。
    // 成功路径完全静默 —— 插件正常加载不该打扰任何人。
    // 失败才留一条，诊断价值全在这一条上（写明具体哪几项注册挂了）。
    this.loadReport =
      failed.length > 0
        ? `数学公式粘贴：${failed.length} 项注册失败（${failed.join("；")}）`
        : "";
  }

  onunload() {
    this.eventBus.off("paste", this.handlePaste);
    this.eventBus.off("click-blockicon", this.onBlockIcon);
    this.eventBus.off("open-menu-content", this.onContentMenu);
    document.removeEventListener("paste", this.onDomPaste, true);
    this.turndown = null;
    // 清掉上一轮的失败提示：插件禁用/启用后不该残留任何提示。
    // 下次启用是全新的一轮 onload，失败信息会在那里重新算。
    this.loadReport = "";
  }

  onLayoutReady() {
    // 没有设置面板 —— 插件启用即生效。这里只负责把失败提示补上：
    // onload 阶段思源的 UI 还没就绪，showMessage 会静默失效。
    if (this.loadReport) {
      showMessage(this.loadReport, 5000);
    }
  }

  /** 诊断日志走 console.debug：默认在 DevTools 的「详细」级别里，不刷屏 */
  private log(...args: unknown[]) {
    console.debug("[latex-paste]", ...args);
  }

  /**
   * 判断一段内容里有没有需要处理的公式。
   * rawHtml 传原始 HTML：公式被渲染成 DOM 之后文本里的 $ 就没了，只能看 HTML 判断。
   */
  private detect(text: string, rawHtml = ""): { count: number; hasMath: boolean } {
    const count = countLatexDelimiters(text);
    const md = hasMarkdownMath(text);
    const nodes = rawHtml ? hasMathNodes(rawHtml) : false;
    return { count: count + (nodes ? 1 : 0), hasMath: count > 0 || md || nodes };
  }

  /**
   * 优先把 HTML 转成 Markdown（保住加粗、列表、链接等格式），
   * 公式在 HTML 里被标签拆碎时退回纯文本。
   */
  private convertPayload(
    textPlain: string,
    textHTML: string,
    plain: { count: number; hasMath: boolean },
    html: { count: number; hasMath: boolean },
  ): string | null {
    if (textHTML && html.hasMath) {
      const { markdown, count, skipped } = this.htmlToMarkdown(textHTML);
      // count 是 HTML 里真抽出来的公式，skipped 是躺在代码块里、本来就不该转的。
      // 两个加起来才对得上纯文本那份统计 —— 否则代码里的 \(x\) 会被当成
      // 「HTML 把公式抽丢了」，一路回退到纯文本，连代码块的围栏都保不住。
      if ((count > 0 || skipped > 0) && count + skipped >= plain.count) {
        this.log("走 HTML → Markdown 路径", { count, skipped, markdown });
        return markdown;
      }
      // HTML 里明明有公式却一个都没抽出来，说明被标签拆碎还被转义了，
      // 这时候用它只会得到 \$ … \$ 这种怪东西，退回纯文本更稳。
      //
      // 注意这里没有「有 HTML 就转」的兜底分支：HTML 里没有公式标记时，
      // 转出来的 Markdown 会丢掉纯文本里那份能用的公式，公式优先于格式。
      this.log("HTML 里的公式没抽全，回退纯文本", { count, skipped, plainCount: plain.count });
    }

    const result = convertLatex(textPlain);
    if (result.count > 0) {
      return result.text;
    }
    // 纯文本里只有 Markdown 公式：内容不用改，关键是让思源走 Markdown 解析
    if (plain.hasMath && textPlain.trim()) {
      return textPlain;
    }
    return null;
  }

  /**
   * 两条粘贴路径共用的管道：先判断有没有公式，再决定走 HTML 还是纯文本。
   * 返回 null 表示这次粘贴不该接管。
   */
  private convertClipboard(textPlain: string, textHTML: string): string | null {
    if (textHTML.length > MAX_HTML_LENGTH) {
      this.log("HTML 太大，跳过处理", { length: textHTML.length });
      return null;
    }
    const plain = this.detect(textPlain);
    const html = this.detect(textHTML ? stripHtml(textHTML) : "", textHTML);
    // 来源到底给了什么，排查时全靠这条
    this.log("收到粘贴", { textPlain, textHTML, plain, html });
    if (!plain.hasMath && !html.hasMath) {
      return null;
    }
    return this.convertPayload(textPlain, textHTML, plain, html);
  }

  /** 路径一：思源事件总线 */
  private handlePaste = (event: CustomEvent<IPasteDetail>) => {
    const detail = event?.detail;
    if (!detail || typeof detail.resolve !== "function") {
      return;
    }

    try {
      const protyle = detail.protyle;
      if (!protyle || protyle.options?.mode === "preview") {
        return;
      }
      // 思源内部复制粘贴：公式本来就是公式，不用管
      if (detail.siyuanHTML) {
        return;
      }
      // 带附件（图片等）的粘贴不接管，避免把文件弄丢
      if (detail.files && detail.files.length > 0) {
        return;
      }
      if (this.isInCodeContext()) {
        return;
      }

      const textPlain = detail.textPlain || "";
      const textHTML = detail.textHTML || "";
      const converted = this.convertClipboard(textPlain, textHTML);
      // 没有 HTML 时，纯文本本来就会走 Markdown 解析，不用多此一举
      if (!converted || (converted === textPlain && !textHTML)) {
        return;
      }

      this.lastBusHandled = Date.now();
      this.log("事件总线：改写载荷", { converted });
      event.preventDefault();
      detail.resolve({
        textHTML: "",
        textPlain: converted,
        siyuanHTML: "",
        files: detail.files,
      });
    } catch (error) {
      console.error("[latex-paste] paste handling failed", error);
    }
  };

  /**
   * 路径二：DOM 兜底，在捕获阶段直接改写剪贴板数据。
   * 老版本思源的事件总线替换载荷有 bug（3.8.0 才修），这条路径不依赖版本。
   */
  private onDomPaste = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) {
      return;
    }

    try {
      // 思源内部复制粘贴，公式已经是对的
      if (Array.prototype.indexOf.call(data.types, "text/siyuan") > -1) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.closest !== "function" || !target.closest(".protyle-wysiwyg")) {
        return;
      }
      if (this.isInCodeContext(target)) {
        return;
      }
      // 事件总线刚处理过这次粘贴，不再重复改
      if (Date.now() - this.lastBusHandled < 200) {
        return;
      }

      const textPlain = data.getData("text/plain") || "";
      const textHTML = data.getData("text/html") || "";
      const converted = this.convertClipboard(textPlain, textHTML);
      if (!converted) {
        return;
      }

      data.setData("text/plain", converted);
      if (textHTML) {
        data.setData("text/html", "");
        if (data.getData("text/html")) {
          // 少数环境下 setData 清不干净，记录在控制台便于排查
          console.warn("[latex-paste] 无法清空 text/html，HTML 分支可能仍然生效");
        }
      }
      this.log("DOM 兜底：改写剪贴板", { converted });
    } catch (error) {
      console.error("[latex-paste] dom paste failed", error);
    }
  };

  /**
   * 把一段 DOM 转成 Markdown。里面没有公式就返回 null（表示别管这次操作）。
   */
  private renderMarkdown(holder: HTMLElement): string | null {
    // 块图标（🏷️）只是装饰，转成 Markdown 会变成一串乱码
    holder.querySelectorAll(".protyle-attr").forEach((node) => node.remove());

    // 含图片/视频时不处理：转成 Markdown 后这些内容在其他软件里就没了
    if (holder.querySelector("img, video, audio, iframe")) {
      this.log("复制：内容里有媒体文件，跳过");
      return null;
    }

    // 思源把完整的块结构塞在 data-siyuan 注释里（base64），外层 HTML 只是简化版。
    // 先留一份原样的，必须在替换占位符之前取。
    const siyuanHTML = holder.innerHTML;

    // 快速排除：外层既没有公式标记、也没带思源原始注释，到此为止。
    // 下面要跑整段 base64 解码，复制普通文字时没必要付这个代价。
    const outerHasMath = hasMathNodes(siyuanHTML);
    if (!outerHasMath && !siyuanHTML.includes("data-siyuan")) {
      return null;
    }

    // 公式可能躺在 data-siyuan 注释里，而且选区内每个块各有一条
    const commentHtml = extractSiyuanComments(siyuanHTML).join("");
    if (!outerHasMath && !hasMathNodes(commentHtml)) {
      return null;
    }

    // 这里别想着借 Lute.BlockDOM2Md 一把梭。实测把块 DOM 直接喂给它，
    // 它会原样吐回 HTML（带 language-math 包装和 &amp; 实体），根本不是 Markdown。
    // 自己抽占位符 + Turndown 虽然笨，但行为可预测。
    let source = holder;
    let segments = extractMathNodes(source);

    if (segments.length === 0 && commentHtml) {
      const fromComment = document.createElement("div");
      fromComment.innerHTML = commentHtml;
      fromComment.querySelectorAll(".protyle-attr").forEach((node) => node.remove());
      const extracted = extractMathNodes(fromComment);
      if (extracted.length > 0) {
        source = fromComment;
        segments = extracted;
        this.log("复制：公式节点在 data-siyuan 注释里，已从那里还原");
      }
    }

    if (segments.length === 0) {
      return null;
    }
    // 先把思源的块结构（列表 / 标题 / 引用 / 代码块）翻译成标准 HTML 标签。
    // 不翻译的话 Turndown 认不出来，列表符号、## 标题、> 引用会整个丢掉。
    const normalized = renderSiyuanBlocks(source);
    // 块级公式还原时会带出前后空行，连续几段就会堆成一堆空行。
    // 折叠时空行只在代码块外面压 —— 代码里的空行是有意义的
    const markdown = collapseBlankLines(
      restoreMath(this.turndownService().turndown(normalized.innerHTML), segments),
    ).trim();
    if (!markdown) {
      return null;
    }
    return markdown;
  }

  /** 一个 Range → Markdown */
  private rangeToMarkdown(range: Range): string | null {
    const anchor = range.commonAncestorContainer;
    const element =
      anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement);
    if (!element || typeof element.closest !== "function" || !element.closest(".protyle-wysiwyg")) {
      return null;
    }

    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    return this.renderMarkdown(holder);
  }

  /** 当前选区 → Markdown */
  private selectionToMarkdown(): string | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    return this.rangeToMarkdown(selection.getRangeAt(0));
  }

  private async writeMarkdown(result: string | null) {
    if (!result) {
      showMessage(this.i18n.commandCopyEmpty);
      return;
    }
    const ok = await this.writeToClipboard(result);
    showMessage(ok ? this.i18n.commandCopyDone : this.i18n.commandCopyFailed);
    if (ok) {
      this.log("复制：已写入剪贴板", { markdown: result });
    }
  }

  /**
   * 写系统剪贴板。
   *
   * navigator.clipboard 在窗口失去焦点时会抛 NotAllowedError —— 多窗口切换、
   * 点完菜单焦点转移都可能触发，这时退回老接口再试一次。
   */
  private async writeToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn("[latex-paste] clipboard API 失败，改用 execCommand", error);
    }
    let area: HTMLTextAreaElement | null = null;
    try {
      area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      return document.execCommand("copy");
    } catch (error) {
      console.error("[latex-paste] 写入剪贴板失败", error);
      return false;
    } finally {
      // 失败时也要收走，否则临时 textarea 会留在 DOM 里
      area?.remove();
    }
  }

  /**
   * 显式命令兜底。
   * 思源菜单里的「复制富文本」是自己写系统剪贴板的，不经过 DOM copy 事件，
   * 所以复制只能走「主动调用」这条路。
   */
  private copyAsMarkdown = async () => {
    // 有选中内容就按选区转；没有选区就退化成「光标所在的那个块」，
    // 这样绑了快捷键之后不需要先精确选中一段文字。
    let result = this.selectionToMarkdown();
    if (!result) {
      const block = this.currentBlock();
      if (block) {
        result = this.blocksToMarkdown([block]);
      }
    }
    await this.writeMarkdown(result);
  };

  /** 光标所在的块元素（思源的块都带 data-node-id） */
  private currentBlock(): HTMLElement | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const anchor = selection.anchorNode;
    const element =
      anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement | null);
    if (!element || typeof element.closest !== "function") {
      return null;
    }
    const root = element.closest(".protyle-wysiwyg");
    if (!root) {
      return null;
    }

    // 光标停在列表项、表格单元格、引用块里面时，「最近的那个块」只是一段文字。
    // 只复制它的话，列表符号、表格、引用结构全没了。所以往上爬到编辑器下的第一层块。
    // 到编辑器根就停：有些版本给 .protyle-wysiwyg 本身也挂了 data-node-id，
    // 不挡住的话「光标所在的块」会变成整篇文档。
    let block = element.closest("[data-node-id]") as HTMLElement | null;
    while (block && block !== root) {
      const parent = block.parentElement?.closest("[data-node-id]") as HTMLElement | null;
      if (!parent || parent === root || !root.contains(parent)) {
        break;
      }
      block = parent;
    }
    return block;
  }

  /**
   * 块图标菜单。
   *
   * 思源复制时会 preventDefault 再用 Electron 异步写系统剪贴板，
   * DOM copy 事件里改的数据会被它覆盖掉，所以从块的 DOM 主动生成才稳。
   */
  private onBlockIcon = ({ detail }: any) => {
    const blocks: HTMLElement[] = detail?.blockElements ?? [];
    const menu = detail?.menu;
    if (!blocks.length || !menu || typeof menu.addItem !== "function") {
      return;
    }
    // 块里没有公式时这条命令什么也复制不出来（renderMarkdown 会直接返回空），
    // 挂上去只会让用户点完收到一句「没有公式」。和右键菜单保持一致：有公式才出现
    if (!blocks.some((block) => hasMathNodes(block.innerHTML))) {
      return;
    }
    menu.addItem({
      icon: "iconCopy",
      label: this.i18n.commandCopyAsMarkdown,
      click: () => {
        void this.writeMarkdown(this.blocksToMarkdown(blocks));
      },
    });
  };

  /**
   * 内容区右键菜单（选中文字后右键）。
   *
   * 只在选中的内容里确实有公式时才加这一项，免得平时右键也挂一条用不上的。
   * Markdown 在弹出菜单时就算好，点击时直接用 —— 菜单弹出后选区可能已经变了。
   */
  private onContentMenu = ({ detail }: any) => {
    const menu = detail?.menu;
    if (!menu || typeof menu.addItem !== "function") {
      return;
    }

    const range: Range | undefined = detail?.range;
    const result = range ? this.rangeToMarkdown(range) : this.selectionToMarkdown();
    if (!result) {
      return;
    }

    menu.addItem({
      icon: "iconCopy",
      label: this.i18n.commandCopyAsMarkdown,
      click: () => {
        void this.writeMarkdown(result);
      },
    });
  };

  /** 一组块的 DOM → Markdown */
  private blocksToMarkdown(blocks: HTMLElement[]): string | null {
    const holder = document.createElement("div");
    for (const block of blocks) {
      holder.appendChild(block.cloneNode(true));
    }
    return this.renderMarkdown(holder);
  }

  private turndownService(): TurndownService {
    if (!this.turndown) {
      this.turndown = new TurndownService({
        headingStyle: "atx",
        hr: "---",
        bulletListMarker: "-",
        codeBlockStyle: "fenced",
        emDelimiter: "*",
        strongDelimiter: "**",
        linkStyle: "inlined",
      });
      this.turndown.use(gfm);
      this.turndown.remove(["script", "style", "noscript", "meta", "link"]);
      // turndown-plugin-gfm 的删除线只输出单个 ~，GitHub / Obsidian 都要求 ~~，
      // 单个波浪线过去就是一串普通文字。这条规则排在 gfm 后面，优先级更高
      this.turndown.addRule("doubleTildeStrike", {
        filter: ["s", "del"],
        replacement: (content) => `~~${content}~~`,
      });
      // Turndown 默认写成 "-   文本"（标记后三个空格），虽然各家解析器都认，
      // 但和手写的 Markdown 放在一起会显得很怪，统一成单空格
      this.turndown.addRule("compactListItem", {
        filter: "li",
        replacement: (content, node, options) => {
          const parent = node.parentNode as HTMLElement | null;
          let prefix = `${options.bulletListMarker} `;
          if (parent && parent.nodeName === "OL") {
            const start = Number(parent.getAttribute("start") ?? 1);
            const index = Array.prototype.indexOf.call(parent.children, node);
            prefix = `${start + index}. `;
          }
          const body = content
            .replace(/^\n+/, "")
            .replace(/\n+$/, "\n")
            .split("\n")
            // 续行缩进 4 空格才留在列表项里；空行不缩进，否则会留下一行满是空格
            .map((line, index) => (index === 0 || line.trim() === "" ? line : `    ${line}`))
            .join("\n");
          return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
        },
      });
    }
    return this.turndown;
  }

  private htmlToMarkdown(html: string): { markdown: string; count: number; skipped: number } {
    let bodyHtml = html;
    const segments: MathSegment[] = [];
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (doc.body) {
        // 从渲染过的网页复制时，公式已经变成 KaTeX/MathJax 的 DOM，纯文本里的 $ 早没了。
        // 趁还在 DOM 上把 LaTeX 源码捞回来，否则这条路径救不回来。
        extractMathNodes(doc.body as unknown as HTMLElement, segments);
        bodyHtml = doc.body.innerHTML;
      }
    } catch {
      // DOMParser 不可用时直接用原始字符串
    }

    const stashed = stashMathInHtml(bodyHtml, segments);
    const restored = restoreMath(this.turndownService().turndown(stashed.html), segments);
    const result = convertLatex(restored);
    // 块级公式还原时会前后各带一个空行，和段落之间原有的空行叠起来就是三四个，
    // 粘进思源会多出空段落。和复制路径用同一套折叠规则
    const markdown = collapseBlankLines(result.text);
    // 已还原成思源公式的部分 + 转换阶段新处理的定界符
    return { markdown, count: segments.length + result.count, skipped: stashed.skipped };
  }

  /**
   * 光标在代码块 / 行内代码里时不做任何转换。
   *
   * DOM 路径直接传粘贴目标元素，比看 selection 更准
   * （鼠标在别处、或用快捷键触发时，selection 未必停在粘贴点上）。
   */
  private isInCodeContext(target?: Element | null): boolean {
    let element: Element | null = target ?? null;
    if (!element) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return false;
      }
      const anchor = selection.anchorNode;
      if (!anchor) {
        return false;
      }
      element =
        anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement);
    }
    if (!element || typeof element.closest !== "function") {
      return false;
    }
    return Boolean(
      element.closest('[data-type="NodeCodeBlock"]') || element.closest("code"),
    );
  }
};
