-- Idempotent sends.
--
-- A client that does not know whether its request arrived (timeout, dropped connection, switch to another server
-- address) or that flushes its offline outbox sends the SAME message again with the same client_id. The unique index
-- turns that into "return the message that already exists" instead of a duplicate.
ALTER TABLE messages ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX idx_messages_client ON messages (conversation_id, sender_id, client_id) WHERE client_id IS NOT NULL;
