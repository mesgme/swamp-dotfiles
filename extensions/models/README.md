# @puddleworks/dotfiles

A swamp model that brings one machine, this one or any machine you can `ssh`
to, to a declared dotfiles state. Nothing about any particular person's setup is
in the extension; you supply the items.

The remote machine needs only `sshd` and `sh`. Swamp does not have to be
installed there.

## Install

```bash
swamp extension pull @puddleworks/dotfiles
swamp model create @puddleworks/dotfiles my-laptop
```

## A definition

```yaml
type: "@puddleworks/dotfiles"
name: my-laptop
globalArguments:
  target: { kind: local }          # or { kind: ssh, host: box, user: me, port: 22, identityFile: ~/.ssh/id_ed25519 }
  sourceDir: dotfiles              # relative to the swamp repo root
  vars: { email: me@example.com }  # extra {{variables}}
  items:
    - { kind: package, package: tmux }                       # brew / apt
    - { kind: file, src: shell/.zshrc, dest: ~/.zshrc, method: link }
    - { kind: file, src: git/.gitconfig.tmpl, dest: ~/.gitconfig, template: true }
    - { kind: tree, src: claude/.claude/skills, dest: ~/.claude/skills, exclude: ["**/tests/**"] }
    - { kind: gitClone, repo: owner/nvim-config, dest: ~/.config/nvim }
    - kind: command
      run: curl -fsSL https://starship.rs/install.sh | sh -s -- -y -b ~/.local/bin
      unless: command -v starship
```

## Items

| kind | what it does |
|---|---|
| `file` | Writes `src` (a file under `sourceDir`) or literal `content` to `dest`. `method: link` symlinks (copied on remote machines). `mode`, `template`, `backup`. |
| `tree` | Every file under a directory, with `exclude` globs. Takes `method`, `template`. |
| `package` | `brew install` on macOS, `apt-get install` on Debian/Ubuntu (via `sudo -n` when not root). `brew:` / `apt:` override the name. |
| `gitClone` | Clones `owner/name` (GitHub) or any URL if the destination is not already a checkout. |
| `command` | Runs `run` only while the `unless` guard exits non-zero. |

Every item takes `os: [darwin, linux]` to limit where it applies. Destinations
may use `~` and `{{home}}`, `{{os}}`, `{{user}}` and your own `vars`. Replacing a
changed file keeps the old one as `<dest>.bak`.

## Methods

- `plan`: what would change, changing nothing.
- `apply`: make it so. A second run reports every item `unchanged`.
- `verify`: fails, naming the items, if the machine differs from the definition.

Each run writes a `report` resource listing every item's outcome, so a failure
on one machine or item is visible by name. A failing item does not stop the
items after it, but the method fails.

## Secrets

Do not put secrets in `content`. Reference a vault so the value is resolved at
deploy time:

```yaml
- { kind: file, dest: ~/.alias.local, mode: "0600",
    content: "${{ vault.get('default', 'alias-local') }}" }
```

## Reuse one item list on several machines

```yaml
# remote.yaml
globalArguments:
  target: { kind: ssh, host: box.example.com, user: me }
  items: "${{ model.my-laptop.definition.globalArguments.items }}"
```

## Limits

- Files are handled as text (UTF-8).
- Packages: Homebrew (must already be installed) and apt only.
- Private git repositories need git credentials on the target machine.
