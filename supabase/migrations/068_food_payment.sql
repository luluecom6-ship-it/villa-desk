-- 068: UPI payment for food orders. The owner saves a UPI ID once; when a caretaker confirms an order
-- the guest is sent a UPI QR for the order total. The caretaker marks the order paid by hand
-- (the app records payment, it never moves money). Orders are still never deleted. Idempotent.

ALTER TABLE properties  ADD COLUMN IF NOT EXISTS upi_id            TEXT;
ALTER TABLE properties  ADD COLUMN IF NOT EXISTS upi_payee_name    TEXT;
ALTER TABLE properties  ADD COLUMN IF NOT EXISTS food_send_upi_qr  BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE food_orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE food_orders ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;
ALTER TABLE food_orders ADD COLUMN IF NOT EXISTS paid_by_name   TEXT;
ALTER TABLE food_orders ADD COLUMN IF NOT EXISTS qr_sent_at     TIMESTAMPTZ;

ALTER TABLE food_orders DROP CONSTRAINT IF EXISTS food_orders_payment_check;
ALTER TABLE food_orders ADD CONSTRAINT food_orders_payment_check
  CHECK (payment_status IN ('unpaid', 'paid') AND ((payment_status = 'paid') = (paid_at IS NOT NULL)));
