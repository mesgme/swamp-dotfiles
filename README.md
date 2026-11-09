# swamp-dotfiles

`@puddleworks/dotfiles`: a [swamp](https://swamp-club.com) extension that brings a
local machine, or any machine you can `ssh` to, to a declared dotfiles state.
Files, directory trees, brew/apt packages, git clones and guarded commands, with
idempotent `plan`, `apply` and `verify`. Remote machines need only sshd and `sh`.

Usage and the item reference are in [extensions/models/README.md](extensions/models/README.md).

```bash
swamp extension pull @puddleworks/dotfiles
```

## Develop

```bash
cd extensions/models && deno test -A
swamp repo init --tool none            # once, at the repo root
swamp extension fmt extensions/models/manifest.yaml
swamp extension quality extensions/models/manifest.yaml
swamp extension push extensions/models/manifest.yaml --dry-run
```

MIT licensed.
