# Key Recovery (workspace secret vault)

## Purpose

Recover from loss, compromise, or rotation need of `HIKMAH_VAULT_KEY` — the
master key that encrypts every saved secret (provider keys, Gmail OAuth refresh
tokens, SSH credentials). `server/workspace-secrets.mjs` derives the AES-256-GCM
key via HKDF from this env var; the database holds only ciphertext.

## The honest part, first

- **If the key is lost and no backup of the key exists, the vault is
  unrecoverable.** AES-256-GCM has no back door and the ciphertext in
  `workspace.sqlite` is random bytes without the key. This is not a limitation
  to work around — it is the security property the vault is built on.
- The key is **not** in any backup: `backup.sh` records only whether
  `HIKMAH_VAULT_KEY` was _present_, never its value. A backup without the key
  restores everything except the secrets.
- Rotation does not decrypt-then-re-encrypt in place: the supported rotation is
  "save each secret again under the new key", because only the running app with
  the old key can decrypt.

## Preconditions

- For rotation/recovery: the app is running with the OLD key (so it can decrypt).
- For backup-of-key: a secrets manager or sealed envelope the owner controls.
  Never commit the key to git, never paste it into chat logs.

## Procedure 1 — Back up the key (do this once, today)

```bash
# 1. Confirm the key the app is actually using (length only, never print it)
node -e "const k=process.env.HIKMAH_VAULT_KEY||''; console.log('length:', k.length)"
# expected: length: >= 32  (workspace-secrets.mjs refuses shorter)

# 2. Store a copy in the owner's password manager under "hikmah vault master key",
#    and (belt and braces) on paper in a sealed envelope.
# 3. Record WHERE the copies live (not the key) in the owner's own notes.
```

## Procedure 2 — Rotate the key

```bash
# 1. With the OLD key active, list which destinations hold secrets
sqlite3 "$HIKMAH_DATA_DIR/workspace.sqlite" \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%secret%';"
# then via the app's one-key panel: re-save every secret (provider keys, gmail,
# ssh, mcp-env). Each save encrypts under the NEW key once it is active.

# 2. Stop the app, set the NEW key (>= 32 chars), start
HIKMAH_VAULT_KEY='<new-32plus-char-key>' npm start

# 3. Re-save each secret through the app UI (one-key panel). The old ciphertext
#    rows are replaced as each destination is saved.

# 4. Verify: hit a provider call and the Gmail flow; both must work without
#    "Saved secret cannot be decrypted".

# 5. Back up the NEW key per Procedure 1. Destroy the old key copies.
```

Expected output: no `SecretError` / "cannot be decrypted" in logs; provider and
Gmail calls succeed.

## Procedure 3 — Key lost, backup of the key EXISTS

1. Retrieve the key from the password manager / envelope.
2. Set `HIKMAH_VAULT_KEY` to it, restart the app.
3. Verify one secret decrypts (open the one-key panel; no "cannot be decrypted").
4. Rotate per Procedure 2 if the loss involved any exposure.

## Procedure 4 — Key lost, NO backup of the key exists

1. Accept the vault contents are gone. Do not waste time on "recovery tools" —
   there are none for AES-256-GCM.
2. Restore the database from the latest backup if needed (backup-restore.md) —
   it restores everything _except_ usable secrets.
3. Re-create each secret from its original source: provider dashboards (issue new
   keys), Gmail OAuth (re-run the connect flow), SSH (re-add credentials).
4. Set a NEW `HIKMAH_VAULT_KEY`, back it up per Procedure 1.
5. Write the postmortem: how the key was lost, and what changes so it cannot
   happen again.

## Rollback

- Rotation rollback: if the new key misbehaves before old copies are destroyed,
  stop the app, restore the OLD key from its backup, restart. Secrets saved
  under the new key after the switch will not decrypt — re-save them.
- There is no rollback for Procedure 4. That is the point of Procedure 1.

## When to escalate to the owner

- Any step that touches the key's _value_ (backup, rotation, retrieval) — the
  owner performs it personally; the operator only verifies lengths and outcomes.
- Procedure 4, always: re-issuing provider keys and re-running OAuth are
  owner-side actions with billing/security implications.
- Any suspicion the key was exfiltrated (not just lost): treat as compromise —
  rotate immediately AND revoke the secrets at their providers.
