# Setting up another household Mac

For a Claude instance on a second Mac on Caleb's network: install the drill
exactly as on the main Mac, sharing the same profiles through the pi. Read
`CLAUDE.md` too; this file is only the install.

**IMPORTANT:**
- **NEVER copy `~/.piano-by-ear/` from another machine.** `device-id` is this
  machine's identity in every synced row; a copied one corrupts the merge.
  Profiles and the roster come from the pi on their own.
- **NEVER sync as chugo.** The profiles live under the pi's `pbe` user; a
  sync as chugo creates an empty `~/piano-by-ear` there and splits them.
- **NEVER type the pi's password.** Caleb runs `ssh-copy-id` himself (step 2).
- **NEVER commit `corpus/local/`** (git-ignored, not redistributable; this
  repo is public).

## 1. Code and Node

Needs git (Xcode Command Line Tools: `xcode-select --install`) and Node 22.5+
(the main Mac uses nvm, Node 24). `pbe.sh` finds node on PATH, in
`~/.nvm/versions/node/*`, or in Homebrew's prefix.

```bash
mkdir -p ~/Development/"personal dev work.nosync"
git clone https://github.com/calebjedhugo/piano-by-ear.git ~/Development/"personal dev work.nosync"/piano-by-ear
cd ~/Development/"personal dev work.nosync"/piano-by-ear && npm install
```

Same path as the main Mac, so the skill and docs work unchanged.

## 2. The pi (profile sync)

**Sync runs as `pbe`, a no-sudo user whose home holds only the profiles.**
The pi is also the house's Pi-hole DNS, and the sync key must work without a
finger (lid-closed play), so any agent on the Mac can use it: it may reach
the piano data and nothing else. Two ssh entries, two keys, both made in
[Secretive](https://github.com/maxgoedjen/secretive) (Secure Enclave; the
private key never exists as a file):

| entry | user | Secretive key | for |
|---|---|---|---|
| `hugopi` | chugo | Touch ID per use | admin, the step 3 copies; never sync |
| `pbe-hugopi` | pbe | Notify (Touch ID cannot be tapped with the lid closed) | sync only |

Append to `~/.ssh/config` (`<…>.pub` = each key's file in Secretive's
`PublicKeys` folder):

```
Host hugopi hugopi.local
    HostName hugopi.local
    User chugo
    IdentityAgent ~/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh
    IdentityFile <chugo key>.pub
    IdentitiesOnly yes
    ServerAliveInterval 60
    ServerAliveCountMax 3

Host pbe-hugopi
    HostName hugopi.local
    User pbe
    IdentityAgent ~/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh
    IdentityFile <pbe key>.pub
    IdentitiesOnly yes
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

**Caleb** installs the chugo key (it asks for the pi's password; `-f`
because there is no private key file):

```bash
ssh-copy-id -f -i "<chugo key>.pub" chugo@hugopi
```

pbe has no password, so `ssh-copy-id` cannot install its key. Someone logged
in as chugo appends the public key to `/home/pbe/.ssh/authorized_keys`
(owner pbe, mode 600) with a `restrict ` prefix (no forwarding, no pty;
commands and scp still work).

Turn sync on; it is OFF by default:

```bash
mkdir -p ~/.piano-by-ear
printf '{\n  "enabled": true,\n  "host": "pbe-hugopi",\n  "dir": "piano-by-ear"\n}\n' > ~/.piano-by-ear/sync.json
```

Verify: `ssh pbe-hugopi 'ls piano-by-ear/profiles'` lists the profiles with
no Touch ID prompt.

## 3. Private files from the pi

`~/piano-by-ear-setup/` on the pi holds what the public repo cannot:

```bash
mkdir -p corpus/local ~/.claude/skills/piano-by-ear
scp 'chugo@hugopi:piano-by-ear-setup/*.json' corpus/local/
scp chugo@hugopi:piano-by-ear-setup/SKILL.md ~/.claude/skills/piano-by-ear/
```

The json is extra trio material (optional, the drill runs without it); the
skill is `/piano-by-ear`.

## 4. Sound

Ask Caleb which keyboard this Mac drives.
- **Mute controller** (no speakers): fetch the pianos (~450 MB) and use them:
  `npm run fetch-samples && launcher/pbe.sh sound app`
- **Keyboard with its own sound** (digital piano): leave the default. The
  metronome plays its woodblock on ch 10. Optional, per instrument:
  `~/.piano-by-ear/click-volume` and `~/.piano-by-ear/reverb` (0-100; the
  main Mac's piano uses 50 and 0).

## 5. Launcher

```bash
launcher/build.sh
```

Builds `/Applications/Piano by Ear.app`. If Claude Code's sandbox is on, run
`build.sh` and every `pbe.sh` call with it disabled (pgrep, MIDI, audio and
ssh fail inside it).

## 6. Verify

Keyboard plugged in, then `launcher/pbe.sh start` and `tail ~/.piano-by-ear/run.log`:
two clicks, MIDI input named, a `sync:` line with no error. Caleb plays his
login chord; the log should show his profile pulled from the pi with its full
history (not a new profile). `launcher/pbe.sh stop` when done.

## Keeping it current

There is no auto-pull (Caleb's ruling). Every push to the repo must be pulled
here by hand, **after checking nobody is playing** (`tail` the log), and both
Macs should sit on the same commit (CLAUDE.md, "VERSION SKEW"):

```bash
git pull --ff-only && npm install && launcher/pbe.sh start
```
