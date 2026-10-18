# Grok Build cheat sheet

Generic [Grok Build](https://x.ai) commands only. Nothing here is runnable from this pane.

---

## Daily

| Need | Command |
|------|---------|
| New session | `grok` |
| Prompt on start | `grok "fix the bug"` |
| Continue last | `grok -c` / `grok --continue` |
| Resume by ID | `grok -r SESSION_ID` |
| Headless one-shot | `grok -p "..."` |
| Resume + one turn | `grok -r SESSION_ID -p "..."` |
| Always approve tools | `grok -p "..." --always-approve` |
| Set cwd | `grok --cwd PATH` |
| Worktree session | `grok -w` / `grok -w -r SESSION_ID` |
| Model | `grok -m MODEL` |
| Reasoning effort | `grok --reasoning-effort medium` |
| Sandbox | `grok --sandbox off` / `coding` / `maxsec` |
| Memory off | `grok --no-memory` |
| No web search | `grok --disable-web-search` |
| Version | `grok -v` |

---

## Sessions

| Need | Command |
|------|---------|
| List | `grok sessions list` |
| Search | `grok sessions search "keyword"` |
| Delete (permanent) | `grok sessions delete SESSION_ID` |
| Export markdown | `grok export SESSION_ID` |
| Import | `grok import …` |
| What config applies here | `grok inspect` |

---

## Dashboard

| Need | Command |
|------|---------|
| Running agents | `grok dashboard` |

---

## Leader / agent / workspace

```bash
grok agent leader
grok leader list
grok leader kill
grok --leader
grok --no-leader
grok agent headless
grok workspace status
grok workspace pause
grok workspace resume
grok workspace stop
```

---

## Maint

```bash
grok models
grok update
grok login
grok logout
grok mcp …
grok memory …
grok plugin …
grok worktree …
grok completions …
```
