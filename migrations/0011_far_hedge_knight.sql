CREATE TABLE `wallet_nonces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_nonces_nonce_unique` ON `wallet_nonces` (`nonce`);--> statement-breakpoint
CREATE INDEX `wallet_nonces_user_idx` ON `wallet_nonces` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_nonces_nonce_idx` ON `wallet_nonces` (`nonce`);--> statement-breakpoint
ALTER TABLE `user_payments` ADD `payment_intent_id` text;--> statement-breakpoint
CREATE INDEX `user_payments_payment_intent_idx` ON `user_payments` (`payment_intent_id`);