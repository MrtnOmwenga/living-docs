---
alwaysApply: true
description: Rules for what belongs in project docs (docs/INDEX.md + docs/modules/*.md) and when to update each section
---

<!-- policy-version: 2 -->

# Documentation Policy

This project keeps a `docs/` folder (sibling to the project's subrepos, e.g.
`acme/docs/`) with one `docs/INDEX.md` and one file per module/topic
under `docs/modules/`. This is separate from code comments and commit
messages: it exists to capture the reasoning that neither of those hold —
the *why*, not just the *what*.

## Before starting work

`docs/INDEX.md` is already loaded every session (imported via `CLAUDE.md`),
compacted or not — so the list of domains and what each covers is always
in context. That is not the same as actually having read one. Before
making a non-trivial change, debugging a regression, or extending existing
behavior, check `docs/INDEX.md` for the domain involved and read that
module's Context and Implementation sections first, rather than assuming.

**When a request conflicts with what's documented**: before implementing,
check the proposed approach against the domain's Context/Implementation/
Relationships and the team's own architecture guidelines. If it
conflicts, say so explicitly and get confirmation before proceeding —
regardless of how the request was phrased. Confidence in a conversation
isn't evidence of correctness. If there's a genuine reason to deviate,
that reason itself belongs in Decision History as a deliberate choice,
not something that slips in as if it were always the plan.

This is what makes it safe for Implementation and Decision History updates
to commit and push directly — no staging branch, no gate other than this
check. (Context edits, new modules and the other cases in "Direct push vs.
PR" below do go through a PR.) It doesn't replace
code review (a human is still the backstop on actual code correctness),
and it can't catch something the docs don't cover yet — but it's an
earlier, cheaper checkpoint than discovering a documented mistake after
it's already shared. Creating a new domain remains the one point that
always needs a human: see "Creating a new domain is not autonomous" below.

## Domains, not arbitrary topics

Module files are organized by **business domain** (auth, product-sync,
billing — a bounded context with its own vocabulary and rules that changes
on its own timeline), not by whatever felt notable in a given conversation.
Something that's only an implementation detail of one domain (e.g. JWT
refresh logic within auth) is a subsection of that domain's file, not a
file of its own — this is the main defense against topic sprawl.

**Creating a new domain is not autonomous.** Updating an existing domain's
docs is. If a conversation surfaces something that doesn't fit any
existing module in `docs/INDEX.md`, do not create the file — propose it
instead (state the domain, why it doesn't fit an existing one, and what
would go in it) and open it as a PR against the docs repo for the tech
lead to review. A human deliberately extends the domain list; the
automation only ever fills in domains that already exist.

**Standing topics** are the non-business modules — cross-cutting context
that no single domain owns but that a new engineer needs to make good
calls: `architecture` (how the pieces fit, and which repo owns what),
`deployment` (environments, pipelines, release), `integrations`
(third-party systems and their failure modes), `glossary` (shared
vocabulary) and `troubleshooting` (non-obvious problems and their fixes).
Groups may opt in to `security`, `data-model` and `local-dev` at setup.
They are seeded when the docs are first created and maintained like any
other module. Adding or removing one is the same kind of decision as adding
a domain, so it goes through the same PR.

A topic earns a slot only if no single domain owns it, conversations
regularly produce it, a newcomer would go wrong without it, and code, a
README or these rules don't already cover it better.

A freshly created module starts with `_Not yet documented._` under its
title, so blank bullets are never mistaken for fact. Whoever writes the
first real content removes that line.

## Direct push vs. PR

The automation decides mechanically, by what the change *is*, never by how
confident it feels:

| Change | Path |
|---|---|
| Edit to an existing module's Decision History, or to its Implementation from code that is already on the default branch | Direct push, after reconciling with what's already documented |
| Edit to an existing module's **Implementation** from a code branch that has not merged | Held on a `docs/wip/<repo>/<branch>` draft PR; merged automatically when the code PR merges |
| Edit to an existing module's **Context** (use case, limitations, constraints) | PR |
| New business domain | PR |
| New standing topic | PR |
| Removing, renaming or merging a module | PR |
| A capture that couldn't be pushed after retries (conflict, branch protection) | PR, so nothing captured is lost |
| Scheduled drift-audit corrections | PR |

Context is a PR because it states what the module is *for* and what
constrains it: a wrong Context misleads every later decision, and it only
legitimately changes when requirements change — a moment worth a second
pair of eyes. Implementation and Decision History are lower-stakes (the
first is re-derivable from code, the second is append-only).

The sync step detects a Context change from the actual diff of the
`## Context` section, not from what the extraction step reports, so it
can't be skipped by omission. A capture that touches both goes out as two
changes: the Context edit on a PR branch, everything else direct.

The extraction step only ever edits existing module files. When something
doesn't fit one, it *proposes* a module (kind, slug, why, draft) instead of
writing it, and the sync step turns each proposal into a PR. A proposal
that duplicates an existing module, has a malformed slug, or is too similar
to an existing module or an open proposal is dropped (an open one gets a
"seen again" comment instead, so evidence accumulates on one PR). Closing a
proposal PR without merging rejects it: it is not proposed again for 90 days.
The PR prefills the module's use case from the proposal, so the reviewer can
correct it at the moment it matters.

**Held Implementation.** Implementation says what the code *does*, which is only
true once the code is on the default branch. So Implementation edits captured
from an unmerged code branch are not pushed to main: they wait on a draft PR
for that branch, and the docs-repo workflow merges it when the code PR merges
(or closes it if the code PR is closed unmerged). Decision History entries from
the same session are published at once — a decision was made whether or not the
code lands — and are stamped with the branch they came from. A branch cut from
another held branch stacks its docs on the parent's, so they land in the same
order as the code. When you are told which branch a conversation happened on,
describe Implementation as *that branch* has it and never document work from
another branch.

**Interconnected domains**: each module file may have a **Relationships**
section listing which other domains it depends on or is depended on by,
and the nature of that dependency (e.g. "product-sync trusts auth's user
identity but doesn't own auth logic"). A decision that affects two domains
is recorded once, in whichever domain actually owns that concept — the
other domain links to it rather than duplicating it.

## Per-module file shape

Every business-domain and standing-topic module — except the two
list-shaped ones below (`glossary`, `troubleshooting`) — has these
sections, in this order (Relationships is omitted if the module has no real
cross-domain dependencies worth naming):

```
# <Module name>

## Context
- Use case: ...
- Limitations: ...
- Restrictions / constraints: ...

## Relationships
- Depends on: <domain> — <nature of the dependency>
- Depended on by: <domain> — <nature of the dependency>

## Implementation
- ...

## Decision History
- YYYY-MM-DD: <what changed>, why, what was considered/rejected
```

## Glossary and troubleshooting: list-shaped modules

`glossary` and `troubleshooting` are lists of entries rather than a module
with a use case and an architecture, so they don't use the
Context / Implementation / Decision History shape. Because they have no
`## Context`, edits to them are direct pushes.

**`glossary.md`** — one `## Terms` section, entries in alphabetical order:

```
- **Term** — one-sentence definition. Owner: <domain>. Not the same as: <confusable term>.
```

A term belongs here only if it has a *domain-specific* meaning, is used
with different meanings in different domains or repos, or is commonly
misread (a name that means something else in general use). Do not define
general programming or industry terms. One entry per term, owned by the
domain that defines it; other domains link to it rather than redefine it.
Add a term when a conversation defines, corrects or disambiguates it. When a
meaning changes or a term is retired, keep the entry and mark it
`Deprecated (YYYY-MM-DD): <what replaced it>` — old code and old commits
still use the old word.

**`troubleshooting.md`** — one `## Issues` section, newest first:

```
- YYYY-MM-DD **<symptom as someone would search for it>** — Cause: ... Fix: ... (Domain: <domain>)
```

Only problems that were non-obvious to diagnose belong here, per the
"What does NOT get documented" rules below. When a fix stops applying,
mark the entry `Obsolete (YYYY-MM-DD): <why>` rather than deleting it.

## What goes where

**Context** — the use case, limitations, restrictions, and constraints that
shape this module. Rewritten in place when it goes stale; it is a *current*
statement, not a log. Update it only when the actual use case, scope, or a
hard constraint genuinely changes (a real requirements conversation) —
not from routine debugging. Bar for inclusion: would a new engineer make a
wrong call without knowing this?

**Implementation** — the current architecture: key files/modules, data
flow, integration points. Rewritten in place to reflect current truth, not
appended to forever. This is deliberately lighter than the code itself —
capture what orients someone (entry points, how pieces connect, non-obvious
choices), not a restatement of what's already obvious from reading the
files.

**Decision History** — append-only, dated, never edited or deleted. Add new
entries at the end, oldest first, so the file reads as a timeline. One
entry per non-trivial decision (each new entry is stamped automatically with
`(src: <code repo>@<branch> <sha>)`, so a decision can be traced to the code
it came from — don't write that tag yourself): what was decided, why, and what alternative
was considered and rejected. This is the part that survives everything
else going stale.

**Correcting a decision.** Old entries are never edited, so a decision that
turned out wrong or was reversed is corrected by a *new* entry that starts with
`Supersedes <date> "<first words of the old entry>":` and says what replaced it
and why. Readers follow the later entry; the history stays honest about what was
believed when.

## What does NOT get documented

- Anything a good commit message already captures (routine "what changed").
- Debugging paths that were explored and reverted — dead ends aren't
  decisions unless the fact that they were rejected is itself useful context
  (e.g. "we tried X, it doesn't work because Y" — that IS worth a Decision
  History line).
- Pure style/formatting discussion.
- Anything fully re-derivable by reading the current code.

## Routing

Before writing, check `docs/INDEX.md` for existing module files. Update an
existing one if the topic matches; only create a new module file if none
fits. Keep `docs/INDEX.md` in sync — one line per module file, a short
description, and a relative link — whenever a module file is added.

## Updating manually (mid-conversation)

When a conversation produces a real architecture decision or a fix whose
reasoning would be expensive to reconstruct later, propose capturing it in
the relevant `docs/modules/<topic>.md` before the conversation ends, rather
than waiting for it to be caught automatically.
