CREATE TABLE `conversation_recaps` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`last_message_id` text NOT NULL,
	`payload` text NOT NULL,
	`dismissed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_recaps_conversation_id_unique` ON `conversation_recaps` (`conversation_id`);