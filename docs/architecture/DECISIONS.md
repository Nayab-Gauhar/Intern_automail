# Lead decisions

Conflicts between architecture documents, resolved by the lead. Each entry is a decision the
docs could not settle among themselves, with the reasoning, so it is not relitigated.

---

## D1 — `campaigns.launch` is available to MEMBER

**Status:** decided. Supersedes `07-auth-and-security.md` §9.4.

### The conflict

Two docs specified opposite things:

| Doc | Position | Argument |
|---|---|---|
| `07-auth-and-security.md` §9.4 | ADMIN+ only | Launching sends real mail from a real domain and can burn its reputation — a blast radius outside the product. |
| `02-backend.md` §16.12 | MEMBER | "A tool where the person doing outreach must ask an admin to press send is a tool people work around." |

`02-backend.md` cited `03-frontend.md` §16 as agreeing with it. It does not: §16 lists mailbox
connection as an *open question* and says "The brief's role table does not say." The citation
was wrong, so it carries no weight either way.

The locked brief does not settle it. It requires only that campaign launch be **audit-logged**
(§6), which marks the action as sensitive without assigning a role.

### Decision: MEMBER may launch. `'campaigns.launch': ALL`.

The security argument for ADMIN-only rests on a premise that does not hold here: that
launching is what endangers the domain. It is not. The controls that actually bound outbound
volume and reputation are separate capabilities, and all of them remain ADMIN+:

```
mailboxes.connect       ADMIN+   which mailboxes exist at all
mailboxes.limits_edit   ADMIN+   daily cap, sending window, ramp
domains.manage          ADMIN+   SPF/DKIM/DMARC
warmup.manage           ADMIN+   ramp policy
```

A MEMBER pressing launch cannot exceed a cap they cannot edit, send from a mailbox they
cannot connect, or widen a window they cannot change. They can start sending *within limits an
ADMIN already set*. The reputation risk sits with whoever sets those limits, and that is
already gated.

Against that, ADMIN-only launch has a concrete security cost: the primary user of an outreach
tool **is** the person doing outreach. Making them ask someone else to press send does not
stop the send — it produces shared ADMIN credentials, which is strictly worse than the
capability we were trying to withhold.

### What stays ADMIN+, and why the reasoning differs

- `leads.export` and `leads.bulk_delete` — the lead list is the customer's commercial asset,
  and "departing employee exports the list" is a real incident class. Unlike launching, there
  is **no** other capability that bounds the damage: one export is total. Both docs already
  agree here.
- `mailboxes.connect` — grants us an OAuth scope over a person's real mailbox. Also
  irreversible in the sense that matters: the grant exists until revoked.

The distinction is whether another ADMIN-gated control already bounds the blast radius.
For launching, one does. For exporting, none does.

### Consequences

- `src/server/authz.ts`: `'campaigns.launch'` moves from `STAFF` to `ALL`.
- `campaigns.pause` was already `ALL` and stays there — stopping sends is a safety action and
  must never require permission.
- Launch remains audit-logged per the brief.
- `07-auth-and-security.md` §9.4's `campaigns.launch` row is superseded by this entry. The doc
  is left as written rather than edited, so the original reasoning stays legible.
