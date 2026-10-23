CREATE TABLE `user_wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_wallets_address_unique` ON `user_wallets` (`address`);--> statement-breakpoint
CREATE INDEX `user_wallets_user_idx` ON `user_wallets` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_wallets_address_idx` ON `user_wallets` (`address`);