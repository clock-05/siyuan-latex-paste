import test from "node:test";
import assert from "node:assert/strict";
import {
  convertLatex,
  countLatexDelimiters,
  hasMarkdownMath,
  looksLikeMath,
} from "./.build/latex.mjs";

const DEFAULT = { inline: true, display: true, environments: true };
const convert = (text, options = DEFAULT) => convertLatex(text, options);

test("行内公式 \\( ... \\) 转成 $ ... $", () => {
  assert.equal(convert("质能方程 \\(E=mc^2\\) 很著名").text, "质能方程 $E=mc^2$ 很著名");
});

test("块级公式 \\[ ... \\] 独占行时转成 $$ 块", () => {
  const result = convert("前文\n\n\\[\\int_0^1 x^2 dx\\]\n\n后文");
  assert.match(result.text, /\$\$\n\\int_0\^1 x\^2 dx\n\$\$/);
  assert.equal(result.count, 1);
});

test("\\[ ... \\] 夹在文字中间也做成公式块", () => {
  // 块级定界符一律当块：宁可把一句话切成三段，也不让带 \int 的式子挤成行内
  const result = convert("由 \\[x=1\\] 可得");
  assert.equal(result.text, "由 \n\n$$\nx=1\n$$\n\n 可得");
  assert.equal(result.count, 1);
});

test("equation 环境转成 $$ 块", () => {
  const result = convert("\\begin{equation}\na^2+b^2=c^2\n\\end{equation}");
  assert.match(result.text, /\$\$\n\\begin\{equation\}/);
  assert.equal(result.count, 1);
});

test("align 环境保留环境名", () => {
  const result = convert("\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}");
  assert.match(result.text, /\\begin\{align\}/);
  assert.match(result.text, /\\end\{align\}/);
});

test("已经是 $$ 的公式不会被二次包裹", () => {
  const input = "$$\nE=mc^2\n$$";
  assert.equal(convert(input).text.trim(), input.trim());
  assert.equal(convert(input).count, 0);
});

// ---- 行中间的 $$：思源编辑器不认「行级派生块级」----
// Lute 的 inline_math.go 里，ProtyleWYSIWYG 模式下遇到 $$ 只吃掉一个 $ 当文本，
// 剩下的 $ 会去和后面公式的 $ 配对，把中文吞进行内公式、把 \begin{aligned} 切成两半。

test("行中间的 $$ 升级成公式块", () => {
  const result = convert("设 $$ A(z)=\\left(x\\right) $$ 记Levi矩阵");
  assert.equal(result.text, "设 \n\n$$\nA(z)=\\left(x\\right)\n$$\n\n 记Levi矩阵");
  assert.equal(result.count, 1);
});

test("行中间的 aligned 环境不会被切碎", () => {
  const result = convert("设 $$ \\begin{aligned} a &= b\\\\ &= c \\end{aligned} $$ 完");
  assert.match(result.text, /\\begin\{aligned\} a &= b\\\\ &= c \\end\{aligned\}/);
  assert.equal(result.count, 1);
});

test("升级成公式块后，块内的 align 环境不会被再包一层", () => {
  const result = convert("设 $$ \\begin{align} x &= 1 \\end{align} $$ 完");
  // 只有一对外层 $$，里面直接是环境本身
  assert.equal((result.text.match(/\$\$/g) || []).length, 2);
  assert.match(result.text, /^\$\$\n\\begin\{align\}/m);
});

test("中文段落不会被行内公式吞掉", () => {
  const doc = [
    " 设 $$ f=\\sum_{j=1}^n f_j $$ 记Levi矩阵 $$ A(z)=\\left(x\\right) $$ ",
    "由于$\\varphi$是强多次调和函数，于是 $$ \\begin{aligned} a &= b\\\\ &= c \\end{aligned} $$ 完",
  ].join("\n");
  const result = convert(doc);

  assert.equal((result.text.match(/\$\$/g) || []).length % 2, 0, "$$ 必须成对");
  assert.doesNotMatch(result.text, /\$[^$\n]*[\u4e00-\u9fa5][^$\n]*\$/, "中文不该出现在公式里");
  assert.match(result.text, /记Levi矩阵/);
  assert.match(result.text, /由于\$\\varphi\$是强多次调和函数/);
});

test("行内公式内容里的 $ 会被转义", () => {
  assert.equal(convert("\\(a\\$b\\)").text, "$a\\$b$");
});

test("代码块里的定界符保持原样", () => {
  const input = "```latex\n\\(x^2\\)\n```";
  assert.equal(convert(input).text, input);
  assert.equal(convert(input).count, 0);
});

test("行内代码里的定界符保持原样", () => {
  const input = "写法是 `\\(x\\)` 这样";
  assert.equal(convert(input).text, input);
});

test("代码块之外的部分仍然转换", () => {
  const input = "`\\(ignore\\)`\n\n\\(keep\\)";
  const result = convert(input);
  assert.match(result.text, /`\\\(ignore\\\)`/);
  assert.match(result.text, /\$keep\$/);
});

test("多个公式全部转换", () => {
  const result = convert("\\(a\\) 和 \\(b\\) 以及 \\(c\\)");
  assert.equal(result.text, "$a$ 和 $b$ 以及 $c$");
  assert.equal(result.count, 3);
});

test("转换是幂等的", () => {
  const once = convert("公式 \\(x^2\\) 与 \\[y^2\\]").text;
  const twice = convert(once).text;
  assert.equal(once, twice);
});

test("没有定界符的公式不处理", () => {
  const input = "\\frac{a}{b} = c";
  assert.equal(convert(input).text, input);
  assert.equal(convert(input).count, 0);
});

test("嵌套：\\[ 里含环境时只包一层", () => {
  const result = convert("\\[\\begin{matrix}a & b\\\\c & d\\end{matrix}\\]");
  assert.equal(result.count, 1);
  assert.equal((result.text.match(/\$\$/g) || []).length, 2);
});

test("块级公式前后多余空行被压回", () => {
  const result = convert("a\n\n\\[x\\]\n\nb");
  assert.ok(!/\n{3,}/.test(result.text), "不应出现三连换行");
});

test("没有公式时不动原文的空行", () => {
  const result = convert("a\n\n\n\nb");
  assert.equal(result.text, "a\n\n\n\nb", "原文的空行不该被顺手压掉");
  assert.equal(result.count, 0);
});

test("countLatexDelimiters 统计各类定界符", () => {
  assert.equal(countLatexDelimiters("\\(a\\) \\[b\\]"), 2);
  assert.equal(countLatexDelimiters("\\begin{align}x\\end{align}"), 1);
  assert.equal(countLatexDelimiters("没有公式"), 0);
});

// ---- 代码段：检测要和转换用同一套规则 ----

test("统计公式个数时跳过代码块和行内代码", () => {
  const block = "代码：\n\n```\nprint(\\(x\\))\n```\n\n正文 \\(y\\)";
  assert.equal(countLatexDelimiters(block), 1, "围栏里的不算，只数正文那一个");
  assert.equal(countLatexDelimiters("行内 `\\(x\\)` 也不算"), 0);
});

test("代码块里的 $$ 不算 Markdown 公式", () => {
  assert.equal(hasMarkdownMath("```\necho $$5$$\n```"), false);
  assert.equal(hasMarkdownMath("正文 $x^2+1=y$"), true);
});

// ---- 落单的定界符不能把正文吞进公式 ----

test("落单的 $$ 夹着整段中文时，不包成公式", () => {
  const input = "价格 $$5 和 $$10 元";
  const result = convert(input);
  assert.equal(result.count, 0);
  assert.equal(result.text, input, "看不出是公式就别动，包进去只会得到一条报错");
});

test("公式里有 \\text{中文} 时照常转成公式块", () => {
  const result = convert("公式 $$ \\text{若 } x>0 $$ 成立");
  assert.match(result.text, /\$\$\n\\text\{若 \} x>0\n\$\$/, "有反斜杠就是公式，不能被中文吓退");
  assert.equal(result.count, 1);
});

test("句子中间的 \\[见附录\\] 不当公式", () => {
  const result = convert("见 \\[见附录\\] 一节");
  assert.equal(result.count, 0);
  assert.equal(result.text, "见 \\[见附录\\] 一节");
});

test("空字符串安全", () => {
  assert.deepEqual(convert(""), { text: "", count: 0 });
});

// ---- looksLikeMath：单个变量/微分这类「没有数学符号」的公式也要认 ----

test("短的变量名也算公式", () => {
  for (const item of ["dA", "x", "dz", "n", "E0", "abc"]) {
    assert.equal(looksLikeMath(item), true, `${item} 应该被当成公式`);
  }
});

test("金额和普通词不算公式", () => {
  assert.equal(looksLikeMath("5 到 10"), false, "含空格和数字");
  assert.equal(looksLikeMath("hello"), false, "普通英文单词");
  assert.equal(looksLikeMath("note"), false, "四个字母也不该算");
  assert.equal(looksLikeMath("价格"), false, "中文");
  assert.equal(looksLikeMath(""), false);
});

test("$dA$ 这种短公式能被 hasMarkdownMath 识别", () => {
  assert.equal(hasMarkdownMath("记 $dA$ 为面积测度"), true);
  assert.equal(hasMarkdownMath("这本书 $5 到 $10 之间"), false);
});
