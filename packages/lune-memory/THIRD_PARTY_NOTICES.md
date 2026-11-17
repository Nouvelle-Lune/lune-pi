# Third-party notices

Some files of `@lune_99/lune-memory` are adapted from the Pi coding agent
(`@earendil-works/pi-coding-agent`, https://github.com/earendil-works/pi), which is
licensed under the MIT License. The adapted code reads and checks `models.json`, resolves its
values and builds the providers of custom endpoints, so lune-memory reads the same file format
as Pi.

| File                                     | Adapted from                                    |
| ---------------------------------------- | ----------------------------------------------- |
| `src/dreaming/providers/models-json.ts`  | `src/core/model-config.ts`, `src/utils/json.ts` |
| `src/dreaming/providers/config-value.ts` | `src/core/resolve-config-value.ts`              |
| `src/dreaming/providers/compose.ts`      | `src/core/provider-composer.ts`                 |

The license of the upstream repository follows.

---

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
