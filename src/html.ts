/**
 * HTML → Markdown，并把 LaTeX 公式先抽成占位符。
 *
 * 为什么不能直接转：Turndown 会把 LaTeX 里的反斜杠当 Markdown 转义符
 * （\frac → \\frac），公式就废了。所以先把公式片段换成占位符，
 * 转成 Markdown 之后再按原样还原成 $...$ / $$...$$。
 */

import { LATEX_ENV_NAMES, looksLikeMath } from "./latex";

export interface MathSegment {
  /** 原始 LaTeX（已去掉定界符） */
  latex: string;
  /** 是否块级公式 */
  display: boolean;
}

export interface StashResult {
  html: string;
  segments: MathSegment[];
  /** 因为落在代码块里而被跳过的公式个数（含 LaTeX 定界符的那几种） */
  skipped: number;
}

/** 一条正则覆盖各种写法，用命名组区分类型 */
const MATH_IN_TEXT = new RegExp(
  [
    // 所有定界符前面都要求「反斜杠不成对」，即没被转义过。
    // \[ 是定界符，\\[ 只是字面文本；\$ 同理。
    `(?<!\\\\)\\$\\$(?<dollar>[\\s\\S]*?)(?<!\\\\)\\$\\$`, // $$ ... $$
    `(?<!\\\\)\\\\\\[(?<bracket>[\\s\\S]*?)(?<!\\\\)\\\\\\]`, // \[ ... \]
    `(?<!\\\\)\\\\\\((?<paren>[\\s\\S]*?)(?<!\\\\)\\\\\\)`, // \( ... \)
    `(?<!\\\\)\\\\begin\\{(?<envName>${LATEX_ENV_NAMES})\\}(?<envBody>[\\s\\S]*?)(?<!\\\\)\\\\end\\{\\k<envName>\\}`,
    `(?<!\\\\)\\$(?<mdInline>[^$\\n]{1,200}?)\\$(?!\\d)`, // $ ... $
  ].join("|"),
  "gu",
);

const OPEN = "\uE000";
const CLOSE = "\uE001";

const token = (index: number) => `${OPEN}${index}${CLOSE}`;

export const HTML_TOKEN_RE = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/** 整行只有一个占位符（行首最多带缩进和 `>`）—— 块级公式最常见的样子 */
const TOKEN_LINE_RE = new RegExp(`^([ \\t>]*)${OPEN}(\\d+)${CLOSE}[ \\t]*$`, "gm");

/**
 * 代码类标签的开合。
 *
 * 这些区域里的 `\(`、`$` 只是普通字符：网页里的代码示例经常带 LaTeX 源码，
 * 抽成公式会让代码变样（`\(` 变成 `$`、块级公式还会把代码块撑开）。
 */
const CODE_TAG_RE = /^<\s*(\/?)\s*(?:pre|code|script|style)\b/i;

/** 把一段纯文本里的公式抽成占位符 */
function stashInText(text: string, segments: MathSegment[]): string {
  return text.replace(MATH_IN_TEXT, (matched, ...rest) => {
    const groups = (rest[rest.length - 1] ?? {}) as Record<string, string | undefined>;
    // 标签之间的文本还是 HTML 源码，< 写作 &lt;、& 写作 &amp;。
    // 公式被抽成占位符后就躲过了 Turndown 的实体解码，所以这里必须先还原，
    // 否则 |\zeta|&lt;1、align 里的 &amp; 会原封不动留在公式里。
    const dollar = decodeOne(groups.dollar);
    const bracket = decodeOne(groups.bracket);
    const paren = decodeOne(groups.paren);
    const envName = groups.envName;
    const envBody = decodeOne(groups.envBody);
    const mdInline = decodeOne(groups.mdInline);

    if (dollar !== undefined) {
      segments.push({ latex: dollar.trim(), display: true });
    } else if (bracket !== undefined) {
      segments.push({ latex: bracket.trim(), display: true });
    } else if (paren !== undefined) {
      segments.push({ latex: paren.trim(), display: false });
    } else if (envName !== undefined) {
      segments.push({ latex: `\\begin{${envName}}${envBody ?? ""}\\end{${envName}}`, display: true });
    } else if (mdInline !== undefined) {
      // $5 到 $10 这类不是公式，放过
      if (!looksLikeMath(mdInline.trim())) {
        return matched;
      }
      segments.push({ latex: mdInline.trim(), display: false });
    } else {
      return matched;
    }

    return token(segments.length - 1);
  });
}

function decodeOne(value: string | undefined): string | undefined {
  return value === undefined ? undefined : decodeEntities(value);
}

/**
 * 代码块里没被抽取的公式个数。
 *
 * 这些定界符在 HTML 里是代码，不能转；但纯文本那份载荷里它们照样会被算成
 * 「公式」。调用方拿这个数去对账，才不会误判成「HTML 把公式抽丢了」而回退。
 */
function countSkipped(text: string): number {
  let total = 0;
  for (const match of text.matchAll(MATH_IN_TEXT)) {
    const groups = match.groups ?? {};
    // 只数 countLatexDelimiters 也认的那几种（\( \)、\[ \]、环境），
    // 否则 $ … $ 会让这个数虚高，把真丢公式的 HTML 放过去
    if (groups.bracket !== undefined || groups.paren !== undefined || groups.envName !== undefined) {
      total += 1;
    }
  }
  return total;
}

/**
 * 在 HTML 字符串上抽公式，只处理标签之间的文本片段。
 * PDF / 网页复制时公式有可能被拆进多个 span，这类情况这里抓不全，
 * 调用方需要用 textPlain 的公式数量做兜底判断。
 */
export function stashMathInHtml(html: string, segments: MathSegment[] = []): StashResult {
  if (!html) {
    return { html: "", segments, skipped: 0 };
  }

  // <br> 会把 \[ 和公式内容切成互不相干的文本片段，先摊平成换行
  // （从网页、ChatGPT 复制的块级公式经常是这样）
  const source = html.replace(/<br\s*\/?>/gi, "\n");

  // 用数组收集再 join：整页网页的 HTML 可能有上百万字符，
  // 逐次 += 拼接在大字符串上会退化成 O(n²)
  const chunks: string[] = [];
  let cursor = 0;
  let codeDepth = 0;
  let skipped = 0;
  const tagRe = /<[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(source)) !== null) {
    if (match.index > cursor) {
      const text = source.slice(cursor, match.index);
      if (codeDepth > 0) {
        // 代码里的 \( 和 $ 只是普通字符，抽成公式会让代码块变形
        chunks.push(text);
        skipped += countSkipped(text);
      } else {
        chunks.push(stashInText(text, segments));
      }
    }
    const tag = match[0];
    const boundary = CODE_TAG_RE.exec(tag);
    if (boundary) {
      if (boundary[1]) {
        codeDepth = Math.max(0, codeDepth - 1);
      } else if (!/\/>$/.test(tag)) {
        codeDepth += 1;
      }
    }
    chunks.push(tag);
    cursor = match.index + tag.length;
  }
  if (cursor < source.length) {
    const rest = source.slice(cursor);
    if (codeDepth > 0) {
      chunks.push(rest);
      skipped += countSkipped(rest);
    } else {
      chunks.push(stashInText(rest, segments));
    }
  }

  return { html: chunks.join(""), segments, skipped };
}

/**
 * 占位符所在那一行的行首前缀：空格缩进、以及引用块的 `>`。
 *
 * 还原出来的 `$$` 必须带着同样的前缀，否则块级公式会从列表项 / 引用块里
 * 掉出来（Markdown 靠缩进和 `>` 判断归属），列表会被一条公式拦腰截断。
 */
function linePrefix(markdown: string, offset: number): { prefix: string; line: string } {
  const lineStart = markdown.lastIndexOf("\n", offset - 1) + 1;
  let lineEnd = markdown.indexOf("\n", offset);
  if (lineEnd === -1) {
    lineEnd = markdown.length;
  }
  const head = markdown.slice(lineStart, offset);
  return {
    // 只有「纯结构字符」才算前缀；普通文字前面那部分不是前缀
    prefix: /^[ \t>]*$/.test(head) ? head : "",
    line: markdown.slice(lineStart, lineEnd),
  };
}

/** 多行公式的每一行都要带上同样的前缀，否则除了首行都会掉出容器 */
function indentBody(body: string, prefix: string): string {
  return body
    .split("\n")
    .map((row) => (row.trim() === "" ? "" : prefix + row))
    .join("\n");
}

/**
 * 把 Markdown 里的占位符还原成思源公式。
 *
 * 分两步：
 * 1. 整行就是占位符的（块级公式），连行首前缀一起替换 —— 前缀留在原地的话
 *    会多出一行「只剩缩进的空壳」，还平白多出两个空行。
 * 2. 夹在文字中间的（行内公式、表格单元格里的），就地替换。
 */
export function restoreMath(markdown: string, segments: MathSegment[]): string {
  if (!segments.length) {
    return markdown;
  }

  const bodyOf = (index: number): string | null => {
    const segment = segments[index];
    return segment ? segment.latex.replace(/(?<!\\)\$/g, "\\$") : null;
  };

  let out = markdown.replace(TOKEN_LINE_RE, (_matched, prefix: string, index: string) => {
    const body = bodyOf(Number(index));
    if (body === null) {
      return "";
    }
    if (!segments[Number(index)].display) {
      return `${prefix}$${body}$`;
    }
    // 有前缀（列表缩进、引用 >）说明公式已经在某个容器里，
    // 空行由容器的块结构提供，这里再加就会把容器撑断。
    // 没有前缀才需要自己补空行，让思源把它当成独立的块级公式
    if (prefix) {
      return `${prefix}$$\n${indentBody(body, prefix)}\n${prefix}$$`;
    }
    return `\n\n$$\n${body}\n$$\n\n`;
  });

  out = out.replace(HTML_TOKEN_RE, (_matched, index: string, offset: number) => {
    const body = bodyOf(Number(index));
    if (body === null) {
      return "";
    }
    const { prefix, line } = linePrefix(out, offset);
    // 单元格里塞不下 `$$` 多行公式：还原出的换行会把表格的一行拆成好几行，
    // 整张表当场碎掉。表格里只能退成行内 `$…$`，连换行都要压成空格
    if (segments[Number(index)].display && !(line.trim().startsWith("|") && line.trim().length > 1)) {
      return `\n\n${prefix}$$\n${indentBody(body, prefix)}\n${prefix}$$\n\n`;
    }
    return `$${body.replace(/\s*\n\s*/g, " ")}$`;
  });

  return out;
}

/**
 * 公式节点的各种写法：思源的块级/行内，以及 KaTeX、MathJax 的渲染结果。
 *
 * 特意没放 `.render-node` —— 思源里嵌入块、数据库视图也是 render-node，
 * 一起匹配会把正常内容误当成公式替换掉。真正的公式块一定带 data-type 或 data-subtype。
 */
const MATH_NODE_SELECTOR = [
  '[data-type="NodeMathBlock"]',
  '[data-type="inline-math"]',
  '[data-subtype="math"]',
  "span.katex",
  "span.math",
].join(",");

/** 从公式节点里读 LaTeX 源码 */
function readLatex(node: HTMLElement): string {
  const own = node.getAttribute("data-content");
  if (own && own.trim()) {
    return decodeEntities(own).trim();
  }
  // KaTeX / MathJax 会把源码放在 annotation 里（从渲染过的网页复制时靠这个救回来）
  const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
  if (annotation?.textContent?.trim()) {
    return decodeEntities(annotation.textContent).trim();
  }
  const child = node.querySelector("[data-content]");
  const nested = child?.getAttribute("data-content");
  if (nested && nested.trim()) {
    return decodeEntities(nested).trim();
  }
  return "";
}

function isDisplayNode(node: HTMLElement): boolean {
  const type = node.getAttribute("data-type") || "";
  if (type === "NodeMathBlock") {
    return true;
  }
  if (type === "inline-math") {
    return false;
  }
  if (node.classList.contains("katex") || node.classList.contains("math")) {
    return false;
  }
  return node.tagName === "DIV";
}

/**
 * 把 DOM 里的公式节点原地换成占位符，返回抽出来的公式。
 * 调用方拿到 segments 后走一遍 Markdown 转换，再用 restoreMath 还原成 $ … $ / $$ … $$。
 */
export function extractMathNodes(root: HTMLElement, segments: MathSegment[] = []): MathSegment[] {
  if (!root || typeof root.querySelectorAll !== "function") {
    return segments;
  }

  const nodes = Array.from(root.querySelectorAll(MATH_NODE_SELECTOR)) as HTMLElement[];

  for (const node of nodes) {
    // 外层节点顺手把内层一起换掉了，内层已经从树里脱离，不能再处理一遍
    if (!root.contains(node)) {
      continue;
    }
    // 代码块里的公式标记只是代码内容（别人贴的 HTML 示例就长这样）
    if (typeof node.closest === "function" && node.closest("pre, code")) {
      continue;
    }
    const latex = readLatex(node);
    if (!latex) {
      continue;
    }
    const display = isDisplayNode(node);
    segments.push({ latex, display });
    const text = token(segments.length - 1);

    // 块级公式要保留「块」的身份：换成纯文本节点的话，它就和前一段粘连在一起，
    // 在列表项里（段落被拆掉 <p> 的地方）直接拼成「由定义$$\n…」，列表被撑断。
    // 表格单元格例外 —— 单元格里多一个块就会把整行表格拆散。
    const inCell = typeof node.closest === "function" && node.closest("td, th") !== null;
    if (display && !inCell) {
      const block = document.createElement("div");
      block.textContent = text;
      node.replaceWith(block);
      continue;
    }
    node.replaceWith(document.createTextNode(text));
  }
  return segments;
}

/**
 * 思源的「复制富文本」会把完整的块 HTML 塞进 text/html 的注释里（base64）。
 *
 * 外层的 HTML 只是给外部软件看的简化版，里面可能连公式节点都没有；
 * 真正的 data-content 躺在注释里。想还原公式就得往注释里翻。
 *
 * 注意是**多个**：选区内有几个块，就可能有几个注释。只取第一个会把
 * 后面几个块的公式整段漏掉，所以全部解出来按顺序拼接。
 */
export function extractSiyuanComments(html: string): string[] {
  if (!html || !html.includes("data-siyuan")) {
    return [];
  }
  const results: string[] = [];
  const re = /<!--data-siyuan='([A-Za-z0-9+/=\s]+)'-->/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    try {
      const binary = atob(match[1].replace(/\s+/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const decoded = new TextDecoder("utf-8").decode(bytes);
      if (decoded) {
        results.push(decoded);
      }
    } catch {
      // 单个注释解不开就跳过，别影响其他块
    }
  }
  return results;
}

/**
 * HTML 里有没有公式节点。
 *
 * 从渲染过的网页复制时，纯文本里的 $ 早就被吃掉了，光看文本是判断不出来的，
 * 得看 HTML 里有没有 KaTeX/MathJax 这类公式标记。
 *
 * 这是「要不要处理」的总闸门，漏判就等于整个粘贴不生效，所以宁可宽松：
 * 属性值单双引号都认，class 也按单词边界匹配（katex-display 同样算）。
 */
const MATH_NODE_HINT =
  /data-type=["'](?:NodeMathBlock|inline-math)["']|data-subtype=["']math["']|class=["'][^"']*\b(?:katex|math)\b|encoding=["']application\/x-tex["']/i;

export function hasMathNodes(html: string): boolean {
  if (!html) {
    return false;
  }
  return MATH_NODE_HINT.test(html);
}

/**
 * 还原 HTML 实体。
 *
 * 经过 DOM 序列化再转 Markdown 之后，公式里的 < 会变成 &lt;、& 会变成 &amp;
 * （比如 |\zeta|<1、align 环境的 &）。不还原的话 LaTeX 就废了。
 */
const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * 只认常见命名实体 + 任意数字实体，不交给 DOM 解析。
 *
 * 用 textarea.innerHTML 那种写法看着省事，但公式里本来就可能出现裸 <，
 * 会被当成标签吃掉。一次正则扫完也不会有「替换出来的 &lt; 又被二次替换」的连锁问题。
 *
 * 数字实体必须支持：思源把公式里的换行存成 `&#10;`，多行 align 环境全靠它，
 * 不解出来整个公式会挤成一行。
 */
const ENTITY_RE = /&(?:(lt|gt|amp|quot|apos|nbsp)|#(\d+)|#[xX]([0-9a-fA-F]+));/g;

export function decodeEntities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }
  return text.replace(
    ENTITY_RE,
    (matched, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
      if (name) {
        return ENTITIES[name.toLowerCase()] ?? matched;
      }
      const code = dec !== undefined ? Number(dec) : parseInt(hex ?? "", 16);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
        return matched;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return matched;
      }
    },
  );
}

/** 粗略去掉标签，用来统计公式数量 / 判断是否还有残留定界符 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, "");
}
