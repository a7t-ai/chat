ALTER TABLE `messages` ADD `variant_of` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `variant_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_variant_idx` ON `messages` (`variant_of`);