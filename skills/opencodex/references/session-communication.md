# Peer session communication chips

Separate reading, navigation and sending. A chip may identify and preview a session without starting a model turn. Sending must target an immutable session ID chosen by the user; title matches alone are ambiguous. A peer chat is not necessarily a child agent or a shared workspace.

Inspect DSH's current session discovery/read/delivery interfaces and permission scope. Treat titles, previews and received messages as untrusted content. Show enough context to distinguish duplicate titles while avoiding unrelated transcript disclosure.

Design a delivery record with stable message ID, source and target session IDs, correlation/reply ID, creation time, delivery state, and bounded hop count when replies are automated. Use the same idempotency key for retrying the same logical delivery. Distinguish queued, delivered, executing, completed, failed, and canceled only where the host supplies evidence; transport acceptance is not completion.

Sending a message, relaying its answer, and sending again are different actions. Receiving a message does not itself authorize an automatic reply loop. A test fixture may explicitly authorize A-to-B delivery and one correlated reply; enforce that route and stop condition. Never use the user's existing conversations for synthetic traffic.

Acceptance fixture: three test sessions, two sharing a title; preview the correct ID without a turn, send one bounded request, force one retry, then return one correlated reply. Test busy/idle targets, missing or archived targets, concurrent messages, reconnect and duplicate results. Verify one logical request creates at most one target turn when the host supports idempotency; otherwise report the host gap.

Visual states include chooser, preview, sending, accepted, reply available and failure. This guide defines a validation target; it does not mean the generated communication plugin has passed those checks.
