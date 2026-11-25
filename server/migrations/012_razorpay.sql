-- 012: real payments with Razorpay (test mode). Each of our orders gets the Razorpay ORDER it is paid
-- through ("order_Nz…"), created once; the webhook finds our order by it.
ALTER TABLE orders ADD COLUMN provider_order_id TEXT;
CREATE UNIQUE INDEX orders_provider_order_id_key ON orders (provider_order_id) WHERE provider_order_id IS NOT NULL;
