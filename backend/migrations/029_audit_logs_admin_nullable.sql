-- Relax audit_logs.admin_id to allow NULL so system-generated events
-- (no acting admin) can be recorded.
ALTER TABLE audit_logs ALTER COLUMN admin_id DROP NOT NULL;
