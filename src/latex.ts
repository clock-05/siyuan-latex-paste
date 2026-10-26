/**
 * LaTeX 定界符 → 思源公式语法的纯文本转换。
 *
 * 思源（Lute / KaTeX）原生语法：
 *   行内公式   $E=mc^2$
 *   块级公式   $$
 *              E=mc^2
 *              $$
 *
 * 常见来源的写法（思源不认）：
 *   \( ... \)            LaTeX 标准行内
 *   \[ ... \]            LaTeX 标准块级
 *   \begin{equation} …   LaTeX 环境
 *   \begin{align} …
 *
 * 这个模块只处理字符串，不依赖 DOM，方便直接跑单元测试。
 */

export interface LatexConvertOptions {
  /** \( ... \)  →  $ ... $ */
  inline: boolean;
  /** \[ ... \]  →  $$ ... $$（一律块级） */
  display: boolean;
  /** \begin{equation} / align / gather 等环境 → $$ ... $$ */
  environments: boolean;
}

export interface LatexConvertResult {
  text: string;
  /** 实际转换掉的公式个数，0 表示内容没有变化 */
  count: number;
}

export const DEFAULT_OPTIONS: LatexConvertOptions = {
  inline: true,
  display: true,
  environments: true,
};

/** 代码块 / 行内代码：这些区域里的内容一律不动 */
const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+)/g;

/** 已经是思源块级公式的内容，先整段保护起来 */
const DISPLAY_MATH = /\$\$[\s\S]*?\$\$/g;

/** KaTeX 认识、且通常独立成块的 LaTeX 环境。html.ts 也用它，别复制一份 */
export const LATEX_ENV_NAMES =
  "equation\\*?|align\\*?|alignat\\*?|flalign\\*?|gather\\*?|multline\\*?|eqnarray\\*?|displaymath|math";

/**
 * 定界符前的反斜杠必须是「奇数个」，也就是没有被转义过。
 *
 * 内容一旦经过 Markdown 转义，\[ 会变成 \\\[，这时候它表示的是字面文本而不是定界符，
 * 再处理就会拼出 \$ … \$ 这种畸形结果。前面的 (?<!\\) 就是为了挡住这种情况。
 */
const ENV_RE = new RegExp(
  `(?<!\\\\)\\\\begin\\{(${LATEX_ENV_NAMES})\\}([\\s\\S]*?)(?<!\\\\)\\\\end\\{\\1\\}`,
  "g",
);
const BRACKET_RE = /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g;
const PAREN_RE = /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g;

const PLACEHOLDER_OPEN = "\u0000";
const PLACEHOLDER_CLOSE = "\u0001";

const placeholder = (index: number) => `${PLACEHOLDER_OPEN}M${index}${PLACEHOLDER_CLOSE}`;

/** 还原占位符用；提出来避免每个片段都重新编译一次正则 */
const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_OPEN}M(\\d+)${PLACEHOLDER_CLOSE}`, "g");

/** 生成行内公式。内容里的 $ 需要转义，否则会破坏定界。 */
function inlineMath(inner: string): string {
  const body = inner.trim();
  if (!body) {
    return "";
  }
  return `$${body.replace(/(?<!\\)\$/g, "\\$")}$`;
}

/** 生成块级公式，前后留空行让它独立成块 */
function blockMath(inner: string): string {
  const body = inner.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "").trim();
  if (!body) {
    return "";
  }
  return `\n\n$$\n${body.replace(/(?<!\\)\$/g, "\\$")}\n$$\n\n`;
}

/** 判断「独占一行」时最多往两侧看多少字符：再长只能是空白，当行首/行尾即可 */
const STANDALONE_SCAN = 512;

/**
 * 判断一段内容是否独占一行。
 * 只用来决定 $$ ... $$ 要不要原样保留：独占行时思源自己就能解析成公式块。
 *
 * 这里逐字符往两边扫，**不能**用 whole.slice(0, offset) 再跑正则 ——
 * 一次粘贴可能有上万个公式，每次都切一遍整篇就是 O(n²)（实测 20k 个 \[ \] 要 3.4 秒）。
 */
function isStandalone(whole: string, offset: number, length: number): boolean {
  const isBlank = (ch: string) => ch === " " || ch === "\t" || ch === "\r";

  for (let i = offset - 1, steps = 0; i >= 0 && steps < STANDALONE_SCAN; i -= 1, steps += 1) {
    const ch = whole[i];
    if (ch === "\n") {
      break;
    }
    if (!isBlank(ch)) {
      return false;
    }
  }
  for (let i = offset + length, steps = 0; i < whole.length && steps < STANDALONE_SCAN; i += 1, steps += 1) {
    const ch = whole[i];
    if (ch === "\n") {
      return true;
    }
    if (!isBlank(ch)) {
      return false;
    }
  }
  return true;
}

/**
 * 两个定界符之间写的是「一段话」，不是公式。
 *
 * 行中间的 $$ 会被升级成公式块。万一文中有一个落单的 $$，它会和几百字之后
 * 的下一个 $$ 配成一对，把整段中文包进公式里 —— 这比不转换更糟。
 * 判据刻意收得很窄：**含中文，且一个数学符号都没有**。正常公式里哪怕有
 * \text{若}，前面也有反斜杠，不会被误判。
 */
function looksLikeProse(body: string): boolean {
  if (!/[\u4e00-\u9fa5]/.test(body)) {
    return false;
  }
  return !/[\\^_=<>+\-*/]/.test(body);
}

/**
 * 内容中间夹着空行 —— 说明这两个定界符根本配不成一对。
 *
 * 公式（行内也好、块级也好）都不可能跨空行存在：Markdown 遇到空行就把段落断开，
 * 公式在那之前就结束了。所以跨空行的「公式」一定是文档里落单的定界符抓错了搭档，
 * 硬转只会把前后两段正文吞进来。
 */
function spansParagraphs(body: string): boolean {
  return /\n[ \t]*\n/.test(body);
}

/**
 * 内容里有没有换行。
 *
 * 专门给 `\( ... \)` 用：思源（Lute）的行内公式**不能跨行** ——
 * `parse/inline_math.go` 的 `matchInlineMathEnd` 一遇到 `\n` 就返回 -1，
 * 于是 `$a\nb$` 根本不是公式，只会在正文里留下两个多余的 `$`。
 * 所以跨行的 `\( ... \)` 一律不转：要么是排版断开的，要么是落单的定界符配错了对。
 */
function spansLines(body: string): boolean {
  return body.includes("\n");
}

/**
 * 去掉代码段（围栏代码块 / 行内代码），只留下正文。
 *
 * 检测阶段必须和转换阶段用同一套「哪里算代码」的规则：代码里的 \( ... \)
 * 只是普通字符，算进公式数量会让「HTML 里公式抽全了没有」这个比较得出错误结论。
 */
function stripCode(input: string): string {
  return input
    .split(CODE_SEGMENT)
    .map((part, index) => (index % 2 === 1 ? "" : part))
    .join("");
}

/** 处理一段「非代码」文本 */
function convertSegment(segment: string, options: LatexConvertOptions): LatexConvertResult {
  let count = 0;
  // 只有真的插入了块级公式才需要压缩空行，否则会把原文里连续空行也一起压掉
  let blockInserted = false;
  const stash: string[] = [];

  // 1. 已经是 $$ ... $$ 的：独占行就原样保护，夹在文字中间就必须升级成公式块。
  //
  // 为什么非改不可：思源编辑器（Protyle）里，行中间的 $$ 不会被当成公式块。
  // Lute 的 inline_math.go 里有这么一条分支 —— ProtyleWYSIWYG 时「不允许从行级派生块级」，
  // 遇到 $$ 只吃掉一个 $ 当普通文本，剩下的那个 $ 就去和后面公式的 $ 配对：
  //   设 $$ A(z) $$ 记Levi矩阵 $$ B(z) $$
  // 会被切成一堆行内公式，连中文段落都被吞进公式里，\begin{aligned} 也会丢掉 \end{aligned}。
  // 用户看到的就是「公式环境不匹配」。所以这里把行中间的 $$ 整体搬到独立行上。
  let text = segment.replace(
    DISPLAY_MATH,
    (matched: string, offset: number, whole: string) => {
      if (isStandalone(whole, offset, matched.length)) {
        stash.push(matched);
        return placeholder(stash.length - 1);
      }
      const inner = matched.slice(2, -2);
      // 落单的 $$ 可能一直配到后文去，中间隔着整段中文或空行。这种不要包成公式
      if (looksLikeProse(inner) || spansParagraphs(inner)) {
        stash.push(matched);
        return placeholder(stash.length - 1);
      }
      const converted = blockMath(inner);
      if (!converted) {
        stash.push(matched);
        return placeholder(stash.length - 1);
      }
      count++;
      blockInserted = true;
      // 必须也收进 stash：下面第 2 步还要处理 \begin{align} 这类环境，
      // 刚生成的 $$ 块如果不藏起来，里面的环境会被再包一层 $$，整段直接炸掉。
      stash.push(converted);
      return placeholder(stash.length - 1);
    },
  );

  // 2. LaTeX 环境
  if (options.environments) {
    text = text.replace(ENV_RE, (matched: string, env: string, body: string) => {
      const converted = blockMath(`\\begin{${env}}${body}\\end{${env}}`);
      if (!converted) {
        return matched;
      }
      count++;
      blockInserted = true;
      // 和第 1 步一样藏起来：环境体里可能还带着 \[ \]，不能让它再被包一层
      stash.push(converted);
      return placeholder(stash.length - 1);
    });
  }

  // 3. \[ ... \] —— LaTeX 的块级定界符，一律当公式块。
  //
  // 夹在句子中间也是块：`由 \[x=1\] 可得` 会被切成「由」/ 公式 /「可得」三段。
  // 这是刻意的取舍 —— 公式是主体，显示效果优先于段落连贯；降级成行内反而会让
  // 带 \int、\sum 的式子挤成一团，上下标全靠右。
  if (options.display) {
    text = text.replace(
      BRACKET_RE,
      (matched: string, inner: string, offset: number, whole: string) => {
        // 句子中间的 \[见附录\] 不是公式，跨空行的更不是，都原样留着
        if (
          !isStandalone(whole, offset, matched.length) &&
          (looksLikeProse(inner) || spansParagraphs(inner))
        ) {
          return matched;
        }
        const converted = blockMath(inner);
        if (!converted) {
          return matched;
        }
        count++;
        blockInserted = true;
        // 同样收进 stash：后面还有 \( ... \) 一步，别让它钻进来
        stash.push(converted);
        return placeholder(stash.length - 1);
      },
    );
  }

  // 4. \( ... \)
  if (options.inline) {
    text = text.replace(PAREN_RE, (matched: string, inner: string) => {
      // 两个反斜杠括号之间夹着一整段中文、或者跨了行：不转。
      // 思源的行内公式不能跨行（Lute 的 matchInlineMathEnd 见到 \n 就放弃），
      // 硬转只会得到 `$a\nb$` 这种既不渲染、又留下两个多余 $ 的畸形结果
      if (looksLikeProse(inner) || spansLines(inner)) {
        return matched;
      }
      count++;
      return inlineMath(inner);
    });
  }

  // 5. 还原被保护的块级公式
  if (stash.length > 0) {
    text = text.replace(PLACEHOLDER_RE, (_matched, index: string) => stash[Number(index)]);
  }

  // 块级公式前后会堆出多余空行，压回最多一空行
  if (blockInserted) {
    text = text.replace(/\n{3,}/g, "\n\n");
  }

  return { text, count };
}

/**
 * 把文本里的 LaTeX 定界符转换成思源公式语法。
 * 代码块、行内代码、已有的 $$ 公式都会被跳过。
 */
export function convertLatex(input: string, options: LatexConvertOptions = DEFAULT_OPTIONS): LatexConvertResult {
  if (!input) {
    return { text: input, count: 0 };
  }

  const parts = input.split(CODE_SEGMENT);
  let count = 0;

  const output = parts.map((part, index) => {
    // split 带捕获组时，奇数位是代码段，原样保留
    if (index % 2 === 1) {
      return part;
    }
    const result = convertSegment(part, options);
    count += result.count;
    return result.text;
  });

  return { text: output.join(""), count };
}

/**
 * Markdown 公式定界符 $ ... $ / $$ ... $$ 的检测。
 *
 * 从 ChatGPT、Claude 复制的内容里公式常常已经写成 $x^2+1=y$，这是思源的原生语法，
 * 但因为剪贴板同时带了 HTML，思源会走 HTML 分支而不做 Markdown 解析，公式就只是普通文字。
 * 检测到这类公式时需要把 HTML 降级掉。
 */

/** 内容是否像数学式子，用来避免把 $5 到 $10 之类的金额误判成公式 */
export function looksLikeMath(content: string): boolean {
  if (!content || content.length > 300) {
    return false;
  }
  // 含中文基本不可能是公式
  if (/[\u4e00-\u9fa5]/.test(content)) {
    return false;
  }
  if (!/[A-Za-z0-9]/.test(content)) {
    return false;
  }
  // 有明确的数学符号，基本可以断定是公式
  if (/[\^_\\=<>+\-*/]/.test(content)) {
    return true;
  }
  // 短的纯字母数字组合也算：$dA$、$dz$、$x$ 这类单个变量/微分非常常见，
  // 但之前会被漏掉，导致思源不把它当公式。
  // 限长 3 个字符 + 不允许空格：再宽就会把 $hello$ 这类普通词也当成公式。
  if (content.length <= 3 && /^[A-Za-z0-9]+$/.test(content)) {
    return true;
  }
  return false;
}

const MD_DISPLAY_RE = /\$\$[\s\S]{1,2000}?\$\$/;
const MD_INLINE_RE = /(?<!\\)\$(?!\$)(?!\s)([^$\n]{1,200})(?<!\s)\$(?!\d)/g;

export function hasMarkdownMath(input: string): boolean {
  if (!input) {
    return false;
  }
  // 代码里的 $$ 是普通字符，算进来会让整段代码被当成「含公式」而丢掉原有格式
  const body = stripCode(input);
  if (MD_DISPLAY_RE.test(body)) {
    return true;
  }
  const matches = body.match(MD_INLINE_RE);
  if (!matches) {
    return false;
  }
  return matches.some((matched) => looksLikeMath(matched.slice(1, -1)));
}

/** 统计公式个数，用于「HTML 转换是否丢公式」的兜底判断 */
export function countLatexDelimiters(input: string): number {
  if (!input) {
    return 0;
  }
  // 和 convertLatex 用同一套代码段规则：代码里的定界符不算，也不会被转换
  const body = stripCode(input);
  const paren = body.match(PAREN_RE)?.length ?? 0;
  const bracket = body.match(BRACKET_RE)?.length ?? 0;
  const env = body.match(ENV_RE)?.length ?? 0;
  return paren + bracket + env;
}
