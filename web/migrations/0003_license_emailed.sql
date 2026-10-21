-- When a license's key was last emailed to its owner. A purchase's email is sent until this is set:
-- if the email provider fails, the webhook fails too and the payment provider's redelivery sends it.
-- Licenses from before this stay NULL.
ALTER TABLE licenses ADD COLUMN emailed_at TEXT;
