# Privacy boundary

The raw browser trace is not stored in PostgreSQL or sent to Cerebras or
OpenRouter unchanged. Before either boundary, the server:

- removes duplicate semantic XML snapshots;
- replaces demonstrated typed strings and numbers with a user-input marker;
- removes URL query strings and fragments;
- replaces long URL identifiers;
- redacts email, phone, payment-number, credential, street-address,
  account-greeting, and long numeric identifier shapes.

The compiler prompt adds a second boundary: it must generalize values into
parameters and must not reproduce personal names, contact details, addresses,
account or order identifiers, payment details, credentials, or literal typed
values.

This is an experimental heuristic, not a guarantee that arbitrary page content
contains no personal information. Use the owned storefront while developing;
do not record signed-in account or checkout pages until the privacy behavior is
appropriate for that environment.
