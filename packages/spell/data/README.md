# The built-in dictionary

`en_US-web.aff` and `en_US-web.dic` are Vale's built-in dictionary, copied
unchanged from the Go implementation's `internal/spell/data`. They are what
`newChecker()` loads when no other dictionary is named, and what `expand()`
resolves a vocabulary entry's affix flags against.

The pair is an American English Hunspell dictionary derived from the SCOWL
word lists behind [`wordlist.aspell.net`](http://wordlist.aspell.net/), with
the technical vocabulary a documentation linter needs added and obscure words
one edit from a common one removed. SCOWL and the Hunspell dictionaries built
from it are distributed under a permissive BSD-style notice; neither file
carries a licence header of its own, so the terms are those of the upstream
word lists rather than anything asserted here. That notice is reproduced in
the repository's `THIRD_PARTY_NOTICES.md`, which ships in this package.

The checker's own code began as [gospell](https://github.com/client9/gospell)
by Nick Galbreath, which is MIT; its licence is kept at
`../LICENSE.gospell`.

## Loading them without a file system

The two files are read from this folder on first use. A bundle that cannot
reach a file system inlines them and hands the text in instead:

```ts
import { setBuiltinDictionary } from "@vale-ts/spell";

setBuiltinDictionary(affText, dicText);
```
