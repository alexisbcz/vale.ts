import { newConfig, newFlags } from "@vale-ts/core";
import { newMyST } from "../../src/myst.ts";
import { newQuarto } from "../../src/qmd.ts";
import { newMDX } from "../../src/mdx.ts";
import { qdocFragmentToHTML } from "../../src/qdoc.ts";
import { orgToHTML } from "../../src/org.ts";

const cfg = newConfig(newFlags({ ignoreGlobal: true }));
const myst = newMyST(cfg);
console.log("--- MyST");
for (const s of [
  "(contributing-volto-label)=\n\nSome prose.\n",
  "Call {func}`render_page` for that.\n",
  "Read the {term}`server-side rendering` glossary entry.\n",
  "See {ref}`the setup guide <setup>` and {ref}`setup`.\n",
  "Version {{ version }} is out.\n",
  "Some [styled text]{.customclass} here.\n",
  "Before.\n\n% a comment with a misteak\n\n+++ {\"meta\": 1}\n\nAfter.\n",
  "{.bg-primary}\n\nStyled paragraph.\n",
  "```{note}\n:class: dropdown\n\nAdmonition prose here.\n```\n",
  ":::{warning}\nColon prose here.\n:::\n",
  "```{figure} img.png\n---\nheight: 150px\nname: fig-target\n---\nThe caption is prose.\n```\n",
  "```{code-block} python\nimport volto\n```\n",
  ":::{math}\na^2 + b^2\n:::\n",
  "`````{note}\nOuter prose.\n\n````{tab-set}\n```{tab-item} Label\nInner prose.\n```\n````\n`````\n",
  "```python\nimport volto\n```\n",
  ":::\nDiv prose.\n:::\n",
]) console.log(JSON.stringify(s), "=>\n" + myst.render(s));

const q = newQuarto();
console.log("--- Quarto");
for (const s of [
  "::: {.callout-note}\nCallout prose here.\n:::\n",
  "::: {.callout-tip title=\"A titled tip\" #tip-1}\nTip prose.\n:::\n",
  "::: warning\nBare-word prose.\n:::\n",
  ":::: {.columns}\n::: {.column width=\"40%\"}\nLeft prose.\n:::\n::: {.column width=\"60%\"}\nRight prose.\n:::\n::::\n",
  "::: {.a}\nOuter prose.\n\n::: {.b}\nInner prose.\n:::\n\nStill outer.\n:::\n\nOutside.\n",
  "Before.\n\n:::\n\nAfter.\n",
  "```{r}\n#| label: fig-plot\nplot(cars)\n```\n",
  "## Overview {#sec-overview}\n\nProse here.\n",
  "Prose with [styled text]{.underline} in it.\n",
  "{{< video https://example.com/v.mp4 >}}\n\nPress {{< kbd F5 >}} to run.\n",
  "The mean is `{python} np.mean(x)` overall.\n",
]) console.log(JSON.stringify(s), "=>\n" + q.render(s));
