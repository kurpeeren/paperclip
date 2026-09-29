ALTER TABLE "budget_incidents" ALTER COLUMN "amount_limit" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "budget_incidents" ALTER COLUMN "amount_observed" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "budget_policies" ALTER COLUMN "amount" SET DATA TYPE bigint;