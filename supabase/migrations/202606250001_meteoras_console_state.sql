create table if not exists public.meteoras_console_state (
  id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.meteoras_console_state enable row level security;

revoke all on table public.meteoras_console_state from anon;
revoke all on table public.meteoras_console_state from authenticated;
grant all on table public.meteoras_console_state to service_role;
