-- Run this FIRST, on its own (Postgres won't use a new enum value in the same run).
alter type public.moderation_status add value if not exists 'pending';
