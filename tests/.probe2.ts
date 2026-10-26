import { slashCaretAt, slashFlagAt, commandFlags } from "../src/lib/slash";
function probe(word: string) {
  const caret = slashCaretAt(word, word.length)!;
  const subVerb = caret?.prev[0] ?? "";
  const subName = caret?.prev[1] ?? "";
  const hasSub = caret?.index === 1 && (commandFlags(subVerb).length > 0 || true);
  const subDecl = (caret && caret.index >= 2) ? subVerb : undefined;
  const flagLevel = !!caret && caret.index >= 2 && commandFlags(subVerb).length > 0;
  const flag = caret ? slashFlagAt(caret, subVerb) : null;
  console.log(JSON.stringify({ word, index: caret?.index, prev: caret?.prev, wordW: caret?.word, flagLevel, flag }));
}
["/schedule ","/schedule create ","/schedule create --sk","/schedule create --skills=","/schedule create --skills=an","/schedule create --plugins=","/schedule create --mcp=a"].forEach(probe);
