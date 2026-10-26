# Math Formula Paste

Paste math formulas into SiYuan and they become native formulas; copy them out and you get Markdown with `$` delimiters.

## Pasting in

| Copied as | What you get in SiYuan |
| --- | --- |
| `\(x=1\)`, `$x=1$` | inline formula `$x=1$` |
| `\[ x=1 \]`, `$$ x=1 $$` | display block `$$`, wherever it appears |
| `\begin{align} … \end{align}` and friends | display block, environment name kept |

## Copying out

`Ctrl+C` and the "Copy rich text" menu item won't give you Markdown formulas — use one of these three entries:

**Entry points** (any one):

- Select content → right-click → the "Plugins" submenu at the end of the menu → "Copy as Markdown (with formulas)"
- Click the block icon → "Copy as Markdown (with formulas)"
- Search the command palette for "Copy as Markdown (with formulas)"; or bind a shortcut under Settings → Keymap

### Result

| In SiYuan | Copied out |
| --- | --- |
| inline formula | `$…$` |
| display block | `$$` block |
| bolded formula | `**$…$**` |
| lists, headings, quotes, tables, code blocks | standard Markdown syntax |
| no formula in the selection | left alone, SiYuan's native copy |

## Development

```bash
npm run dev        # watch build, output goes straight into the workspace (SIYUAN_WORKSPACE in .env)
npm run build      # one-off build into dist/
npm test           # 92 test cases
npm run typecheck  # type check
```

## License

MIT
